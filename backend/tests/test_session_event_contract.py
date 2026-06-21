from __future__ import annotations

from pathlib import Path
import sys
import unittest


BACKEND_ROOT = Path(__file__).resolve().parents[1]
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from app.api.response_builders import serialize_dataclass_payload
from app.schemas.session import (
    SESSION_EVENT_SCHEMA_VERSION,
    SessionSnapshot,
    SpeechSynthesisContract,
    SpeechTranscriptionContract,
)
from app.services.speech import DefaultSessionEventFactory


class SessionEventContractTests(unittest.TestCase):
    def test_session_event_schema_version_is_two(self) -> None:
        self.assertEqual(SESSION_EVENT_SCHEMA_VERSION, 2)

    def test_synthesis_segment_defaults_describe_single_final_segment(self) -> None:
        synthesis = SpeechSynthesisContract(
            profile_id="tts.gpt-sovits.2026-stable",
            status="ready",
            text="Hello.",
            locale="en-US",
        )
        self.assertIsNone(synthesis.utterance_id)
        self.assertEqual(synthesis.segment_index, 0)
        self.assertIsNone(synthesis.segment_count)
        self.assertTrue(synthesis.is_final)

    def test_build_event_stamps_version_two_and_preserves_segment_fields(self) -> None:
        factory = DefaultSessionEventFactory()
        snapshot = SessionSnapshot(session_id="session-1", active_character_id="niko")
        synthesis = SpeechSynthesisContract(
            profile_id="tts.gpt-sovits.2026-stable",
            status="ready",
            text="Second sentence.",
            locale="en-US",
            utterance_id="utterance-1",
            segment_index=2,
            segment_count=3,
            is_final=False,
        )

        event = factory.build_event(
            snapshot,
            character_id="niko",
            event_type="speech.synthesis",
            status="ready",
            synthesis=synthesis,
        )

        self.assertEqual(event.schema_version, 2)
        self.assertEqual(event.event_type, "speech.synthesis")
        self.assertIsNotNone(event.synthesis)
        self.assertEqual(event.synthesis.utterance_id, "utterance-1")
        self.assertEqual(event.synthesis.segment_index, 2)
        self.assertEqual(event.synthesis.segment_count, 3)
        self.assertFalse(event.synthesis.is_final)


class TranscriptionContractTests(unittest.TestCase):
    def test_default_transcription_is_final_is_none_and_omitted_when_serialized(self) -> None:
        # Phase 3: is_final defaults to None so existing (confirmed) transcripts
        # serialize byte-identically — strip_none drops the field, keeping the
        # stability baselines unchanged.
        transcription = SpeechTranscriptionContract(
            profile_id="stt.faster-whisper.medium-2026",
            status="final",
            locale="en-US",
            transcript="Hey Niko.",
            confidence=0.98,
        )
        self.assertIsNone(transcription.is_final)
        payload = serialize_dataclass_payload(transcription)
        self.assertNotIn("is_final", payload)
        self.assertEqual(payload["transcript"], "Hey Niko.")

    def test_partial_transcription_serializes_is_final_false(self) -> None:
        transcription = SpeechTranscriptionContract(
            profile_id="stt.faster-whisper.medium-2026",
            status="partial",
            locale="en-US",
            transcript="Hey Niko, can you",
            confidence=0.61,
            is_final=False,
        )
        payload = serialize_dataclass_payload(transcription)
        self.assertIn("is_final", payload)
        self.assertFalse(payload["is_final"])

    def test_build_transcript_partial_event_carries_transcription(self) -> None:
        factory = DefaultSessionEventFactory()
        snapshot = SessionSnapshot(session_id="session-1", active_character_id="niko")
        transcription = SpeechTranscriptionContract(
            profile_id="stt.faster-whisper.medium-2026",
            status="partial",
            locale="en-US",
            transcript="Hey Niko, can you",
            is_final=False,
        )

        event = factory.build_event(
            snapshot,
            character_id="niko",
            event_type="transcript.partial",
            status="partial",
            transcription=transcription,
        )

        self.assertEqual(event.schema_version, 2)
        self.assertEqual(event.event_type, "transcript.partial")
        self.assertIsNotNone(event.transcription)
        self.assertFalse(event.transcription.is_final)


if __name__ == "__main__":
    unittest.main()
