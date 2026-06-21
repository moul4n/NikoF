from __future__ import annotations

import sys
from pathlib import Path
import unittest


BACKEND_ROOT = Path(__file__).resolve().parents[1]
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from app.services import speech, speech_adapters


class SpeechAdaptersModuleTests(unittest.TestCase):
    def test_speech_reexports_adapter_layer(self) -> None:
        # The extraction must preserve `app.services.speech.X` for callers
        # (turns, tts_worker, tts_engines, tests).
        for name in (
            "SpeechTranscriptionRequest",
            "SpeechSynthesisRequest",
            "StubSpeechTranscriptionService",
            "FasterWhisperTranscriptionAdapter",
            "StubSpeechSynthesisService",
            "GptSovitsSynthesisAdapter",
            "SpeechAdapterRuntimeBinding",
            "SpeechAdapterInvocationError",
        ):
            self.assertIs(getattr(speech, name), getattr(speech_adapters, name), name)

    def test_registry_builds_real_adapters(self) -> None:
        registry = speech.build_speech_service_registry()
        self.assertIsInstance(
            registry.transcription_services["faster-whisper"],
            speech_adapters.FasterWhisperTranscriptionAdapter,
        )
        self.assertIsInstance(
            registry.synthesis_services["gpt-sovits"],
            speech_adapters.GptSovitsSynthesisAdapter,
        )

    def test_self_contained_no_speech_import(self) -> None:
        # speech_adapters must not import speech (would be a cycle); it imports
        # only leaf helpers. Guard against a regression reintroducing the cycle.
        source = (BACKEND_ROOT / "app" / "services" / "speech_adapters.py").read_text(encoding="utf-8")
        self.assertNotIn("from app.services.speech import", source)
        self.assertNotIn("import app.services.speech\n", source)


if __name__ == "__main__":
    unittest.main()
