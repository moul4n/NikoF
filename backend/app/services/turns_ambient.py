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

When weather is enabled in the store, a cached, keyless current-weather line is
appended (app.services.weather, Open-Meteo). It is non-blocking — a stale cache
only schedules a background refresh — so weather never adds network latency to a
turn, and the line is simply omitted when unavailable / offline.
"""

from __future__ import annotations

from datetime import datetime, tzinfo
import logging
from typing import Callable
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from app.services.ambient_context import DEFAULT_AMBIENT_TIMEZONE, get_ambient_context_state
from app.services.interaction_log import get_last_interaction_state
from app.services.weather import get_weather_service


logger = logging.getLogger(__name__)

# Only surface "time since we last talked" once the gap is meaningful — within an
# active conversation it would just be noise.
_LAST_SEEN_MIN_SECONDS = 60 * 60


def format_time_since(seconds: float) -> str | None:
    """Human "X ago" for the last-seen line, or None when too recent to mention."""
    if seconds < _LAST_SEEN_MIN_SECONDS:
        return None
    if seconds < 24 * 60 * 60:
        hours = round(seconds / 3600)
        return f"{hours} hour{'s' if hours != 1 else ''} ago"
    days = int(seconds // (24 * 60 * 60))
    return f"{days} day{'s' if days != 1 else ''} ago"

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

    location = str(settings.get("location") or "")
    timezone = str(settings.get("timezone") or "") or DEFAULT_AMBIENT_TIMEZONE
    body = render_ambient_lines(now=now, location=location)

    # "Time since we last talked" — relational continuity, pure local.
    seconds_since = get_last_interaction_state().seconds_since(now.timestamp())
    if seconds_since is not None:
        last_seen = format_time_since(seconds_since)
        if last_seen:
            body.append(f"last_seen: {last_seen}")

    if settings.get("weather_enabled"):
        # Cached + non-blocking: a stale cache only schedules a background fetch,
        # so weather never adds network latency to the turn. None -> no line yet
        # / offline (the companion just won't mention weather).
        try:
            weather_line = get_weather_service().ambient_weather_line(
                location=location, timezone=timezone, now=now
            )
        except Exception:  # never let weather break a turn
            logger.debug("Ambient weather line lookup failed", exc_info=True)
            weather_line = None
        if weather_line:
            body.append(f"weather: {weather_line}")

    if not body:
        return []
    return [AMBIENT_BLOCK_HEADER, AMBIENT_ADVISORY, *body]
