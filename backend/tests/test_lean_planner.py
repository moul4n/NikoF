from __future__ import annotations

from pathlib import Path
import sys
import unittest
from unittest.mock import patch


BACKEND_ROOT = Path(__file__).resolve().parents[1]
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from app.core import runtime_tuning
from app.services.turns import _build_lean_reply_prompt, _build_spoken_reply_prompt


class _VoiceProfile:
    style = "gentle"
    notes = "warm"
    profile_id = "tts.gpt-sovits.2026-stable"
    provider = "gpt-sovits"
    settings: dict = {}


class LeanPlannerPromptTests(unittest.TestCase):
    def test_lean_prompt_is_slim_and_drops_heavy_fields(self) -> None:
        text = "How are you today?"
        lean = _build_lean_reply_prompt(text, character_id="niko", voice_profile=_VoiceProfile())
        # Requests only the slim schema.
        self.assertIn('"reply_text"', lean)
        self.assertIn('"feeling"', lean)
        self.assertIn('"animation_cues"', lean)
        # Drops the expensive-to-generate fields.
        self.assertNotIn("thinking_summary", lean)
        self.assertNotIn("memory_writebacks", lean)
        self.assertNotIn("voice_tone", lean)
        self.assertIn(text, lean)

    def test_lean_prompt_is_shorter_than_full(self) -> None:
        text = "Tell me something nice."
        lean = _build_lean_reply_prompt(text, character_id="niko", voice_profile=_VoiceProfile())
        full = _build_spoken_reply_prompt(text, character_id="niko", voice_profile=_VoiceProfile())
        self.assertLess(len(lean), len(full))

    def test_spoken_reply_prompt_lean_flag_routes_to_lean(self) -> None:
        text = "Hi."
        routed = _build_spoken_reply_prompt(text, character_id="niko", voice_profile=_VoiceProfile(), lean=True)
        direct = _build_lean_reply_prompt(text, character_id="niko", voice_profile=_VoiceProfile())
        self.assertEqual(routed, direct)

    def test_tuning_flag(self) -> None:
        runtime_tuning.get_runtime_tuning.cache_clear()
        self.addCleanup(runtime_tuning.get_runtime_tuning.cache_clear)
        with patch.dict(runtime_tuning.os.environ, {}, clear=True):
            runtime_tuning.get_runtime_tuning.cache_clear()
            self.assertFalse(runtime_tuning.get_runtime_tuning().llm_lean_planner)
        with patch.dict(runtime_tuning.os.environ, {"NIKOF_LLM_LEAN_PLANNER": "1"}, clear=True):
            runtime_tuning.get_runtime_tuning.cache_clear()
            self.assertTrue(runtime_tuning.get_runtime_tuning().llm_lean_planner)


if __name__ == "__main__":
    unittest.main()
