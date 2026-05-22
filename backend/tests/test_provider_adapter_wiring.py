from __future__ import annotations

import json
import os
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import sys
from tempfile import TemporaryDirectory
import threading
import unittest
from unittest.mock import patch


BACKEND_ROOT = Path(__file__).resolve().parents[1]
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from app.api.operator_routes import (
    OperatorCommandRouteServices,
    _build_text_question_response,
    _build_tts_preview_response,
)
from app.api.router_composition import build_default_api_runtime_services
from app.core.settings import AppPaths
from app.schemas.session import OperatorCommandRequest
from app.services.llm import OllamaTextGenerationAdapter, TextGenerationRequest
from app.services.speech import (
    BackendTurnRequest,
    FasterWhisperTranscriptionAdapter,
    GptSovitsSynthesisAdapter,
    SpeechSynthesisRequest,
    SpeechTranscriptionRequest,
    StubSpeechSynthesisService,
    StubSpeechTranscriptionService,
)


def build_app_paths(root: Path) -> AppPaths:
    models_root = root / "models"
    return AppPaths(
        repo_root=BACKEND_ROOT.parent,
        assets_root=BACKEND_ROOT.parent / "assets",
        character_assets_root=BACKEND_ROOT.parent / "assets" / "characters",
        local_data_root=root,
        models_root=models_root,
        llm_models_root=models_root / "llm",
        stt_models_root=models_root / "stt",
        tts_models_root=models_root / "tts",
        embeddings_root=models_root / "embeddings",
        providers_root=root / "providers",
        cache_root=root / "cache",
    )


def build_operator_services(default_services) -> OperatorCommandRouteServices:
    return OperatorCommandRouteServices(
        session_service=default_services.session_service,
        character_service=default_services.character_service,
        text_generation_service=default_services.text_generation_service,
        synthesis_service=default_services.synthesis_service,
        session_event_factory=default_services.session_event_factory,
    )


class _OllamaHandler(BaseHTTPRequestHandler):
    response_payload: dict[str, object] = {
        "response": "Default reply.",
        "status": "ready",
    }
    last_request_payload: dict[str, object] | None = None

    def do_POST(self) -> None:  # noqa: N802
        content_length = int(self.headers.get("Content-Length", "0"))
        request_body = self.rfile.read(content_length).decode("utf-8")
        try:
            type(self).last_request_payload = json.loads(request_body)
        except json.JSONDecodeError:
            type(self).last_request_payload = {"_raw": request_body}
        response_body = json.dumps(type(self).response_payload).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(response_body)))
        self.end_headers()
        self.wfile.write(response_body)

    def log_message(self, format: str, *args) -> None:  # noqa: A003
        del format, args


class OllamaTextGenerationAdapterTests(unittest.TestCase):
    def test_generate_returns_unavailable_when_local_runtime_roots_are_missing(self) -> None:
        with TemporaryDirectory() as temp_dir:
            adapter = OllamaTextGenerationAdapter(app_paths=build_app_paths(Path(temp_dir)))

            contract = adapter.generate(
                TextGenerationRequest(prompt="What should I do next?", locale="en-US")
            )

        self.assertEqual("unavailable", contract.status)
        self.assertEqual("Local text generation is unavailable.", contract.text)

    def test_generate_uses_ollama_runtime_config_from_local_roots(self) -> None:
        with TemporaryDirectory() as temp_dir:
            app_paths = build_app_paths(Path(temp_dir))
            provider_root = app_paths.providers_root / "llm" / "ollama"
            model_root = app_paths.llm_models_root / "ollama-llama3.1-8b"
            provider_root.mkdir(parents=True)
            model_root.mkdir(parents=True)

            server = ThreadingHTTPServer(("127.0.0.1", 0), _OllamaHandler)
            _OllamaHandler.response_payload = {
                "model": "llama3.1:8b",
                "response": "Keep the backend seam narrow.",
                "done": True,
                "done_reason": "stop",
            }
            server_thread = threading.Thread(target=server.serve_forever)
            server_thread.start()
            try:
                (provider_root / "runtime.json").write_text(
                    json.dumps(
                        {
                            "endpoint": f"http://127.0.0.1:{server.server_address[1]}",
                            "model": "llama3.1:8b",
                        }
                    ),
                    encoding="utf-8",
                )
                adapter = OllamaTextGenerationAdapter(app_paths=app_paths)

                contract = adapter.generate(
                    TextGenerationRequest(prompt="What should I do next?", locale="en-US")
                )
            finally:
                server.shutdown()
                server.server_close()
                server_thread.join()

        self.assertEqual("ready", contract.status)
        self.assertEqual("Keep the backend seam narrow.", contract.text)


