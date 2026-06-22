from __future__ import annotations

import sys
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest


BACKEND_ROOT = Path(__file__).resolve().parents[1]
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from app.services.companion_memory import SqliteCompanionMemoryService
from app.services.memory_consolidation import (
    MemoryConsolidationConfig,
    run_consolidation_cycle,
)


def _service(temp_dir: str) -> SqliteCompanionMemoryService:
    service = SqliteCompanionMemoryService(Path(temp_dir) / "companion-memory.sqlite3")
    service.ensure_persona_core(persona_id="niko", display_name="Niko")
    return service


def _append_durable(service: SqliteCompanionMemoryService, summary: str) -> None:
    service.append_memory(
        persona_id="niko",
        namespace="memory",
        source="player",
        role="writeback",
        summary=summary,
        content=summary,
        salience=0.9,
        tags=("preference",),
    )


def _append_dialog(service: SqliteCompanionMemoryService, index: int) -> None:
    service.store_turn(
        persona_id="niko",
        session_id="session-01",
        locale="en-US",
        user_text=f"Tell me about widget {index}.",
        assistant_text=f"Widget {index} is interesting.",
        assistant_status="ready",
    )


_CONFIG = MemoryConsolidationConfig(
    enabled=True, idle_seconds=20.0, keep_recent=2, min_batch=2, max_batch=10
)


class DedupTests(unittest.TestCase):
    def test_identical_durable_facts_merge_and_reinforce(self) -> None:
        with TemporaryDirectory() as temp_dir:
            service = _service(temp_dir)
            for _ in range(3):
                _append_durable(service, "User loves cats.")
            _append_durable(service, "User loves dogs.")  # distinct, untouched

            removed = service.consolidate_durable_duplicates(persona_id="niko")

            context = service.get_prompt_context(persona_id="niko", query_text="cats dogs")
            summaries = [e.summary for e in context.retrieved_memories]
            cats = [e for e in context.retrieved_memories if "cats" in e.summary.lower()]

        self.assertEqual(removed, 2)
        self.assertEqual(summaries.count("User loves cats."), 1)
        self.assertEqual(cats[0].reinforcement_count, 3)
        self.assertIn("User loves dogs.", summaries)

    def test_dialog_turns_are_never_merged(self) -> None:
        with TemporaryDirectory() as temp_dir:
            service = _service(temp_dir)
            # Two identical raw dialog turns must NOT be deduped (only durable
            # writebacks are merge-eligible).
            for _ in range(2):
                service.store_turn(
                    persona_id="niko",
                    session_id="s",
                    locale="en-US",
                    user_text="the sky is blue",
                    assistant_text="indeed it is",
                    assistant_status="ready",
                )
            removed = service.consolidate_durable_duplicates(persona_id="niko")
        self.assertEqual(removed, 0)


class RollupTests(unittest.TestCase):
    def test_batch_excludes_recent_window_and_supersedes_on_rollup(self) -> None:
        with TemporaryDirectory() as temp_dir:
            service = _service(temp_dir)
            for i in range(6):
                _append_dialog(service, i)

            batch = service.select_dialog_rollup_batch(
                persona_id="niko", keep_recent=2, max_batch=10
            )
            # 6 turns × 2 entries (user+assistant) = 12 dialog entries; keep 2 most
            # recent verbatim, so 10 are eligible, oldest-first.
            self.assertEqual(len(batch), 10)
            self.assertEqual(batch[0].entry_id, min(e.entry_id for e in batch))

            stored = service.store_dialog_rollup(
                persona_id="niko",
                summary="They chatted about widgets.",
                covered_entry_ids=tuple(e.entry_id for e in batch),
            )
            self.assertIsNotNone(stored)

            # Covered turns are superseded → excluded from recall; the rollup is not.
            context = service.get_prompt_context(persona_id="niko", query_text="widget")
            ids = {e.entry_id for e in context.retrieved_memories}
            self.assertNotIn(batch[0].entry_id, ids)

            # A second batch no longer sees the rolled-up turns.
            again = service.select_dialog_rollup_batch(
                persona_id="niko", keep_recent=2, max_batch=10
            )
            self.assertEqual(len(again), 0)

    def test_empty_summary_does_not_supersede(self) -> None:
        with TemporaryDirectory() as temp_dir:
            service = _service(temp_dir)
            _append_dialog(service, 0)
            batch = service.select_dialog_rollup_batch(
                persona_id="niko", keep_recent=0, max_batch=10
            )
            result = service.store_dialog_rollup(
                persona_id="niko", summary="   ", covered_entry_ids=tuple(e.entry_id for e in batch)
            )
        self.assertIsNone(result)


class ConsolidationCycleTests(unittest.TestCase):
    def test_cycle_dedups_and_rolls_up(self) -> None:
        with TemporaryDirectory() as temp_dir:
            service = _service(temp_dir)
            for _ in range(2):
                _append_durable(service, "User is vegetarian.")
            for i in range(5):
                _append_dialog(service, i)

            calls: list[int] = []

            def fake_summarize(batch):
                calls.append(len(batch))
                return "Episodic summary of widget chatter."

            result = run_consolidation_cycle(
                service, summarize=fake_summarize, config=_CONFIG
            )

        self.assertEqual(result.personas_processed, 1)
        self.assertEqual(result.duplicates_removed, 1)
        self.assertEqual(result.rollups_created, 1)
        self.assertTrue(calls and calls[0] >= _CONFIG.min_batch)

    def test_cycle_aborts_when_no_longer_idle(self) -> None:
        with TemporaryDirectory() as temp_dir:
            service = _service(temp_dir)
            for _ in range(2):
                _append_durable(service, "User is vegetarian.")

            result = run_consolidation_cycle(
                service,
                summarize=lambda _b: "should not be called",
                config=_CONFIG,
                should_continue=lambda: False,
            )

        # Aborted before touching anything.
        self.assertEqual(result.personas_processed, 0)
        self.assertEqual(result.duplicates_removed, 0)
        self.assertEqual(result.rollups_created, 0)

    def test_below_min_batch_skips_rollup(self) -> None:
        with TemporaryDirectory() as temp_dir:
            service = _service(temp_dir)
            _append_dialog(service, 0)  # 2 entries, keep_recent=2 → 0 eligible

            called = False

            def fake_summarize(_batch):
                nonlocal called
                called = True
                return "x"

            result = run_consolidation_cycle(
                service, summarize=fake_summarize, config=_CONFIG
            )

        self.assertEqual(result.rollups_created, 0)
        self.assertFalse(called)


if __name__ == "__main__":
    unittest.main()
