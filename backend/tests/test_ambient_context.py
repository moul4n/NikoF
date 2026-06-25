from __future__ import annotations

from datetime import datetime, timedelta, timezone
from pathlib import Path
import sys
import unittest


BACKEND_ROOT = Path(__file__).resolve().parents[1]
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from app.services.turns import _build_lean_reply_prompt, _build_spoken_reply_prompt
from app.services import ambient_context, important_dates, interaction_log, turns_ambient, weather
from app.services.ambient_context import AmbientContextState
from app.services.important_dates import ImportantDate, ImportantDatesStore
from app.services.interaction_log import LastInteractionState
from app.services.turns_ambient import (
    AMBIENT_BLOCK_HEADER,
    build_ambient_block,
    format_time_since,
    render_ambient_lines,
)


class _FakeWeatherService:
    """Stand-in for the weather service: records the query inputs and returns a
    canned line (or None) without any network."""

    def __init__(self, line: str | None) -> None:
        self.line = line
        self.calls: list[tuple[str, str]] = []

    def ambient_weather_line(self, *, location: str, timezone: str, now) -> str | None:
        self.calls.append((location, timezone))
        return self.line


def _zoneinfo_available(key: str) -> bool:
    """IANA zones need a tz database, which Windows lacks unless the `tzdata`
    package is installed. Tests of the resolved-override path skip when absent."""
    try:
        from zoneinfo import ZoneInfo

        ZoneInfo(key)
        return True
    except Exception:
        return False


# A Thursday (weekday) and a Saturday (weekend) in June 2026, both aware. Fixed
# offset (named "BST") so the fixtures need no IANA tz database.
_BST = timezone(timedelta(hours=1), "BST")
_WEEKDAY = datetime(2026, 6, 25, 14, 30, tzinfo=_BST)
_WEEKEND = datetime(2026, 6, 27, 9, 5, tzinfo=_BST)


class _VoiceProfile:
    style = "gentle"
    notes = "warm"
    profile_id = "tts.gpt-sovits.2026-stable"


class RenderAmbientLinesTests(unittest.TestCase):
    def test_weekday_vs_weekend_day_type(self) -> None:
        weekday = render_ambient_lines(now=_WEEKDAY)
        weekend = render_ambient_lines(now=_WEEKEND)
        self.assertIn("day_type: weekday", weekday)
        self.assertIn("day_type: weekend", weekend)

    def test_time_line_present_with_year_and_tz_when_aware(self) -> None:
        lines = render_ambient_lines(now=_WEEKDAY)
        time_line = next(line for line in lines if line.startswith("local_time:"))
        self.assertIn("2026", time_line)
        # Aware datetime renders a parenthesised zone abbreviation.
        self.assertIn("(", time_line)

    def test_naive_datetime_omits_tz_label(self) -> None:
        naive = datetime(2026, 6, 25, 14, 30)
        time_line = next(
            line for line in render_ambient_lines(now=naive) if line.startswith("local_time:")
        )
        self.assertNotIn("(", time_line)

    def test_location_included_only_when_set(self) -> None:
        self.assertNotIn("location:", " ".join(render_ambient_lines(now=_WEEKDAY)))
        self.assertIn(
            "location: Brighton, UK",
            render_ambient_lines(now=_WEEKDAY, location="Brighton, UK"),
        )
        # Whitespace-only location is dropped.
        self.assertNotIn(
            "location:", " ".join(render_ambient_lines(now=_WEEKDAY, location="   "))
        )


class FormatTimeSinceTests(unittest.TestCase):
    def test_recent_returns_none(self) -> None:
        self.assertIsNone(format_time_since(0))
        self.assertIsNone(format_time_since(59 * 60))

    def test_hours_and_days_with_pluralization(self) -> None:
        self.assertEqual("1 hour ago", format_time_since(60 * 60))
        self.assertEqual("2 hours ago", format_time_since(2 * 60 * 60))
        self.assertEqual("1 day ago", format_time_since(24 * 60 * 60))
        self.assertEqual("3 days ago", format_time_since(3 * 24 * 60 * 60))


