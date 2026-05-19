"""Frontend-facing animation playback commands for VRMA runtime.

These are thin, actionable commands the backend publishes to tell the frontend
WHAT to play and WHEN, without any bone math or engine internals.
The frontend handles all playback execution via @pixiv/three-vrm-animation.
"""
from __future__ import annotations

from dataclasses import dataclass, field


ANIMATION_COMMAND_SCHEMA_VERSION = 1


@dataclass(slots=True, frozen=True)
class PlayAnimationCommand:
    """Play a VRMA clip on the frontend."""

    command: str = "play_animation"
    clip_id: str = ""
    transition_ms: int = 200
    loop: bool = True
    layer: str = "base"
    weight: float = 1.0
    schema_version: int = ANIMATION_COMMAND_SCHEMA_VERSION


@dataclass(slots=True, frozen=True)
class StopAnimationCommand:
    """Stop a currently-playing clip."""

    command: str = "stop_animation"
    clip_id: str = ""
    fade_out_ms: int = 200
    schema_version: int = ANIMATION_COMMAND_SCHEMA_VERSION


@dataclass(slots=True, frozen=True)
class CrossfadeCommand:
    """Crossfade from one clip to another."""

    command: str = "crossfade"
    from_clip: str = ""
    to_clip: str = ""
    duration_ms: int = 300
    loop: bool = True
    layer: str = "base"
    schema_version: int = ANIMATION_COMMAND_SCHEMA_VERSION


@dataclass(slots=True, frozen=True)
class SetExpressionCommand:
    """Set a VRM blend shape expression."""

    command: str = "set_expression"
    name: str = ""
    weight: float = 0.0
    transition_ms: int = 100
    schema_version: int = ANIMATION_COMMAND_SCHEMA_VERSION


@dataclass(slots=True, frozen=True)
class SetLookAtCommand:
    """Set the VRM look-at target position."""

    command: str = "set_lookat"
    target: tuple[float, float, float] = (0.0, 1.5, 2.0)
    schema_version: int = ANIMATION_COMMAND_SCHEMA_VERSION


# Union of all frontend playback command types
FrontendAnimationCommand = (
    PlayAnimationCommand
    | StopAnimationCommand
    | CrossfadeCommand
    | SetExpressionCommand
    | SetLookAtCommand
)


@dataclass(slots=True, frozen=True)
class AnimationCommandEnvelope:
    """Envelope for streaming frontend animation commands over SSE."""

    session_id: str = ""
    character_id: str = ""
    sequence: int = 0
    command: FrontendAnimationCommand = field(default_factory=PlayAnimationCommand)
    source_command_id: str = ""
    schema_version: int = ANIMATION_COMMAND_SCHEMA_VERSION