class GptSovitsSynthesisAdapterTests(unittest.TestCase):
    def test_synthesize_returns_unavailable_when_local_runtime_roots_are_missing(self) -> None:
        with TemporaryDirectory() as temp_dir:
            adapter = GptSovitsSynthesisAdapter(app_paths=build_app_paths(Path(temp_dir)))

            contract = adapter.synthesize(
                SpeechSynthesisRequest(text="Preview this.", locale="en-US")
            )

        self.assertEqual("unavailable", contract.status)
        self.assertIsNone(contract.audio_reference)

    def test_synthesize_invokes_provider_entrypoint_and_normalizes_contract(self) -> None:
        with TemporaryDirectory() as temp_dir:
            app_paths = build_app_paths(Path(temp_dir))
            provider_root = app_paths.providers_root / "tts" / "gpt-sovits"
            model_root = app_paths.tts_models_root / "gpt-sovits"
            provider_root.mkdir(parents=True)
            model_root.mkdir(parents=True)
            audio_path = model_root / "preview.wav"
            synthesize_script = provider_root / "synthesize.py"
            synthesize_script.write_text(
                "import json\n"
                "from pathlib import Path\n"
                "import sys\n"
                "request = json.loads(sys.stdin.read())\n"
                "audio_path = Path(request['model_root']) / 'preview.wav'\n"
                "audio_path.write_bytes(b'RIFF')\n"
                "response = {\n"
                "    'status': 'ready',\n"
                "    'text': request['text'],\n"
                "    'locale': request['locale'],\n"
                "    'audio_reference': str(audio_path),\n"
                "    'timing': {\n"
                "        'utterance_duration_ms': 980,\n"
                "        'segment_ranges': [{'start_ms': 0, 'end_ms': 980, 'text': request['text']}],\n"
                "        'audio_format': {\n"
                "            'container': 'wav',\n"
                "            'encoding': 'pcm_s16le',\n"
                "            'sample_rate_hz': 32000,\n"
                "            'channels': 1\n"
                "        },\n"
                "        'phoneme_slots': [{'phoneme': 'P', 'start_ms': 0, 'end_ms': 120}],\n"
                "        'viseme_slots': [{'viseme': 'aa', 'start_ms': 0, 'end_ms': 120}]\n"
                "    }\n"
                "}\n"
                "sys.stdout.write(json.dumps(response))\n",
                encoding="utf-8",
            )
            adapter = GptSovitsSynthesisAdapter(app_paths=app_paths)

            contract = adapter.synthesize(
                SpeechSynthesisRequest(text="Preview this.", locale="en-US")
            )

        self.assertEqual("ready", contract.status)
        self.assertEqual(str(audio_path), contract.audio_reference)
        self.assertEqual(980, contract.timing.utterance_duration_ms)
        self.assertEqual(32000, contract.timing.audio_format.sample_rate_hz)

    def test_synthesize_honors_runtime_manifest_entrypoint_override(self) -> None:
        with TemporaryDirectory() as temp_dir:
            app_paths = build_app_paths(Path(temp_dir))
            provider_root = app_paths.providers_root / "tts" / "gpt-sovits"
            model_root = app_paths.tts_models_root / "gpt-sovits"
            provider_root.mkdir(parents=True)
            model_root.mkdir(parents=True)
            audio_path = model_root / "runtime-manifest-preview.wav"
            launch_script = provider_root / "vendor" / "launch.py"
            launch_script.parent.mkdir(parents=True)
            launch_script.write_text(
                "import json\n"
                "from pathlib import Path\n"
                "import sys\n"
                "request = json.loads(sys.stdin.read())\n"
                "audio_path = Path(request['model_root']) / 'runtime-manifest-preview.wav'\n"
                "audio_path.write_bytes(b'RIFF')\n"
                "sys.stdout.write(json.dumps({\n"
                "    'status': 'ready',\n"
                "    'text': request['text'],\n"
                "    'locale': request['locale'],\n"
                "    'audio_reference': str(audio_path),\n"
                "    'timing': {'utterance_duration_ms': 410}\n"
                "}))\n",
                encoding="utf-8",
            )
            (provider_root / "runtime.json").write_text(
                json.dumps(
                    {
                        "entrypoint": "vendor/launch.py",
                        "timeout_seconds": 30,
                    }
                ),
                encoding="utf-8",
            )
            adapter = GptSovitsSynthesisAdapter(app_paths=app_paths)

            contract = adapter.synthesize(
                SpeechSynthesisRequest(text="Preview this via runtime.json.", locale="en-US")
            )

        self.assertEqual("ready", contract.status)
        self.assertEqual(str(audio_path), contract.audio_reference)
        self.assertEqual(410, contract.timing.utterance_duration_ms)

    def test_synthesize_generates_fallback_viseme_slots_from_text_when_provider_returns_duration_only(self) -> None:
        with TemporaryDirectory() as temp_dir:
            app_paths = build_app_paths(Path(temp_dir))
            provider_root = app_paths.providers_root / "tts" / "gpt-sovits"
            model_root = app_paths.tts_models_root / "gpt-sovits"
            provider_root.mkdir(parents=True)
            model_root.mkdir(parents=True)
            audio_path = model_root / "fallback-viseme-preview.wav"
            synthesize_script = provider_root / "synthesize.py"
            synthesize_script.write_text(
                "import json\n"
                "from pathlib import Path\n"
                "import sys\n"
                "request = json.loads(sys.stdin.read())\n"
                "audio_path = Path(request['model_root']) / 'fallback-viseme-preview.wav'\n"
                "audio_path.write_bytes(b'RIFF')\n"
                "response = {\n"
                "    'status': 'ready',\n"
                "    'text': request['text'],\n"
                "    'locale': request['locale'],\n"
                "    'audio_reference': str(audio_path),\n"
                "    'timing': {\n"
                "        'utterance_duration_ms': 1200,\n"
                "        'segment_ranges': [{'start_ms': 0, 'end_ms': 1200, 'text': request['text']}],\n"
                "        'audio_format': {\n"
                "            'container': 'wav',\n"
                "            'encoding': 'pcm_s16le',\n"
                "            'sample_rate_hz': 32000,\n"
                "            'channels': 1\n"
                "        }\n"
                "    }\n"
                "}\n"
                "sys.stdout.write(json.dumps(response))\n",
                encoding="utf-8",
            )
            adapter = GptSovitsSynthesisAdapter(app_paths=app_paths)

            contract = adapter.synthesize(
                SpeechSynthesisRequest(text="Fallback viseme timing please.", locale="en-US")
            )

        self.assertEqual("ready", contract.status)
        self.assertEqual(str(audio_path), contract.audio_reference)
        self.assertEqual(1200, contract.timing.utterance_duration_ms)
        self.assertGreater(len(contract.timing.viseme_slots), 0)
        self.assertIsNotNone(contract.timing.lip_sync)
        self.assertEqual("text_fallback_visemes", contract.timing.lip_sync.debug.timing_source)
        self.assertGreater(len(contract.timing.lip_sync.mouth_cue_tracks), 0)

    def test_synthesize_serializes_overlapping_provider_invocations(self) -> None:
        with TemporaryDirectory() as temp_dir:
            app_paths = build_app_paths(Path(temp_dir))
            provider_root = app_paths.providers_root / "tts" / "gpt-sovits"
            model_root = app_paths.tts_models_root / "gpt-sovits"
            provider_root.mkdir(parents=True)
            model_root.mkdir(parents=True)
            (provider_root / "synthesize.py").write_text("print('unused')\n", encoding="utf-8")
            audio_path = model_root / "serialized-preview.wav"
            audio_path.write_bytes(b"RIFF")
            adapter = GptSovitsSynthesisAdapter(app_paths=app_paths)

            state_lock = threading.Lock()
            first_entered = threading.Event()
            second_entered = threading.Event()
            release_first = threading.Event()
            worker_errors: list[str] = []
            contracts: dict[str, object] = {}
            in_flight = 0
            max_in_flight = 0

            def fake_run_json_entrypoint(entrypoint, payload, **kwargs):
                del entrypoint, kwargs
                nonlocal in_flight, max_in_flight
                with state_lock:
                    in_flight += 1
                    max_in_flight = max(max_in_flight, in_flight)
                    is_first_call = not first_entered.is_set()
                    if is_first_call:
                        first_entered.set()
                    else:
                        second_entered.set()

                try:
                    if is_first_call and not release_first.wait(timeout=1.0):
                        worker_errors.append("first call did not release")
                    return {
                        "status": "ready",
                        "text": payload["text"],
                        "locale": payload["locale"],
                        "audio_reference": str(audio_path),
                        "timing": {"utterance_duration_ms": 320},
                    }
                finally:
                    with state_lock:
                        in_flight -= 1

            def run_request(text: str) -> None:
                contracts[text] = adapter.synthesize(
                    SpeechSynthesisRequest(text=text, locale="en-US")
                )

            with patch("app.services.speech._run_json_entrypoint", side_effect=fake_run_json_entrypoint):
                first_thread = threading.Thread(target=run_request, args=("First preview.",))
                second_thread = threading.Thread(target=run_request, args=("Second preview.",))

                first_thread.start()
                self.assertTrue(first_entered.wait(timeout=1.0))

                second_thread.start()
                self.assertFalse(
                    second_entered.wait(timeout=0.1),
                    "Second GPT-SoVITS invocation entered the provider runner before the first completed.",
                )

                release_first.set()
                first_thread.join(timeout=1.0)
                second_thread.join(timeout=1.0)

            self.assertFalse(first_thread.is_alive())
            self.assertFalse(second_thread.is_alive())
            self.assertEqual([], worker_errors)
            self.assertTrue(second_entered.is_set())
            self.assertEqual(1, max_in_flight)
            self.assertEqual("ready", contracts["First preview."].status)
            self.assertEqual("ready", contracts["Second preview."].status)


