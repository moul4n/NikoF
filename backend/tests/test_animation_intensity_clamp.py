from __future__ import annotations

from pathlib import Path
import sys
import unittest


BACKEND_ROOT = Path(__file__).resolve().parents[1]
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from app.services.animation import _clamp_intensity


class ClampIntensityTests(unittest.TestCase):
    def test_none_falls_back_to_default(self) -> None:
        # AssistantAnimationCueContract.intensity is float | None; a missing
        # intensity must not crash the turn pipeline's animation snapshot build.
        self.assertEqual(_clamp_intensity(None), 1.0)

    def test_clamps_into_unit_range(self) -> None:
        self.assertEqual(_clamp_intensity(-0.5), 0.0)
        self.assertEqual(_clamp_intensity(1.5), 1.0)
        self.assertEqual(_clamp_intensity(0.4), 0.4)


if __name__ == "__main__":
    unittest.main()
