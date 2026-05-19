"""Translates resolved AnimationCommand into frontend-facing playback commands.

The backend decides WHAT plays WHEN; this module converts those decisions into
the thin command protocol the VRMA frontend runtime understands.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Protocol

from app.schemas.animation import AnimationCommand, SessionAnimationSnapshot
from app.schemas.animation_commands import (
    AnimationCommandEnvelope,
    CrossfadeCommand,
    FrontendAnimationCommand,
    PlayAnimationCommand,
    StopAnimationCommand,
)


# Blend hints that map to additive/upper-body layers
_ADDITIVE_BLEND_HINTS = frozenset({"upper_body_additive", "additive"})

# Default transition durations by playback mode
_DEFAULT_TRANSITION_MS = {
    "loop": 300,
    "oneshot": 150,
}


class AnimationCommandPublisher(Protocol):
    """Boundary for publishing frontend animation commands."""

    def publish(self, envelope: AnimationCommandEnvelope) -> None:
        raise NotImplementedError


@dataclass(slots=True)
class AnimationCommandTranslator:
    """Converts backend AnimationCommand into frontend playback commands.

    Maintains minimal state to produce crossfade commands when the
    current clip changes on the base layer.
    """

    _current_base_clip: dict[str, str] = field(default_factory=dict, init=False, repr=False)
    _sequence: dict[str, int] = field(default_factory=dict, init=False, repr=False)

    def translate(self, snapshot: SessionAnimationSnapshot) -> AnimationCommandEnvelope:
        """Translate a session animation snapshot into a frontend command envelope."""
        command = snapshot.command
        frontend_cmd = self._translate_command(command)
        session_id = snapshot.session_id

        seq = self._sequence.get(session_id, 0) + 1
        self._sequence[session_id] = seq

        return AnimationCommandEnvelope(
            session_id=session_id,
            character_id=snapshot.active_character_id,
            sequence=seq,
            command=frontend_cmd,
            source_command_id=command.command_id,
        )

    def _translate_command(self, command: AnimationCommand) -> FrontendAnimationCommand:
        """Convert a resolved AnimationCommand to the appropriate frontend command."""
        clip_id = command.semantic_id
        session_id = command.session_id
        is_loop = command.playback.loop
        layer = self._resolve_layer(command)
        transition_ms = self._resolve_transition_ms(command)

        # Determine if this is a crossfade on the base layer
        if layer == "base":
            current_clip = self._current_base_clip.get(session_id)
            if current_clip and current_clip != clip_id:
                # Crossfade from current to new
                self._current_base_clip[session_id] = clip_id
                return CrossfadeCommand(
                    from_clip=current_clip,
                    to_clip=clip_id,
                    duration_ms=transition_ms,
                    loop=is_loop,
                    layer=layer,
                )
            self._current_base_clip[session_id] = clip_id

        # Stop command if resolved_state indicates stop
        if command.resolved_state == "stopped":
            return StopAnimationCommand(
                clip_id=clip_id,
                fade_out_ms=transition_ms,
            )

        # Default: play animation
        return PlayAnimationCommand(
            clip_id=clip_id,
            transition_ms=transition_ms,
            loop=is_loop,
            layer=layer,
            weight=command.intensity,
        )

    def _resolve_layer(self, command: AnimationCommand) -> str:
        """Map blend_hint to a frontend layer name."""
        hint = command.playback.blend_hint or ""
        if hint in _ADDITIVE_BLEND_HINTS:
            return "additive"
        return "base"

    def _resolve_transition_ms(self, command: AnimationCommand) -> int:
        """Determine transition duration from timing or playback defaults."""
        if command.timing.offset_ms > 0:
            return command.timing.offset_ms
        return _DEFAULT_TRANSITION_MS.get(command.playback.mode, 200)
