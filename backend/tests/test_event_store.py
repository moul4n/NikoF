from __future__ import annotations

import unittest

from app.schemas.session import SessionSnapshot
from app.services.session import InMemorySessionEventStore
from app.services.speech import (
    DefaultSessionEventFactory,
    StubSpeechLifecycleSnapshotService,
    StubSpeechSynthesisService,
    StubSpeechTranscriptionService,
)


class InMemorySessionEventStoreTests(unittest.TestCase):
    def test_append_and_cursor_reads_are_ordered(self) -> None:
        snapshot = SessionSnapshot(
            session_id="session-scaffold-01",
            active_character_id="test-vrm-01",
        )
        store = InMemorySessionEventStore()
        factory = DefaultSessionEventFactory()

        first_event = factory.build_event(
            snapshot,
            character_id="test-vrm-01",
            event_type="transcription.status",
            status="final",
        )
        second_event = factory.build_event(
            snapshot,
            character_id="test-vrm-01",
            event_type="speech.synthesis",
            status="ready",
        )

        first_envelope = store.append("speech.lifecycle", first_event)
        second_envelope = store.append("speech.lifecycle", second_event)

        all_events = store.read("speech.lifecycle", session_id=snapshot.session_id)
        after_first = store.read(
            "speech.lifecycle",
            session_id=snapshot.session_id,
            after_cursor=first_envelope.cursor,
        )

        self.assertEqual([1, 2], [event.sequence for event in all_events])
        self.assertEqual(second_envelope.cursor, after_first[0].cursor)
        self.assertEqual(
            "speech.lifecycle:session-scaffold-01:3",
            store.next_cursor("speech.lifecycle", session_id=snapshot.session_id),
        )


class StubSpeechLifecycleSnapshotServiceTests(unittest.TestCase):
    def test_snapshot_reads_seed_once_and_support_cursor_reads(self) -> None:
        snapshot = SessionSnapshot(
            session_id="session-scaffold-01",
            active_character_id="test-vrm-01",
        )
        store = InMemorySessionEventStore()
        service = StubSpeechLifecycleSnapshotService(
            transcription_service=StubSpeechTranscriptionService(),
            synthesis_service=StubSpeechSynthesisService(),
            session_event_factory=DefaultSessionEventFactory(),
            event_store=store,
        )

        first_snapshot = service.get_snapshot(snapshot, character_id="test-vrm-01")
        after_first_snapshot = service.get_snapshot(
            snapshot,
            character_id="test-vrm-01",
            cursor=first_snapshot.events[0].cursor,
        )
        changed_character_snapshot = service.get_snapshot(snapshot, character_id="test-vrm-02")

        self.assertEqual(2, len(first_snapshot.events))
        self.assertEqual(1, len(after_first_snapshot.events))
        self.assertEqual("speech.synthesis", after_first_snapshot.events[0].event.event_type)
        self.assertEqual(4, len(changed_character_snapshot.events))
        self.assertEqual("test-vrm-02", changed_character_snapshot.events[-1].event.character_id)
        self.assertEqual(
            "speech.lifecycle:session-scaffold-01:5",
            changed_character_snapshot.next_cursor,
        )


if __name__ == "__main__":
    unittest.main()