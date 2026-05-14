from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timezone
import json
from pathlib import Path
import subprocess
import sys
from typing import Any, Protocol
from urllib.parse import unquote, urlparse

from app.core.settings import AppPaths, get_app_paths
from app.schemas.session import (
    AudioFormatMetadata,
    SessionEvent,
    SessionSnapshot,
    SpeechLifecycleEventEnvelope,
    SpeechLifecycleTransportSnapshot,
    SpeechPhonemeSlot,
    SpeechSegmentRange,
    SpeechSynthesisContract,
    SpeechTimingMetadata,
    SpeechTranscriptionContract,
    SpeechVisemeSlot,
    STT_BASELINE_PROFILE_IDS,
    TTS_BASELINE_PROFILE_IDS,
)
from app.services.session import SessionEventStore


SPEECH_LIFECYCLE_STREAM = "speech.lifecycle"


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


@dataclass(slots=True, frozen=True)
class BackendTurnRequest:
    character_id: str
    transcription: SpeechTranscriptionRequest
    synthesis: SpeechSynthesisRequest
    reason: str | None = "turn.pipeline"


@dataclass(slots=True, frozen=True)
class BackendTurnPublication:
    ordered_events: tuple[SpeechLifecycleEventEnvelope, ...]
    session_events: tuple[SpeechLifecycleEventEnvelope, ...]
    speech_lifecycle_events: tuple[SpeechLifecycleEventEnvelope, ...]


