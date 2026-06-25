from __future__ import annotations

from datetime import datetime, timedelta, timezone
from pathlib import Path
import sys
import unittest


BACKEND_ROOT = Path(__file__).resolve().parents[1]
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from app.services.sky import moon_phase, part_of_day, season

_TZ = timezone(timedelta(hours=1), "BST")


def _at(year: int, month: int, day: int, hour: int) -> datetime:
    return datetime(year, month, day, hour, 0, tzinfo=_TZ)


class PartOfDayTests(unittest.TestCase):
    def test_buckets(self) -> None:
        self.assertEqual("morning", part_of_day(_at(2026, 6, 25, 8)))
        self.assertEqual("afternoon", part_of_day(_at(2026, 6, 25, 14)))
        self.assertEqual("evening", part_of_day(_at(2026, 6, 25, 19)))
        self.assertEqual("night", part_of_day(_at(2026, 6, 25, 23)))
        self.assertEqual("night", part_of_day(_at(2026, 6, 25, 3)))

    def test_boundaries(self) -> None:
        self.assertEqual("morning", part_of_day(_at(2026, 6, 25, 5)))
        self.assertEqual("afternoon", part_of_day(_at(2026, 6, 25, 12)))
        self.assertEqual("evening", part_of_day(_at(2026, 6, 25, 17)))
        self.assertEqual("night", part_of_day(_at(2026, 6, 25, 21)))


class SeasonTests(unittest.TestCase):
    def test_northern_default(self) -> None:
        self.assertEqual("winter", season(_at(2026, 1, 15, 12)))
        self.assertEqual("spring", season(_at(2026, 4, 15, 12)))
        self.assertEqual("summer", season(_at(2026, 7, 15, 12)))
        self.assertEqual("autumn", season(_at(2026, 10, 15, 12)))

    def test_southern_is_opposite(self) -> None:
        self.assertEqual("summer", season(_at(2026, 1, 15, 12), hemisphere="south"))
        self.assertEqual("winter", season(_at(2026, 7, 15, 12), hemisphere="south"))


class MoonPhaseTests(unittest.TestCase):
    def test_known_new_moon_reference(self) -> None:
        # The reference epoch itself is a new moon.
        self.assertEqual("new moon", moon_phase(datetime(2000, 1, 6, 12, tzinfo=_TZ)))

    def test_full_moon_about_two_weeks_later(self) -> None:
        # ~14.7 days after a new moon is full.
        self.assertEqual("full moon", moon_phase(datetime(2000, 1, 21, 12, tzinfo=_TZ)))

    def test_returns_a_known_label(self) -> None:
        labels = {
            "new moon", "waxing crescent", "first quarter", "waxing gibbous",
            "full moon", "waning gibbous", "last quarter", "waning crescent",
        }
        for day in range(1, 30):
            self.assertIn(moon_phase(datetime(2026, 6, day, 12, tzinfo=_TZ)), labels)


if __name__ == "__main__":
    unittest.main()
