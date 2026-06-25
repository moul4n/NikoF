"""Operator-curated important dates (birthdays, anniversaries) for the companion.

Pure local, no network (live-info Stage A). The control surface edits a small
list; the ambient block surfaces any that are today or within the next week so
the companion can remember them ("don't forget — your mum's birthday is Sunday")
and offer greetings. Persisted to disk like the other small session stores.

Dates are treated as recurring annually (the optional `year` is the original
year, kept for reference only). Shape on disk / over the wire:
    { "entries": [ { "label": "Mum's birthday", "month": 6, "day": 28, "year": 1960 } ] }
"""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date
import json
import logging
from pathlib import Path

logger = logging.getLogger(__name__)

# Only surface dates within this many days so the block stays small + relevant.
UPCOMING_WINDOW_DAYS = 7


@dataclass(slots=True, frozen=True)
class ImportantDate:
    label: str
    month: int
    day: int
    year: int | None = None


def _coerce_entry(raw: object) -> ImportantDate | None:
    """Validate one raw entry into an ImportantDate, or None if unusable."""
    if not isinstance(raw, dict):
        return None
    label = raw.get("label")
    month = raw.get("month")
    day = raw.get("day")
    year = raw.get("year")
    if not isinstance(label, str) or not label.strip():
        return None
    if not isinstance(month, int) or isinstance(month, bool) or not (1 <= month <= 12):
        return None
    if not isinstance(day, int) or isinstance(day, bool) or not (1 <= day <= 31):
        return None
    if year is not None and (not isinstance(year, int) or isinstance(year, bool)):
        year = None
    return ImportantDate(label=label.strip(), month=month, day=day, year=year)


def _safe_date(year: int, month: int, day: int) -> date | None:
    try:
        return date(year, month, day)
    except ValueError:
        # Feb 29 in a non-leap year -> treat as Feb 28 so the date still fires.
        if month == 2 and day == 29:
            return date(year, 2, 28)
        return None


def next_occurrence(entry: ImportantDate, today: date) -> date | None:
    """The next annual occurrence on/after `today`."""
    this_year = _safe_date(today.year, entry.month, entry.day)
    if this_year is None:
        return None
    if this_year >= today:
        return this_year
    return _safe_date(today.year + 1, entry.month, entry.day)


def describe_upcoming(
    entries: list[ImportantDate], today: date, *, window_days: int = UPCOMING_WINDOW_DAYS
) -> list[str]:
    """Ambient lines for dates that are today or within the window, soonest first."""
    dated: list[tuple[int, str]] = []
    for entry in entries:
        occurrence = next_occurrence(entry, today)
        if occurrence is None:
            continue
        days = (occurrence - today).days
        if days == 0:
            dated.append((0, f"today: {entry.label}"))
        elif 0 < days <= window_days:
            plural = "s" if days != 1 else ""
            dated.append((days, f"upcoming: {entry.label} in {days} day{plural}"))
    dated.sort(key=lambda item: item[0])
    return [line for _, line in dated]


@dataclass(slots=True)
class ImportantDatesStore:
    state_path: Path | None = None
    entries: list[ImportantDate] = field(default_factory=list)

    def __post_init__(self) -> None:
        self._restore()

    def _restore(self) -> None:
        if self.state_path is None:
            return
        try:
            raw = self.state_path.read_text(encoding="utf-8")
        except (FileNotFoundError, OSError):
            return
        try:
            data = json.loads(raw)
        except ValueError:
            return
        if not isinstance(data, dict):
            return
        raw_entries = data.get("entries")
        if isinstance(raw_entries, list):
            self.entries = [entry for entry in (_coerce_entry(item) for item in raw_entries) if entry is not None]

    def _persist(self) -> None:
        if self.state_path is None:
            return
        try:
            self.state_path.parent.mkdir(parents=True, exist_ok=True)
            self.state_path.write_text(json.dumps(self.to_document()), encoding="utf-8")
        except OSError:
            logger.debug("Failed to persist important dates to %s", self.state_path, exc_info=True)

    def to_document(self) -> dict:
        return {
            "entries": [
                {"label": e.label, "month": e.month, "day": e.day, "year": e.year} for e in self.entries
            ]
        }

    def snapshot(self) -> dict:
        return self.to_document()

    def set_entries(self, raw_entries: list[object]) -> dict:
        """Replace the whole list (validated) and persist."""
        self.entries = [entry for entry in (_coerce_entry(item) for item in raw_entries) if entry is not None]
        self._persist()
        return self.to_document()


_important_dates_store: ImportantDatesStore | None = None


def get_important_dates_store() -> ImportantDatesStore:
    """Process-wide durable important-dates list, under the app data root."""
    global _important_dates_store
    if _important_dates_store is None:
        from app.core.settings import get_app_paths

        _important_dates_store = ImportantDatesStore(
            state_path=get_app_paths().local_data_root / "session" / "important-dates.json"
        )
    return _important_dates_store
