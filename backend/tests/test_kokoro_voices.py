from __future__ import annotations

import dataclasses
import sys
import tempfile
import unittest
from pathlib import Path


BACKEND_ROOT = Path(__file__).resolve().parents[1]
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from app.core.settings import get_app_paths
from app.services import kokoro_voices as kv


def _temp_paths(tmp: str):
    # Point only the TTS models root at a scratch dir; the service writes
    # runtime.json under <tts_models_root>/kokoro.
    return dataclasses.replace(get_app_paths(), tts_models_root=Path(tmp))


class KokoroVoiceMetadataTests(unittest.TestCase):
    def test_describe_voice_flags_female_english(self) -> None:
        heart = kv.describe_voice("af_heart")
        self.assertTrue(heart.female)
        self.assertTrue(heart.english)
        self.assertEqual("American English", heart.language)
        self.assertIn("Heart", heart.label)

    def test_describe_voice_non_english_female(self) -> None:
        gon = kv.describe_voice("jf_gongitsune")
        self.assertTrue(gon.female)
        self.assertFalse(gon.english)
        self.assertEqual("Japanese", gon.language)

    def test_describe_voice_male(self) -> None:
        adam = kv.describe_voice("am_adam")
        self.assertFalse(adam.female)
        self.assertTrue(adam.english)


class KokoroVoicePersistenceTests(unittest.TestCase):
    def test_set_and_get_roundtrip(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            paths = _temp_paths(tmp)
            # No installed voices file in the scratch dir, so validation is skipped.
            stored = kv.set_selected_kokoro_voice("af_bella", app_paths=paths)
            self.assertEqual("af_bella", stored)
            self.assertEqual("af_bella", kv.get_selected_kokoro_voice(app_paths=paths))

    def test_get_falls_back_to_default_when_unset(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            paths = _temp_paths(tmp)
            # No persisted value and (in CI) no env override -> default voice.
            import os

            if "NIKOF_KOKORO_VOICE" not in os.environ:
                self.assertEqual(kv.DEFAULT_KOKORO_VOICE, kv.get_selected_kokoro_voice(app_paths=paths))

    def test_blank_voice_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            paths = _temp_paths(tmp)
            with self.assertRaises(ValueError):
                kv.set_selected_kokoro_voice("   ", app_paths=paths)


if __name__ == "__main__":
    unittest.main()
