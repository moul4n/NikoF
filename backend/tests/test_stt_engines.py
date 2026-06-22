from __future__ import annotations

import sys
from pathlib import Path
import unittest
from unittest.mock import patch


BACKEND_ROOT = Path(__file__).resolve().parents[1]
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from app.providers import stt_engines
from app.providers.stt_engines import (
    ParakeetTranscriptionEngine,
    TranscriptionResult,
    build_transcription_payload,
    resolve_stt_engine_name,
    stt_profile_id_for,
)


class _FakeArray:
    """Minimal stand-in for a numpy float32 array (avoids a numpy dependency
    in the unit test while exercising the duration math)."""

    def __init__(self, length: int) -> None:
        self.shape = (length,)


class _FakeModel:
    def __init__(self, recognized: object) -> None:
        self._recognized = recognized
        self.calls: list[object] = []

    def recognize(self, audio: object) -> object:
        self.calls.append(audio)
        return self._recognized


class SttEngineSelectionTests(unittest.TestCase):
    def test_resolve_defaults_to_faster_whisper(self) -> None:
        with patch.dict(stt_engines.os.environ, {}, clear=True):
            self.assertEqual(resolve_stt_engine_name(), "faster-whisper")

    def test_resolve_selects_parakeet(self) -> None:
        with patch.dict(stt_engines.os.environ, {"NIKOF_STT_ENGINE": "parakeet"}, clear=True):
            self.assertEqual(resolve_stt_engine_name(), "parakeet")

    def test_resolve_unknown_falls_back(self) -> None:
        with patch.dict(stt_engines.os.environ, {"NIKOF_STT_ENGINE": "vosk"}, clear=True):
            self.assertEqual(resolve_stt_engine_name(), "faster-whisper")

    def test_profile_ids_are_locked(self) -> None:
        self.assertEqual(stt_profile_id_for("faster-whisper"), "stt.faster-whisper.medium-2026")
        self.assertEqual(stt_profile_id_for("parakeet"), "stt.parakeet-tdt.0.6b-v2-2026")
        self.assertEqual(stt_profile_id_for("unknown"), "stt.faster-whisper.medium-2026")


class TranscriptionPayloadTests(unittest.TestCase):
    def test_payload_for_successful_transcript(self) -> None:
        result = TranscriptionResult(transcript="Hello there.", confidence=0.9, duration_ms=1200)
        payload = build_transcription_payload(result, locale="en-US")
        self.assertEqual(payload["status"], "final")
        self.assertEqual(payload["transcript"], "Hello there.")
        self.assertEqual(payload["locale"], "en-US")
        self.assertEqual(payload["confidence"], 0.9)
        self.assertEqual(payload["timing"]["utterance_duration_ms"], 1200)
        self.assertEqual(payload["timing"]["audio_format"]["sample_rate_hz"], 16000)

    def test_payload_for_empty_transcript_is_unavailable(self) -> None:
        payload = build_transcription_payload(TranscriptionResult(transcript="   "), locale="en-US")
        self.assertEqual(payload["status"], "unavailable")
        self.assertEqual(payload["transcript"], "Local transcription is unavailable.")


class ParakeetEngineTests(unittest.TestCase):
    def _engine_with_model(self, recognized: object) -> tuple[ParakeetTranscriptionEngine, _FakeModel]:
        engine = ParakeetTranscriptionEngine(Path("does-not-need-to-exist"))
        model = _FakeModel(recognized)
        engine._model = model  # inject so _load_model (and onnx_asr) are never touched
        return engine, model

    def test_transcribe_string_result(self) -> None:
        engine, model = self._engine_with_model("hey niko")
        result = engine.transcribe(_FakeArray(16000), locale="en-US")
        self.assertEqual(result.transcript, "hey niko")
        self.assertEqual(result.duration_ms, 1000)
        self.assertEqual(len(model.calls), 1)

    def test_transcribe_list_result_is_joined(self) -> None:
        engine, _model = self._engine_with_model(["hey", "niko"])
        result = engine.transcribe(_FakeArray(8000), locale="en-US")
        self.assertEqual(result.transcript, "hey niko")
        self.assertEqual(result.duration_ms, 500)

    def test_transcribe_object_with_text_attr(self) -> None:
        class _Res:
            text = "  spoken words  "

        engine, _model = self._engine_with_model(_Res())
        result = engine.transcribe(_FakeArray(16000), locale="en-US")
        self.assertEqual(result.transcript, "spoken words")

    def test_missing_dependency_raises_clear_error(self) -> None:
        engine = ParakeetTranscriptionEngine(Path("nope"))
        with patch.dict(sys.modules, {"onnx_asr": None}):
            # import onnx_asr -> ModuleNotFoundError is wrapped as RuntimeError.
            with self.assertRaises(RuntimeError):
                engine.ensure_ready()


if __name__ == "__main__":
    unittest.main()
