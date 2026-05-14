from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Protocol

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
    ) -> SpeechLifecycleTransportSnapshot:
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
    """Configuration-aware shell for future Faster-Whisper-backed transcription."""

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
        invocation_entrypoint = provider_root / "transcribe.py"
        return SpeechAdapterRuntimeBinding(
            profile_id=request.profile_id,
            modality="stt",
            family="faster-whisper",
            provider_root=provider_root,
            model_root=model_root,
            invocation_entrypoint=invocation_entrypoint,
            configured=provider_root.exists() and model_root.exists(),
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
        invocation_entrypoint = provider_root / "api_server.py"
        return SpeechAdapterRuntimeBinding(
            profile_id=request.profile_id,
            modality="tts",
            family="gpt-sovits",
            provider_root=provider_root,
            model_root=model_root,
            invocation_entrypoint=invocation_entrypoint,
            configured=provider_root.exists() and model_root.exists(),
        )


@dataclass(slots=True)
class StubSpeechLifecycleSnapshotService:
    """Deterministic read surface until live speech delivery exists."""

    transcription_service: SpeechTranscriptionService
    synthesis_service: SpeechSynthesisService
    session_event_factory: SessionEventFactory

    def get_snapshot(
        self,
        snapshot: SessionSnapshot,
        *,
        character_id: str,
    ) -> SpeechLifecycleTransportSnapshot:
        transcription = self.transcription_service.transcribe(
            SpeechTranscriptionRequest(
                audio_reference="session://speech-sample/transcription.wav",
                locale="en-US",
                transcript_hint="Hey Niko, can you wave after you answer?",
                confidence_hint=0.98,
            )
        )
        synthesis = self.synthesis_service.synthesize(
            SpeechSynthesisRequest(
                text="Sure. I can wave once I finish speaking.",
                locale="en-US",
            )
        )

        events = (
            self.session_event_factory.build_event(
                snapshot,
                character_id=character_id,
                event_type="transcription.status",
                status="final",
                transcription=transcription,
            ),
            self.session_event_factory.build_event(
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
                cursor=f"speech.lifecycle:{snapshot.session_id}:{sequence}",
                event=event,
            )
            for sequence, event in enumerate(events, start=1)
        )

        return SpeechLifecycleTransportSnapshot(
            schema_version=1,
            stream="speech.lifecycle",
            delivery="snapshot",
            session_id=snapshot.session_id,
            next_cursor=f"speech.lifecycle:{snapshot.session_id}:{len(envelopes) + 1}",
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