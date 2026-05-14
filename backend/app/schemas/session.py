from __future__ import annotations

from dataclasses import dataclass, field

from app.schemas.character import CharacterSummary


STT_BASELINE_PROFILE_IDS = (
    "stt.faster-whisper.medium-2026",
    "stt.faster-whisper.small-2026",
)

TTS_BASELINE_PROFILE_IDS = (
    "tts.gpt-sovits.2026-stable",
)


@dataclass(slots=True, frozen=True)
class SpeechAdapterProfile:
    profile_id: str
    modality: str
    family: str
    revision: str
    quality_tier: str


@dataclass(slots=True, frozen=True)
class AudioFormatMetadata:
    container: str
    encoding: str
    sample_rate_hz: int
    channels: int


@dataclass(slots=True, frozen=True)
class SpeechSegmentRange:
    start_ms: int
    end_ms: int
    text: str | None = None


@dataclass(slots=True, frozen=True)
class SpeechPhonemeSlot:
    phoneme: str
    start_ms: int
    end_ms: int


@dataclass(slots=True, frozen=True)
class SpeechVisemeSlot:
    viseme: str
    start_ms: int
    end_ms: int


@dataclass(slots=True, frozen=True)
class SpeechTimingMetadata:
    utterance_duration_ms: int
    segment_ranges: tuple[SpeechSegmentRange, ...] = field(default_factory=tuple)
    audio_format: AudioFormatMetadata | None = None
    phoneme_slots: tuple[SpeechPhonemeSlot, ...] = field(default_factory=tuple)
    viseme_slots: tuple[SpeechVisemeSlot, ...] = field(default_factory=tuple)


@dataclass(slots=True, frozen=True)
class SpeechTranscriptionContract:
    profile_id: str
    status: str
    locale: str
    transcript: str | None = None
    confidence: float | None = None
    timing: SpeechTimingMetadata | None = None


@dataclass(slots=True, frozen=True)
class SpeechSynthesisContract:
    profile_id: str
    status: str
    text: str
    locale: str
    timing: SpeechTimingMetadata | None = None


def build_baseline_speech_adapter_profiles() -> tuple[SpeechAdapterProfile, ...]:
    return (
        SpeechAdapterProfile(
            profile_id=STT_BASELINE_PROFILE_IDS[0],
            modality="stt",
            family="faster-whisper",
            revision="2026",
            quality_tier="default",
        ),
        SpeechAdapterProfile(
            profile_id=STT_BASELINE_PROFILE_IDS[1],
            modality="stt",
            family="faster-whisper",
            revision="2026",
            quality_tier="fallback",
        ),
        SpeechAdapterProfile(
            profile_id=TTS_BASELINE_PROFILE_IDS[0],
            modality="tts",
            family="gpt-sovits",
            revision="2026-stable",
            quality_tier="default",
        ),
    )


@dataclass(slots=True, frozen=True)
class SessionSnapshot:
    session_id: str
    active_character_id: str
    lifecycle_state: str = "idle"


@dataclass(slots=True, frozen=True)
class SessionEvent:
    schema_version: int
    event_type: str
    session_id: str
    character_id: str
    status: str
    timestamp: str
    reason: str | None = None
    transcription: SpeechTranscriptionContract | None = None
    synthesis: SpeechSynthesisContract | None = None


@dataclass(slots=True, frozen=True)
class ActiveCharacterSelectionResult:
    requested_character_id: str
    applied: bool
    error_code: str | None = None
    message: str | None = None


@dataclass(slots=True, frozen=True)
class ActiveCharacterResponse:
    schema_version: int
    session_id: str
    lifecycle_state: str
    active_character: CharacterSummary
    selection: ActiveCharacterSelectionResult
    session_event: SessionEvent
