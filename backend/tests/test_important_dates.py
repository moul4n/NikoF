from __future__ import annotations

from datetime import date
from pathlib import Path
import sys
import tempfile
import unittest


BACKEND_ROOT = Path(__file__).resolve().parents[1]
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from app.services.important_dates import (
    ImportantDate,
    ImportantDatesStore,
    describe_upcoming,
    next_occurrence,
)

_TODAY = date(2026, 6, 25)  # Thursday


class NextOccurrenceTests(unittest.TestCase):
    def test_today_and_future_this_year(self) -> None:
        self.assertEqual(date(2026, 6, 25), next_occurrence(ImportantDate("x", 6, 25), _TODAY))
        self.assertEqual(date(2026, 12, 1), next_occurrence(ImportantDate("x", 12, 1), _TODAY))

    def test_past_this_year_rolls_to_next_year(self) -> None:
        self.assertEqual(date(2027, 1, 1), next_occurrence(ImportantDate("x", 1, 1), _TODAY))

    def test_feb_29_clamps_in_non_leap_year(self) -> None:
        # 2027 is not a leap year -> Feb 29 falls back to Feb 28.
        self.assertEqual(date(2027, 2, 28), next_occurrence(ImportantDate("x", 2, 29), date(2027, 2, 1)))


class DescribeUpcomingTests(unittest.TestCase):
    def test_today_upcoming_and_beyond_window(self) -> None:
        entries = [
            ImportantDate("Anna", 6, 25),       # today
            ImportantDate("Mum", 6, 28),         # in 3 days
            ImportantDate("Tom", 6, 26),         # in 1 day
            ImportantDate("Faraway", 7, 30),     # beyond the 7-day window
        ]
        lines = describe_upcoming(entries, _TODAY)
        self.assertEqual(
            ["today: Anna", "upcoming: Tom in 1 day", "upcoming: Mum in 3 days"],
            lines,
        )

    def test_empty_when_nothing_near(self) -> None:
        self.assertEqual([], describe_upcoming([ImportantDate("Later", 9, 1)], _TODAY))


class ImportantDatesStoreTests(unittest.TestCase):
    def test_coerce_drops_invalid_entries(self) -> None:
        store = ImportantDatesStore(state_path=None)
        store.set_entries(
            [
                {"label": "Good", "month": 6, "day": 28, "year": 1960},
                {"label": "", "month": 6, "day": 1},              # blank label
                {"label": "BadMonth", "month": 13, "day": 1},      # month out of range
                {"label": "BadDay", "month": 6, "day": 0},         # day out of range
                {"month": 6, "day": 1},                            # missing label
                "not a dict",
            ]
        )
        self.assertEqual([ImportantDate("Good", 6, 28, 1960)], store.entries)

    def test_persists_and_restores(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "session" / "important-dates.json"
            first = ImportantDatesStore(state_path=path)
            first.set_entries([{"label": "Anniversary", "month": 9, "day": 14}])
            restored = ImportantDatesStore(state_path=path)
            self.assertEqual([ImportantDate("Anniversary", 9, 14, None)], restored.entries)

    def test_set_entries_replaces_whole_list(self) -> None:
        store = ImportantDatesStore(state_path=None)
        store.set_entries([{"label": "A", "month": 1, "day": 1}])
        store.set_entries([{"label": "B", "month": 2, "day": 2}])
        self.assertEqual([ImportantDate("B", 2, 2, None)], store.entries)

    def test_in_memory_store_does_not_touch_disk(self) -> None:
        store = ImportantDatesStore(state_path=None)
        store.set_entries([{"label": "A", "month": 1, "day": 1}])  # no error without a path
        self.assertEqual(1, len(store.entries))


if __name__ == "__main__":
    unittest.main()
