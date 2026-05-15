from __future__ import annotations

from dataclasses import dataclass, field


ANIMATION_SCHEMA_VERSION = 1
DEFAULT_FALLBACK_SEMANTIC_ID = "idle.default"


@dataclass(slots=True, frozen=True)
class AnimationTimingHint:
    mode: str = "immediate"
    anchor: str | None = None
    anchor_event_id: str | None = None
    offset_ms: int = 0
    max_start_delay_ms: int | None = None


@dataclass(slots=True, frozen=True)
class AnimationPolicy:
    interruptible: bool = True
    fallback_semantic_id: str = DEFAULT_FALLBACK_SEMANTIC_ID
    drop_if_late: bool = False
    on_interruption: str = "replace"
    on_missing_resolution: str = "fallback"


@dataclass(slots=True, frozen=True)
class AnimationIntent:
    schema_version: int = ANIMATION_SCHEMA_VERSION
    intent_id: str = ""
    session_id: str = ""
    character_id: str = ""
    intent_type: str = "gesture"
    semantic_id: str = ""
    source: str = "system"
    priority: str = "normal"
    requested_state: str = "enqueue"
    intensity: float = 1.0
    timing: AnimationTimingHint = field(default_factory=AnimationTimingHint)
    policy: AnimationPolicy = field(default_factory=AnimationPolicy)
    parameters: dict[str, str] = field(default_factory=dict)
    reason: str | None = None


@dataclass(slots=True, frozen=True)
class AnimationResolution:
    selected_source: str
    selected_asset_id: str
    fallback_applied: bool = False
    override_character_id: str | None = None


@dataclass(slots=True, frozen=True)
class AnimationPlayback:
    mode: str
    blend_hint: str | None = None
    expected_duration_ms: int | None = None
    loop: bool = False


@dataclass(slots=True, frozen=True)
class AnimationCommand:
    command_id: str
    intent_id: str
    session_id: str
    character_id: str
    semantic_id: str
    resolved_state: str
    resolution: AnimationResolution
    playback: AnimationPlayback
    schema_version: int = ANIMATION_SCHEMA_VERSION
    timing: AnimationTimingHint = field(default_factory=AnimationTimingHint)
    policy: AnimationPolicy = field(default_factory=AnimationPolicy)
    intensity: float = 1.0
    parameters: dict[str, str] = field(default_factory=dict)


@dataclass(slots=True, frozen=True)
class SessionAnimationSnapshot:
    session_id: str
    lifecycle_state: str
    active_character_id: str
    command: AnimationCommand
    schema_version: int = ANIMATION_SCHEMA_VERSION


@dataclass(slots=True, frozen=True)
class AnimationPlaybackEvent:
    schema_version: int = ANIMATION_SCHEMA_VERSION
    event_type: str = "animation.command"
    session_id: str = ""
    character_id: str = ""
    status: str = "queued"
    command_id: str = ""
    intent_id: str = ""
    semantic_id: str = ""
    reason: str | None = None
