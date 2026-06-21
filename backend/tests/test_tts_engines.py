from __future__ import annotations

from dataclasses import replace
from pathlib import Path
import sys
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import patch
import wave


BACKEND_ROOT = Path(__file__).resolve().parents[1]
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from app.core.settings import get_app_paths
from app.services import tts_engines
from app.services.speech import SpeechSynthesisRequest
from app.services.tts_engines import (
    KokoroSynthesisAdapter,
    XttsSynthesisAdapter,
    _build_contract,
    _write_wav_int16,
    build_alternate_synthesis_service,
    resolve_tts_engine_name,
)


def _temp_app_paths(root: Path):
    base = get_app_paths()
    return replace(base, tts_models_root=root / "tts", cache_root=root / "cache")


def _request(text: str = "Hello there, this is a test.") -> SpeechSynthesisRequest:
    return SpeechSynthesisRequest(text=text, locale="en-US")


class EngineSelectionTests(unittest.TestCase):
    def test_resolve_engine_name_default_and_env(self) -> None:
        with patch.dict("os.environ", {}, clear=True):
            self.assertEqual(resolve_tts_engine_name(), "gpt-sovits")
        with patch.dict("os.environ", {"NIKOF_TTS_ENGINE": "Kokoro"}, clear=True):
            self.assertEqual(resolve_tts_engine_name(), "kokoro")

    def test_build_alternate_selection(self) -> None:
        self.assertIsNone(build_alternate_synthesis_service("gpt-sovits"))
        self.assertIsNone(build_alternate_synthesis_service("anything-else"))
        self.assertIsInstance(build_alternate_synthesis_service("kokoro"), KokoroSynthesisAdapter)
        self.assertIsInstance(build_alternate_synthesis_service("xtts"), XttsSynthesisAdapter)
        self.assertIsInstance(build_alternate_synthesis_service("xtts-v2"), XttsSynthesisAdapter)

    def test_alternate_service_is_cached_singleton(self) -> None:
        # Lifespan warmup and the request path must share the same (warmed) instance.
        self.assertIs(
            build_alternate_synthesis_service("kokoro"),
            build_alternate_synthesis_service("kokoro"),
        )

    def test_adapters_expose_request_warmup(self) -> None:
        self.assertTrue(callable(getattr(build_alternate_synthesis_service("kokoro"), "request_warmup")))
        self.assertTrue(callable(getattr(build_alternate_synthesis_service("xtts"), "request_warmup")))


class EngineUnavailableTests(unittest.TestCase):
    def test_kokoro_unavailable_without_model(self) -> None:
        with TemporaryDirectory() as tmp:
            adapter = KokoroSynthesisAdapter(app_paths=_temp_app_paths(Path(tmp)))
            contract = adapter.synthesize(_request())
        self.assertEqual(contract.status, "unavailable")
        self.assertEqual(contract.profile_id, "tts.kokoro.2026")

    def test_xtts_unavailable_without_model_or_reference(self) -> None:
        with TemporaryDirectory() as tmp:
            adapter = XttsSynthesisAdapter(app_paths=_temp_app_paths(Path(tmp)))
            contract = adapter.synthesize(_request())
        self.assertEqual(contract.status, "unavailable")
        self.assertEqual(contract.profile_id, "tts.xtts-v2.2026")


class ContractBuilderTests(unittest.TestCase):
    def test_write_wav_int16_round_trip_and_duration(self) -> None:
        import numpy as np

        with TemporaryDirectory() as tmp:
            path = Path(tmp) / "out.wav"
            samples = np.zeros(24000, dtype="float32")  # 1.0 s at 24 kHz
            duration_ms = _write_wav_int16(path, samples, 24000)
            self.assertAlmostEqual(duration_ms, 1000.0, places=1)
            self.assertTrue(path.is_file())
            with wave.open(str(path), "rb") as reader:
                self.assertEqual(reader.getnchannels(), 1)
                self.assertEqual(reader.getsampwidth(), 2)
                self.assertEqual(reader.getframerate(), 24000)
                self.assertEqual(reader.getnframes(), 24000)

    def test_build_contract_has_24k_format_and_lip_sync(self) -> None:
        with TemporaryDirectory() as tmp:
            audio_path = Path(tmp) / "seg.wav"
            audio_path.write_bytes(b"")  # path only; contract doesn't read it
            contract = _build_contract(
                profile_id="tts.kokoro.2026",
                text="Hello there, this is a longer test sentence.",
                locale="en-US",
                audio_path=audio_path,
                duration_ms=1500.0,
            )
        self.assertEqual(contract.status, "ready")
        self.assertEqual(contract.timing.audio_format.sample_rate_hz, 24000)
        self.assertEqual(contract.timing.utterance_duration_ms, 1500)
        # Text-fallback lip-sync produced mouth-cue tracks for the avatar.
        self.assertIsNotNone(contract.timing.lip_sync)
        self.assertGreater(len(contract.timing.lip_sync.mouth_cue_tracks), 0)


if __name__ == "__main__":
    unittest.main()
