from __future__ import annotations

from pathlib import Path
import sys
import unittest


BACKEND_ROOT = Path(__file__).resolve().parents[1]
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from app.services.turn_telemetry import TurnTelemetry, get_turn_telemetry


class TurnTelemetryTests(unittest.TestCase):
    def test_records_sample_and_increments_index(self) -> None:
        telemetry = TurnTelemetry()
        sample = telemetry.record(
            input_source="manual_text",
            status="ready",
            character_id="niko",
            deferred_synthesis=False,
            total_ms=123.456,
            started_epoch=1000.0,
            llm_ms=80.0,
            tts_ms=40.0,
            memory_ms=3.0,
        )
        self.assertEqual(sample.turn_index, 1)
        self.assertEqual(sample.total_ms, 123.5)  # rounded
        self.assertEqual(sample.tts_ms, 40.0)

    def test_summary_averages_skip_missing_stages(self) -> None:
        telemetry = TurnTelemetry()
        # Deferred turn: no inline tts_ms.
        telemetry.record(
            input_source="stt",
            status="ready",
            character_id="niko",
            deferred_synthesis=True,
            total_ms=100.0,
            started_epoch=1.0,
            llm_ms=60.0,
            tts_ms=None,
            memory_ms=10.0,
        )
        # Inline turn: includes tts_ms.
        telemetry.record(
            input_source="manual_text",
            status="ready",
            character_id="niko",
            deferred_synthesis=False,
            total_ms=200.0,
            started_epoch=2.0,
            llm_ms=80.0,
            tts_ms=50.0,
            memory_ms=20.0,
        )
        summary = telemetry.summary()
        self.assertEqual(summary["samples_recorded"], 2)
        self.assertEqual(summary["window_size"], 2)
        self.assertEqual(summary["averages"]["total_ms"], 150.0)
        self.assertEqual(summary["averages"]["llm_ms"], 70.0)
        # Only one sample contributed tts_ms, so the average is that single value.
        self.assertEqual(summary["averages"]["tts_ms"], 50.0)
        self.assertEqual(summary["last"]["total_ms"], 200.0)
        self.assertEqual(len(summary["recent"]), 2)

    def test_window_is_bounded(self) -> None:
        telemetry = TurnTelemetry(window_size=3)
        for index in range(5):
            telemetry.record(
                input_source="manual_text",
                status="ready",
                character_id="niko",
                deferred_synthesis=False,
                total_ms=float(index),
                started_epoch=float(index),
            )
        summary = telemetry.summary()
        self.assertEqual(summary["samples_recorded"], 5)  # cumulative count
        self.assertEqual(summary["window_size"], 3)  # bounded buffer
        # Averages computed over cumulative sums, not just the window.
        self.assertEqual(summary["averages"]["total_ms"], 2.0)  # mean of 0..4

    def test_empty_summary_has_null_last(self) -> None:
        telemetry = TurnTelemetry()
        summary = telemetry.summary()
        self.assertEqual(summary["samples_recorded"], 0)
        self.assertIsNone(summary["last"])
        self.assertEqual(summary["recent"], [])
        self.assertIsNone(summary["averages"]["total_ms"])

    def test_singleton_accessor_is_stable(self) -> None:
        self.assertIs(get_turn_telemetry(), get_turn_telemetry())


if __name__ == "__main__":
    unittest.main()
