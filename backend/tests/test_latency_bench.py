from __future__ import annotations

from pathlib import Path
import sys
import unittest


REPO_ROOT = Path(__file__).resolve().parents[2]
SCRIPTS_TESTING = REPO_ROOT / "scripts" / "testing"
if str(SCRIPTS_TESTING) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_TESTING))

import latency_bench as bench


class LatencyBenchHelperTests(unittest.TestCase):
    def test_percentile_empty_is_none(self) -> None:
        self.assertIsNone(bench._percentile([], 50))

    def test_percentile_single_value(self) -> None:
        self.assertEqual(bench._percentile([42.0], 95), 42.0)

    def test_percentile_interpolates(self) -> None:
        self.assertEqual(bench._percentile([1, 2, 3, 4, 5, 6, 7, 8, 9], 50), 5.0)
        self.assertEqual(bench._percentile([0, 100], 95), 95.0)

    def test_summarize_skips_non_numeric_and_missing(self) -> None:
        runs = [
            {"first_audio_ms": 100.0},
            {"first_audio_ms": 200.0},
            {"first_audio_ms": None},
            {},
        ]
        summary = bench._summarize(runs, "first_audio_ms")
        self.assertEqual(summary["n"], 2)
        self.assertEqual(summary["mean"], 150.0)
        self.assertEqual(summary["min"], 100.0)
        self.assertEqual(summary["max"], 200.0)

    def test_summarize_no_data_is_none(self) -> None:
        self.assertIsNone(bench._summarize([{"x": None}], "x"))


if __name__ == "__main__":
    unittest.main()
