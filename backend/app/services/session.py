from __future__ import annotations

from dataclasses import dataclass, field
import json
import logging
import threading
from pathlib import Path
from typing import Protocol

from app.schemas.character import ActiveCharacterSelection
from app.schemas.session import SessionEvent, SessionSnapshot, SpeechLifecycleEventEnvelope

logger = logging.getLogger(__name__)


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
    _lock: threading.RLock = field(default_factory=threading.RLock, init=False, repr=False)

    def append(self, stream: str, event: SessionEvent) -> SpeechLifecycleEventEnvelope:
        with self._lock:
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
        with self._lock:
            after_sequence = self._parse_after_sequence(
                stream,
                session_id=session_id,
                after_cursor=after_cursor,
            )
            events = self._events_by_stream.get((stream, session_id), [])
            return tuple(event for event in events if event.sequence > after_sequence)

    def next_cursor(self, stream: str, *, session_id: str) -> str:
        with self._lock:
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
    """Session store. Lifecycle state is in-memory (ephemeral per run), but the
    operator's active-character selection is persisted to disk so it survives a
    restart regardless of which surface (control / stage) connects first."""

    default_character_id: str
    session_id: str = "session-scaffold-01"
    lifecycle_state: str = "idle"
    event_store: SessionEventStore = field(default_factory=InMemorySessionEventStore)
    # Optional: where to persist the active character. None keeps it in-memory
    # only (tests / headless construction).
    state_path: Path | None = None
    # Optional allowlist so a stale persisted id (e.g. a removed character) falls
    # back to the default instead of being restored.
    known_character_ids: frozenset[str] | None = None
    _active_character_id: str = field(init=False, repr=False)

    def __post_init__(self) -> None:
        self._active_character_id = self._restore_active_character_id() or self.default_character_id

    def _restore_active_character_id(self) -> str | None:
        if self.state_path is None:
            return None
        try:
            raw = self.state_path.read_text(encoding="utf-8")
        except (FileNotFoundError, OSError):
            return None
        try:
            character_id = json.loads(raw).get("active_character_id")
        except (ValueError, AttributeError):
            return None
        if not isinstance(character_id, str) or not character_id:
            return None
        if self.known_character_ids is not None and character_id not in self.known_character_ids:
            return None
        return character_id

    def _persist_active_character_id(self) -> None:
        if self.state_path is None:
            return
        try:
            self.state_path.parent.mkdir(parents=True, exist_ok=True)
            self.state_path.write_text(
                json.dumps({"active_character_id": self._active_character_id}),
                encoding="utf-8",
            )
        except OSError:
            logger.warning("Failed to persist active character to %s", self.state_path, exc_info=True)

    def get_snapshot(self) -> SessionSnapshot:
        return SessionSnapshot(
            session_id=self.session_id,
            active_character_id=self._active_character_id,
            lifecycle_state=self.lifecycle_state,
        )

    def set_active_character(self, selection: ActiveCharacterSelection) -> SessionSnapshot:
        self._active_character_id = selection.character_id
        self._persist_active_character_id()
        return self.get_snapshot()

    def set_lifecycle_state(self, lifecycle_state: str) -> SessionSnapshot:
        self.lifecycle_state = lifecycle_state
        return self.get_snapshot()
