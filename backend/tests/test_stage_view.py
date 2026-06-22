from __future__ import annotations

import sys
import tempfile
from pathlib import Path
import unittest

BACKEND_ROOT = Path(__file__).resolve().parents[1]
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from app.services.stage_view import (
    DEFAULT_STAGE_BACKGROUND_ID,
    StageViewState,
    is_known_stage_background_id,
)


class StageViewStateTests(unittest.TestCase):
    def test_defaults_to_plain_and_sets_known_ids(self) -> None:
        state = StageViewState()
        self.assertEqual(state.background_id, DEFAULT_STAGE_BACKGROUND_ID)
        self.assertEqual(state.set_background("transparent"), "transparent")
        self.assertEqual(state.background_id, "transparent")

    def test_known_id_validation(self) -> None:
        self.assertTrue(is_known_stage_background_id("plain"))
        self.assertTrue(is_known_stage_background_id("transparent"))
        self.assertFalse(is_known_stage_background_id("nebula"))

    def test_selection_persists_and_restores_across_instances(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            state_path = Path(tmp) / "session" / "stage-view.json"
            first = StageViewState(state_path=state_path)
            first.set_background("transparent")
            # A fresh instance (simulating a restart) restores from disk.
            restored = StageViewState(state_path=state_path)
            self.assertEqual(restored.background_id, "transparent")

    def test_restore_ignores_unknown_stored_id(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            state_path = Path(tmp) / "session" / "stage-view.json"
            state_path.parent.mkdir(parents=True, exist_ok=True)
            state_path.write_text('{"background_id": "nebula"}', encoding="utf-8")
            restored = StageViewState(state_path=state_path)
            self.assertEqual(restored.background_id, DEFAULT_STAGE_BACKGROUND_ID)


if __name__ == "__main__":
    unittest.main()
