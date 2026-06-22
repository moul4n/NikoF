from __future__ import annotations

from pathlib import Path
import sys
import unittest
from unittest.mock import patch


BACKEND_ROOT = Path(__file__).resolve().parents[1]
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from app.core import runtime_tuning


class RuntimeTuningTests(unittest.TestCase):
    def setUp(self) -> None:
        runtime_tuning.get_runtime_tuning.cache_clear()
        self.addCleanup(runtime_tuning.get_runtime_tuning.cache_clear)

    def _resolve(self, env: dict[str, str]) -> runtime_tuning.RuntimeTuning:
        with patch.dict(runtime_tuning.os.environ, env, clear=True):
            runtime_tuning.get_runtime_tuning.cache_clear()
            return runtime_tuning.get_runtime_tuning()

    def test_defaults_when_env_absent(self) -> None:
        tuning = self._resolve({})
        self.assertEqual(tuning.stt_poll_interval_seconds, 0.10)
        self.assertEqual(tuning.speech_lifecycle_poll_interval_seconds, 0.10)
        self.assertTrue(tuning.warm_llm_on_start)
        self.assertTrue(tuning.warm_tts_on_start)
        self.assertEqual(tuning.stt_engine, "faster-whisper")
        self.assertFalse(tuning.stt_partials_enabled)

    def test_stt_partials_flag(self) -> None:
        self.assertTrue(self._resolve({"NIKOF_STT_PARTIALS": "1"}).stt_partials_enabled)
        self.assertFalse(self._resolve({}).stt_partials_enabled)

    def test_stt_engine_selects_parakeet_and_rejects_unknown(self) -> None:
        parakeet = self._resolve({"NIKOF_STT_ENGINE": "parakeet"})
        self.assertEqual(parakeet.stt_engine, "parakeet")
        # Case-insensitive.
        upper = self._resolve({"NIKOF_STT_ENGINE": "Parakeet"})
        self.assertEqual(upper.stt_engine, "parakeet")
        # Unknown engine falls back to the default rather than erroring.
        unknown = self._resolve({"NIKOF_STT_ENGINE": "whisper.cpp"})
        self.assertEqual(unknown.stt_engine, "faster-whisper")

    def test_env_overrides_intervals(self) -> None:
        tuning = self._resolve(
            {
                "NIKOF_STT_POLL_INTERVAL_SECONDS": "0.05",
                "NIKOF_SPEECH_LIFECYCLE_POLL_INTERVAL_SECONDS": "0.2",
            }
        )
        self.assertEqual(tuning.stt_poll_interval_seconds, 0.05)
        self.assertEqual(tuning.speech_lifecycle_poll_interval_seconds, 0.2)

    def test_interval_floor_clamps_too_small_values(self) -> None:
        tuning = self._resolve({"NIKOF_STT_POLL_INTERVAL_SECONDS": "0"})
        self.assertEqual(tuning.stt_poll_interval_seconds, 0.01)

    def test_invalid_interval_falls_back_to_default(self) -> None:
        tuning = self._resolve({"NIKOF_STT_POLL_INTERVAL_SECONDS": "not-a-number"})
        self.assertEqual(tuning.stt_poll_interval_seconds, 0.10)

    def test_warmup_toggles_parse_boolean_strings(self) -> None:
        disabled = self._resolve(
            {"NIKOF_WARM_LLM_ON_START": "false", "NIKOF_WARM_TTS_ON_START": "0"}
        )
        self.assertFalse(disabled.warm_llm_on_start)
        self.assertFalse(disabled.warm_tts_on_start)

        enabled = self._resolve(
            {"NIKOF_WARM_LLM_ON_START": "on", "NIKOF_WARM_TTS_ON_START": "yes"}
        )
        self.assertTrue(enabled.warm_llm_on_start)
        self.assertTrue(enabled.warm_tts_on_start)

    def test_unrecognized_boolean_falls_back_to_default(self) -> None:
        tuning = self._resolve({"NIKOF_WARM_LLM_ON_START": "maybe"})
        self.assertTrue(tuning.warm_llm_on_start)

    def test_result_is_cached_until_cleared(self) -> None:
        first = self._resolve({"NIKOF_STT_POLL_INTERVAL_SECONDS": "0.05"})
        # Same cached object returned without clearing.
        self.assertIs(runtime_tuning.get_runtime_tuning(), first)


if __name__ == "__main__":
    unittest.main()
