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
from app.services.llm import TextGenerationStreamEvent
from app.services.session import InMemorySessionService
from app.services.speech import DefaultSessionEventFactory, SpeechSynthesisRequest
from app.services.turns import UserTurnRequest, UserTurnServices, run_user_text_turn


REPLY = "First sentence here. Second sentence here. Third sentence here."


class FakeStreamingTextGenerationService:
    def generate(self, request):
        del request
        return AssistantMessageContract(
            profile_id="llm.ollama.llama3.1-8b-2026", status="ready", text=REPLY, locale="en-US"
        )

    def generate_stream(self, request):
        contract = self.generate(request)
        # Decoded reply_text deltas (the adapter would have decoded these).
        yield TextGenerationStreamEvent(text_delta="First sentence here. Second ")
        yield TextGenerationStreamEvent(text_delta="sentence here. Third sentence here.")
        yield TextGenerationStreamEvent(contract=contract)


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


def _wait_for_count(session_service, session_id, count, timeout=3.0):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        events = _synthesis_events(session_service, session_id)
        if len(events) >= count:
            return events
        time.sleep(0.01)
    return _synthesis_events(session_service, session_id)


class StreamedTurnFlowTests(unittest.TestCase):
    def setUp(self) -> None:
        runtime_tuning.get_runtime_tuning.cache_clear()
        self.addCleanup(runtime_tuning.get_runtime_tuning.cache_clear)

    def _services(self, session_service):
        return UserTurnServices(
            session_service=session_service,
            character_service=CharacterService(FileSystemCharacterManifestSource()),
            text_generation_service=FakeStreamingTextGenerationService(),
            synthesis_service=CapturingSynthesisService(),
            session_event_factory=DefaultSessionEventFactory(),
        )

    def test_streaming_dispatches_ordered_segments_with_shared_utterance(self) -> None:
        env = {"NIKOF_LLM_STREAMING": "1", "NIKOF_TTS_SEGMENTATION": "1"}
        with patch.dict(runtime_tuning.os.environ, env, clear=False):
            runtime_tuning.get_runtime_tuning.cache_clear()
            session_service = InMemorySessionService(default_character_id="test-vrm-01")
            result = run_user_text_turn(
                UserTurnRequest(text="Tell me three things.", locale="en-US", defer_synthesis=True),
                services=self._services(session_service),
            )

            self.assertEqual("ready", result.status)
            # Session event carries a queued placeholder; audio rides the lifecycle.
            self.assertEqual(result.session_event.synthesis.status, "queued")
            self.assertIsNotNone(result.session_event.synthesis.utterance_id)

            events = _wait_for_count(session_service, result.session_id, 3)
            self.assertEqual([e.event.synthesis.segment_index for e in events], [0, 1, 2])
            self.assertEqual([e.event.synthesis.is_final for e in events], [False, False, True])
            self.assertEqual(
                [e.event.synthesis.text for e in events],
                ["First sentence here.", "Second sentence here.", "Third sentence here."],
            )
            utterance_ids = {e.event.synthesis.utterance_id for e in events}
            self.assertEqual(len(utterance_ids), 1)
            self.assertTrue(next(iter(utterance_ids)).startswith("utterance:"))

    def test_streaming_off_uses_buffered_path(self) -> None:
        # Streaming flag off -> single buffered synthesis event, no utterance_id.
        env = {"NIKOF_LLM_STREAMING": "0", "NIKOF_TTS_SEGMENTATION": "0"}
        with patch.dict(runtime_tuning.os.environ, env, clear=False):
            runtime_tuning.get_runtime_tuning.cache_clear()
            session_service = InMemorySessionService(default_character_id="test-vrm-01")
            result = run_user_text_turn(
                UserTurnRequest(text="Tell me three things.", locale="en-US"),
                services=self._services(session_service),
            )
            self.assertEqual("ready", result.status)
            events = _synthesis_events(session_service, result.session_id)
            self.assertEqual(len(events), 1)
            self.assertEqual(events[0].event.synthesis.text, REPLY)
            self.assertIsNone(events[0].event.synthesis.utterance_id)


if __name__ == "__main__":
    unittest.main()
