from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol

from app.schemas.animation import AnimationCommand


class AnimationService(Protocol):
    """Boundary for semantic animation command handling."""

    def accept_command(self, command: AnimationCommand) -> AnimationCommand:
        raise NotImplementedError


@dataclass(slots=True)
class StubAnimationService:
    """Placeholder for the future animation intent and resolution pipeline."""

    def accept_command(self, command: AnimationCommand) -> AnimationCommand:
        return command