class BuildAmbientBlockTests(unittest.TestCase):
    """build_ambient_block reads the durable ambient-context store live. Override
    the process-wide singleton with an in-memory state (no disk) per test."""

    def _set_store(
        self,
        *,
        enabled: bool,
        timezone: str = "Europe/London",
        location: str = "",
        weather_enabled: bool = False,
        sky_enabled: bool = False,
    ) -> None:
        ambient_context._ambient_context_state = AmbientContextState(
            state_path=None,
            enabled=enabled,
            timezone=timezone,
            location=location,
            weather_enabled=weather_enabled,
            sky_enabled=sky_enabled,
        )

    def _set_weather(self, line: str | None) -> _FakeWeatherService:
        fake = _FakeWeatherService(line)
        weather._weather_service = fake
        return fake

    def _set_last_interaction(self, last_epoch: float | None) -> None:
        interaction_log._last_interaction_state = LastInteractionState(state_path=None, last_epoch=last_epoch)

    def _set_important_dates(self, entries: list[ImportantDate]) -> None:
        store = ImportantDatesStore(state_path=None)
        store.entries = list(entries)
        important_dates._important_dates_store = store

    def setUp(self) -> None:
        self.addCleanup(setattr, ambient_context, "_ambient_context_state", None)
        self.addCleanup(setattr, weather, "_weather_service", None)
        self.addCleanup(setattr, interaction_log, "_last_interaction_state", None)
        self.addCleanup(setattr, important_dates, "_important_dates_store", None)
        # Defaults: no prior interaction and no important dates, so those lines are
        # absent unless a test sets them. (A None singleton would otherwise read
        # the real data root.)
        self._set_last_interaction(None)
        self._set_important_dates([])

    def test_disabled_returns_empty(self) -> None:
        self._set_store(enabled=False)
        self.assertEqual(build_ambient_block(clock=lambda: _WEEKDAY), [])

    def test_enabled_returns_header_advisory_and_body(self) -> None:
        self._set_store(enabled=True, location="Brighton, UK")
        block = build_ambient_block(clock=lambda: _WEEKDAY)
        self.assertEqual(block[0], AMBIENT_BLOCK_HEADER)
        joined = "\n".join(block)
        self.assertIn("advisory", joined)
        self.assertIn("day_type: weekday", joined)
        self.assertIn("location: Brighton, UK", joined)

    def test_unknown_timezone_falls_back_without_raising(self) -> None:
        self._set_store(enabled=True, timezone="Not/AZone")
        # No clock override -> exercises the real wall-clock path + tz fallback.
        block = build_ambient_block()
        self.assertEqual(block[0], AMBIENT_BLOCK_HEADER)
        self.assertTrue(any(line.startswith("local_time:") for line in block))

    def test_empty_timezone_falls_back_to_default_without_raising(self) -> None:
        # A cleared timezone falls back to the default home zone (Europe/London).
        self._set_store(enabled=True, timezone="")
        block = build_ambient_block()
        self.assertTrue(any(line.startswith("local_time:") for line in block))

    def test_weather_line_appended_when_enabled_and_available(self) -> None:
        self._set_store(enabled=True, location="Brighton, UK", weather_enabled=True)
        fake = self._set_weather("14°C, light rain (as of 14:22)")
        block = build_ambient_block(clock=lambda: _WEEKDAY)
        self.assertIn("weather: 14°C, light rain (as of 14:22)", block)
        # The store's location + timezone are passed through to the weather lookup.
        self.assertEqual([("Brighton, UK", "Europe/London")], fake.calls)

    def test_no_weather_line_when_weather_disabled(self) -> None:
        self._set_store(enabled=True, location="Brighton, UK", weather_enabled=False)
        fake = self._set_weather("14°C, light rain (as of 14:22)")
        block = build_ambient_block(clock=lambda: _WEEKDAY)
        self.assertFalse(any(line.startswith("weather:") for line in block))
        self.assertEqual([], fake.calls)  # weather service untouched when disabled

    def test_no_weather_line_when_unavailable(self) -> None:
        self._set_store(enabled=True, location="Brighton, UK", weather_enabled=True)
        self._set_weather(None)  # not yet cached / offline
        block = build_ambient_block(clock=lambda: _WEEKDAY)
        self.assertFalse(any(line.startswith("weather:") for line in block))

    def test_last_seen_absent_with_no_prior_interaction(self) -> None:
        self._set_store(enabled=True)
        self._set_last_interaction(None)
        block = build_ambient_block(clock=lambda: _WEEKDAY)
        self.assertFalse(any(line.startswith("last_seen:") for line in block))

    def test_last_seen_absent_when_recent(self) -> None:
        # A gap under an hour is conversational noise -> omitted.
        self._set_store(enabled=True)
        self._set_last_interaction(_WEEKDAY.timestamp() - 5 * 60)
        block = build_ambient_block(clock=lambda: _WEEKDAY)
        self.assertFalse(any(line.startswith("last_seen:") for line in block))

    def test_last_seen_shows_days(self) -> None:
        self._set_store(enabled=True)
        self._set_last_interaction(_WEEKDAY.timestamp() - 3 * 24 * 60 * 60)
        block = build_ambient_block(clock=lambda: _WEEKDAY)
        self.assertIn("last_seen: 3 days ago", block)

    def test_sky_lines_present_only_when_sky_enabled(self) -> None:
        self._set_store(enabled=True, sky_enabled=True)
        block = build_ambient_block(clock=lambda: _WEEKDAY)  # Thu 25 Jun 14:30 BST
        self.assertIn("part_of_day: afternoon", block)
        self.assertTrue(any(line.startswith("sky: summer") for line in block))

    def test_no_sky_lines_when_disabled(self) -> None:
        self._set_store(enabled=True, sky_enabled=False)
        block = build_ambient_block(clock=lambda: _WEEKDAY)
        self.assertFalse(any(line.startswith("part_of_day:") for line in block))
        self.assertFalse(any(line.startswith("sky:") for line in block))

    def test_important_dates_surface_when_near(self) -> None:
        # _WEEKDAY is 2026-06-25; a 28 Jun date is 3 days out, a 25 Jun is today.
        self._set_store(enabled=True)
        self._set_important_dates([ImportantDate("Mum's birthday", 6, 28), ImportantDate("Anna", 6, 25)])
        block = build_ambient_block(clock=lambda: _WEEKDAY)
        self.assertIn("today: Anna", block)
        self.assertIn("upcoming: Mum's birthday in 3 days", block)

    def test_important_dates_absent_when_far(self) -> None:
        self._set_store(enabled=True)
        self._set_important_dates([ImportantDate("Distant", 12, 1)])
        block = build_ambient_block(clock=lambda: _WEEKDAY)
        self.assertFalse(any(line.startswith(("today:", "upcoming:")) for line in block))

    def test_bad_timezone_name_resolves_to_none(self) -> None:
        # The Windows-relevant path: an unresolvable zone must degrade to None
        # (system local), never raise.
        self.assertIsNone(turns_ambient._resolve_timezone("Definitely/NotAZone"))
        self.assertIsNone(turns_ambient._resolve_timezone(""))

    @unittest.skipUnless(
        _zoneinfo_available("Europe/London"), "IANA tz database unavailable (install tzdata)"
    )
    def test_default_london_zone_resolves(self) -> None:
        self.assertIsNotNone(turns_ambient._resolve_timezone("Europe/London"))
        self._set_store(enabled=True, timezone="Europe/London")
        block = build_ambient_block()
        self.assertTrue(any(line.startswith("local_time:") for line in block))


