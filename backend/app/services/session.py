from __future__ import annotations

from dataclasses import dataclass, field
from typing import Protocol

from app.schemas.character import ActiveCharacterSelection
from app.schemas.session import SessionEvent, SessionSnapshot, SpeechLifecycleEventEnvelope


class InvalidEventCursor(ValueError):
    """Raised when a cursor does not target the requested stream slice."""


class SessionEventStore(Protocol):
    """Ordered canonical event storage for backend-owned session streams."""

    def append(self, stream: str, event: SessionEvent) -> SpeechLifecycleEventEnvelope:
        raise NotImplementedError

    def read(
        self,
        stream: str,
        *,
        session_id: str,
        after_cursor: str | None = None,
    ) -> tuple[SpeechLifecycleEventEnvelope, ...]:
        raise NotImplementedError

    def next_cursor(self, stream: str, *, session_id: str) -> str:
        raise NotImplementedError


@dataclass(slots=True)
class InMemorySessionEventStore:
    """Deterministic per-stream event storage until a durable provider is introduced."""

    _events_by_stream: dict[tuple[str, str], list[SpeechLifecycleEventEnvelope]] = field(
        default_factory=dict,
        init=False,
        repr=False,
    )

    def append(self, stream: str, event: SessionEvent) -> SpeechLifecycleEventEnvelope:
        key = (stream, event.session_id)
        events = self._events_by_stream.setdefault(key, [])
        sequence = len(events) + 1
        envelope = SpeechLifecycleEventEnvelope(
            event_id=f"{stream.replace('.', '-')}-{sequence:04d}",
            sequence=sequence,
            cursor=f"{stream}:{event.session_id}:{sequence}",
            event=event,
        )
        events.append(envelope)
        return envelope

    def read(
        self,
        stream: str,
        *,
        session_id: str,
        after_cursor: str | None = None,
    ) -> tuple[SpeechLifecycleEventEnvelope, ...]:
        after_sequence = self._parse_after_sequence(
            stream,
            session_id=session_id,
            after_cursor=after_cursor,
        )
        events = self._events_by_stream.get((stream, session_id), [])
        return tuple(event for event in events if event.sequence > after_sequence)

    def next_cursor(self, stream: str, *, session_id: str) -> str:
        next_sequence = len(self._events_by_stream.get((stream, session_id), [])) + 1
        return f"{stream}:{session_id}:{next_sequence}"

    def _parse_after_sequence(
        self,
        stream: str,
        *,
        session_id: str,
        after_cursor: str | None,
    ) -> int:
        if after_cursor is None:
            return 0

        cursor_stream, separator, remainder = after_cursor.partition(":")
        if not separator:
            raise InvalidEventCursor(f"Invalid cursor format: {after_cursor}")

        cursor_session_id, separator, sequence_text = remainder.partition(":")
        if not separator:
            raise InvalidEventCursor(f"Invalid cursor format: {after_cursor}")

        if cursor_stream != stream or cursor_session_id != session_id:
            raise InvalidEventCursor(
                f"Cursor {after_cursor} does not belong to {stream} for session {session_id}."
            )

        try:
            sequence = int(sequence_text)
        except ValueError as error:
            raise InvalidEventCursor(f"Invalid cursor sequence: {after_cursor}") from error

        if sequence < 0:
            raise InvalidEventCursor(f"Cursor sequence must be non-negative: {after_cursor}")

        return sequence


class SessionService(Protocol):
    """Boundary for canonical session state."""

    event_store: SessionEventStore

    def get_snapshot(self) -> SessionSnapshot:
        raise NotImplementedError

    def set_active_character(self, selection: ActiveCharacterSelection) -> SessionSnapshot:
        raise NotImplementedError

    def set_lifecycle_state(self, lifecycle_state: str) -> SessionSnapshot:
        raise NotImplementedError


@dataclass(slots=True)
class InMemorySessionService:
    """Temporary session store until orchestration and persistence are implemented."""

    default_character_id: str
    session_id: str = "session-scaffold-01"
    lifecycle_state: str = "idle"
    event_store: SessionEventStore = field(default_factory=InMemorySessionEventStore)
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

    def set_lifecycle_state(self, lifecycle_state: str) -> SessionSnapshot:
        self.lifecycle_state = lifecycle_state
        return self.get_snapshot()
