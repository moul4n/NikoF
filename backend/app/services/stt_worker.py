from __future__ import annotations

import asyncio
from concurrent.futures import ThreadPoolExecutor
import logging
import re
import threading
import time
from collections import deque
from dataclasses import dataclass, field, replace
from enum import Enum
from typing import Any

from app.core.settings import AppPaths, get_app_paths
from app.schemas.session import AudioFormatMetadata, SpeechTimingMetadata, STT_BASELINE_PROFILE_IDS, SpeechTranscriptionContract
from app.services.resource_monitor import SubsystemTracker, get_resource_monitor
from app.services.stt_server import FasterWhisperServerError, FasterWhisperServerManager, get_server_manager
from app.services.turns import UserTurnRequest, UserTurnServices, run_user_text_turn


logger = logging.getLogger(__name__)

MODEL_ESTIMATED_VRAM_MB = 2200.0


class STTWorkerState(str, Enum):
    IDLE = "idle"
    STARTING = "starting"
    READY = "ready"
    LISTENING = "listening"
    DETECTED = "detected"
    PROCESSING = "processing"
    UNAVAILABLE = "unavailable"
    ERROR = "error"
    SHUTDOWN = "shutdown"


@dataclass(slots=True, frozen=True)
class STTInputDevice:
    device_id: str
    label: str
    default: bool
    sample_rate_hz: int | None
    max_input_channels: int | None


@dataclass(slots=True, frozen=True)
class STTTranscriptChunk:
    chunk_id: str
    transcript: str
    locale: str
    captured_at: float
    duration_ms: int
    processing_ms: float | None
    confidence: float | None
    accepted_for_dispatch: bool
    dispatch_state: str
    dispatch_target: str | None
    dispatch_detail: str | None


@dataclass(slots=True)
class STTWorkerStatus:
    state: STTWorkerState
    model_name: str | None
    available: bool
    listening: bool
    selected_device_id: str | None
    selected_device_label: str | None
    latest_confirmed_text: str | None
    latest_confirmed_at: float | None
    total_processed: int
    total_submitted: int
    average_latency_ms: float | None
    last_error: str | None
    compute_device: str | None
    compute_type: str | None
    next_sequence: int
    transcript_chunks: tuple[STTTranscriptChunk, ...] = field(default_factory=tuple)


def _should_submit_transcript(transcript: str) -> bool:
    normalized = transcript.strip().lower()
    if not normalized:
        return False
    if normalized in {"um", "uh", "hmm", "mm", "okay"}:
        return False
    return True


