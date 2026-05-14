from __future__ import annotations

from pathlib import Path
import sys
import unittest
from typing import cast


BACKEND_ROOT = Path(__file__).resolve().parents[1]
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from app.schemas.session import SessionSnapshot, SpeechSynthesisContract, SpeechTranscriptionContract
from app.services.session import InMemorySessionEventStore
from app.services.speech import (
    BackendTurnRequest,
    DefaultSessionEventFactory,
    DefaultTurnPipelinePublisher,
    SpeechSynthesisService,
    SpeechSynthesisRequest,
    SpeechTranscriptionService,
    SpeechTranscriptionRequest,
    StubSpeechLifecycleSnapshotService,
    StubSpeechSynthesisService,
    StubSpeechTranscriptionService,
)


class StaticSpeechTranscriptionService:
    def __init__(self, contract: SpeechTranscriptionContract) -> None:
        self._contract = contract

    def transcribe(self, request: SpeechTranscriptionRequest) -> SpeechTranscriptionContract:
        return self._contract


class StaticSpeechSynthesisService:
    def __init__(self, contract: SpeechSynthesisContract) -> None:
        self._contract = contract

    def synthesize(self, request: SpeechSynthesisRequest) -> SpeechSynthesisContract:
        return self._contract


def build_turn_request() -> BackendTurnRequest:
    return BackendTurnRequest(
        character_id="test-vrm-01",
        transcription=SpeechTranscriptionRequest(
            audio_reference="session://speech-sample/transcription.wav",
            locale="en-US",
            transcript_hint="Hey Niko, can you wave after you answer?",
            confidence_hint=0.98,
        ),
        synthesis=SpeechSynthesisRequest(
            text="Sure. I can wave once I finish speaking.",
            locale="en-US",
        ),
    )


def build_transcription_contract(status: str) -> SpeechTranscriptionContract:
    return SpeechTranscriptionContract(
        profile_id="stt.faster-whisper.medium-2026",
        status=status,
        locale="en-US",
        transcript="Hey Niko, can you wave after you answer?",
        confidence=0.98,
    )


