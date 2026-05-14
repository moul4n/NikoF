from __future__ import annotations

from dataclasses import dataclass

from app.schemas.character import CharacterSummary


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


@dataclass(slots=True, frozen=True)
class ActiveCharacterResponse:
    schema_version: int
    session_id: str
    lifecycle_state: str
    active_character: CharacterSummary
    session_event: SessionEvent
