from __future__ import annotations

from dataclasses import dataclass, field
from typing import Protocol

from app.schemas.character import ActiveCharacterSelection
from app.schemas.session import SessionSnapshot


class SessionService(Protocol):
    """Boundary for canonical session state."""

    def get_snapshot(self) -> SessionSnapshot:
        raise NotImplementedError

    def set_active_character(self, selection: ActiveCharacterSelection) -> SessionSnapshot:
        raise NotImplementedError


@dataclass(slots=True)
class InMemorySessionService:
    """Temporary session store until orchestration and persistence are implemented."""

    default_character_id: str
    session_id: str = "session-scaffold-01"
    lifecycle_state: str = "idle"
    _active_character_id: str = field(init=False, repr=False)

    def __post_init__(self) -> None:
        self._active_character_id = self.default_character_id

    def get_snapshot(self) -> SessionSnapshot:
        return SessionSnapshot(
            session_id=self.session_id,
            active_character_id=self._active_character_id,
            lifecycle_state=self.lifecycle_state,
        )

    def set_active_character(self, selection: ActiveCharacterSelection) -> SessionSnapshot:
        self._active_character_id = selection.character_id
        return self.get_snapshot()
