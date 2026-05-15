from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
import time
from typing import Iterator, Protocol

from app.core.settings import AppPaths, get_app_paths
from app.schemas.session import (
    AssistantMessageContract,
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
from app.services.session import InvalidEventCursor, SessionEventStore


SESSION_STREAM = "session"
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
                return SpeechLifecycleTransportSnapshot(
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

        return SpeechLifecycleTransportSnapshot(
            schema_version=1,
            stream=SPEECH_LIFECYCLE_STREAM,
            delivery="snapshot",
            session_id=snapshot.session_id,
            next_cursor=f"{SPEECH_LIFECYCLE_STREAM}:{snapshot.session_id}:{len(events) + 1}",
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
        assistant: AssistantMessageContract | None = None,
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
        poll_interval_seconds: float = 0.25,
    ) -> Iterator[SpeechLifecycleEventEnvelope]:
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