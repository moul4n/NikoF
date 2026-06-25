"""Local "sky" facts for the ambient block: part of day, season, moon phase.

Pure, deterministic functions of the current local datetime — no network, no
coordinates. Lets the companion say "good morning", "you're up late", "it's
autumn", or "there's a full moon tonight". (Sunrise/sunset need geocoded
coordinates and ride the weather lookup separately.)
"""
from __future__ import annotations

from datetime import date, datetime


def part_of_day(now: datetime) -> str:
    hour = now.hour
    if 5 <= hour < 12:
        return "morning"
    if 12 <= hour < 17:
        return "afternoon"
    if 17 <= hour < 21:
        return "evening"
    return "night"


_NORTHERN_SEASON_BY_MONTH = {
    12: "winter", 1: "winter", 2: "winter",
    3: "spring", 4: "spring", 5: "spring",
    6: "summer", 7: "summer", 8: "summer",
    9: "autumn", 10: "autumn", 11: "autumn",
}
_OPPOSITE_SEASON = {"winter": "summer", "summer": "winter", "spring": "autumn", "autumn": "spring"}


def season(now: datetime, *, hemisphere: str = "north") -> str:
    northern = _NORTHERN_SEASON_BY_MONTH[now.month]
    return _OPPOSITE_SEASON[northern] if hemisphere == "south" else northern


# Mean synodic month and a known new moon (2000-01-06) for a simple phase label.
_SYNODIC_MONTH_DAYS = 29.530588853
_REFERENCE_NEW_MOON_ORDINAL = date(2000, 1, 6).toordinal()
# Upper age bound (days) -> label, in lunar order; ages past the last fall back to
# "new moon" as the cycle wraps.
_MOON_PHASES: tuple[tuple[float, str], ...] = (
    (1.84566, "new moon"),
    (5.53699, "waxing crescent"),
    (9.22831, "first quarter"),
    (12.91963, "waxing gibbous"),
    (16.61096, "full moon"),
    (20.30228, "waning gibbous"),
    (23.99361, "last quarter"),
    (27.68493, "waning crescent"),
)


def moon_phase(now: datetime) -> str:
    age = ((now.toordinal() - _REFERENCE_NEW_MOON_ORDINAL) + now.hour / 24.0) % _SYNODIC_MONTH_DAYS
    for upper_bound, label in _MOON_PHASES:
        if age < upper_bound:
            return label
    return "new moon"
