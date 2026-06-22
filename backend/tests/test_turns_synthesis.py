from __future__ import annotations

import sys
from pathlib import Path
import unittest


BACKEND_ROOT = Path(__file__).resolve().parents[1]
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from app.schemas.session import AssistantMessageContract
from app.services import turns, turns_synthesis


class TurnsSynthesisModuleTests(unittest.TestCase):
    def test_turns_reexports_synthesis_dispatch(self) -> None:
        for name in (
            "_build_degraded_synthesis_contract",
            "_build_queued_synthesis_contract",
            "_build_turn_synthesis_request",
            "_run_synthesis_request",
            "_append_synthesis_event",
            "_dispatch_deferred_synthesis",
            "_dispatch_segmented_synthesis",
            "_run_streamed_generation",
            "_stamp_segment_fields",
            "_new_utterance_id",
        ):
            self.assertIs(getattr(turns, name), getattr(turns_synthesis, name), name)

    def test_degraded_contract_marks_status(self) -> None:
        assistant = AssistantMessageContract(
            profile_id="llm.ollama.llama3.1-8b-2026",
            status="unavailable",
            text="Sorry, the model is offline.",
            locale="en-US",
        )
        contract = turns_synthesis._build_degraded_synthesis_contract(
            assistant, locale="en-US", voice_profile_id=None
        )
        self.assertEqual(contract.status, "unavailable")
        self.assertEqual(contract.text, "Sorry, the model is offline.")

    def test_stamp_segment_fields_derives_is_final(self) -> None:
        queued = turns_synthesis._build_queued_synthesis_contract(
            AssistantMessageContract(
                profile_id="llm.ollama.llama3.1-8b-2026",
                status="ready",
                text="Hello there.",
                locale="en-US",
            ),
            locale="en-US",
            voice_profile_id=None,
        )
        stamped = turns_synthesis._stamp_segment_fields(
            queued, utterance_id="u1", segment_index=1, segment_count=3
        )
        self.assertEqual(stamped.utterance_id, "u1")
        self.assertEqual(stamped.segment_index, 1)
        self.assertFalse(stamped.is_final)
        last = turns_synthesis._stamp_segment_fields(
            queued, utterance_id="u1", segment_index=2, segment_count=3
        )
        self.assertTrue(last.is_final)

    def test_self_contained_no_turns_import(self) -> None:
        source = (BACKEND_ROOT / "app" / "services" / "turns_synthesis.py").read_text(encoding="utf-8")
        self.assertNotIn("from app.services.turns import", source)
        self.assertNotIn("import app.services.turns\n", source)


if __name__ == "__main__":
    unittest.main()
