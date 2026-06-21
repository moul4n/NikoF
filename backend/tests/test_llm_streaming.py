from __future__ import annotations

from pathlib import Path
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import patch


BACKEND_ROOT = Path(__file__).resolve().parents[1]
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from app.schemas.session import LLM_BASELINE_PROFILE_IDS
from app.services import llm
from app.services.llm import (
    OllamaTextGenerationAdapter,
    StubTextGenerationService,
    TextGenerationRequest,
)


def _request() -> TextGenerationRequest:
    return TextGenerationRequest(
        prompt="say hi",
        locale="en-US",
        profile_id=LLM_BASELINE_PROFILE_IDS[0],
        expect_structured_output=True,
    )


class StubStreamTests(unittest.TestCase):
    def test_stub_yields_single_final_event(self) -> None:
        events = list(StubTextGenerationService().generate_stream(_request()))
        self.assertEqual(len(events), 1)
        self.assertIsNotNone(events[0].contract)
        self.assertEqual(events[0].contract.status, "unavailable")
        self.assertEqual(events[0].text_delta, events[0].contract.text)


class OllamaStreamTests(unittest.TestCase):
    def _run(self, lines):
        adapter = OllamaTextGenerationAdapter()
        binding = SimpleNamespace(
            configured=True,
            endpoint="http://127.0.0.1:11434/api/generate",
            model_name="llama3.1:8b",
            timeout_seconds=30,
        )
        with patch.object(OllamaTextGenerationAdapter, "binding_for", return_value=binding):
            with patch.object(llm, "_read_ndjson_stream", return_value=iter(lines)):
                return list(adapter.generate_stream(_request()))

    def test_streams_reply_text_deltas_then_final_contract(self) -> None:
        # The planner JSON streams across NDJSON lines; only the inner reply_text
        # value should surface as deltas.
        lines = [
            {"response": '{"reply_text":"Hello ', "done": False},
            {"response": 'there. How ', "done": False},
            {"response": 'are you?"}', "done": False},
            {"response": "", "done": True},
        ]
        events = self._run(lines)

        deltas = "".join(event.text_delta for event in events if event.contract is None)
        self.assertEqual(deltas, "Hello there. How are you?")

        final = [event for event in events if event.contract is not None]
        self.assertEqual(len(final), 1)
        self.assertEqual(final[0].contract.status, "ready")
        self.assertEqual(final[0].contract.text, "Hello there. How are you?")

    def test_connection_failure_yields_unavailable_contract(self) -> None:
        def boom(*_args, **_kwargs):
            raise llm.TextGenerationInvocationError("connection-failed")

        adapter = OllamaTextGenerationAdapter()
        binding = SimpleNamespace(
            configured=True,
            endpoint="http://127.0.0.1:11434/api/generate",
            model_name="llama3.1:8b",
            timeout_seconds=30,
        )
        with patch.object(OllamaTextGenerationAdapter, "binding_for", return_value=binding):
            with patch.object(llm, "_read_ndjson_stream", side_effect=boom):
                events = list(adapter.generate_stream(_request()))

        self.assertEqual(len(events), 1)
        self.assertEqual(events[0].contract.status, "unavailable")

    def test_unconfigured_binding_yields_unavailable(self) -> None:
        adapter = OllamaTextGenerationAdapter()
        binding = SimpleNamespace(configured=False, endpoint="", model_name="", timeout_seconds=30)
        with patch.object(OllamaTextGenerationAdapter, "binding_for", return_value=binding):
            events = list(adapter.generate_stream(_request()))
        self.assertEqual(len(events), 1)
        self.assertEqual(events[0].contract.status, "unavailable")


if __name__ == "__main__":
    unittest.main()
