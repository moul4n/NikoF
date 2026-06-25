from __future__ import annotations

from dataclasses import dataclass, field

try:
    from pydantic.dataclasses import dataclass as pydantic_dataclass
except ModuleNotFoundError:
    pydantic_dataclass = dataclass

from app.schemas.character import CharacterSummary


STT_BASELINE_PROFILE_IDS = (
    "stt.faster-whisper.medium-2026",
    "stt.faster-whisper.small-2026",
    "stt.parakeet-tdt.0.6b-v2-2026",
)

TTS_BASELINE_PROFILE_IDS = (
    "tts.gpt-sovits.2026-stable",
)

LLM_BASELINE_PROFILE_IDS = (
    "llm.ollama.llama3.1-8b-2026",
)

# Session-event contract version. Bumped to 2 in Phase 1 when the synthesis
# contract gained the multi-segment streaming fields (utterance_id,
# segment_index, segment_count, is_final).
SESSION_EVENT_SCHEMA_VERSION = 2


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
class SpeechMouthCueSlot:
    cue: str
    start_ms: int
    end_ms: int
    weight: float | None = None


@dataclass(slots=True, frozen=True)
class SpeechMouthCueTrack:
    track_id: str
    cue_namespace: str
    cues: tuple[SpeechMouthCueSlot, ...] = field(default_factory=tuple)


@dataclass(slots=True, frozen=True)
class SpeechLipSyncDebug:
    timing_source: str | None = None
    source_slot_type: str | None = None
    generated_track_ids: tuple[str, ...] = field(default_factory=tuple)
    phoneme_slot_count: int = 0
    viseme_slot_count: int = 0


@dataclass(slots=True, frozen=True)
class SpeechLipSyncPayload:
    default_track_id: str | None = None
    mouth_cue_tracks: tuple[SpeechMouthCueTrack, ...] = field(default_factory=tuple)
    debug: SpeechLipSyncDebug | None = None


@dataclass(slots=True, frozen=True)
class SpeechTimingMetadata:
    utterance_duration_ms: int
    segment_ranges: tuple[SpeechSegmentRange, ...] = field(default_factory=tuple)
    audio_format: AudioFormatMetadata | None = None
    phoneme_slots: tuple[SpeechPhonemeSlot, ...] = field(default_factory=tuple)
    viseme_slots: tuple[SpeechVisemeSlot, ...] = field(default_factory=tuple)
    lip_sync: SpeechLipSyncPayload | None = None


@dataclass(slots=True, frozen=True)
class SpeechTranscriptionContract:
    profile_id: str
    status: str
    locale: str
    transcript: str | None = None
    confidence: float | None = None
    timing: SpeechTimingMetadata | None = None
    # Phase 3 streaming STT. None ⇒ a confirmed, final transcript (legacy
    # behavior; serialization is unchanged because strip_none drops None).
    # Interim/partial transcripts (the `transcript.partial` event) set this
    # to False; the LLM turn still fires only on the confirmed final.
    is_final: bool | None = None


@dataclass(slots=True, frozen=True)
class SpeechSynthesisContract:
    profile_id: str
    status: str
    text: str
    locale: str
    audio_reference: str | None = None
    timing: SpeechTimingMetadata | None = None
    # Multi-segment streaming fields (Phase 1). Defaults describe a single,
    # final segment so a non-streamed utterance is semantically unchanged.
    utterance_id: str | None = None
    segment_index: int = 0
    segment_count: int | None = None
    is_final: bool = True


@dataclass(slots=True, frozen=True)
class AssistantFeelingContract:
    name: str
    intensity: float | None = None


@dataclass(slots=True, frozen=True)
class AssistantVoiceToneContract:
    style: str | None = None
    pace: str | None = None
    energy: float | None = None


@dataclass(slots=True, frozen=True)
class AssistantAnimationCueContract:
    cue: str
    layer: str = "face"
    intensity: float | None = None
    duration_ms: int | None = None


