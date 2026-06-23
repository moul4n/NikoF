import tempfile
import unittest
from pathlib import Path

from app.schemas.session import (
    AudioFormatMetadata,
    SessionEvent,
    SpeechSynthesisContract,
    SpeechTimingMetadata,
)
from app.services.session import (
    InvalidEventCursor,
    SqliteSessionEventStore,
    build_session_event_store,
)

STREAM = "speech.lifecycle"
SESSION = "session-test-01"


def _synthesis_event(sequence_hint: int) -> SessionEvent:
    return SessionEvent(
        schema_version=2,
        event_type="speech.synthesis",
        session_id=SESSION,
        character_id="test-vrm-01",
        status="ready",
        timestamp=f"2026-06-23T00:00:0{sequence_hint}Z",
        synthesis=SpeechSynthesisContract(
            profile_id="tts.kokoro.2026",
            status="ready",
            text=f"line {sequence_hint}",
            locale="en-US",
            audio_reference=f"/api/session/speech-artifacts/e-{sequence_hint}/audio",
            timing=SpeechTimingMetadata(
                utterance_duration_ms=1000 + sequence_hint,
                audio_format=AudioFormatMetadata(
                    container="wav", encoding="pcm_s16le", sample_rate_hz=24000, channels=1
                ),
            ),
        ),
    )


class SqliteSessionEventStoreTests(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.db_path = Path(self._tmp.name) / "session" / "events.db"
        self._stores: list[SqliteSessionEventStore] = []

    def tearDown(self) -> None:
        for store in self._stores:
            store.close()
        self._tmp.cleanup()

    def _open(self) -> SqliteSessionEventStore:
        store = SqliteSessionEventStore(self.db_path)
        self._stores.append(store)
        return store

    def test_append_assigns_sequential_cursors(self) -> None:
        store = self._open()
        first = store.append(STREAM, _synthesis_event(1))
        second = store.append(STREAM, _synthesis_event(2))
        self.assertEqual(first.sequence, 1)
        self.assertEqual(second.sequence, 2)
        self.assertEqual(first.cursor, f"{STREAM}:{SESSION}:1")
        self.assertEqual(second.event_id, "speech-lifecycle-0002")
        self.assertEqual(store.next_cursor(STREAM, session_id=SESSION), f"{STREAM}:{SESSION}:3")

    def test_read_after_cursor_returns_only_newer_events(self) -> None:
        store = self._open()
        store.append(STREAM, _synthesis_event(1))
        store.append(STREAM, _synthesis_event(2))
        after_first = store.read(STREAM, session_id=SESSION, after_cursor=f"{STREAM}:{SESSION}:1")
        self.assertEqual(len(after_first), 1)
        self.assertEqual(after_first[0].sequence, 2)
        self.assertEqual(after_first[0].event.synthesis.text, "line 2")

    def test_events_and_cursors_survive_a_restart(self) -> None:
        # Append, drop the instance (simulating a backend restart), reopen the same
        # DB file, and confirm history + cursor continuity are intact — the whole
        # point of the durable store vs the in-memory one.
        store = self._open()
        store.append(STREAM, _synthesis_event(1))
        store.append(STREAM, _synthesis_event(2))
        store.close()

        reopened = self._open()
        replayed = reopened.read(STREAM, session_id=SESSION)
        self.assertEqual([e.sequence for e in replayed], [1, 2])
        self.assertEqual(replayed[1].event.synthesis.audio_reference, "/api/session/speech-artifacts/e-2/audio")
        # A cursor handed out before the restart still resolves correctly afterwards.
        self.assertEqual(
            [e.sequence for e in reopened.read(STREAM, session_id=SESSION, after_cursor=f"{STREAM}:{SESSION}:1")],
            [2],
        )
        # The next appended event continues the sequence rather than restarting at 1.
        third = reopened.append(STREAM, _synthesis_event(3))
        self.assertEqual(third.sequence, 3)

    def test_streams_and_sessions_are_isolated(self) -> None:
        store = self._open()
        store.append(STREAM, _synthesis_event(1))
        store.append("session", _synthesis_event(1))
        self.assertEqual(len(store.read(STREAM, session_id=SESSION)), 1)
        self.assertEqual(len(store.read("session", session_id=SESSION)), 1)
        self.assertEqual(len(store.read(STREAM, session_id="other-session")), 0)

    def test_invalid_cursor_rejected(self) -> None:
        store = self._open()
        store.append(STREAM, _synthesis_event(1))
        with self.assertRaises(InvalidEventCursor):
            store.read(STREAM, session_id=SESSION, after_cursor="not-a-cursor")
        with self.assertRaises(InvalidEventCursor):
            store.read(STREAM, session_id=SESSION, after_cursor=f"{STREAM}:other-session:1")

    def test_factory_returns_in_memory_without_path_and_sqlite_with_path(self) -> None:
        from app.services.session import InMemorySessionEventStore

        self.assertIsInstance(build_session_event_store(db_path=None), InMemorySessionEventStore)
        sqlite_store = build_session_event_store(db_path=self.db_path)
        self.assertIsInstance(sqlite_store, SqliteSessionEventStore)
        sqlite_store.close()


if __name__ == "__main__":
    unittest.main()
