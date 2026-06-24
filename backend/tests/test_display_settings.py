from __future__ import annotations

import sys
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest


BACKEND_ROOT = Path(__file__).resolve().parents[1]
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from app.services.display_settings import DisplaySettingsService


class DisplaySettingsServiceTests(unittest.TestCase):
    def test_defaults(self) -> None:
        service = DisplaySettingsService()
        self.assertEqual(
            service.snapshot(),
            {"global": {"bone_overlay": False, "captions": True, "always_on_top": False}, "characters": {}},
        )

    def test_update_merges_and_clamps(self) -> None:
        service = DisplaySettingsService()
        service.update(bone_overlay=True, captions=False, wardrobe={"flare": {"dress": 0.0, "breast_size": 1.5}})

        snapshot = service.snapshot()
        self.assertTrue(snapshot["global"]["bone_overlay"])
        self.assertFalse(snapshot["global"]["captions"])
        self.assertEqual(snapshot["characters"]["flare"], {"dress": 0.0, "breast_size": 1.0})

    def test_partial_update_preserves_other_state(self) -> None:
        service = DisplaySettingsService()
        service.update(bone_overlay=True, wardrobe={"flare": {"dress": 0.0}})
        # A captions-only toggle must not wipe bone_overlay or the flare wardrobe.
        service.update(captions=False)
        # A second character's wardrobe must not drop flare's.
        service.update(wardrobe={"kohaku": {"gloves": 0.0}})

        snapshot = service.snapshot()
        self.assertTrue(snapshot["global"]["bone_overlay"])
        self.assertFalse(snapshot["global"]["captions"])
        self.assertEqual(snapshot["characters"]["flare"], {"dress": 0.0})
        self.assertEqual(snapshot["characters"]["kohaku"], {"gloves": 0.0})

    def test_ignores_malformed_input(self) -> None:
        service = DisplaySettingsService()
        service.update(bone_overlay="yes", captions=1, wardrobe={"flare": {"dress": "off"}, "bad": 5})  # type: ignore[arg-type]
        self.assertEqual(
            service.snapshot(),
            {"global": {"bone_overlay": False, "captions": True, "always_on_top": False}, "characters": {}},
        )

    def test_always_on_top_persists_and_restores(self) -> None:
        with TemporaryDirectory() as temp_dir:
            state_path = Path(temp_dir) / "session" / "display-settings.json"
            first = DisplaySettingsService(state_path=state_path)
            self.assertFalse(first.snapshot()["global"]["always_on_top"])
            first.update(always_on_top=True)

            restored = DisplaySettingsService(state_path=state_path)
            self.assertTrue(restored.snapshot()["global"]["always_on_top"])
            # A captions-only toggle must not wipe always_on_top.
            restored.update(captions=False)
            self.assertTrue(restored.snapshot()["global"]["always_on_top"])

    def test_persists_and_restores_across_instances(self) -> None:
        with TemporaryDirectory() as temp_dir:
            state_path = Path(temp_dir) / "session" / "display-settings.json"
            first = DisplaySettingsService(state_path=state_path)
            first.update(bone_overlay=True, captions=False, wardrobe={"flare": {"breast_size": 0.5}})

            restored = DisplaySettingsService(state_path=state_path)
            snapshot = restored.snapshot()
            self.assertTrue(snapshot["global"]["bone_overlay"])
            self.assertFalse(snapshot["global"]["captions"])
            self.assertEqual(snapshot["characters"]["flare"], {"breast_size": 0.5})


if __name__ == "__main__":
    unittest.main()