def build_synthesis_contract(status: str) -> SpeechSynthesisContract:
    return SpeechSynthesisContract(
        profile_id="tts.gpt-sovits.2026-stable",
        status=status,
        text="Sure. I can wave once I finish speaking.",
        locale="en-US",
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
    def test_snapshot_reads_do_not_seed_events_before_turn_publication(self) -> None:
        snapshot = SessionSnapshot(
            session_id="session-scaffold-01",
            active_character_id="test-vrm-01",
        )
        store = InMemorySessionEventStore()
        service = StubSpeechLifecycleSnapshotService(event_store=store)

        initial_snapshot = service.get_snapshot(snapshot, character_id="test-vrm-01")

        self.assertEqual((), initial_snapshot.events)
        self.assertEqual(
            "speech.lifecycle:session-scaffold-01:1",
            initial_snapshot.next_cursor,
        )

        publisher = DefaultTurnPipelinePublisher(
            transcription_service=StubSpeechTranscriptionService(),
            synthesis_service=StubSpeechSynthesisService(),
            session_event_factory=DefaultSessionEventFactory(),
            event_store=store,
        )
        publisher.publish_turn(snapshot, build_turn_request())

        published_snapshot = service.get_snapshot(snapshot, character_id="test-vrm-01")

        self.assertEqual(
            ["transcription.status", "speech.synthesis"],
            [event.event.event_type for event in published_snapshot.events],
        )

    def test_snapshot_reads_published_events_and_support_cursor_reads(self) -> None:
        snapshot = SessionSnapshot(
            session_id="session-scaffold-01",
            active_character_id="test-vrm-01",
        )
        store = InMemorySessionEventStore()
        publisher = DefaultTurnPipelinePublisher(
            transcription_service=StubSpeechTranscriptionService(),
            synthesis_service=StubSpeechSynthesisService(),
            session_event_factory=DefaultSessionEventFactory(),
            event_store=store,
        )
        publisher.publish_turn(snapshot, build_turn_request())
        service = StubSpeechLifecycleSnapshotService(
            event_store=store,
        )

        first_snapshot = service.get_snapshot(snapshot, character_id="test-vrm-01")
        after_first_snapshot = service.get_snapshot(
            snapshot,
            character_id="test-vrm-01",
            cursor=first_snapshot.events[0].cursor,
        )
        publisher.publish_turn(
            snapshot,
            BackendTurnRequest(
                character_id="test-vrm-02",
                transcription=build_turn_request().transcription,
                synthesis=build_turn_request().synthesis,
            ),
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


class DefaultTurnPipelinePublisherTests(unittest.TestCase):
    def test_publish_turn_appends_session_and_speech_events_in_fixed_order(self) -> None:
        snapshot = SessionSnapshot(
            session_id="session-scaffold-01",
            active_character_id="test-vrm-01",
        )
        store = InMemorySessionEventStore()
        publisher = DefaultTurnPipelinePublisher(
            transcription_service=StubSpeechTranscriptionService(),
            synthesis_service=StubSpeechSynthesisService(),
            session_event_factory=DefaultSessionEventFactory(),
            event_store=store,
        )

        publication = publisher.publish_turn(snapshot, build_turn_request())

        self.assertEqual(
            [
                "session.turn.started",
                "transcription.status",
                "speech.synthesis",
                "session.turn.published",
            ],
            [envelope.event.event_type for envelope in publication.ordered_events],
        )
        self.assertEqual(
            ["session.turn.started", "session.turn.published"],
            [
                envelope.event.event_type
                for envelope in store.read("session", session_id=snapshot.session_id)
            ],
        )
        self.assertEqual(
            ["transcription.status", "speech.synthesis"],
            [
                envelope.event.event_type
                for envelope in store.read("speech.lifecycle", session_id=snapshot.session_id)
            ],
        )

    def test_publish_turn_keeps_speech_lifecycle_order_deterministic_across_publications(self) -> None:
        snapshot = SessionSnapshot(
            session_id="session-scaffold-01",
            active_character_id="test-vrm-01",
        )
        store = InMemorySessionEventStore()
        publisher = DefaultTurnPipelinePublisher(
            transcription_service=StubSpeechTranscriptionService(),
            synthesis_service=StubSpeechSynthesisService(),
            session_event_factory=DefaultSessionEventFactory(),
            event_store=store,
        )

        first_publication = publisher.publish_turn(snapshot, build_turn_request())
        second_publication = publisher.publish_turn(snapshot, build_turn_request())

        speech_events = store.read("speech.lifecycle", session_id=snapshot.session_id)
        session_events = store.read("session", session_id=snapshot.session_id)

        self.assertEqual([1, 2], [event.sequence for event in first_publication.speech_lifecycle_events])
        self.assertEqual([3, 4], [event.sequence for event in second_publication.speech_lifecycle_events])
        self.assertEqual([1, 2, 3, 4], [event.sequence for event in speech_events])
        self.assertEqual(
            [
                "transcription.status",
                "speech.synthesis",
                "transcription.status",
                "speech.synthesis",
            ],
            [event.event.event_type for event in speech_events],
        )
        self.assertEqual(
            [
                "session.turn.started",
                "session.turn.published",
                "session.turn.started",
                "session.turn.published",
            ],
            [event.event.event_type for event in session_events],
        )

    def test_publish_turn_derives_publication_status_from_degraded_speech_outcomes(self) -> None:
        snapshot = SessionSnapshot(
            session_id="session-scaffold-01",
            active_character_id="test-vrm-01",
        )
        cases = (
            ("unavailable", "ready", "degraded"),
            ("final", "unavailable", "degraded"),
            ("error", "ready", "error"),
            ("final", "error", "error"),
        )

        for transcription_status, synthesis_status, publication_status in cases:
            with self.subTest(
                transcription_status=transcription_status,
                synthesis_status=synthesis_status,
                publication_status=publication_status,
            ):
                store = InMemorySessionEventStore()
                publisher = DefaultTurnPipelinePublisher(
                    transcription_service=cast(
                        SpeechTranscriptionService,
                        StaticSpeechTranscriptionService(
                            build_transcription_contract(transcription_status)
                        ),
                    ),
                    synthesis_service=cast(
                        SpeechSynthesisService,
                        StaticSpeechSynthesisService(build_synthesis_contract(synthesis_status)),
                    ),
                    session_event_factory=DefaultSessionEventFactory(),
                    event_store=store,
                )

                publication = publisher.publish_turn(snapshot, build_turn_request())

                self.assertEqual(
                    publication_status,
                    publication.session_events[-1].event.status,
                )
                self.assertEqual(
                    [transcription_status, synthesis_status],
                    [
                        publication.speech_lifecycle_events[0].event.status,
                        publication.speech_lifecycle_events[1].event.status,
                    ],
                )
                self.assertEqual(
                    publication_status,
                    publication.ordered_events[-1].event.status,
                )


if __name__ == "__main__":
    unittest.main()