class AmbientPromptInjectionTests(unittest.TestCase):
    _AMBIENT = [AMBIENT_BLOCK_HEADER, "(advisory)", "local_time: Thu 25 Jun 2026 14:30 (BST)", "day_type: weekday"]

    def test_full_prompt_without_ambient_has_no_block(self) -> None:
        prompt = _build_spoken_reply_prompt("Hi.", character_id="niko", voice_profile=_VoiceProfile())
        self.assertNotIn(AMBIENT_BLOCK_HEADER, prompt)

    def test_full_prompt_injects_ambient_before_current_input(self) -> None:
        prompt = _build_spoken_reply_prompt(
            "Hi.", character_id="niko", voice_profile=_VoiceProfile(), ambient_lines=self._AMBIENT
        )
        self.assertIn(AMBIENT_BLOCK_HEADER, prompt)
        self.assertIn("day_type: weekday", prompt)
        # Ambient must sit before the user input section.
        self.assertLess(prompt.index(AMBIENT_BLOCK_HEADER), prompt.index("[CURRENT_INPUT]"))

    def test_lean_prompt_injects_ambient_before_user_message(self) -> None:
        prompt = _build_lean_reply_prompt(
            "Hi.", character_id="niko", voice_profile=_VoiceProfile(), ambient_lines=self._AMBIENT
        )
        self.assertIn(AMBIENT_BLOCK_HEADER, prompt)
        self.assertLess(prompt.index(AMBIENT_BLOCK_HEADER), prompt.index("User message:"))

    def test_lean_routing_forwards_ambient_lines(self) -> None:
        routed = _build_spoken_reply_prompt(
            "Hi.", character_id="niko", voice_profile=_VoiceProfile(), lean=True, ambient_lines=self._AMBIENT
        )
        direct = _build_lean_reply_prompt(
            "Hi.", character_id="niko", voice_profile=_VoiceProfile(), ambient_lines=self._AMBIENT
        )
        self.assertEqual(routed, direct)


if __name__ == "__main__":
    unittest.main()
