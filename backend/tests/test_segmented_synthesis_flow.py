from __future__ import annotations

from pathlib import Path
import sys
import time
import unittest
from unittest.mock import patch


BACKEND_ROOT = Path(__file__).resolve().parents[1]
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from app.core import runtime_tuning
from app.schemas.session import AssistantMessageContract, SpeechSynthesisContract
from app.services.character import CharacterService, FileSystemCharacterManifestSource
from app.services.session import InMemorySessionService
from app.services.speech import DefaultSessionEventFactory, SpeechSynthesisRequest
from app.services.turns import UserTurnRequest, UserTurnServices, run_user_text_turn


THREE_SENTENCES = "First sentence here. Second sentence here. Third sentence here."


class MultiSentenceTextGenerationService:
    def generate(self, request):
        del request
        return AssistantMessageContract(
            profile_id="llm.ollama.llama3.1-8b-2026",
            status="ready",
            text=THREE_SENTENCES,
            locale="en-US",
        )


class CapturingSynthesisService:
    def synthesize(self, request: SpeechSynthesisRequest) -> SpeechSynthesisContract:
        return SpeechSynthesisContract(
            profile_id=request.profile_id,
            status="ready",
            text=request.text,
            locale=request.locale,
            audio_reference="session://speech/test.wav",
        )


def _synthesis_events(session_service, session_id):
    return [
        envelope
        for envelope in session_service.event_store.read("speech.lifecycle", session_id=session_id)
        if envelope.event.event_type == "speech.synthesis"
    ]


def _wait_for_synthesis_count(session_service, session_id, count, timeout=3.0):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        events = _synthesis_events(session_service, session_id)
        if len(events) >= count:
            return events
        time.sleep(0.01)
    return _synthesis_events(session_service, session_id)


class SegmentedSynthesisFlowTests(unittest.TestCase):
    def setUp(self) -> None:
        runtime_tuning.get_runtime_tuning.cache_clear()
        self.addCleanup(runtime_tuning.get_runtime_tuning.cache_clear)

    def _services(self, session_service):
        return UserTurnServices(
            session_service=session_service,
            character_service=CharacterService(FileSystemCharacterManifestSource()),
            text_generation_service=MultiSentenceTextGenerationService(),
            synthesis_service=CapturingSynthesisService(),
            session_event_factory=DefaultSessionEventFactory(),
        )

    def _assert_ordered_segments(self, events) -> None:
        self.assertEqual([e.event.synthesis.segment_index for e in events], [0, 1, 2])
        self.assertEqual([e.event.synthesis.is_final for e in events], [False, False, True])
        self.assertTrue(all(e.event.synthesis.segment_count == 3 for e in events))
        utterance_ids = {e.event.synthesis.utterance_id for e in events}
        self.assertEqual(len(utterance_ids), 1)
        self.assertIsNotNone(next(iter(utterance_ids)))
        # Each segment carries its own sentence text, in order.
        self.assertEqual(
            [e.event.synthesis.text for e in events],
            ["First sentence here.", "Second sentence here.", "Third sentence here."],
        )

    def test_inline_path_emits_ordered_segments(self) -> None:
        with patch.dict(runtime_tuning.os.environ, {"NIKOF_TTS_SEGMENTATION": "1"}, clear=False):
            runtime_tuning.get_runtime_tuning.cache_clear()
            session_service = InMemorySessionService(default_character_id="test-vrm-01")
            result = run_user_text_turn(
                UserTurnRequest(text="Tell me three things.", locale="en-US"),
                services=self._services(session_service),
            )
            self.assertEqual("ready", result.status)
            # Segment 0 is synthesized inline and present in the immediate result.
            inline_synth = [
                e for e in result.speech_lifecycle_events if e.event.event_type == "speech.synthesis"
            ]
            self.assertEqual(len(inline_synth), 1)
            self.assertEqual(inline_synth[0].event.synthesis.segment_index, 0)
            self.assertFalse(inline_synth[0].event.synthesis.is_final)

            events = _wait_for_synthesis_count(session_service, result.session_id, 3)
            self._assert_ordered_segments(events)

    def test_deferred_path_emits_ordered_segments(self) -> None:
        with patch.dict(runtime_tuning.os.environ, {"NIKOF_TTS_SEGMENTATION": "1"}, clear=False):
            runtime_tuning.get_runtime_tuning.cache_clear()
            session_service = InMemorySessionService(default_character_id="test-vrm-01")
            result = run_user_text_turn(
                UserTurnRequest(text="Tell me three things.", locale="en-US", defer_synthesis=True),
                services=self._services(session_service),
            )
            self.assertEqual("ready", result.status)
            # Deferred: no synthesis event in the immediate result; session event
            # placeholder carries utterance grouping.
            self.assertEqual(result.session_event.synthesis.segment_count, 3)
            self.assertEqual(result.session_event.synthesis.segment_index, 0)
            self.assertIsNotNone(result.session_event.synthesis.utterance_id)

            events = _wait_for_synthesis_count(session_service, result.session_id, 3)
            self._assert_ordered_segments(events)

    def test_flag_off_keeps_single_unsegmented_event(self) -> None:
        # No NIKOF_TTS_SEGMENTATION set -> default OFF -> one synthesis event,
        # no utterance grouping (behavior-neutral).
        with patch.dict(runtime_tuning.os.environ, {"NIKOF_TTS_SEGMENTATION": "0"}, clear=False):
            runtime_tuning.get_runtime_tuning.cache_clear()
            session_service = InMemorySessionService(default_character_id="test-vrm-01")
            result = run_user_text_turn(
                UserTurnRequest(text="Tell me three things.", locale="en-US"),
                services=self._services(session_service),
            )
            self.assertEqual("ready", result.status)
            events = _synthesis_events(session_service, result.session_id)
            self.assertEqual(len(events), 1)
            self.assertEqual(events[0].event.synthesis.text, THREE_SENTENCES)
            self.assertEqual(events[0].event.synthesis.segment_index, 0)
            self.assertTrue(events[0].event.synthesis.is_final)
            self.assertIsNone(events[0].event.synthesis.utterance_id)


if __name__ == "__main__":
    unittest.main()
