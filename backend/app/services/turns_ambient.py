"""Ambient context block for the companion planner prompt.

Live-info Stage A (docs/LIVE_INFO_TOOLS.md). Produces a small, *advisory* block
of cheap local facts — current local time, date, day-type, and an optional
configured location — that is injected into the planner prompt every turn so the
companion is always aware of "now" without a tool call or any network access.

This module is the only place that reads the wall clock for the ambient block.
Rendering is pure and deterministic given an injected `now`, so prompt builders
stay free of I/O and unit tests / stability baselines stay stable. The wall-clock
read is isolated to `build_ambient_block` and is overridable via `clock` for
tests.

The enabled flag, timezone, and location come from the durable, control-surface-
editable store in app.services.ambient_context (read live per turn, so a UI edit
applies without a backend restart). An empty stored timezone falls back to
DEFAULT_AMBIENT_TIMEZONE (Europe/London).

Stage B (docs/LIVE_INFO_TOOLS.md) will extend the block with a last-known
weather line sourced from the Tier-1 weather tool cache; that line is omitted
here until that cache exists.
"""

from __future__ import annotations

from datetime import datetime, tzinfo
import logging
from typing import Callable
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from app.services.ambient_context import DEFAULT_AMBIENT_TIMEZONE, get_ambient_context_state


logger = logging.getLogger(__name__)

AMBIENT_BLOCK_HEADER = "[AMBIENT]"
# Phrased so a small model uses these facts when relevant and otherwise ignores
# them, rather than narrating the time on every turn.
AMBIENT_ADVISORY = "(advisory; mention these only if relevant to the user's message)"


def _resolve_timezone(name: str) -> tzinfo | None:
    """Resolve an IANA timezone name, or None to fall back to system local time."""
    if not name:
        return None
    try:
        return ZoneInfo(name)
    except (ZoneInfoNotFoundError, ValueError):
        logger.warning("Unknown ambient timezone %r; using system local time", name)
        return None


def _day_type(now: datetime) -> str:
    # Monday=0 .. Sunday=6; Saturday/Sunday are the weekend.
    return "weekend" if now.weekday() >= 5 else "weekday"


def render_ambient_lines(*, now: datetime, location: str = "") -> list[str]:
    """Render the ambient block body (no header) from an explicit `now`.

    Pure and deterministic. When `now` is timezone-aware its zone abbreviation is
    appended to the time line; a naive `now` renders without it. The location
    line is omitted when no location is configured.
    """
    stamp = now.strftime("%a %d %b %Y %H:%M")  # e.g. "Wed 25 Jun 2026 14:30"
    tz_label = now.strftime("%Z") if now.tzinfo is not None else ""
    time_line = f"local_time: {stamp}" + (f" ({tz_label})" if tz_label else "")
    lines = [time_line, f"day_type: {_day_type(now)}"]
    location = (location or "").strip()
    if location:
        lines.append(f"location: {location}")
    return lines


def build_ambient_block(*, clock: Callable[[], datetime] | None = None) -> list[str]:
    """Resolve the full ambient block (header + advisory + body) from runtime
    tuning and the wall clock, or `[]` when ambient context is disabled.

    The returned list is ready to splice into a planner prompt's line list. Pass
    `clock` (returning an aware datetime) to make the result deterministic in
    tests.
    """
    settings = get_ambient_context_state().snapshot()
    if not settings.get("enabled"):
        return []

    if clock is not None:
        now = clock()
    else:
        # Empty stored timezone falls back to the default home zone (London).
        tz = _resolve_timezone(str(settings.get("timezone") or "") or DEFAULT_AMBIENT_TIMEZONE)
        # astimezone() gives an aware datetime in the system local zone so the
        # %Z abbreviation renders even when the IANA db is unavailable.
        now = datetime.now(tz) if tz is not None else datetime.now().astimezone()

    body = render_ambient_lines(now=now, location=str(settings.get("location") or ""))
    if not body:
        return []
    return [AMBIENT_BLOCK_HEADER, AMBIENT_ADVISORY, *body]