class FasterWhisperTranscriptionAdapterTests(unittest.TestCase):
    def test_transcribe_returns_unavailable_when_local_runtime_roots_are_missing(self) -> None:
        with TemporaryDirectory() as temp_dir:
            adapter = FasterWhisperTranscriptionAdapter(app_paths=build_app_paths(Path(temp_dir)))

            contract = adapter.transcribe(
                SpeechTranscriptionRequest(
                    audio_reference="session://speech-sample/transcription.wav",
                    locale="en-US",
                )
            )

        self.assertEqual("unavailable", contract.status)
        self.assertEqual("Local transcription is unavailable.", contract.transcript)

    def test_transcribe_invokes_provider_entrypoint_and_normalizes_contract(self) -> None:
        with TemporaryDirectory() as temp_dir:
            app_paths = build_app_paths(Path(temp_dir))
            provider_root = app_paths.providers_root / "stt" / "faster-whisper"
            model_root = app_paths.stt_models_root / "faster-whisper-medium"
            provider_root.mkdir(parents=True)
            model_root.mkdir(parents=True)
            transcribe_script = provider_root / "transcribe.py"
            transcribe_script.write_text(
                "import json\n"
                "import sys\n"
                "request = json.loads(sys.stdin.read())\n"
                "response = {\n"
                "    'status': 'final',\n"
                "    'transcript': 'Runtime transcript from provider.',\n"
                "    'locale': request['locale'],\n"
                "    'confidence': 0.77,\n"
                "    'timing': {\n"
                "        'utterance_duration_ms': 730,\n"
                "        'segment_ranges': [{'start_ms': 0, 'end_ms': 730, 'text': 'Runtime transcript from provider.'}],\n"
                "        'audio_format': {\n"
                "            'container': 'wav',\n"
                "            'encoding': 'pcm_s16le',\n"
                "            'sample_rate_hz': 16000,\n"
                "            'channels': 1\n"
                "        }\n"
                "    }\n"
                "}\n"
                "sys.stdout.write(json.dumps(response))\n",
                encoding="utf-8",
            )
            adapter = FasterWhisperTranscriptionAdapter(app_paths=app_paths)

            contract = adapter.transcribe(
                SpeechTranscriptionRequest(
                    audio_reference="session://speech-sample/transcription.wav",
                    locale="en-US",
                    transcript_hint="Scaffold transcription unavailable.",
                    confidence_hint=0.98,
                )
            )

        self.assertEqual("ready", contract.status)
        self.assertEqual("Runtime transcript from provider.", contract.transcript)
        self.assertEqual(0.77, contract.confidence)
        self.assertEqual(730, contract.timing.utterance_duration_ms)

    def test_transcribe_honors_runtime_manifest_entrypoint_override(self) -> None:
        with TemporaryDirectory() as temp_dir:
            app_paths = build_app_paths(Path(temp_dir))
            provider_root = app_paths.providers_root / "stt" / "faster-whisper"
            model_root = app_paths.stt_models_root / "faster-whisper-medium"
            provider_root.mkdir(parents=True)
            model_root.mkdir(parents=True)
            launch_script = provider_root / "vendor" / "launch.py"
            launch_script.parent.mkdir(parents=True)
            launch_script.write_text(
                "import json\n"
                "import sys\n"
                "request = json.loads(sys.stdin.read())\n"
                "sys.stdout.write(json.dumps({\n"
                "    'status': 'final',\n"
                "    'transcript': 'Runtime manifest transcript.',\n"
                "    'locale': request['locale'],\n"
                "    'confidence': 0.66,\n"
                "    'timing': {'utterance_duration_ms': 410}\n"
                "}))\n",
                encoding="utf-8",
            )
            (provider_root / "runtime.json").write_text(
                json.dumps(
                    {
                        "entrypoint": "vendor/launch.py",
                        "timeout_seconds": 30,
                    }
                ),
                encoding="utf-8",
            )
            adapter = FasterWhisperTranscriptionAdapter(app_paths=app_paths)

            contract = adapter.transcribe(
                SpeechTranscriptionRequest(
                    audio_reference="session://speech-sample/transcription.wav",
                    locale="en-US",
                    transcript_hint="Scaffold transcription unavailable.",
                )
            )

        self.assertEqual("ready", contract.status)
        self.assertEqual("Runtime manifest transcript.", contract.transcript)
        self.assertEqual(410, contract.timing.utterance_duration_ms)


