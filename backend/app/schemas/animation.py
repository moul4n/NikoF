from __future__ import annotations

from dataclasses import dataclass, field


@dataclass(slots=True, frozen=True)
class AnimationCommand:
    animation_id: str
    character_id: str
    state: str
    intensity: float = 1.0
    parameters: dict[str, str] = field(default_factory=dict)
