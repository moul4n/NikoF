from __future__ import annotations

from dataclasses import dataclass, field, replace
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import subprocess
import sys
import threading
import time
from typing import Any, Iterator, Protocol

from app.core.runtime_tuning import get_runtime_tuning
from app.core.settings import AppPaths, get_app_paths
from app.schemas.session import (
    AssistantMessageContract,
    AudioFormatMetadata,
    SESSION_EVENT_SCHEMA_VERSION,
    SessionEvent,
    SessionSnapshot,
    SpeechLifecycleEventEnvelope,
    SpeechLifecycleTransportSnapshot,
    SpeechLipSyncDebug,
    SpeechLipSyncPayload,
    SpeechMouthCueSlot,
    SpeechMouthCueTrack,
    SpeechPhonemeSlot,
    SpeechSegmentRange,
    SpeechSynthesisContract,
    SpeechTimingMetadata,
    SpeechTranscriptionContract,
    SpeechVisemeSlot,
    STT_BASELINE_PROFILE_IDS,
    TTS_BASELINE_PROFILE_IDS,
)
from app.services.resource_monitor import get_resource_monitor
from app.services.session import InvalidEventCursor, SessionEventStore

# Pure timing / lip-sync normalization helpers (extracted to keep speech.py
# focused on adapters + lifecycle services). Re-exported so existing
# `app.services.speech.X` references — e.g. tts_engines' `speech._normalize_timing`
# — keep resolving.
from app.services.speech_timing import (  # noqa: F401  (re-exported for callers)
    _coerce_float,
    _coerce_int,
    _normalize_contract_status,
    _normalize_timing,
)


SESSION_STREAM = "session"
SPEECH_LIFECYCLE_STREAM = "speech.lifecycle"
RUNTIME_CONFIG_FILE_NAME = "runtime.json"
PUBLIC_SESSION_SPEECH_ARTIFACT_PREFIX = "/api/session/speech-artifacts"
_GPT_SOVITS_SYNTHESIS_SINGLE_FLIGHT = threading.Lock()