@dataclass(slots=True, frozen=True)
class AssistantMemoryWriteContract:
    namespace: str
    summary: str
    salience: float | None = None
    source: str | None = None
    tags: tuple[str, ...] = field(default_factory=tuple)


@dataclass(slots=True, frozen=True)
class AssistantMessageContract:
    profile_id: str
    status: str
    text: str
    locale: str
    thinking_summary: str | None = None
    feeling: AssistantFeelingContract | None = None
    voice_tone: AssistantVoiceToneContract | None = None
    animation_cues: tuple[AssistantAnimationCueContract, ...] = field(default_factory=tuple)
    memory_writebacks: tuple[AssistantMemoryWriteContract, ...] = field(default_factory=tuple)


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
    assistant: AssistantMessageContract | None = None
    synthesis: SpeechSynthesisContract | None = None


@dataclass(slots=True, frozen=True)
class SpeechLifecycleEventEnvelope:
    event_id: str
    sequence: int
    cursor: str
    event: SessionEvent


@dataclass(slots=True, frozen=True)
class SpeechLifecycleTransportSnapshot:
    schema_version: int
    stream: str
    delivery: str
    session_id: str
    next_cursor: str
    events: tuple[SpeechLifecycleEventEnvelope, ...] = field(default_factory=tuple)


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


@pydantic_dataclass(slots=True, frozen=True)
class OperatorCommandRequest:
    command_type: str
    text: str
    locale: str = "en-US"


@pydantic_dataclass(slots=True, frozen=True)
class SessionLifecycleUpdateRequest:
    lifecycle_state: str
    reason: str = "frontend_animation_sync"


@pydantic_dataclass(slots=True, frozen=True)
class SessionGestureRequest:
    """Operator-triggered one-shot gesture, broadcast over the session animation
    stream so every avatar-rendering client (stage window, display) plays it."""

    semantic_id: str
    reason: str = "operator_gesture"


@pydantic_dataclass(slots=True, frozen=True)
class StageBackgroundUpdateRequest:
    """Operator-selected backdrop for the stage / display window (plain,
    transparent, or a future named scene). A presentation setting, not part of
    the session animation/speech contracts."""

    background_id: str


@pydantic_dataclass(slots=True, frozen=True)
class DisplaySettingsUpdateRequest:
    """Partial update to the persisted display/wardrobe settings the stage
    window polls. Global bone-overlay + captions toggles, plus per-character
    wardrobe control values (keyed characterId -> controlId -> 0..1). A
    presentation setting, not part of the session animation/speech contracts."""

    bone_overlay: bool | None = None
    captions: bool | None = None
    always_on_top: bool | None = None
    wardrobe: dict[str, dict[str, float]] | None = None


@pydantic_dataclass(slots=True, frozen=True)
class AmbientContextUpdateRequest:
    """Partial update to the durable ambient-context settings the planner prompt
    reads each turn: an enabled flag, an optional IANA timezone (empty falls back
    to the default home zone), and an optional free-text location label. A prompt
    setting, not part of the session animation/speech contracts."""

    enabled: bool | None = None
    timezone: str | None = None
    location: str | None = None


@pydantic_dataclass(slots=True, frozen=True)
class AudioOutputUpdateRequest:
    """Operator-selected audio output device (speaker/headphones) for avatar
    speech playback. ``device_id`` null means the system default. Browsers apply
    it via HTMLAudioElement.setSinkId; the backend only persists the choice so it
    survives a restart. A presentation setting, not part of the session
    animation/speech contracts."""

    device_id: str | None = None
    device_label: str | None = None


@dataclass(slots=True, frozen=True)
class OperatorCommandResponse:
    schema_version: int
    session_id: str
    command_type: str
    character_id: str
    status: str
    session_event: SessionEvent
    next_speech_cursor: str
    speech_lifecycle_events: tuple[SpeechLifecycleEventEnvelope, ...] = field(default_factory=tuple)
