"""Persistent TTS worker with async queue for non-blocking synthesis.

Design goals:
- Model loads lazily on first request, stays resident until shutdown/restart.
- Requests enqueue instantly; callers never block on model inference.
- FIFO processing with configurable max queue depth.
- Queue flushes on restart (stale requests from a previous lifecycle are dropped).
- Reports resource usage to the shared ResourceMonitor.
- Publishes completed synthesis events back to the session event store.
"""

from __future__ import annotations

import asyncio
import logging
import time
import threading
from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Callable

from app.core.settings import AppPaths, get_app_paths
from app.schemas.session import (
    SpeechSynthesisContract,
    SpeechTimingMetadata,
    TTS_BASELINE_PROFILE_IDS,
)
from app.services.resource_monitor import (
    ModelSubsystem,
    SubsystemTracker,
    get_resource_monitor,
)
from app.services.speech import (
    GptSovitsSynthesisAdapter,
    SpeechSynthesisRequest,
    SpeechSynthesisService,
    StubSpeechSynthesisService,
    _normalize_audio_reference,
    _normalize_timing,
    _normalize_contract_status,
    SpeechTimingMetadata as _TimingMeta,
    AudioFormatMetadata,
    SpeechSegmentRange,
)
from app.services.tts_server import (
    GPTSoVITSServerManager,
    GPTSoVITSServerError,
    get_server_manager,
    load_server_config,
)

logger = logging.getLogger(__name__)


class TTSWorkerState(str, Enum):
    IDLE = "idle"               # Not started, no model loaded
    LOADING = "loading"         # Model is loading into GPU
    READY = "ready"             # Model loaded, waiting for work
    PROCESSING = "processing"   # Currently synthesizing
    ERROR = "error"             # Failed to load or crashed
    SHUTDOWN = "shutdown"       # Gracefully stopped


MAX_QUEUE_DEPTH = int(__import__("os").environ.get("NIKOF_TTS_QUEUE_MAX", "20"))
MODEL_ESTIMATED_VRAM_MB = 3500.0  # GPT-SoVITS typical VRAM footprint


@dataclass(slots=True)
class TTSQueueItem:
    """A single synthesis request in the queue."""

    request_id: str
    request: SpeechSynthesisRequest
    enqueued_at: float
    future: asyncio.Future[SpeechSynthesisContract]


@dataclass(slots=True)
class TTSWorkerStatus:
    state: TTSWorkerState
    model_name: str | None
    queue_depth: int
    max_queue_depth: int
    total_processed: int
    average_latency_ms: float | None
    last_error: str | None
    vram_allocated_mb: float | None


