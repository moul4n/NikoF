from __future__ import annotations

import sys
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


if __name__ == "__main__":
    unittest.main()