def _read_runtime_config(*roots: Path) -> tuple[dict[str, Any], Path | None]:
    for root in roots:
        config_path = root / RUNTIME_CONFIG_FILE_NAME
        if not config_path.is_file():
            continue

        try:
            decoded = json.loads(config_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue

        if isinstance(decoded, dict):
            return decoded, config_path

    return {}, None


def _resolve_relative_entrypoint(provider_root: Path, raw_value: Any) -> Path | None:
    if not isinstance(raw_value, str) or not raw_value.strip():
        return None

    candidate = (provider_root / raw_value.strip()).resolve()
    provider_root_resolved = provider_root.resolve()
    try:
        candidate.relative_to(provider_root_resolved)
    except ValueError:
        return None

    return candidate


def _normalize_python_executable(raw_value: Any) -> str:
    if isinstance(raw_value, str) and raw_value.strip():
        return raw_value.strip()

    return sys.executable


@dataclass(slots=True, frozen=True)
class SpeechTranscriptionRequest:
    audio_reference: str
    locale: str
    profile_id: str = STT_BASELINE_PROFILE_IDS[0]
    transcript_hint: str | None = None
    confidence_hint: float | None = None
    timing: SpeechTimingMetadata | None = None


@dataclass(slots=True, frozen=True)
class SpeechSynthesisRequest:
    text: str
    locale: str
    profile_id: str = TTS_BASELINE_PROFILE_IDS[0]
    timing: SpeechTimingMetadata | None = None
    voice_profile_id: str | None = None
    voice_profile: dict[str, Any] | None = None
    preferred_lip_sync_track_id: str | None = None


class SpeechTranscriptionService(Protocol):
    """Boundary for provider-agnostic speech-to-text adapters."""

    def transcribe(self, request: SpeechTranscriptionRequest) -> SpeechTranscriptionContract:
        raise NotImplementedError


class SpeechSynthesisService(Protocol):
    """Boundary for provider-agnostic text-to-speech adapters."""

    def synthesize(self, request: SpeechSynthesisRequest) -> SpeechSynthesisContract:
        raise NotImplementedError


class SessionEventFactory(Protocol):
    """Boundary for canonical session-event production around speech contracts."""

    def build_event(
        self,
        snapshot: SessionSnapshot,
        *,
        character_id: str,
        event_type: str,
        status: str,
        reason: str | None = None,
        transcription: SpeechTranscriptionContract | None = None,
        assistant: AssistantMessageContract | None = None,
        synthesis: SpeechSynthesisContract | None = None,
    ) -> SessionEvent:
        raise NotImplementedError


class SpeechLifecycleSnapshotService(Protocol):
    """Boundary for a provider-agnostic speech lifecycle polling surface."""

    def get_snapshot(
        self,
        snapshot: SessionSnapshot,
        *,
        character_id: str,
        cursor: str | None = None,
    ) -> SpeechLifecycleTransportSnapshot:
        raise NotImplementedError


class SpeechLifecycleLiveDeliveryService(Protocol):
    """Boundary for streaming speech lifecycle delivery over a canonical cursor seam."""

    def iter_live_events(
        self,
        snapshot: SessionSnapshot,
        *,
        character_id: str,
        cursor: str | None = None,
        poll_interval_seconds: float = 0.25,
    ) -> Iterator[SpeechLifecycleEventEnvelope]:
        raise NotImplementedError


@dataclass(slots=True, frozen=True)
class BackendTurnRequest:
    character_id: str
    transcription: SpeechTranscriptionRequest
    synthesis: SpeechSynthesisRequest


@dataclass(slots=True, frozen=True)
class BackendTurnPublication:
    status: str
    session_events: tuple[SpeechLifecycleEventEnvelope, ...]
    speech_lifecycle_events: tuple[SpeechLifecycleEventEnvelope, ...]
    ordered_events: tuple[SpeechLifecycleEventEnvelope, ...]


class TurnPipelinePublisher(Protocol):
    """Boundary for publishing backend-owned turn events into canonical streams."""

    def publish_turn(
        self,
        snapshot: SessionSnapshot,
        turn_request: BackendTurnRequest,
    ) -> BackendTurnPublication:
        raise NotImplementedError


@dataclass(slots=True, frozen=True)
class SpeechAdapterRuntimeBinding:
    """Describes where a future provider-specific adapter will resolve its runtime assets."""

    profile_id: str
    modality: str
    family: str
    provider_root: Path
    model_root: Path
    invocation_entrypoint: Path
    configured: bool
    runtime_config_path: Path | None = None
    python_executable: str = sys.executable
    timeout_seconds: int = 20


class SpeechAdapterInvocationError(RuntimeError):
    """Raised when a local speech adapter cannot complete a request."""


def _resolve_invocation_entrypoint(provider_root: Path, primary_name: str, fallback_name: str) -> Path:
    primary_entrypoint = provider_root / primary_name
    fallback_entrypoint = provider_root / fallback_name
    if primary_entrypoint.exists() or not fallback_entrypoint.exists():
        return primary_entrypoint

    return fallback_entrypoint


def _run_json_entrypoint(
    entrypoint: Path,
    payload: dict[str, Any],
    *,
    python_executable: str = sys.executable,
    timeout_seconds: int = 20,
    environment: dict[str, str] | None = None,
) -> dict[str, Any]:
    try:
        completed = subprocess.run(
            [python_executable, str(entrypoint)],
            input=json.dumps(payload),
            capture_output=True,
            text=True,
            timeout=timeout_seconds,
            check=False,
            cwd=str(entrypoint.parent),
            env=environment,
        )
    except (OSError, subprocess.SubprocessError) as error:
        raise SpeechAdapterInvocationError("execution-failed") from error

    if completed.returncode != 0:
        raise SpeechAdapterInvocationError("execution-failed")

    try:
        decoded = json.loads(completed.stdout)
    except json.JSONDecodeError as error:
        raise SpeechAdapterInvocationError("invalid-json") from error

    if not isinstance(decoded, dict):
        raise SpeechAdapterInvocationError("invalid-payload")

    return decoded


def _normalize_audio_reference(raw_value: Any, *, provider_root: Path, model_root: Path) -> str | None:
    if not isinstance(raw_value, str) or not raw_value.strip():
        return None

    normalized_value = raw_value.strip()
    if "://" in normalized_value:
        return normalized_value

    raw_path = Path(normalized_value)
    if raw_path.is_absolute():
        return str(raw_path) if raw_path.exists() else None

    for base_root in (provider_root, model_root):
        resolved = (base_root / raw_path).resolve()
        if resolved.exists():
            return str(resolved)

    return None


def _looks_like_machine_local_audio_reference(raw_value: str) -> bool:
    normalized_value = raw_value.strip()
    if not normalized_value or normalized_value.startswith("session://"):
        return False

    if "://" in normalized_value:
        return False

    return Path(normalized_value).is_absolute()


def _is_relative_to(path: Path, root: Path) -> bool:
    try:
        path.relative_to(root)
    except ValueError:
        return False

    return True


def _resolve_public_speech_audio_artifact_path(audio_reference: str) -> Path | None:
    if not _looks_like_machine_local_audio_reference(audio_reference):
        return None

    audio_path = Path(audio_reference).resolve()
    if not audio_path.is_file():
        return None

    app_paths = get_app_paths()
    allowed_roots = (
        app_paths.tts_models_root.resolve(),
        app_paths.cache_root.resolve(),
    )
    if not any(_is_relative_to(audio_path, root) for root in allowed_roots):
        return None

    return audio_path


def build_public_speech_audio_reference(*, event_id: str) -> str:
    return f"{PUBLIC_SESSION_SPEECH_ARTIFACT_PREFIX}/{event_id}/audio"


def project_public_session_event(
    event: SessionEvent,
    *,
    audio_event_id: str | None = None,
) -> SessionEvent:
    synthesis = event.synthesis
    if synthesis is None or synthesis.audio_reference is None or audio_event_id is None:
        return event

    if _resolve_public_speech_audio_artifact_path(synthesis.audio_reference) is None:
        return event

    return replace(
        event,
        synthesis=replace(
            synthesis,
            audio_reference=build_public_speech_audio_reference(event_id=audio_event_id),
        ),
    )


def project_public_speech_lifecycle_envelope(
    envelope: SpeechLifecycleEventEnvelope,
) -> SpeechLifecycleEventEnvelope:
    projected_event = project_public_session_event(
        envelope.event,
        audio_event_id=envelope.event_id,
    )
    if projected_event == envelope.event:
        return envelope

    return replace(envelope, event=projected_event)


def project_public_speech_lifecycle_snapshot(
    snapshot: SpeechLifecycleTransportSnapshot,
) -> SpeechLifecycleTransportSnapshot:
    return replace(
        snapshot,
        events=tuple(project_public_speech_lifecycle_envelope(envelope) for envelope in snapshot.events),
    )


def resolve_session_speech_artifact_path(
    event_store: SessionEventStore,
    *,
    session_id: str,
    event_id: str,
) -> Path | None:
    for envelope in event_store.read(SPEECH_LIFECYCLE_STREAM, session_id=session_id):
        if envelope.event_id != event_id:
            continue

        synthesis = envelope.event.synthesis
        if synthesis is None or synthesis.audio_reference is None:
            return None

        return _resolve_public_speech_audio_artifact_path(synthesis.audio_reference)

    return None


def _normalize_string(value: Any) -> str | None:
    if value is None:
        return None

    normalized = str(value).strip()
    return normalized or None


def _normalize_voice_profile_payload(
    raw_value: Any,
    *,
    provider_root: Path,
    model_root: Path,
) -> dict[str, Any]:
    if not isinstance(raw_value, dict):
        return {}

    normalized: dict[str, Any] = {}
    for key in (
        "profile_id",
        "provider",
        "style",
        "notes",
        "speaker",
        "prompt_text",
        "prompt_language",
        "reference_text",
        "text_language",
    ):
        value = _normalize_string(raw_value.get(key))
        if value is not None:
            normalized[key] = value

    reference_audio = _normalize_audio_reference(
        raw_value.get("reference_audio"),
        provider_root=provider_root,
        model_root=model_root,
    )
    if reference_audio is not None:
        normalized["reference_audio"] = reference_audio

    for key in ("speed", "temperature", "top_p", "repetition_penalty"):
        value = _coerce_float(raw_value.get(key))
        if value is not None:
            normalized[key] = value

    top_k = _coerce_int(raw_value.get("top_k"), -1)
    if top_k >= 0:
        normalized["top_k"] = top_k

    seed = _coerce_int(raw_value.get("seed"), -1)
    if seed >= 0:
        normalized["seed"] = seed

    return normalized


def _normalize_runtime_synthesis_options(
    raw_value: Any,
    *,
    locale: str,
    provider_root: Path,
    model_root: Path,
) -> dict[str, Any]:
    if not isinstance(raw_value, dict):
        return {}

    source = raw_value.get("synthesis") if isinstance(raw_value.get("synthesis"), dict) else raw_value
    normalized = _normalize_voice_profile_payload(
        source,
        provider_root=provider_root,
        model_root=model_root,
    )
    if "text_language" not in normalized:
        normalized["text_language"] = locale
    return normalized


def _merge_synthesis_options(
    runtime_options: dict[str, Any],
    voice_profile: dict[str, Any],
) -> dict[str, Any]:
    if not runtime_options and not voice_profile:
        return {}

    merged = dict(runtime_options)
    for key, value in voice_profile.items():
        if value is None:
            continue

        merged[key] = value

    return merged


def _resolve_profile_family(profile_id: str) -> str:
    _, separator, remainder = profile_id.partition(".")
    if not separator:
        return profile_id

    family, _, _ = remainder.partition(".")
    return family or profile_id


@dataclass(slots=True)
class StubSpeechTranscriptionService:
    """Deterministic scaffold until a real STT adapter is wired in."""

    default_timing: SpeechTimingMetadata = SpeechTimingMetadata(
        utterance_duration_ms=1890,
        segment_ranges=(
            SpeechSegmentRange(start_ms=0, end_ms=640, text="Hey Niko,"),
            SpeechSegmentRange(start_ms=640, end_ms=1890, text="can you wave after you answer?"),
        ),
        audio_format=AudioFormatMetadata(
            container="wav",
            encoding="pcm_s16le",
            sample_rate_hz=16000,
            channels=1,
        ),
    )

    def transcribe(self, request: SpeechTranscriptionRequest) -> SpeechTranscriptionContract:
        return SpeechTranscriptionContract(
            profile_id=request.profile_id,
            status="final",
            locale=request.locale,
            transcript=request.transcript_hint or "Scaffold transcription unavailable.",
            confidence=request.confidence_hint if request.confidence_hint is not None else 0.98,
            timing=request.timing or self.default_timing,
        )


@dataclass(slots=True)
class FasterWhisperTranscriptionAdapter(StubSpeechTranscriptionService):
    """Configuration-aware Faster-Whisper adapter behind the local provider contract."""

    app_paths: AppPaths = field(default_factory=get_app_paths)
    model_directories: dict[str, str] = field(
        default_factory=lambda: {
            STT_BASELINE_PROFILE_IDS[0]: "faster-whisper-medium",
            STT_BASELINE_PROFILE_IDS[1]: "faster-whisper-small",
        }
    )

    def binding_for(self, request: SpeechTranscriptionRequest) -> SpeechAdapterRuntimeBinding:
        model_directory = self.model_directories.get(request.profile_id, "faster-whisper-medium")
        provider_root = self.app_paths.providers_root / "stt" / "faster-whisper"
        model_root = self.app_paths.stt_models_root / model_directory
        runtime_config, runtime_config_path = _read_runtime_config(model_root, provider_root)
        invocation_entrypoint = _resolve_relative_entrypoint(
            provider_root,
            runtime_config.get("entrypoint"),
        ) or _resolve_invocation_entrypoint(
            provider_root,
            "transcribe.py",
            "main.py",
        )
        return SpeechAdapterRuntimeBinding(
            profile_id=request.profile_id,
            modality="stt",
            family="faster-whisper",
            provider_root=provider_root,
            model_root=model_root,
            invocation_entrypoint=invocation_entrypoint,
            configured=provider_root.exists()
            and model_root.exists()
            and invocation_entrypoint.exists(),
            runtime_config_path=runtime_config_path,
            python_executable=_normalize_python_executable(runtime_config.get("python_executable")),
            timeout_seconds=max(1, _coerce_int(runtime_config.get("timeout_seconds"), 20)),
        )

    def transcribe(self, request: SpeechTranscriptionRequest) -> SpeechTranscriptionContract:
        binding = self.binding_for(request)
        tracker = get_resource_monitor().tracker("stt")
        fallback_timing = request.timing or self.default_timing
        if not binding.configured:
            return SpeechTranscriptionContract(
                profile_id=request.profile_id,
                status="unavailable",
                locale=request.locale,
                transcript=request.transcript_hint or "Local transcription is unavailable.",
                confidence=request.confidence_hint,
                timing=fallback_timing,
            )

        start_time = time.time()
        try:
            response = _run_json_entrypoint(
                binding.invocation_entrypoint,
                {
                    "profile_id": request.profile_id,
                    "audio_reference": request.audio_reference,
                    "locale": request.locale,
                    "transcript_hint": request.transcript_hint,
                    "confidence_hint": request.confidence_hint,
                    "model_root": str(binding.model_root),
                    "provider_root": str(binding.provider_root),
                    "timing": None if request.timing is None else {
                        "utterance_duration_ms": request.timing.utterance_duration_ms,
                        "segment_ranges": [
                            {
                                "start_ms": segment.start_ms,
                                "end_ms": segment.end_ms,
                                "text": segment.text,
                            }
                            for segment in request.timing.segment_ranges
                        ],
                    },
                },
                python_executable=binding.python_executable,
                timeout_seconds=binding.timeout_seconds,
                environment={
                    **os.environ,
                    "NIKOF_BACKEND_ROOT": str(Path(__file__).resolve().parents[2]),
                },
            )
        except SpeechAdapterInvocationError as error:
            status = "unavailable" if str(error) == "execution-failed" else "error"
            return SpeechTranscriptionContract(
                profile_id=request.profile_id,
                status=status,
                locale=request.locale,
                transcript=request.transcript_hint or "Local transcription is unavailable.",
                confidence=request.confidence_hint,
                timing=fallback_timing,
            )

        elapsed_ms = (time.time() - start_time) * 1000

        # Mark STT as loaded on first successful transcription
        if not tracker.loaded:
            # faster-whisper medium uses ~2GB VRAM
            tracker.mark_loaded(f"faster-whisper/{binding.model_root.name}", vram_mb=2000, ram_mb=512)
        tracker.record_request(elapsed_ms)

        transcript = str(
            response.get("transcript")
            or response.get("text")
            or request.transcript_hint
            or ""
        )
        success = bool(transcript.strip())
        status = _normalize_contract_status(response.get("status"), success=success)
        confidence = _coerce_float(response.get("confidence"))
        if confidence is None:
            confidence = request.confidence_hint

        return SpeechTranscriptionContract(
            profile_id=request.profile_id,
            status=status,
            locale=str(response.get("locale") or request.locale),
            transcript=transcript,
            confidence=confidence,
            timing=_normalize_timing(response.get("timing"), fallback=fallback_timing),
        )


@dataclass(slots=True)
class StubSpeechSynthesisService:
    """Deterministic scaffold until a real TTS adapter is wired in."""

    default_timing: SpeechTimingMetadata = SpeechTimingMetadata(
        utterance_duration_ms=2120,
        segment_ranges=(
            SpeechSegmentRange(start_ms=0, end_ms=880, text="Sure."),
            SpeechSegmentRange(
                start_ms=880,
                end_ms=2120,
                text="I can wave once I finish speaking.",
            ),
        ),
        audio_format=AudioFormatMetadata(
            container="wav",
            encoding="pcm_s16le",
            sample_rate_hz=24000,
            channels=1,
        ),
        phoneme_slots=(
            SpeechPhonemeSlot(phoneme="S", start_ms=0, end_ms=110),
            SpeechPhonemeSlot(phoneme="UH", start_ms=110, end_ms=260),
        ),
        viseme_slots=(
            SpeechVisemeSlot(viseme="sil", start_ms=0, end_ms=45),
            SpeechVisemeSlot(viseme="smile", start_ms=45, end_ms=310),
        ),
    )

    def synthesize(self, request: SpeechSynthesisRequest) -> SpeechSynthesisContract:
        return SpeechSynthesisContract(
            profile_id=request.profile_id,
            status="ready",
            text=request.text,
            locale=request.locale,
            timing=request.timing or self.default_timing,
        )


@dataclass(slots=True)
class GptSovitsSynthesisAdapter(StubSpeechSynthesisService):
    """Configuration-aware shell for future GPT-SoVITS-backed synthesis."""

    app_paths: AppPaths = field(default_factory=get_app_paths)
    model_directories: dict[str, str] = field(
        default_factory=lambda: {
            TTS_BASELINE_PROFILE_IDS[0]: "gpt-sovits",
        }
    )

    def binding_for(self, request: SpeechSynthesisRequest) -> SpeechAdapterRuntimeBinding:
        model_directory = self.model_directories.get(request.profile_id, "gpt-sovits")
        provider_root = self.app_paths.providers_root / "tts" / "gpt-sovits"
        model_root = self.app_paths.tts_models_root / model_directory
        runtime_config, runtime_config_path = _read_runtime_config(model_root, provider_root)
        invocation_entrypoint = _resolve_relative_entrypoint(
            provider_root,
            runtime_config.get("entrypoint"),
        ) or _resolve_invocation_entrypoint(
            provider_root,
            "synthesize.py",
            "api_server.py",
        )
        return SpeechAdapterRuntimeBinding(
            profile_id=request.profile_id,
            modality="tts",
            family="gpt-sovits",
            provider_root=provider_root,
            model_root=model_root,
            invocation_entrypoint=invocation_entrypoint,
            configured=provider_root.exists()
            and model_root.exists()
            and invocation_entrypoint.exists(),
            runtime_config_path=runtime_config_path,
            python_executable=_normalize_python_executable(runtime_config.get("python_executable")),
            timeout_seconds=max(1, _coerce_int(runtime_config.get("timeout_seconds"), 20)),
        )

    def synthesize(self, request: SpeechSynthesisRequest) -> SpeechSynthesisContract:
        binding = self.binding_for(request)
        fallback_timing = request.timing or self.default_timing
        if not binding.configured:
            return SpeechSynthesisContract(
                profile_id=request.profile_id,
                status="unavailable",
                text=request.text,
                locale=request.locale,
                timing=fallback_timing,
            )

        runtime_config, _ = _read_runtime_config(binding.model_root, binding.provider_root)
        voice_profile = _normalize_voice_profile_payload(
            request.voice_profile,
            provider_root=binding.provider_root,
            model_root=binding.model_root,
        )
        synthesis_options = _merge_synthesis_options(
            _normalize_runtime_synthesis_options(
                runtime_config,
                locale=request.locale,
                provider_root=binding.provider_root,
                model_root=binding.model_root,
            ),
            voice_profile,
        )

        try:
            with _GPT_SOVITS_SYNTHESIS_SINGLE_FLIGHT:
                response = _run_json_entrypoint(
                    binding.invocation_entrypoint,
                    {
                        "profile_id": request.profile_id,
                        "voice_profile_id": request.voice_profile_id
                        or _normalize_string(voice_profile.get("profile_id"))
                        or _normalize_string(synthesis_options.get("profile_id")),
                        "text": request.text,
                        "locale": request.locale,
                        "model_root": str(binding.model_root),
                        "provider_root": str(binding.provider_root),
                        "voice_profile": voice_profile or None,
                        "synthesis_options": synthesis_options or None,
                        "timing": None if request.timing is None else {
                            "utterance_duration_ms": request.timing.utterance_duration_ms,
                            "segment_ranges": [
                                {
                                    "start_ms": segment.start_ms,
                                    "end_ms": segment.end_ms,
                                    "text": segment.text,
                                }
                                for segment in request.timing.segment_ranges
                            ],
                        },
                    },
                    python_executable=binding.python_executable,
                    timeout_seconds=binding.timeout_seconds,
                    environment={
                        **os.environ,
                        "NIKOF_BACKEND_ROOT": str(Path(__file__).resolve().parents[2]),
                    },
                )
        except SpeechAdapterInvocationError as error:
            status = "unavailable" if str(error) == "execution-failed" else "error"
            return SpeechSynthesisContract(
                profile_id=request.profile_id,
                status=status,
                text=request.text,
                locale=request.locale,
                timing=fallback_timing,
            )

        audio_reference = _normalize_audio_reference(
            response.get("audio_reference")
            or response.get("audio_path")
            or response.get("output_path")
            or response.get("wav_path"),
            provider_root=binding.provider_root,
            model_root=binding.model_root,
        )
        timing = _normalize_timing(
            response.get("timing"),
            fallback=fallback_timing,
            preferred_lip_sync_track_id=request.preferred_lip_sync_track_id,
            source_text=str(response.get("text") or request.text),
        )
        success = audio_reference is not None
        status = _normalize_contract_status(response.get("status"), success=success)

        return SpeechSynthesisContract(
            profile_id=request.profile_id,
            status=status,
            text=str(response.get("text") or request.text),
            locale=str(response.get("locale") or request.locale),
            audio_reference=audio_reference,
            timing=timing,
        )


@dataclass(slots=True)
class StubSpeechLifecycleSnapshotService:
    """Deterministic read surface that prefers canonical event-store data when present."""

    event_store: SessionEventStore | None = None
    transcription_service: SpeechTranscriptionService | None = None
    synthesis_service: SpeechSynthesisService | None = None
    session_event_factory: SessionEventFactory | None = None
    fallback_on_empty: bool = False

    def get_snapshot(
        self,
        snapshot: SessionSnapshot,
        *,
        character_id: str,
        cursor: str | None = None,
    ) -> SpeechLifecycleTransportSnapshot:
        if self.event_store is not None:
            events = self.event_store.read(
                SPEECH_LIFECYCLE_STREAM,
                session_id=snapshot.session_id,
                after_cursor=cursor,
            )
            if events or not self.fallback_on_empty:
                return project_public_speech_lifecycle_snapshot(
                    SpeechLifecycleTransportSnapshot(
                        schema_version=1,
                        stream=SPEECH_LIFECYCLE_STREAM,
                        delivery="snapshot",
                        session_id=snapshot.session_id,
                        next_cursor=self.event_store.next_cursor(
                            SPEECH_LIFECYCLE_STREAM,
                            session_id=snapshot.session_id,
                        ),
                        events=events,
                    )
                )

        transcription_service = self.transcription_service or StubSpeechTranscriptionService()
        synthesis_service = self.synthesis_service or StubSpeechSynthesisService()
        session_event_factory = self.session_event_factory or DefaultSessionEventFactory()
        after_sequence = _parse_cursor_sequence(
            SPEECH_LIFECYCLE_STREAM,
            session_id=snapshot.session_id,
            cursor=cursor,
        )

        transcription = transcription_service.transcribe(
            SpeechTranscriptionRequest(
                audio_reference="session://speech-sample/transcription.wav",
                locale="en-US",
                transcript_hint="Hey Niko, can you wave after you answer?",
                confidence_hint=0.98,
            )
        )
        synthesis = synthesis_service.synthesize(
            SpeechSynthesisRequest(
                text="Sure. I can wave once I finish speaking.",
                locale="en-US",
            )
        )

        events = (
            session_event_factory.build_event(
                snapshot,
                character_id=character_id,
                event_type="transcription.status",
                status="final",
                transcription=transcription,
            ),
            session_event_factory.build_event(
                snapshot,
                character_id=character_id,
                event_type="speech.synthesis",
                status="ready",
                synthesis=synthesis,
            ),
        )

        envelopes = tuple(
            SpeechLifecycleEventEnvelope(
                event_id=f"speech-lifecycle-{sequence:04d}",
                sequence=sequence,
                cursor=f"{SPEECH_LIFECYCLE_STREAM}:{snapshot.session_id}:{sequence}",
                event=event,
            )
            for sequence, event in enumerate(events, start=1)
            if sequence > after_sequence
        )

        return project_public_speech_lifecycle_snapshot(
            SpeechLifecycleTransportSnapshot(
                schema_version=1,
                stream=SPEECH_LIFECYCLE_STREAM,
                delivery="snapshot",
                session_id=snapshot.session_id,
                next_cursor=f"{SPEECH_LIFECYCLE_STREAM}:{snapshot.session_id}:{len(events) + 1}",
                events=envelopes,
            )
        )


@dataclass(slots=True)
class SpeechServiceRegistry:
    """Minimal profile-family registry for provider shells while contracts stay stable."""

    transcription_services: dict[str, SpeechTranscriptionService] = field(default_factory=dict)
    synthesis_services: dict[str, SpeechSynthesisService] = field(default_factory=dict)
    fallback_transcription_service: SpeechTranscriptionService = field(
        default_factory=StubSpeechTranscriptionService
    )
    fallback_synthesis_service: SpeechSynthesisService = field(
        default_factory=StubSpeechSynthesisService
    )

    def resolve_transcription(self, request: SpeechTranscriptionRequest) -> SpeechTranscriptionService:
        return self.transcription_services.get(
            _resolve_profile_family(request.profile_id),
            self.fallback_transcription_service,
        )

    def resolve_synthesis(self, request: SpeechSynthesisRequest) -> SpeechSynthesisService:
        return self.synthesis_services.get(
            _resolve_profile_family(request.profile_id),
            self.fallback_synthesis_service,
        )


def build_speech_service_registry(app_paths: AppPaths | None = None) -> SpeechServiceRegistry:
    resolved_paths = app_paths or get_app_paths()
    return SpeechServiceRegistry(
        transcription_services={
            "faster-whisper": FasterWhisperTranscriptionAdapter(app_paths=resolved_paths),
        },
        synthesis_services={
            "gpt-sovits": GptSovitsSynthesisAdapter(app_paths=resolved_paths),
        },
    )


@dataclass(slots=True)
class DefaultSessionEventFactory:
    """Builds the current backend session-event envelope without provider coupling."""

    def build_event(
        self,
        snapshot: SessionSnapshot,
        *,
        character_id: str,
        event_type: str,
        status: str,
        reason: str | None = None,
        transcription: SpeechTranscriptionContract | None = None,
        assistant: AssistantMessageContract | None = None,
        synthesis: SpeechSynthesisContract | None = None,
    ) -> SessionEvent:
        return SessionEvent(
            schema_version=SESSION_EVENT_SCHEMA_VERSION,
            event_type=event_type,
            session_id=snapshot.session_id,
            character_id=character_id,
            status=status,
            timestamp=datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
            reason=reason,
            transcription=transcription,
            assistant=assistant,
            synthesis=synthesis,
        )


def _parse_cursor_sequence(
    stream: str,
    *,
    session_id: str,
    cursor: str | None,
) -> int:
    if cursor is None:
        return 0

    cursor_stream, separator, remainder = cursor.partition(":")
    if not separator:
        raise InvalidEventCursor(f"Invalid cursor format: {cursor}")

    cursor_session_id, separator, sequence_text = remainder.partition(":")
    if not separator:
        raise InvalidEventCursor(f"Invalid cursor format: {cursor}")

    if cursor_stream != stream or cursor_session_id != session_id:
        raise InvalidEventCursor(
            f"Cursor {cursor} does not belong to {stream} for session {session_id}."
        )

    try:
        sequence = int(sequence_text)
    except ValueError as error:
        raise InvalidEventCursor(f"Invalid cursor sequence: {cursor}") from error

    if sequence < 0:
        raise InvalidEventCursor(f"Cursor sequence must be non-negative: {cursor}")

    return sequence


def _derive_publication_status(*statuses: str) -> str:
    if any(status == "error" for status in statuses):
        return "error"

    if any(status in {"degraded", "unavailable"} for status in statuses):
        return "degraded"

    return "ready"


@dataclass(slots=True)
class DefaultTurnPipelinePublisher:
    transcription_service: SpeechTranscriptionService
    synthesis_service: SpeechSynthesisService
    session_event_factory: SessionEventFactory
    event_store: SessionEventStore

    def publish_turn(
        self,
        snapshot: SessionSnapshot,
        turn_request: BackendTurnRequest,
    ) -> BackendTurnPublication:
        session_started = self.event_store.append(
            SESSION_STREAM,
            self.session_event_factory.build_event(
                snapshot,
                character_id=turn_request.character_id,
                event_type="session.turn.started",
                status="started",
            ),
        )
        transcription = self.transcription_service.transcribe(turn_request.transcription)
        transcription_event = self.event_store.append(
            SPEECH_LIFECYCLE_STREAM,
            self.session_event_factory.build_event(
                snapshot,
                character_id=turn_request.character_id,
                event_type="transcription.status",
                status=transcription.status,
                transcription=transcription,
            ),
        )
        synthesis = self.synthesis_service.synthesize(turn_request.synthesis)
        synthesis_event = self.event_store.append(
            SPEECH_LIFECYCLE_STREAM,
            self.session_event_factory.build_event(
                snapshot,
                character_id=turn_request.character_id,
                event_type="speech.synthesis",
                status=synthesis.status,
                synthesis=synthesis,
            ),
        )
        publication_status = _derive_publication_status(transcription.status, synthesis.status)
        session_published = self.event_store.append(
            SESSION_STREAM,
            self.session_event_factory.build_event(
                snapshot,
                character_id=turn_request.character_id,
                event_type="session.turn.published",
                status=publication_status,
            ),
        )

        session_events = (session_started, session_published)
        speech_lifecycle_events = (transcription_event, synthesis_event)
        return BackendTurnPublication(
            status=publication_status,
            session_events=session_events,
            speech_lifecycle_events=speech_lifecycle_events,
            ordered_events=(
                session_started,
                transcription_event,
                synthesis_event,
                session_published,
            ),
        )


@dataclass(slots=True)
class PollingSpeechLifecycleLiveDeliveryService:
    snapshot_service: SpeechLifecycleSnapshotService

    def iter_live_events(
        self,
        snapshot: SessionSnapshot,
        *,
        character_id: str,
        cursor: str | None = None,
        poll_interval_seconds: float | None = None,
    ) -> Iterator[SpeechLifecycleEventEnvelope]:
        if poll_interval_seconds is None:
            poll_interval_seconds = get_runtime_tuning().speech_lifecycle_poll_interval_seconds
        current_cursor = cursor

        while True:
            transport_snapshot = self.snapshot_service.get_snapshot(
                snapshot,
                character_id=character_id,
                cursor=current_cursor,
            )
            if transport_snapshot.events:
                for envelope in transport_snapshot.events:
                    current_cursor = envelope.cursor
                    yield envelope
                continue

            time.sleep(poll_interval_seconds)