class TTSWorker:
    """Background worker that owns the TTS model lifecycle and processes a FIFO queue.

    The worker does NOT start the model on construction. It waits until the first
    request is enqueued, then loads the model in the background processing loop.
    """

    def __init__(
        self,
        *,
        app_paths: AppPaths | None = None,
        on_synthesis_complete: Callable[[str, SpeechSynthesisContract], None] | None = None,
    ) -> None:
        self._app_paths = app_paths or get_app_paths()
        self._on_synthesis_complete = on_synthesis_complete
        self._state = TTSWorkerState.IDLE
        self._last_error: str | None = None

        # Queue
        self._queue: asyncio.Queue[TTSQueueItem | None] = asyncio.Queue(maxsize=MAX_QUEUE_DEPTH)
        self._processing_task: asyncio.Task[None] | None = None
        self._loop: asyncio.AbstractEventLoop | None = None

        # Model adapter (created lazily)
        self._adapter: SpeechSynthesisService | None = None
        self._model_loaded = False
        self._model_name: str | None = None
        self._server_manager: GPTSoVITSServerManager | None = None
        self._use_server = False

        # Metrics (thread-safe via the resource monitor tracker)
        self._tracker: SubsystemTracker = get_resource_monitor().tracker("tts")
        self._request_counter = 0

    @property
    def state(self) -> TTSWorkerState:
        return self._state

    @property
    def queue_depth(self) -> int:
        return self._queue.qsize()

    def status(self) -> TTSWorkerStatus:
        tracker_snap = self._tracker.snapshot()
        return TTSWorkerStatus(
            state=self._state,
            model_name=self._model_name,
            queue_depth=self._queue.qsize(),
            max_queue_depth=MAX_QUEUE_DEPTH,
            total_processed=tracker_snap.requests_processed,
            average_latency_ms=tracker_snap.average_latency_ms,
            last_error=self._last_error,
            vram_allocated_mb=tracker_snap.vram_allocated_mb,
        )

    async def start(self, loop: asyncio.AbstractEventLoop | None = None) -> None:
        """Start the background processing loop. Does NOT load the model yet."""
        if self._processing_task is not None:
            return

        self._loop = loop or asyncio.get_running_loop()
        self._state = TTSWorkerState.IDLE
        self._processing_task = asyncio.create_task(self._process_loop())
        logger.info("TTS worker started (idle, awaiting first request)")

    async def stop(self) -> None:
        """Gracefully shut down: flush queue, stop loop."""
        self._state = TTSWorkerState.SHUTDOWN

        # Drain pending items and cancel their futures
        self._flush_queue("Worker shutting down")

        # Signal the processing loop to exit
        try:
            self._queue.put_nowait(None)
        except asyncio.QueueFull:
            pass

        if self._processing_task is not None:
            try:
                await asyncio.wait_for(self._processing_task, timeout=5.0)
            except (asyncio.TimeoutError, asyncio.CancelledError):
                self._processing_task.cancel()
            self._processing_task = None

        self._unload_model()
        logger.info("TTS worker stopped")

    async def enqueue(
        self,
        request: SpeechSynthesisRequest,
        request_id: str,
    ) -> asyncio.Future[SpeechSynthesisContract]:
        """Enqueue a synthesis request. Returns a Future that resolves when done.

        Raises asyncio.QueueFull if the queue is at capacity.
        """
        if self._state == TTSWorkerState.SHUTDOWN:
            future: asyncio.Future[SpeechSynthesisContract] = asyncio.get_running_loop().create_future()
            future.set_result(SpeechSynthesisContract(
                profile_id=request.profile_id,
                status="unavailable",
                text=request.text,
                locale=request.locale,
            ))
            return future

        loop = asyncio.get_running_loop()
        future = loop.create_future()

        item = TTSQueueItem(
            request_id=request_id,
            request=request,
            enqueued_at=time.time(),
            future=future,
        )

        try:
            self._queue.put_nowait(item)
        except asyncio.QueueFull:
            # Drop oldest item to make room (configurable policy)
            logger.warning(f"TTS queue full ({MAX_QUEUE_DEPTH}), rejecting request {request_id}")
            future.set_result(SpeechSynthesisContract(
                profile_id=request.profile_id,
                status="error",
                text=request.text,
                locale=request.locale,
            ))
            return future

        # If the worker hasn't started its loop yet, make sure it's running
        if self._processing_task is None:
            await self.start()

        logger.debug(f"TTS request {request_id} enqueued (queue depth: {self._queue.qsize()})")
        return future

    def _flush_queue(self, reason: str) -> None:
        """Drop all pending items and cancel their futures."""
        dropped = 0
        while not self._queue.empty():
            try:
                item = self._queue.get_nowait()
                if item is not None and not item.future.done():
                    item.future.set_result(SpeechSynthesisContract(
                        profile_id=item.request.profile_id,
                        status="error",
                        text=item.request.text,
                        locale=item.request.locale,
                    ))
                    dropped += 1
            except asyncio.QueueEmpty:
                break

        if dropped:
            logger.info(f"TTS queue flushed: {dropped} items dropped ({reason})")

    def _load_model(self) -> bool:
        """Start the persistent GPT-SoVITS server. Returns True on success."""
        self._state = TTSWorkerState.LOADING
        logger.info("TTS worker: starting persistent GPT-SoVITS server...")

        try:
            monitor = get_resource_monitor()
            if not monitor.can_load_subsystem("tts", MODEL_ESTIMATED_VRAM_MB):
                logger.warning("TTS worker: insufficient VRAM to load model")
                self._state = TTSWorkerState.ERROR
                self._last_error = "Insufficient VRAM"
                return False

            self._server_manager = get_server_manager(self._app_paths)

            if not self._server_manager.server_configured:
                logger.warning(
                    f"TTS worker: server not configured "
                    f"(provider={self._server_manager.config.provider_root}, "
                    f"model={self._server_manager.config.model_root})"
                )
                self._adapter = GptSovitsSynthesisAdapter(app_paths=self._app_paths)
                self._model_name = "gpt-sovits adapter"
                self._model_loaded = True
                self._use_server = False
                self._tracker.mark_loaded(self._model_name, vram_mb=0, ram_mb=0)
                self._state = TTSWorkerState.READY
                self._last_error = None
                return True

            # Start the persistent server (loads model into GPU)
            if not self._server_manager.start():
                logger.error("TTS worker: server failed to start")
                self._adapter = None
                self._model_name = "unavailable (server start failed)"
                self._model_loaded = False
                self._use_server = False
                self._tracker.mark_unloaded()
                self._state = TTSWorkerState.ERROR
                self._last_error = "TTS sidecar failed to start"
                return False

            # Server is running — use HTTP adapter
            self._adapter = None  # We'll use _synthesize_via_server directly
            self._model_name = f"gpt-sovits server ({self._server_manager.config.base_url})"
            self._model_loaded = True
            self._use_server = True

            # Get actual VRAM from server health if available
            health = self._server_manager.health()
            vram_mb = health.get("vram_mb") or MODEL_ESTIMATED_VRAM_MB
            self._tracker.mark_loaded(
                self._model_name,
                vram_mb=float(vram_mb) if vram_mb else MODEL_ESTIMATED_VRAM_MB,
                ram_mb=512,
            )
            self._state = TTSWorkerState.READY
            logger.info(f"TTS worker: persistent server ready ({self._model_name})")
            return True

        except Exception as exc:
            self._state = TTSWorkerState.ERROR
            self._last_error = str(exc)
            logger.exception("TTS worker: failed to load model")
            return False

    def _unload_model(self) -> None:
        """Release model resources and stop server."""
        if self._model_loaded:
            # Stop the persistent server if we started one
            if hasattr(self, "_server_manager") and self._server_manager is not None:
                try:
                    self._server_manager.stop()
                except Exception:
                    logger.exception("TTS worker: error stopping server")

            self._adapter = None
            self._model_loaded = False
            self._model_name = None
            self._use_server = False
            self._tracker.mark_unloaded()
            logger.info("TTS worker: model unloaded")

    async def _process_loop(self) -> None:
        """Main processing loop: waits for items and synthesizes sequentially."""
        model_loaded = False

        while self._state != TTSWorkerState.SHUTDOWN:
            try:
                item = await self._queue.get()
            except asyncio.CancelledError:
                break

            if item is None:
                # Sentinel for shutdown
                break

            # Lazy model loading on first real request
            if not model_loaded:
                model_loaded = await asyncio.get_running_loop().run_in_executor(
                    None, self._load_model
                )
                if not model_loaded:
                    # Model failed to load — reject this and future items
                    if not item.future.done():
                        item.future.set_result(SpeechSynthesisContract(
                            profile_id=item.request.profile_id,
                            status="unavailable",
                            text=item.request.text,
                            locale=item.request.locale,
                        ))
                    continue

            # Process the item
            self._state = TTSWorkerState.PROCESSING
            start_time = time.time()

            try:
                # Run synthesis in executor to avoid blocking the event loop
                contract = await asyncio.get_running_loop().run_in_executor(
                    None, self._synthesize, item.request
                )
            except Exception as exc:
                logger.exception(f"TTS synthesis failed for request {item.request_id}")
                contract = SpeechSynthesisContract(
                    profile_id=item.request.profile_id,
                    status="error",
                    text=item.request.text,
                    locale=item.request.locale,
                )
                self._last_error = str(exc)

            elapsed_ms = (time.time() - start_time) * 1000
            self._tracker.record_request(elapsed_ms)
            self._request_counter += 1

            # Resolve the future
            if not item.future.done():
                item.future.set_result(contract)

            # Notify callback
            if self._on_synthesis_complete is not None:
                try:
                    self._on_synthesis_complete(item.request_id, contract)
                except Exception:
                    logger.exception("TTS completion callback failed")

            self._state = TTSWorkerState.READY
            logger.debug(
                f"TTS request {item.request_id} completed in {elapsed_ms:.0f}ms "
                f"(status={contract.status}, queue_remaining={self._queue.qsize()})"
            )

        self._state = TTSWorkerState.SHUTDOWN

    def _synthesize(self, request: SpeechSynthesisRequest) -> SpeechSynthesisContract:
        """Invoke synthesis - via persistent server or fallback adapter."""
        if hasattr(self, "_use_server") and self._use_server and self._server_manager is not None:
            result = self._synthesize_via_server(request)
            if result.status != "error":
                return result
            # Server unreachable — return error, do NOT spawn subprocess fallback
            # (subprocess fallback loads the model into VRAM on every call)
            logger.warning("TTS server synthesis failed — no fallback (server mode)")
            return result

        if self._adapter is None:
            return SpeechSynthesisContract(
                profile_id=request.profile_id,
                status="unavailable",
                text=request.text,
                locale=request.locale,
            )

        return self._adapter.synthesize(request)

    def _synthesize_via_server(self, request: SpeechSynthesisRequest) -> SpeechSynthesisContract:
        """Send synthesis request to the persistent GPT-SoVITS HTTP server."""
        payload: dict[str, Any] = {
            "text": request.text,
            "locale": request.locale,
            "profile_id": request.profile_id,
        }
        if request.voice_profile_id:
            payload["voice_profile_id"] = request.voice_profile_id
        if request.voice_profile:
            payload["voice_profile"] = request.voice_profile

        try:
            response = self._server_manager.synthesize(payload)
        except GPTSoVITSServerError as exc:
            if str(exc) != self._last_error:
                logger.error(f"TTS server synthesis failed: {exc}")
            self._last_error = str(exc)
            return SpeechSynthesisContract(
                profile_id=request.profile_id,
                status="error",
                text=request.text,
                locale=request.locale,
            )

        # Parse the server response into a contract
        audio_reference = response.get("audio_reference") or response.get("audio_path") or response.get("wav_path")
        status_raw = response.get("status", "ready")
        success = audio_reference is not None
        status = "ready" if success else "error"
        if isinstance(status_raw, str) and status_raw in ("error", "failed", "unavailable"):
            status = status_raw

        # Parse timing if provided
        timing: SpeechTimingMetadata | None = None
        raw_timing = response.get("timing")
        if isinstance(raw_timing, dict):
            fallback_timing = SpeechTimingMetadata(
                utterance_duration_ms=0,
                segment_ranges=(),
                audio_format=AudioFormatMetadata(
                    container="wav", encoding="pcm_s16le",
                    sample_rate_hz=24000, channels=1,
                ),
                phoneme_slots=(),
                viseme_slots=(),
            )
            timing = _normalize_timing(raw_timing, fallback=fallback_timing)

        return SpeechSynthesisContract(
            profile_id=request.profile_id,
            status=status,
            text=str(response.get("text") or request.text),
            locale=str(response.get("locale") or request.locale),
            audio_reference=audio_reference,
            timing=timing,
        )


