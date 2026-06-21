from __future__ import annotations

import sys
from pathlib import Path
import unittest


BACKEND_ROOT = Path(__file__).resolve().parents[1]
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from app.schemas.session import AudioFormatMetadata, SpeechTimingMetadata
from app.services import speech, speech_timing


class SpeechTimingModuleTests(unittest.TestCase):
    def test_speech_reexports_timing_helpers(self) -> None:
        # The split must preserve `app.services.speech.X` access for callers
        # such as tts_engines (`speech._normalize_timing`).
        self.assertIs(speech._normalize_timing, speech_timing._normalize_timing)
        self.assertIs(speech._coerce_int, speech_timing._coerce_int)
        self.assertIs(speech._normalize_contract_status, speech_timing._normalize_contract_status)

    def test_coerce_helpers(self) -> None:
        self.assertEqual(speech_timing._coerce_int("12", 0), 12)
        self.assertEqual(speech_timing._coerce_int("nope", 7), 7)
        self.assertEqual(speech_timing._coerce_float("1.5"), 1.5)
        self.assertIsNone(speech_timing._coerce_float("x"))

    def test_contract_status_normalization(self) -> None:
        self.assertEqual(speech_timing._normalize_contract_status("ok", success=True), "ready")
        self.assertEqual(speech_timing._normalize_contract_status("ok", success=False), "error")
        self.assertEqual(speech_timing._normalize_contract_status("missing", success=True), "unavailable")
        self.assertEqual(speech_timing._normalize_contract_status("degraded", success=True), "degraded")

    def test_text_fallback_visemes_span_the_utterance(self) -> None:
        slots = speech_timing._build_text_fallback_viseme_slots("hello", 1000)
        self.assertTrue(slots)
        self.assertEqual(slots[0].start_ms, 0)
        self.assertEqual(slots[-1].end_ms, 1000)
        # Slots are contiguous and strictly increasing.
        for earlier, later in zip(slots, slots[1:]):
            self.assertLessEqual(earlier.end_ms, later.start_ms + 1)
            self.assertGreater(later.end_ms, later.start_ms)

    def test_normalize_timing_generates_lip_sync_from_text_fallback(self) -> None:
        fallback = SpeechTimingMetadata(
            utterance_duration_ms=0,
            audio_format=AudioFormatMetadata(container="wav", encoding="pcm_s16le", sample_rate_hz=24000, channels=1),
        )
        timing = speech_timing._normalize_timing(
            {"utterance_duration_ms": 900},
            fallback=fallback,
            source_text="Hello there",
        )
        self.assertEqual(timing.utterance_duration_ms, 900)
        # No phoneme/viseme slots provided -> text-fallback visemes + lip sync.
        self.assertTrue(timing.viseme_slots)
        self.assertIsNotNone(timing.lip_sync)
        self.assertTrue(timing.lip_sync.mouth_cue_tracks)
        self.assertIn("text_fallback_visemes", timing.lip_sync.debug.timing_source or "")

    def test_normalize_timing_passthrough_when_not_dict(self) -> None:
        fallback = SpeechTimingMetadata(utterance_duration_ms=42)
        self.assertIs(speech_timing._normalize_timing(None, fallback=fallback), fallback)

    def test_phoneme_cue_resolvers(self) -> None:
        self.assertEqual(speech_timing._resolve_basic_cue_from_phoneme("M"), "sil")
        self.assertEqual(speech_timing._resolve_advanced_cue_from_phoneme("M"), "bmp")
        self.assertEqual(speech_timing._resolve_advanced_cue_from_phoneme("F"), "fv")
        self.assertIsNone(speech_timing._resolve_basic_cue_from_phoneme(""))


if __name__ == "__main__":
    unittest.main()