class TurnPipelinePublisher(Protocol):
    """Explicit backend seam for executing one speech turn and publishing canonical events."""

    def publish_turn(
        self,
        snapshot: SessionSnapshot,
        request: BackendTurnRequest,
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
    runtime_executable: Path | None = None


class ProviderInvocationError(RuntimeError):
    """Raised when a provider-local runtime cannot complete a request."""


def _select_first_existing_path(*candidates: Path) -> Path:
    for candidate in candidates:
        if candidate.exists():
            return candidate

    return candidates[0]


def _resolve_provider_python(provider_root: Path) -> Path | None:
    candidates = (
        provider_root / ".venv" / "Scripts" / "python.exe",
        provider_root / "venv" / "Scripts" / "python.exe",
        provider_root / "runtime" / "python.exe",
    )
    for candidate in candidates:
        if candidate.exists():
            return candidate

    if sys.executable:
        return Path(sys.executable)

    return None


def _looks_like_windows_path(value: str) -> bool:
    return len(value) >= 3 and value[1] == ":" and value[2] in ("\\", "/")


def _resolve_local_audio_path(audio_reference: str) -> Path | None:
    if _looks_like_windows_path(audio_reference):
        return Path(audio_reference)

    parsed = urlparse(audio_reference)
    if parsed.scheme == "file":
        raw_path = unquote(parsed.path or "")
        if raw_path.startswith("/") and _looks_like_windows_path(raw_path[1:]):
            raw_path = raw_path[1:]
        return Path(raw_path)

    if parsed.scheme:
        return None

    return Path(unquote(audio_reference))


def _coerce_int(value: Any) -> int | None:
    if isinstance(value, bool):
        return None

    if isinstance(value, int):
        return value

    if isinstance(value, float):
        return int(round(value))

    if isinstance(value, str) and value.strip():
        try:
            return int(float(value))
        except ValueError:
            return None

    return None


def _coerce_float(value: Any) -> float | None:
    if isinstance(value, bool):
        return None

    if isinstance(value, (int, float)):
        return float(value)

    if isinstance(value, str) and value.strip():
        try:
            return float(value)
        except ValueError:
            return None

    return None


def _coerce_str(value: Any) -> str | None:
    if value is None:
        return None

    if isinstance(value, str):
        stripped = value.strip()
        return stripped or None

    return str(value)


def _resolve_language_hint(locale: str) -> str | None:
    primary, _, _ = locale.partition("-")
    normalized = primary.strip().lower()
    return normalized or None


def _deserialize_audio_format(
    value: Any,
    fallback: AudioFormatMetadata | None,
) -> AudioFormatMetadata | None:
    if not isinstance(value, dict):
        return fallback

    container = _coerce_str(value.get("container")) or (fallback.container if fallback else None)
    encoding = _coerce_str(value.get("encoding")) or (fallback.encoding if fallback else None)
    sample_rate_hz = _coerce_int(value.get("sample_rate_hz"))
    channels = _coerce_int(value.get("channels"))

    if sample_rate_hz is None and fallback is not None:
        sample_rate_hz = fallback.sample_rate_hz
    if channels is None and fallback is not None:
        channels = fallback.channels

    if container is None or encoding is None or sample_rate_hz is None or channels is None:
        return fallback

    return AudioFormatMetadata(
        container=container,
        encoding=encoding,
        sample_rate_hz=sample_rate_hz,
        channels=channels,
    )


def _deserialize_segment_ranges(
    value: Any,
    fallback: tuple[SpeechSegmentRange, ...],
) -> tuple[SpeechSegmentRange, ...]:
    if not isinstance(value, list):
        return fallback

    segment_ranges: list[SpeechSegmentRange] = []
    for item in value:
        if not isinstance(item, dict):
            continue

        start_ms = _coerce_int(item.get("start_ms"))
        end_ms = _coerce_int(item.get("end_ms"))
        if start_ms is None or end_ms is None:
            continue

        segment_ranges.append(
            SpeechSegmentRange(
                start_ms=start_ms,
                end_ms=end_ms,
                text=_coerce_str(item.get("text")),
            )
        )

    return tuple(segment_ranges) if segment_ranges else fallback


def _deserialize_phoneme_slots(
    value: Any,
    fallback: tuple[SpeechPhonemeSlot, ...],
) -> tuple[SpeechPhonemeSlot, ...]:
    if not isinstance(value, list):
        return fallback

    phoneme_slots: list[SpeechPhonemeSlot] = []
    for item in value:
        if not isinstance(item, dict):
            continue

        phoneme = _coerce_str(item.get("phoneme"))
        start_ms = _coerce_int(item.get("start_ms"))
        end_ms = _coerce_int(item.get("end_ms"))
        if phoneme is None or start_ms is None or end_ms is None:
            continue

        phoneme_slots.append(
            SpeechPhonemeSlot(
                phoneme=phoneme,
                start_ms=start_ms,
                end_ms=end_ms,
            )
        )

    return tuple(phoneme_slots) if phoneme_slots else fallback


def _deserialize_viseme_slots(
    value: Any,
    fallback: tuple[SpeechVisemeSlot, ...],
) -> tuple[SpeechVisemeSlot, ...]:
    if not isinstance(value, list):
        return fallback

    viseme_slots: list[SpeechVisemeSlot] = []
    for item in value:
        if not isinstance(item, dict):
            continue

        viseme = _coerce_str(item.get("viseme"))
        start_ms = _coerce_int(item.get("start_ms"))
        end_ms = _coerce_int(item.get("end_ms"))
        if viseme is None or start_ms is None or end_ms is None:
            continue

        viseme_slots.append(
            SpeechVisemeSlot(
                viseme=viseme,
                start_ms=start_ms,
                end_ms=end_ms,
            )
        )

    return tuple(viseme_slots) if viseme_slots else fallback


def _deserialize_timing_metadata(
    value: Any,
    fallback: SpeechTimingMetadata | None,
) -> SpeechTimingMetadata | None:
    if isinstance(value, SpeechTimingMetadata):
        return value

    if not isinstance(value, dict):
        return fallback

    utterance_duration_ms = _coerce_int(value.get("utterance_duration_ms"))
    if utterance_duration_ms is None and fallback is not None:
        utterance_duration_ms = fallback.utterance_duration_ms
    if utterance_duration_ms is None:
        return fallback

    fallback_segments = fallback.segment_ranges if fallback else tuple()
    fallback_audio_format = fallback.audio_format if fallback else None
    fallback_phoneme_slots = fallback.phoneme_slots if fallback else tuple()
    fallback_viseme_slots = fallback.viseme_slots if fallback else tuple()

    return SpeechTimingMetadata(
        utterance_duration_ms=utterance_duration_ms,
        segment_ranges=_deserialize_segment_ranges(value.get("segment_ranges"), fallback_segments),
        audio_format=_deserialize_audio_format(value.get("audio_format"), fallback_audio_format),
        phoneme_slots=_deserialize_phoneme_slots(value.get("phoneme_slots"), fallback_phoneme_slots),
        viseme_slots=_deserialize_viseme_slots(value.get("viseme_slots"), fallback_viseme_slots),
    )


def _run_provider_process(
    binding: SpeechAdapterRuntimeBinding,
    payload: dict[str, Any],
) -> dict[str, Any]:
    if not binding.invocation_entrypoint.exists():
        raise ProviderInvocationError("missing-entrypoint")

    runtime_executable = binding.runtime_executable or _resolve_provider_python(binding.provider_root)
    if runtime_executable is None or not runtime_executable.exists():
        raise ProviderInvocationError("missing-runtime")

    if binding.invocation_entrypoint.suffix.lower() == ".py":
        command = [str(runtime_executable), str(binding.invocation_entrypoint)]
    else:
        command = [str(binding.invocation_entrypoint)]

    completed = subprocess.run(
        command,
        input=json.dumps(payload),
        capture_output=True,
        text=True,
        cwd=binding.provider_root,
        timeout=180,
        check=False,
    )

    if completed.returncode != 0:
        raise ProviderInvocationError("non-zero-exit")

    stdout = completed.stdout.strip()
    if not stdout:
        raise ProviderInvocationError("empty-response")

    try:
        response = json.loads(stdout)
    except json.JSONDecodeError as exc:
        raise ProviderInvocationError("invalid-json") from exc

    if not isinstance(response, dict):
        raise ProviderInvocationError("invalid-payload")

    return response


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
    """Real Faster-Whisper execution with deterministic local-runtime fallback behavior."""

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
        invocation_entrypoint = _select_first_existing_path(
            provider_root / "transcribe.py",
            provider_root / "main.py",
        )
        runtime_executable = _resolve_provider_python(provider_root)
        return SpeechAdapterRuntimeBinding(
            profile_id=request.profile_id,
            modality="stt",
            family="faster-whisper",
            provider_root=provider_root,
            model_root=model_root,
            invocation_entrypoint=invocation_entrypoint,
            configured=model_root.exists() and (invocation_entrypoint.exists() or runtime_executable is not None),
            runtime_executable=runtime_executable,
        )

    def _unavailable_contract(
        self,
        request: SpeechTranscriptionRequest,
        *,
        status: str = "unavailable",
    ) -> SpeechTranscriptionContract:
        return SpeechTranscriptionContract(
            profile_id=request.profile_id,
            status=status,
            locale=request.locale,
            transcript=request.transcript_hint,
            confidence=request.confidence_hint if request.confidence_hint is not None else 0.0,
            timing=request.timing or self.default_timing,
        )

    def _try_inline_transcription(
        self,
        request: SpeechTranscriptionRequest,
        *,
        binding: SpeechAdapterRuntimeBinding,
        audio_path: Path,
    ) -> SpeechTranscriptionContract | None:
        try:
            from faster_whisper import WhisperModel
        except ImportError:
            return None

        try:
            model = WhisperModel(str(binding.model_root), device="auto", compute_type="auto")
            segments, info = model.transcribe(
                str(audio_path),
                language=_resolve_language_hint(request.locale),
                vad_filter=True,
            )

            segment_ranges: list[SpeechSegmentRange] = []
            transcript_parts: list[str] = []
            confidence_values: list[float] = []

            for segment in segments:
                text = _coerce_str(getattr(segment, "text", None))
                start_seconds = _coerce_float(getattr(segment, "start", None))
                end_seconds = _coerce_float(getattr(segment, "end", None))
                if text is None or start_seconds is None or end_seconds is None:
                    continue

                transcript_parts.append(text)
                segment_ranges.append(
                    SpeechSegmentRange(
                        start_ms=int(round(start_seconds * 1000)),
                        end_ms=int(round(end_seconds * 1000)),
                        text=text,
                    )
                )

                probability = _coerce_float(getattr(segment, "no_speech_prob", None))
                if probability is not None:
                    confidence_values.append(max(0.0, min(1.0, 1.0 - probability)))

            transcript = " ".join(transcript_parts).strip() or request.transcript_hint
            confidence = request.confidence_hint
            if confidence is None:
                confidence = _coerce_float(getattr(info, "language_probability", None))
            if confidence is None and confidence_values:
                confidence = round(sum(confidence_values) / len(confidence_values), 3)

            last_end_ms = segment_ranges[-1].end_ms if segment_ranges else self.default_timing.utterance_duration_ms
            fallback_timing = request.timing or self.default_timing
            timing = SpeechTimingMetadata(
                utterance_duration_ms=last_end_ms,
                segment_ranges=tuple(segment_ranges) if segment_ranges else fallback_timing.segment_ranges,
                audio_format=fallback_timing.audio_format,
            )

            return SpeechTranscriptionContract(
                profile_id=request.profile_id,
                status="final",
                locale=request.locale,
                transcript=transcript,
                confidence=confidence,
                timing=timing,
            )
        except Exception:
            return None

    def _invoke_provider_transcription(
        self,
        request: SpeechTranscriptionRequest,
        *,
        binding: SpeechAdapterRuntimeBinding,
        audio_path: Path,
    ) -> SpeechTranscriptionContract:
        try:
            response = _run_provider_process(
                binding,
                {
                    "action": "transcribe",
                    "profile_id": request.profile_id,
                    "locale": request.locale,
                    "audio_path": str(audio_path),
                    "model_root": str(binding.model_root),
                    "transcript_hint": request.transcript_hint,
                    "confidence_hint": request.confidence_hint,
                },
            )
        except ProviderInvocationError:
            return self._unavailable_contract(request, status="error")

        return SpeechTranscriptionContract(
            profile_id=request.profile_id,
            status=_coerce_str(response.get("status")) or "final",
            locale=_coerce_str(response.get("locale")) or request.locale,
            transcript=_coerce_str(response.get("transcript")) or request.transcript_hint,
            confidence=_coerce_float(response.get("confidence")),
            timing=_deserialize_timing_metadata(response.get("timing"), request.timing or self.default_timing),
        )

    def transcribe(self, request: SpeechTranscriptionRequest) -> SpeechTranscriptionContract:
        binding = self.binding_for(request)
        audio_path = _resolve_local_audio_path(request.audio_reference)
        if audio_path is None or not audio_path.exists() or not binding.model_root.exists():
            return self._unavailable_contract(request)

        inline_contract = self._try_inline_transcription(
            request,
            binding=binding,
            audio_path=audio_path,
        )
        if inline_contract is not None:
            return inline_contract

        if binding.invocation_entrypoint.exists():
            return self._invoke_provider_transcription(
                request,
                binding=binding,
                audio_path=audio_path,
            )

        return self._unavailable_contract(request)


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
    """Real GPT-SoVITS execution through a local provider entrypoint."""

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
        invocation_entrypoint = _select_first_existing_path(
            provider_root / "synthesize.py",
            provider_root / "api_server.py",
        )
        runtime_executable = _resolve_provider_python(provider_root)
        return SpeechAdapterRuntimeBinding(
            profile_id=request.profile_id,
            modality="tts",
            family="gpt-sovits",
            provider_root=provider_root,
            model_root=model_root,
            invocation_entrypoint=invocation_entrypoint,
            configured=model_root.exists() and invocation_entrypoint.exists(),
            runtime_executable=runtime_executable,
        )

    def _unavailable_contract(
        self,
        request: SpeechSynthesisRequest,
        *,
        status: str = "unavailable",
    ) -> SpeechSynthesisContract:
        return SpeechSynthesisContract(
            profile_id=request.profile_id,
            status=status,
            text=request.text,
            locale=request.locale,
            timing=request.timing or self.default_timing,
        )

    def synthesize(self, request: SpeechSynthesisRequest) -> SpeechSynthesisContract:
        binding = self.binding_for(request)
        if not binding.model_root.exists() or not binding.invocation_entrypoint.exists():
            return self._unavailable_contract(request)

        try:
            response = _run_provider_process(
                binding,
                {
                    "action": "synthesize",
                    "profile_id": request.profile_id,
                    "locale": request.locale,
                    "text": request.text,
                    "model_root": str(binding.model_root),
                },
            )
        except ProviderInvocationError:
            return self._unavailable_contract(request, status="error")

        return SpeechSynthesisContract(
            profile_id=request.profile_id,
            status=_coerce_str(response.get("status")) or "ready",
            text=_coerce_str(response.get("text")) or request.text,
            locale=_coerce_str(response.get("locale")) or request.locale,
            timing=_deserialize_timing_metadata(response.get("timing"), request.timing or self.default_timing),
        )


@dataclass(slots=True)
class StubSpeechLifecycleSnapshotService:
    """Deterministic read surface until live speech delivery exists."""
    event_store: SessionEventStore

    def get_snapshot(
        self,
        snapshot: SessionSnapshot,
        *,
        character_id: str,
        cursor: str | None = None,
    ) -> SpeechLifecycleTransportSnapshot:
        envelopes = self.event_store.read(
            SPEECH_LIFECYCLE_STREAM,
            session_id=snapshot.session_id,
            after_cursor=cursor,
        )

        return SpeechLifecycleTransportSnapshot(
            schema_version=1,
            stream=SPEECH_LIFECYCLE_STREAM,
            delivery="snapshot",
            session_id=snapshot.session_id,
            next_cursor=self.event_store.next_cursor(
                SPEECH_LIFECYCLE_STREAM,
                session_id=snapshot.session_id,
            ),
            events=envelopes,
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


def _resolve_turn_publication_status(
    transcription: SpeechTranscriptionContract,
    synthesis: SpeechSynthesisContract,
) -> str:
    if transcription.status == "error" or synthesis.status == "error":
        return "error"

    if transcription.status == "unavailable" or synthesis.status == "unavailable":
        return "degraded"

    return "published"


@dataclass(slots=True)
class DefaultTurnPipelinePublisher:
    """Executes one backend-owned speech turn and appends canonical events in fixed order."""

    transcription_service: SpeechTranscriptionService
    synthesis_service: SpeechSynthesisService
    session_event_factory: SessionEventFactory
    event_store: SessionEventStore

    def publish_turn(
        self,
        snapshot: SessionSnapshot,
        request: BackendTurnRequest,
    ) -> BackendTurnPublication:
        session_started = self.event_store.append(
            "session",
            self.session_event_factory.build_event(
                snapshot,
                character_id=request.character_id,
                event_type="session.turn.started",
                status="started",
                reason=request.reason,
            ),
        )

        transcription = self.transcription_service.transcribe(request.transcription)
        transcription_event = self.event_store.append(
            SPEECH_LIFECYCLE_STREAM,
            self.session_event_factory.build_event(
                snapshot,
                character_id=request.character_id,
                event_type="transcription.status",
                status=transcription.status,
                reason=request.reason,
                transcription=transcription,
            ),
        )

        synthesis = self.synthesis_service.synthesize(request.synthesis)
        synthesis_event = self.event_store.append(
            SPEECH_LIFECYCLE_STREAM,
            self.session_event_factory.build_event(
                snapshot,
                character_id=request.character_id,
                event_type="speech.synthesis",
                status=synthesis.status,
                reason=request.reason,
                synthesis=synthesis,
            ),
        )

        session_published = self.event_store.append(
            "session",
            self.session_event_factory.build_event(
                snapshot,
                character_id=request.character_id,
                event_type="session.turn.published",
                status=_resolve_turn_publication_status(transcription, synthesis),
                reason=request.reason,
                transcription=transcription,
                synthesis=synthesis,
            ),
        )

        return BackendTurnPublication(
            ordered_events=(
                session_started,
                transcription_event,
                synthesis_event,
                session_published,
            ),
            session_events=(session_started, session_published),
            speech_lifecycle_events=(transcription_event, synthesis_event),
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
        synthesis: SpeechSynthesisContract | None = None,
    ) -> SessionEvent:
        return SessionEvent(
            schema_version=1,
            event_type=event_type,
            session_id=snapshot.session_id,
            character_id=character_id,
            status=status,
            timestamp=datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
            reason=reason,
            transcription=transcription,
            synthesis=synthesis,
        )