# Module-level singleton
_tts_worker: TTSWorker | None = None
_tts_worker_lock = threading.Lock()


def get_tts_worker(app_paths: AppPaths | None = None) -> TTSWorker:
    """Get or create the global TTS worker instance."""
    global _tts_worker
    resolved_paths = app_paths or get_app_paths()
    if _tts_worker is None:
        with _tts_worker_lock:
            if _tts_worker is None:
                _tts_worker = TTSWorker(app_paths=resolved_paths)
    elif app_paths is not None:
        if _tts_worker._app_paths.providers_root != resolved_paths.providers_root or _tts_worker._app_paths.tts_models_root != resolved_paths.tts_models_root:
            _tts_worker = TTSWorker(app_paths=resolved_paths)
    return _tts_worker


class QueuedSynthesisService:
    """SpeechSynthesisService adapter that enqueues to the TTSWorker.

    For use in synchronous code paths that need immediate results (like the
    existing operator_routes), this provides a blocking wait with timeout.
    For async code, use the worker's enqueue() directly.
    """

    def __init__(self, worker: TTSWorker | None = None, *, eager: bool = False) -> None:
        self._worker = worker or get_tts_worker()
        self._counter = 0
        self._counter_lock = threading.Lock()

        # Eagerly load the model in a background thread so the first request is fast
        if eager and not self._worker._model_loaded:
            threading.Thread(
                target=self._worker._load_model,
                name="tts-eager-load",
                daemon=True,
            ).start()

    def _next_request_id(self) -> str:
        with self._counter_lock:
            self._counter += 1
            return f"tts-sync-{self._counter:06d}"

    def synthesize(self, request: SpeechSynthesisRequest) -> SpeechSynthesisContract:
        """Run synthesis synchronously.

        For sync callers (FastAPI threadpool), bypass the async queue and call
        the worker's synthesis method directly. This avoids cross-event-loop
        issues while still using the persistent server.
        """
        # Ensure the model is loaded (lazy init)
        if not self._worker._model_loaded:
            loaded = self._worker._load_model()
            if not loaded:
                return SpeechSynthesisContract(
                    profile_id=request.profile_id,
                    status="unavailable",
                    text=request.text,
                    locale=request.locale,
                )

        # Call synthesis directly (thread-safe — server uses HTTP)
        start_time = time.time()
        try:
            contract = self._worker._synthesize(request)
        except Exception as exc:
            logger.warning(f"TTS sync synthesis failed: {exc}")
            return SpeechSynthesisContract(
                profile_id=request.profile_id,
                status="error",
                text=request.text,
                locale=request.locale,
            )

        elapsed_ms = (time.time() - start_time) * 1000
        self._worker._tracker.record_request(elapsed_ms)
        self._worker._request_counter += 1
        return contract