class OperatorCommandProviderWiringTests(unittest.TestCase):
    def test_default_runtime_services_use_real_provider_adapters_when_local_roots_are_configured(self) -> None:
        with TemporaryDirectory() as temp_dir:
            temp_root = Path(temp_dir)
            provider_root = temp_root / "providers"
            llm_provider_root = provider_root / "llm" / "ollama"
            stt_provider_root = provider_root / "stt" / "faster-whisper"
            tts_provider_root = provider_root / "tts" / "gpt-sovits"
            llm_model_root = temp_root / "models" / "llm" / "ollama-llama3.1-8b"
            stt_model_root = temp_root / "models" / "stt" / "faster-whisper-medium"
            tts_model_root = temp_root / "models" / "tts" / "gpt-sovits"
            llm_provider_root.mkdir(parents=True)
            stt_provider_root.mkdir(parents=True)
            tts_provider_root.mkdir(parents=True)
            llm_model_root.mkdir(parents=True)
            stt_model_root.mkdir(parents=True)
            tts_model_root.mkdir(parents=True)

            transcribe_script = stt_provider_root / "transcribe.py"
            transcribe_script.write_text(
                "import json\n"
                "import sys\n"
                "request = json.loads(sys.stdin.read())\n"
                "sys.stdout.write(json.dumps({\n"
                "    'status': 'final',\n"
                "    'transcript': 'Runtime transcription is live.',\n"
                "    'locale': request['locale'],\n"
                "    'confidence': 0.91,\n"
                "    'timing': {'utterance_duration_ms': 520}\n"
                "}))\n",
                encoding="utf-8",
            )

            synthesize_script = tts_provider_root / "synthesize.py"
            synthesize_script.write_text(
                "import json\n"
                "from pathlib import Path\n"
                "import sys\n"
                "request = json.loads(sys.stdin.read())\n"
                "audio_path = Path(request['model_root']) / 'operator-preview.wav'\n"
                "audio_path.write_bytes(b'RIFF')\n"
                "sys.stdout.write(json.dumps({\n"
                "    'status': 'ready',\n"
                "    'text': request['text'],\n"
                "    'locale': request['locale'],\n"
                "    'audio_reference': str(audio_path),\n"
                "    'timing': {'utterance_duration_ms': 640}\n"
                "}))\n",
                encoding="utf-8",
            )

            server = ThreadingHTTPServer(("127.0.0.1", 0), _OllamaHandler)
            _OllamaHandler.response_payload = {
                "response": "Local LLaMA lane is live.",
                "done": True,
            }
            server_thread = threading.Thread(target=server.serve_forever)
            server_thread.start()
            try:
                (llm_provider_root / "runtime.json").write_text(
                    json.dumps(
                        {
                            "endpoint": f"http://127.0.0.1:{server.server_address[1]}",
                            "model": "llama3.1:8b",
                        }
                    ),
                    encoding="utf-8",
                )
                with patch.dict(
                    os.environ,
                    {
                        "NIKOF_LLM_MODELS_ROOT": str(temp_root / "models" / "llm"),
                        "NIKOF_STT_MODELS_ROOT": str(temp_root / "models" / "stt"),
                        "NIKOF_TTS_MODELS_ROOT": str(temp_root / "models" / "tts"),
                        "NIKOF_PROVIDERS_ROOT": str(provider_root),
                    },
                    clear=False,
                ):
                    services = build_default_api_runtime_services()
                    operator_services = build_operator_services(services)
                    turn_publication = services.turn_pipeline_publisher.publish_turn(
                        services.session_service.get_snapshot(),
                        BackendTurnRequest(
                            character_id="test-vrm-01",
                            transcription=SpeechTranscriptionRequest(
                                audio_reference="session://speech-sample/transcription.wav",
                                locale="en-US",
                                transcript_hint="Scaffold transcription unavailable.",
                            ),
                            synthesis=SpeechSynthesisRequest(
                                text="Preview this voice.",
                                locale="en-US",
                            ),
                        ),
                    )
                    text_response = _build_text_question_response(
                        OperatorCommandRequest(
                            command_type="text_question",
                            text="What changed?",
                            locale="en-US",
                        ),
                        normalized_text="What changed?",
                        services=operator_services,
                    )
                    preview_response = _build_tts_preview_response(
                        OperatorCommandRequest(
                            command_type="tts_preview",
                            text="Preview this voice.",
                            locale="en-US",
                        ),
                        normalized_text="Preview this voice.",
                        services=operator_services,
                    )
            finally:
                server.shutdown()
                server.server_close()
                server_thread.join()

        self.assertIsInstance(services.transcription_service, FasterWhisperTranscriptionAdapter)
        self.assertEqual("ready", turn_publication.status)
        self.assertEqual(
            "Runtime transcription is live.",
            turn_publication.speech_lifecycle_events[0].event.transcription.transcript,
        )
        self.assertEqual("ready", text_response.status)
        self.assertEqual(
            "Local LLaMA lane is live.",
            text_response.session_event.assistant.text,
        )
        self.assertEqual("ready", preview_response.status)
        self.assertEqual(
            f"/api/session/speech-artifacts/{preview_response.speech_lifecycle_events[0].event_id}/audio",
            preview_response.speech_lifecycle_events[0].event.synthesis.audio_reference,
        )
        self.assertEqual(
            f"/api/session/speech-artifacts/{preview_response.speech_lifecycle_events[0].event_id}/audio",
            preview_response.session_event.synthesis.audio_reference,
        )

    def test_text_question_shapes_spoken_reply_and_passes_voice_defaults_to_tts(self) -> None:
        with TemporaryDirectory() as temp_dir:
            temp_root = Path(temp_dir)
            provider_root = temp_root / "providers"
            llm_provider_root = provider_root / "llm" / "ollama"
            tts_provider_root = provider_root / "tts" / "gpt-sovits"
            llm_model_root = temp_root / "models" / "llm" / "ollama-llama3.1-8b"
            tts_model_root = temp_root / "models" / "tts" / "gpt-sovits"
            llm_provider_root.mkdir(parents=True)
            tts_provider_root.mkdir(parents=True)
            llm_model_root.mkdir(parents=True)
            tts_model_root.mkdir(parents=True)
            reference_audio_path = tts_model_root / "reference.wav"
            reference_audio_path.write_bytes(b"RIFF")
            captured_payload_path = temp_root / "tts-request.json"

            (tts_model_root / "runtime.json").write_text(
                json.dumps(
                    {
                        "synthesis": {
                            "speaker": "niko-default",
                            "reference_audio": "reference.wav",
                            "prompt_text": "Warm and grounded.",
                            "prompt_language": "en",
                            "style": "runtime-style",
                        }
                    }
                ),
                encoding="utf-8",
            )

            synthesize_script = tts_provider_root / "synthesize.py"
            synthesize_script.write_text(
                "import json\n"
                "from pathlib import Path\n"
                "import sys\n"
                f"capture_path = Path(r'{captured_payload_path}')\n"
                "request = json.loads(sys.stdin.read())\n"
                "capture_path.write_text(json.dumps(request), encoding='utf-8')\n"
                "audio_path = Path(request['model_root']) / 'spoken-reply.wav'\n"
                "audio_path.write_bytes(b'RIFF')\n"
                "sys.stdout.write(json.dumps({\n"
                "    'status': 'ready',\n"
                "    'text': request['text'],\n"
                "    'locale': request['locale'],\n"
                "    'output_path': str(audio_path),\n"
                "    'timing': {'utterance_duration_ms': 480}\n"
                "}))\n",
                encoding="utf-8",
            )

            server = ThreadingHTTPServer(("127.0.0.1", 0), _OllamaHandler)
            _OllamaHandler.response_payload = {
                "response": "I can keep the answer short and clear.",
                "done": True,
            }
            _OllamaHandler.last_request_payload = None
            server_thread = threading.Thread(target=server.serve_forever)
            server_thread.start()
            try:
                (llm_provider_root / "runtime.json").write_text(
                    json.dumps(
                        {
                            "endpoint": f"http://127.0.0.1:{server.server_address[1]}",
                            "model": "llama3.1:8b",
                        }
                    ),
                    encoding="utf-8",
                )
                with patch.dict(
                    os.environ,
                    {
                        "NIKOF_LOCAL_ROOT": str(temp_root),
                        "NIKOF_LLM_MODELS_ROOT": str(temp_root / "models" / "llm"),
                        "NIKOF_TTS_MODELS_ROOT": str(temp_root / "models" / "tts"),
                        "NIKOF_PROVIDERS_ROOT": str(provider_root),
                    },
                    clear=False,
                ):
                    services = build_default_api_runtime_services()
                    operator_services = build_operator_services(services)
                    response = _build_text_question_response(
                        OperatorCommandRequest(
                            command_type="text_question",
                            text="Give me the short answer.",
                            locale="en-US",
                        ),
                        normalized_text="Give me the short answer.",
                        services=operator_services,
                    )
                    captured_payload = json.loads(captured_payload_path.read_text(encoding="utf-8"))
            finally:
                server.shutdown()
                server.server_close()
                server_thread.join()

            self.assertEqual("ready", response.status)
            self.assertIsNotNone(_OllamaHandler.last_request_payload)
            prompt = str(_OllamaHandler.last_request_payload["prompt"])
            self.assertIn("Return only the exact reply text to speak.", prompt)
            self.assertIn("Preferred delivery style: default.", prompt)
            self.assertIn("Voice notes: Replace with a real local TTS voice profile after asset review.", prompt)
            self.assertEqual("test-vrm-01-default", captured_payload["voice_profile_id"])
            self.assertEqual("test-vrm-01-default", captured_payload["voice_profile"]["profile_id"])
            self.assertEqual("default", captured_payload["voice_profile"]["style"])
            self.assertEqual("niko-default", captured_payload["synthesis_options"]["speaker"])
            self.assertEqual(str(reference_audio_path), captured_payload["synthesis_options"]["reference_audio"])
            self.assertEqual("default", captured_payload["synthesis_options"]["style"])

    def test_text_question_skips_tts_invocation_when_llm_is_unavailable(self) -> None:
        with TemporaryDirectory() as temp_dir:
            temp_root = Path(temp_dir)
            provider_root = temp_root / "providers"
            tts_provider_root = provider_root / "tts" / "gpt-sovits"
            tts_model_root = temp_root / "models" / "tts" / "gpt-sovits"
            tts_provider_root.mkdir(parents=True)
            tts_model_root.mkdir(parents=True)
            invoked_marker_path = temp_root / "tts-invoked.txt"

            synthesize_script = tts_provider_root / "synthesize.py"
            synthesize_script.write_text(
                "from pathlib import Path\n"
                "import sys\n"
                f"Path(r'{invoked_marker_path}').write_text('invoked', encoding='utf-8')\n"
                "sys.stdout.write('{}')\n",
                encoding="utf-8",
            )

            with patch.dict(
                os.environ,
                {
                    "NIKOF_LOCAL_ROOT": str(temp_root),
                    "NIKOF_TTS_MODELS_ROOT": str(temp_root / "models" / "tts"),
                    "NIKOF_PROVIDERS_ROOT": str(provider_root),
                },
                clear=False,
            ):
                services = build_default_api_runtime_services()
                operator_services = build_operator_services(services)
                response = _build_text_question_response(
                    OperatorCommandRequest(
                        command_type="text_question",
                        text="Can you still reply?",
                        locale="en-US",
                    ),
                    normalized_text="Can you still reply?",
                    services=operator_services,
                )

            self.assertEqual("unavailable", response.status)
            self.assertFalse(invoked_marker_path.exists())
            synthesis_contract = response.speech_lifecycle_events[1].event.synthesis
            self.assertEqual("unavailable", synthesis_contract.status)
            self.assertIsNone(synthesis_contract.audio_reference)


class DefaultApiRuntimeServicesTests(unittest.TestCase):
    def test_speech_lifecycle_fallback_uses_stub_speech_services(self) -> None:
        services = build_default_api_runtime_services()

        self.assertIsInstance(
            services.speech_lifecycle_service.transcription_service,
            StubSpeechTranscriptionService,
        )
        self.assertIsInstance(
            services.speech_lifecycle_service.synthesis_service,
            StubSpeechSynthesisService,
        )


if __name__ == "__main__":
    unittest.main()