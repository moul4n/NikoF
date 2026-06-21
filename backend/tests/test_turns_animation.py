from __future__ import annotations

import sys
from pathlib import Path
import unittest


BACKEND_ROOT = Path(__file__).resolve().parents[1]
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from app.schemas.session import (
    AssistantAnimationCueContract,
    AssistantFeelingContract,
    AssistantMessageContract,
)
from app.services import turns, turns_animation


def _assistant(
    text: str,
    *,
    cue: str | None = None,
    feeling: str | None = None,
    status: str = "ready",
) -> AssistantMessageContract:
    return AssistantMessageContract(
        profile_id="llm.ollama.llama3.1-8b-2026",
        status=status,
        text=text,
        locale="en-US",
        feeling=AssistantFeelingContract(name=feeling, intensity=0.6) if feeling else None,
        animation_cues=(AssistantAnimationCueContract(cue=cue),) if cue else (),
    )


class TurnsAnimationTests(unittest.TestCase):
    def test_turns_reexports_animation_builders(self) -> None:
        self.assertIs(
            turns._build_assistant_animation_snapshot,
            turns_animation._build_assistant_animation_snapshot,
        )
        self.assertIs(
            turns._build_llm_thinking_animation_snapshot,
            turns_animation._build_llm_thinking_animation_snapshot,
        )

    def test_alias_normalization(self) -> None:
        self.assertEqual(
            turns_animation._normalize_animation_semantic_id(AssistantAnimationCueContract(cue="wave")),
            "greet.wave.once",
        )
        # An explicit dotted semantic id passes through untouched.
        self.assertEqual(
            turns_animation._normalize_animation_semantic_id(AssistantAnimationCueContract(cue="emote.angry.once")),
            "emote.angry.once",
        )

    def test_keyword_rule_picks_highest_priority_match(self) -> None:
        rule = turns_animation._resolve_animation_keyword_rule(_assistant("Let me give a small wave hello."))
        self.assertIsNotNone(rule)
        # "small wave" (priority 120) beats "wave"/"hello" (110).
        self.assertEqual(rule.semantic_id, "greet.wave.small.once")

    def test_choice_prefers_explicit_semantic_cue(self) -> None:
        choice = turns_animation._resolve_assistant_animation_choice(
            _assistant("Anything.", cue="dance.hiphop.loop")
        )
        self.assertIsNotNone(choice)
        semantic_id, _layer, _intensity, _duration, source = choice
        self.assertEqual(semantic_id, "dance.hiphop.loop")
        self.assertEqual(source, "explicit_semantic")

    def test_choice_none_when_no_cue_or_keyword(self) -> None:
        self.assertIsNone(turns_animation._resolve_assistant_animation_choice(_assistant("zzz qqq")))


if __name__ == "__main__":
    unittest.main()
