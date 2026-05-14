from __future__ import annotations

from dataclasses import dataclass


@dataclass(slots=True, frozen=True)
class SessionSnapshot:
    active_character_id: str
    lifecycle_state: str = "idle"
