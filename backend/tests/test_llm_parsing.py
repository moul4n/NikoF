from __future__ import annotations

import sys
from pathlib import Path
import unittest


BACKEND_ROOT = Path(__file__).resolve().parents[1]
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from app.services import llm, llm_contracts, llm_parsing
from app.services.llm_contracts import TextGenerationInvocationError, TextGenerationRequest


class LlmContractsReexportTests(unittest.TestCase):
    def test_llm_reexports_contracts_and_parsing(self) -> None:
        self.assertIs(llm.TextGenerationRequest, llm_contracts.TextGenerationRequest)
        self.assertIs(llm.TextGenerationService, llm_contracts.TextGenerationService)
        self.assertIs(llm.TextGenerationInvocationError, llm_contracts.TextGenerationInvocationError)
        self.assertIs(llm.TextGenerationStreamEvent, llm_contracts.TextGenerationStreamEvent)
        self.assertIs(llm._normalize_structured_contract, llm_parsing._normalize_structured_contract)
        self.assertIs(llm._extract_json_object, llm_parsing._extract_json_object)

    def test_parsing_has_no_llm_cycle(self) -> None:
        for module in ("llm_contracts", "llm_parsing"):
            source = (BACKEND_ROOT / "app" / "services" / f"{module}.py").read_text(encoding="utf-8")
            self.assertNotIn("from app.services.llm import", source)
            self.assertNotIn("import app.services.llm\n", source)


class ExtractJsonObjectTests(unittest.TestCase):
    def test_plain_json(self) -> None:
        self.assertEqual(llm_parsing._extract_json_object('{"reply_text":"hi"}'), {"reply_text": "hi"})

    def test_fenced_json(self) -> None:
        raw = 'Sure!\n```json\n{"reply_text":"hi"}\n```'
        self.assertEqual(llm_parsing._extract_json_object(raw), {"reply_text": "hi"})

    def test_embedded_object_is_balanced(self) -> None:
        raw = 'prefix {"a": {"b": 1}} trailing noise'
        self.assertEqual(llm_parsing._extract_json_object(raw), {"a": {"b": 1}})

    def test_no_json_returns_none(self) -> None:
        self.assertIsNone(llm_parsing._extract_json_object("no json here"))


class NormalizeStructuredContractTests(unittest.TestCase):
    def _request(self) -> TextGenerationRequest:
        return TextGenerationRequest(prompt="p", locale="en-US")

    def test_full_payload(self) -> None:
        contract = llm_parsing._normalize_structured_contract(
            self._request(),
            {
                "reply_text": "Hello there.",
                "feeling": {"name": "happy", "intensity": 0.7},
                "animation_cues": [{"cue": "greet.wave.once", "layer": "upper"}],
                "memory_writebacks": [
                    {"namespace": "Memory", "summary": "Likes tea", "tags": ["Pref"]}
                ],
            },
        )
        self.assertEqual(contract.status, "ready")
        self.assertEqual(contract.text, "Hello there.")
        self.assertEqual(contract.feeling.name, "happy")
        self.assertEqual(contract.animation_cues[0].cue, "greet.wave.once")
        self.assertEqual(contract.memory_writebacks[0].namespace, "memory")
        self.assertEqual(contract.memory_writebacks[0].tags, ("pref",))

    def test_missing_reply_text_raises(self) -> None:
        with self.assertRaises(TextGenerationInvocationError):
            llm_parsing._normalize_structured_contract(self._request(), {"feeling": {"name": "x"}})


if __name__ == "__main__":
    unittest.main()
