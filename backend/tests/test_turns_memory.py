from __future__ import annotations

import sys
import time
from pathlib import Path
import unittest


BACKEND_ROOT = Path(__file__).resolve().parents[1]
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from app.schemas.session import (
    AssistantMemoryWriteContract,
    AssistantMessageContract,
)
from app.services import turns, turns_memory


def _assistant(writebacks: tuple[AssistantMemoryWriteContract, ...]) -> AssistantMessageContract:
    return AssistantMessageContract(
        profile_id="llm.ollama.llama3.1-8b-2026",
        status="ready",
        text="Sure thing.",
        locale="en-US",
        memory_writebacks=writebacks,
    )


class TurnsMemoryTests(unittest.TestCase):
    def test_turns_reexports_memory_helpers(self) -> None:
        self.assertIs(turns._dispatch_async_memory_store, turns_memory._dispatch_async_memory_store)
        self.assertIs(turns._extract_memory_writebacks, turns_memory._extract_memory_writebacks)
        self.assertIs(turns._writebacks_to_dicts, turns_memory._writebacks_to_dicts)

    def test_writebacks_to_dicts_maps_fields(self) -> None:
        assistant = _assistant(
            (
                AssistantMemoryWriteContract(
                    namespace="memory",
                    summary="Likes tea.",
                    salience=0.8,
                    source="player",
                    tags=("preference",),
                ),
            )
        )
        result = turns_memory._writebacks_to_dicts(assistant)
        self.assertEqual(len(result), 1)
        self.assertEqual(result[0]["namespace"], "memory")
        self.assertEqual(result[0]["summary"], "Likes tea.")
        self.assertEqual(result[0]["tags"], ["preference"])

    def test_writebacks_to_dicts_empty(self) -> None:
        self.assertEqual(turns_memory._writebacks_to_dicts(_assistant(())), ())

    def test_dispatch_async_memory_store_persists_in_background(self) -> None:
        captured: dict[str, object] = {}

        class _Memory:
            def store_turn(self, **kwargs: object) -> None:
                captured.update(kwargs)

        class _Services:
            memory_service = _Memory()
            text_generation_service = object()

        snapshot = type("S", (), {"session_id": "s1"})()
        turns_memory._dispatch_async_memory_store(
            services=_Services(),
            snapshot=snapshot,
            character_id="niko",
            locale="en-US",
            user_text="hi",
            assistant=_assistant(()),
            extract_writebacks=False,  # no LLM call
        )
        for _ in range(200):
            if captured:
                break
            time.sleep(0.005)
        self.assertEqual(captured.get("persona_id"), "niko")
        self.assertEqual(captured.get("assistant_text"), "Sure thing.")


if __name__ == "__main__":
    unittest.main()
