from __future__ import annotations

from datetime import datetime, timedelta, timezone
from pathlib import Path
import sys
import unittest


BACKEND_ROOT = Path(__file__).resolve().parents[1]
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from app.services.turns import _build_lean_reply_prompt, _build_spoken_reply_prompt
from app.services import ambient_context, turns_ambient
from app.services.ambient_context import AmbientContextState
from app.services.turns_ambient import (
    AMBIENT_BLOCK_HEADER,
    build_ambient_block,
    render_ambient_lines,
)


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


class BuildAmbientBlockTests(unittest.TestCase):
    """build_ambient_block reads the durable ambient-context store live. Override
    the process-wide singleton with an in-memory state (no disk) per test."""

    def _set_store(self, *, enabled: bool, timezone: str = "Europe/London", location: str = "") -> None:
        ambient_context._ambient_context_state = AmbientContextState(
            state_path=None, enabled=enabled, timezone=timezone, location=location
        )

    def setUp(self) -> None:
        self.addCleanup(setattr, ambient_context, "_ambient_context_state", None)

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