class STTWorker:
    def __init__(self, *, app_paths: AppPaths | None = None) -> None:
        self._app_paths = app_paths or get_app_paths()
        self._manager: FasterWhisperServerManager = get_server_manager(self._app_paths)
        self._tracker: SubsystemTracker = get_resource_monitor().tracker("stt")
        self._state = STTWorkerState.IDLE
        self._last_error: str | None = None
        self._listening = False
        self._selected_device_id: str | None = None
        self._selected_device_label: str | None = None
        self._latest_confirmed_text: str | None = None
        self._latest_confirmed_at: float | None = None
        self._total_submitted = 0
        self._compute_device: str | None = None
        self._compute_type: str | None = None
        self._model_name: str | None = None
        self._available = False
        self._next_sequence = 1
        self._chunk_sequence = 0
        self._transcript_chunks: deque[STTTranscriptChunk] = deque(maxlen=24)
        self._poll_task: asyncio.Task[None] | None = None
        self._turn_services: UserTurnServices | None = None
        self._dispatch_executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="stt-turn-dispatch")
        self._lock = threading.Lock()

    def configure_turn_services(self, services: UserTurnServices) -> None:
        self._turn_services = services

    def status(self) -> STTWorkerStatus:
        tracker_snapshot = self._tracker.snapshot()
        return STTWorkerStatus(
            state=self._state,
            model_name=self._model_name,
            available=self._available,
            listening=self._listening,
            selected_device_id=self._selected_device_id,
            selected_device_label=self._selected_device_label,
            latest_confirmed_text=self._latest_confirmed_text,
            latest_confirmed_at=self._latest_confirmed_at,
            total_processed=tracker_snapshot.requests_processed,
            total_submitted=self._total_submitted,
            average_latency_ms=tracker_snapshot.average_latency_ms,
            last_error=self._last_error,
            compute_device=self._compute_device,
            compute_type=self._compute_type,
            next_sequence=self._next_sequence,
            transcript_chunks=tuple(self._transcript_chunks),
        )

    async def start(self) -> None:
        if self._poll_task is not None:
            return

        self._state = STTWorkerState.STARTING
        allow_gpu = get_resource_monitor().can_load_subsystem("stt", MODEL_ESTIMATED_VRAM_MB)
        if not self._manager.start(allow_gpu=allow_gpu):
            self._state = STTWorkerState.UNAVAILABLE
            self._available = False
            self._last_error = "STT sidecar is unavailable"
            self._tracker.mark_unloaded()
            return

        await self._refresh_state()
        self._poll_task = asyncio.create_task(self._poll_loop())

    async def stop(self) -> None:
        self._state = STTWorkerState.SHUTDOWN
        if self._poll_task is not None:
            self._poll_task.cancel()
            try:
                await self._poll_task
            except asyncio.CancelledError:
                pass
            self._poll_task = None
        self._manager.stop()
        self._dispatch_executor.shutdown(wait=False, cancel_futures=False)
        self._tracker.mark_unloaded()

    async def list_devices(self) -> tuple[STTInputDevice, ...]:
        if not self._manager.is_healthy:
            return tuple()
        try:
            payload = self._manager.devices()
        except FasterWhisperServerError as exc:
            self._last_error = str(exc)
            return tuple()

        devices = payload.get("devices") if isinstance(payload.get("devices"), list) else []
        return tuple(
            STTInputDevice(
                device_id=str(device.get("device_id")),
                label=str(device.get("label") or device.get("device_id") or "Input"),
                default=bool(device.get("default")),
                sample_rate_hz=int(device.get("sample_rate_hz")) if device.get("sample_rate_hz") is not None else None,
                max_input_channels=int(device.get("max_input_channels")) if device.get("max_input_channels") is not None else None,
            )
            for device in devices
            if isinstance(device, dict)
        )

    async def set_selected_device(self, device_id: str | None) -> STTWorkerStatus:
        try:
            self._manager.set_device(device_id)
            await self._refresh_state()
        except FasterWhisperServerError as exc:
            self._last_error = str(exc)
            self._state = STTWorkerState.ERROR
        return self.status()

    async def set_listening(self, enabled: bool) -> STTWorkerStatus:
        try:
            if enabled:
                self._latest_confirmed_text = None
                self._latest_confirmed_at = None
                self._manager.start_listening()
            else:
                self._manager.stop_listening()
            await self._refresh_state()
        except FasterWhisperServerError as exc:
            self._last_error = str(exc)
            self._state = STTWorkerState.ERROR
        return self.status()

    async def _poll_loop(self) -> None:
        while True:
            try:
                await self._process_events()
                await asyncio.sleep(0.35)
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                self._last_error = str(exc)
                self._state = STTWorkerState.ERROR
                await asyncio.sleep(1.0)

    async def _process_events(self) -> None:
        if not self._manager.is_healthy:
            self._available = False
            self._state = STTWorkerState.UNAVAILABLE
            self._tracker.mark_unloaded()
            return

        payload = self._manager.events(after_sequence=self._next_sequence - 1)
        events = payload.get("events") if isinstance(payload.get("events"), list) else []
        if not events:
            await self._refresh_state()
            return

        for event in events:
            if not isinstance(event, dict):
                continue
            sequence = int(event.get("sequence") or self._next_sequence)
            self._next_sequence = max(self._next_sequence, sequence + 1)
            event_type = str(event.get("event_type") or "")
            state_name = str(event.get("state") or "").strip().lower()
            self._apply_state_name(state_name)

            if event_type == "transcript.confirmed":
                transcript = str(event.get("transcript") or "").strip()
                if not transcript:
                    continue
                confidence = float(event.get("confidence")) if event.get("confidence") is not None else None
                duration_ms = int(event.get("duration_ms") or 0)
                latency_ms = float(event.get("latency_ms") or 0.0)
                self._tracker.record_request(latency_ms)
                self._latest_confirmed_text = transcript
                self._latest_confirmed_at = float(event.get("timestamp_epoch") or time.time())
                if _should_submit_transcript(transcript):
                    self._total_submitted += 1
                    chunk = self._record_transcript_chunk(
                        transcript=transcript,
                        locale=str(event.get("locale") or "en-US"),
                        confidence=confidence,
                        duration_ms=duration_ms,
                        processing_ms=latency_ms,
                        accepted_for_dispatch=True,
                        dispatch_state="queued",
                        dispatch_target="llm",
                        dispatch_detail="Transcript accepted and queued for downstream dispatch.",
                    )
                    await self._submit_transcript(
                        chunk_id=chunk.chunk_id,
                        transcript=transcript,
                        locale=str(event.get("locale") or "en-US"),
                        confidence=confidence,
                        duration_ms=duration_ms,
                    )
                else:
                    self._record_transcript_chunk(
                        transcript=transcript,
                        locale=str(event.get("locale") or "en-US"),
                        confidence=confidence,
                        duration_ms=duration_ms,
                        processing_ms=latency_ms,
                        accepted_for_dispatch=False,
                        dispatch_state="filtered",
                        dispatch_target=None,
                        dispatch_detail="Transcript kept for debugging but not forwarded because it did not meet the STT submission threshold.",
                    )
            elif event_type == "transcript.error":
                self._last_error = str(event.get("message") or "STT transcription failed")

        await self._refresh_state()

    async def _submit_transcript(
        self,
        *,
        chunk_id: str,
        transcript: str,
        locale: str,
        confidence: float | None,
        duration_ms: int,
    ) -> None:
        if self._turn_services is None:
            self._update_transcript_chunk(
                chunk_id,
                dispatch_state="stub-recorded",
                dispatch_target="stub",
                dispatch_detail="Transcript recorded to the STT debug buffer; no live LLM turn services are configured yet.",
            )
            return

        transcription = SpeechTranscriptionContract(
            profile_id=STT_BASELINE_PROFILE_IDS[0],
            status="ready",
            locale=locale,
            transcript=transcript,
            confidence=confidence,
            timing=SpeechTimingMetadata(
                utterance_duration_ms=duration_ms,
                audio_format=AudioFormatMetadata(
                    container="wav",
                    encoding="pcm_f32le",
                    sample_rate_hz=16000,
                    channels=1,
                ),
            ),
        )
        try:
            self._update_transcript_chunk(
                chunk_id,
                dispatch_state="dispatching",
                dispatch_target="llm",
                dispatch_detail="Transcript dispatch is running in the dedicated STT turn executor.",
            )
            await asyncio.get_running_loop().run_in_executor(
                self._dispatch_executor,
                lambda: run_user_text_turn(
                    UserTurnRequest(
                        text=transcript,
                        locale=locale,
                        session_event_type="session.stt.accepted",
                        transcription=transcription,
                        defer_synthesis=True,
                    ),
                    services=self._turn_services,
                ),
            )
        except Exception as exc:
            self._update_transcript_chunk(
                chunk_id,
                dispatch_state="error",
                dispatch_target="llm",
                dispatch_detail=str(exc),
            )
            raise
        else:
            self._update_transcript_chunk(
                chunk_id,
                dispatch_state="submitted",
                dispatch_target="llm",
                dispatch_detail="Transcript submitted through the shared user-text turn workflow.",
            )

    async def _refresh_state(self) -> None:
        try:
            snapshot = self._manager.state()
        except FasterWhisperServerError as exc:
            self._available = False
            self._state = STTWorkerState.UNAVAILABLE
            self._last_error = str(exc)
            self._tracker.mark_unloaded()
            return

        self._available = snapshot.get("status") == "ready"
        self._listening = bool(snapshot.get("listening"))
        self._selected_device_id = str(snapshot.get("selected_device_id")) if snapshot.get("selected_device_id") is not None else None
        self._selected_device_label = str(snapshot.get("selected_device_label")) if snapshot.get("selected_device_label") is not None else None
        self._compute_device = str(snapshot.get("compute_device")) if snapshot.get("compute_device") is not None else None
        self._compute_type = str(snapshot.get("compute_type")) if snapshot.get("compute_type") is not None else None
        self._model_name = str(snapshot.get("model_name")) if snapshot.get("model_name") is not None else None
        self._next_sequence = int(snapshot.get("next_sequence") or self._next_sequence)
        self._last_error = str(snapshot.get("last_error")) if snapshot.get("last_error") is not None else self._last_error
        self._apply_state_name(str(snapshot.get("state") or "ready"))

        if self._available:
            vram_mb = MODEL_ESTIMATED_VRAM_MB if self._compute_device == "cuda" else 0.0
            ram_mb = 768.0 if self._compute_device == "cpu" else 512.0
            self._tracker.mark_loaded(self._model_name or "faster-whisper", vram_mb=vram_mb, ram_mb=ram_mb)
        else:
            self._tracker.mark_unloaded()

    def _apply_state_name(self, state_name: str) -> None:
        mapping = {
            "ready": STTWorkerState.READY,
            "listening": STTWorkerState.LISTENING,
            "detected": STTWorkerState.DETECTED,
            "processing": STTWorkerState.PROCESSING,
            "error": STTWorkerState.ERROR,
            "starting": STTWorkerState.STARTING,
        }
        self._state = mapping.get(state_name, self._state if state_name else self._state)

    def _record_transcript_chunk(
        self,
        *,
        transcript: str,
        locale: str,
        confidence: float | None,
        duration_ms: int,
        processing_ms: float | None,
        accepted_for_dispatch: bool,
        dispatch_state: str,
        dispatch_target: str | None,
        dispatch_detail: str | None,
    ) -> STTTranscriptChunk:
        self._chunk_sequence += 1
        chunk = STTTranscriptChunk(
            chunk_id=f"stt-chunk-{self._chunk_sequence}",
            transcript=transcript,
            locale=locale,
            captured_at=time.time(),
            duration_ms=duration_ms,
            processing_ms=processing_ms,
            confidence=confidence,
            accepted_for_dispatch=accepted_for_dispatch,
            dispatch_state=dispatch_state,
            dispatch_target=dispatch_target,
            dispatch_detail=dispatch_detail,
        )
        self._transcript_chunks.appendleft(chunk)
        return chunk

    def _update_transcript_chunk(
        self,
        chunk_id: str,
        *,
        dispatch_state: str,
        dispatch_target: str | None,
        dispatch_detail: str | None,
    ) -> None:
        for index, chunk in enumerate(self._transcript_chunks):
            if chunk.chunk_id != chunk_id:
                continue
            self._transcript_chunks[index] = replace(
                chunk,
                dispatch_state=dispatch_state,
                dispatch_target=dispatch_target,
                dispatch_detail=dispatch_detail,
            )
            return


_stt_worker: STTWorker | None = None
_stt_worker_lock = threading.Lock()


def get_stt_worker(app_paths: AppPaths | None = None) -> STTWorker:
    global _stt_worker
    resolved_paths = app_paths or get_app_paths()
    if _stt_worker is None:
        with _stt_worker_lock:
            if _stt_worker is None:
                _stt_worker = STTWorker(app_paths=resolved_paths)
    elif app_paths is not None:
        if _stt_worker._app_paths.providers_root != resolved_paths.providers_root or _stt_worker._app_paths.stt_models_root != resolved_paths.stt_models_root:
            _stt_worker = STTWorker(app_paths=resolved_paths)
    return _stt_worker