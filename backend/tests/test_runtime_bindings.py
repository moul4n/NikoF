from __future__ import annotations

import os
from pathlib import Path
from tempfile import TemporaryDirectory
import sys
import unittest
from unittest.mock import patch


BACKEND_ROOT = Path(__file__).resolve().parents[1]
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from app.core.settings import AppPaths, get_startup_runtime_prerequisites
from app.schemas.session import LLM_BASELINE_PROFILE_IDS, STT_BASELINE_PROFILE_IDS, TTS_BASELINE_PROFILE_IDS
from app.services.llm import OllamaTextGenerationAdapter, TextGenerationRequest
from app.services.speech import (
    FasterWhisperTranscriptionAdapter,
    GptSovitsSynthesisAdapter,
    SpeechSynthesisRequest,
    SpeechTranscriptionRequest,
)


def build_app_paths(root: Path) -> AppPaths:
    assets_root = root / "assets"
    local_data_root = root / "local"
    models_root = local_data_root / "models"
    return AppPaths(
        repo_root=root,
        assets_root=assets_root,
        character_assets_root=assets_root / "characters",
        local_data_root=local_data_root,
        models_root=models_root,
        llm_models_root=models_root / "llm",
        stt_models_root=models_root / "stt",
        tts_models_root=models_root / "tts",
        embeddings_root=models_root / "embeddings",
        providers_root=local_data_root / "providers",
        cache_root=local_data_root / "cache",
    )


class RuntimeBindingTests(unittest.TestCase):
    def test_gpt_sovits_scaffold_manifests_do_not_count_as_ready_prerequisites(self) -> None:
        with TemporaryDirectory() as temp_dir:
            app_paths = build_app_paths(Path(temp_dir))
            model_root = app_paths.tts_models_root / "gpt-sovits"
            provider_root = app_paths.providers_root / "tts" / "gpt-sovits"
            model_root.mkdir(parents=True)
            provider_root.mkdir(parents=True)
            (model_root / "runtime.json").write_text("{}", encoding="utf-8")
            (model_root / "install-plan.json").write_text("{}", encoding="utf-8")
            (provider_root / "runtime.json").write_text("{}", encoding="utf-8")

            prerequisites = {
                prerequisite.id: prerequisite
                for prerequisite in get_startup_runtime_prerequisites(app_paths=app_paths)
            }

        self.assertEqual("scaffolded", prerequisites["tts-model-gpt-sovits"].state)
        self.assertEqual("scaffolded", prerequisites["tts-provider-entrypoint"].state)
        self.assertFalse(prerequisites["tts-model-gpt-sovits"].present)
        self.assertFalse(prerequisites["tts-provider-entrypoint"].present)

    def test_ollama_scaffold_does_not_count_as_installed_runtime(self) -> None:
        with TemporaryDirectory() as temp_dir:
            app_paths = build_app_paths(Path(temp_dir))
            provider_root = app_paths.providers_root / "llm" / "ollama"
            provider_root.mkdir(parents=True)
            (provider_root / "runtime.json").write_text("{}", encoding="utf-8")

            with patch("app.core.settings._resolve_local_command_path", return_value=None):
                prerequisites = {
                    prerequisite.id: prerequisite
                    for prerequisite in get_startup_runtime_prerequisites(app_paths=app_paths)
                }

        self.assertEqual("missing", prerequisites["provider-ollama"].state)
        self.assertFalse(prerequisites["provider-ollama"].present)

    def test_ollama_binding_aligns_with_bootstrap_provider_layout(self) -> None:
        with TemporaryDirectory() as temp_dir:
            app_paths = build_app_paths(Path(temp_dir))

            with patch.dict(os.environ, {}, clear=True):
                binding = OllamaTextGenerationAdapter(app_paths=app_paths).binding_for(
                    TextGenerationRequest(
                        prompt="What should I do next?",
                        locale="en-US",
                        profile_id=LLM_BASELINE_PROFILE_IDS[0],
                    )
                )

        self.assertEqual(app_paths.providers_root / "llm" / "ollama", binding.provider_root)
        self.assertEqual(app_paths.llm_models_root / "ollama-llama3.1-8b", binding.model_root)
        self.assertEqual("http://127.0.0.1:11434/api/generate", binding.endpoint)
        self.assertEqual("llama3.1:8b", binding.model_name)
        self.assertEqual(90, binding.timeout_seconds)
        self.assertFalse(binding.configured)

    def test_ollama_binding_uses_endpoint_environment_without_local_payloads(self) -> None:
        with TemporaryDirectory() as temp_dir:
            app_paths = build_app_paths(Path(temp_dir))
            provider_root = app_paths.providers_root / "llm" / "ollama"
            model_root = app_paths.llm_models_root / "ollama-llama3.1-8b"
            provider_root.mkdir(parents=True)
            model_root.mkdir(parents=True)
            (provider_root / "runtime.json").write_text(
                '{"endpoint": "http://127.0.0.1:11434", "model": "llama3.1:8b-instruct", "timeout_seconds": 75}',
                encoding="utf-8",
            )

            with patch.dict(
                os.environ,
                {},
                clear=True,
            ):
                binding = OllamaTextGenerationAdapter(app_paths=app_paths).binding_for(
                    TextGenerationRequest(
                        prompt="What should I do next?",
                        locale="en-US",
                        profile_id=LLM_BASELINE_PROFILE_IDS[0],
                    )
                )

        self.assertTrue(binding.configured)
        self.assertEqual("http://127.0.0.1:11434/api/generate", binding.endpoint)
        self.assertEqual("llama3.1:8b-instruct", binding.model_name)
        self.assertEqual(75, binding.timeout_seconds)

    def test_gpt_sovits_binding_prefers_synthesize_entrypoint_by_default(self) -> None:
        with TemporaryDirectory() as temp_dir:
            app_paths = build_app_paths(Path(temp_dir))

            with patch.dict(os.environ, {}, clear=True):
                binding = GptSovitsSynthesisAdapter(app_paths=app_paths).binding_for(
                    SpeechSynthesisRequest(
                        text="This is a voice preview.",
                        locale="en-US",
                        profile_id=TTS_BASELINE_PROFILE_IDS[0],
                    )
                )

        self.assertEqual(app_paths.providers_root / "tts" / "gpt-sovits", binding.provider_root)
        self.assertEqual(app_paths.tts_models_root / "gpt-sovits", binding.model_root)
        self.assertEqual(binding.provider_root / "synthesize.py", binding.invocation_entrypoint)
        self.assertFalse(binding.configured)

    def test_gpt_sovits_binding_accepts_api_server_fallback_entrypoint(self) -> None:
        with TemporaryDirectory() as temp_dir:
            app_paths = build_app_paths(Path(temp_dir))
            provider_root = app_paths.providers_root / "tts" / "gpt-sovits"
            model_root = app_paths.tts_models_root / "gpt-sovits"
            provider_root.mkdir(parents=True)
            model_root.mkdir(parents=True)
            (provider_root / "api_server.py").write_text("print('stub')\n", encoding="utf-8")

            with patch.dict(os.environ, {}, clear=True):
                binding = GptSovitsSynthesisAdapter(app_paths=app_paths).binding_for(
                    SpeechSynthesisRequest(
                        text="This is a voice preview.",
                        locale="en-US",
                        profile_id=TTS_BASELINE_PROFILE_IDS[0],
                    )
                )

        self.assertEqual(binding.provider_root / "api_server.py", binding.invocation_entrypoint)
        self.assertTrue(binding.configured)

    def test_gpt_sovits_binding_uses_runtime_manifest_for_entrypoint_and_python(self) -> None:
        with TemporaryDirectory() as temp_dir:
            app_paths = build_app_paths(Path(temp_dir))
            provider_root = app_paths.providers_root / "tts" / "gpt-sovits"
            model_root = app_paths.tts_models_root / "gpt-sovits"
            provider_root.mkdir(parents=True)
            model_root.mkdir(parents=True)
            custom_entrypoint = provider_root / "vendor" / "launch.py"
            custom_entrypoint.parent.mkdir(parents=True)
            custom_entrypoint.write_text("print('stub')\n", encoding="utf-8")
            runtime_config_path = provider_root / "runtime.json"
            runtime_config_path.write_text(
                '{"entrypoint": "vendor/launch.py", "python_executable": "C:/Tools/GPTSoVITS/python.exe", "timeout_seconds": 45}',
                encoding="utf-8",
            )

            with patch.dict(os.environ, {}, clear=True):
                binding = GptSovitsSynthesisAdapter(app_paths=app_paths).binding_for(
                    SpeechSynthesisRequest(
                        text="This is a voice preview.",
                        locale="en-US",
                        profile_id=TTS_BASELINE_PROFILE_IDS[0],
                    )
                )

        self.assertEqual(custom_entrypoint.resolve(), binding.invocation_entrypoint)
        self.assertEqual(runtime_config_path, binding.runtime_config_path)
        self.assertEqual("C:/Tools/GPTSoVITS/python.exe", binding.python_executable)
        self.assertEqual(45, binding.timeout_seconds)
        self.assertTrue(binding.configured)

    def test_faster_whisper_binding_prefers_transcribe_entrypoint_by_default(self) -> None:
        with TemporaryDirectory() as temp_dir:
            app_paths = build_app_paths(Path(temp_dir))

            with patch.dict(os.environ, {}, clear=True):
                binding = FasterWhisperTranscriptionAdapter(app_paths=app_paths).binding_for(
                    SpeechTranscriptionRequest(
                        audio_reference="session://speech-sample/transcription.wav",
                        locale="en-US",
                        profile_id=STT_BASELINE_PROFILE_IDS[0],
                    )
                )

        self.assertEqual(app_paths.providers_root / "stt" / "faster-whisper", binding.provider_root)
        self.assertEqual(app_paths.stt_models_root / "faster-whisper-medium", binding.model_root)
        self.assertEqual(binding.provider_root / "transcribe.py", binding.invocation_entrypoint)
        self.assertFalse(binding.configured)

    def test_faster_whisper_binding_accepts_main_entrypoint_fallback(self) -> None:
        with TemporaryDirectory() as temp_dir:
            app_paths = build_app_paths(Path(temp_dir))
            provider_root = app_paths.providers_root / "stt" / "faster-whisper"
            model_root = app_paths.stt_models_root / "faster-whisper-medium"
            provider_root.mkdir(parents=True)
            model_root.mkdir(parents=True)
            (provider_root / "main.py").write_text("print('stub')\n", encoding="utf-8")

            with patch.dict(os.environ, {}, clear=True):
                binding = FasterWhisperTranscriptionAdapter(app_paths=app_paths).binding_for(
                    SpeechTranscriptionRequest(
                        audio_reference="session://speech-sample/transcription.wav",
                        locale="en-US",
                        profile_id=STT_BASELINE_PROFILE_IDS[0],
                    )
                )

        self.assertEqual(binding.provider_root / "main.py", binding.invocation_entrypoint)
        self.assertTrue(binding.configured)

    def test_faster_whisper_binding_uses_runtime_manifest_for_entrypoint_and_python(self) -> None:
        with TemporaryDirectory() as temp_dir:
            app_paths = build_app_paths(Path(temp_dir))
            provider_root = app_paths.providers_root / "stt" / "faster-whisper"
            model_root = app_paths.stt_models_root / "faster-whisper-medium"
            provider_root.mkdir(parents=True)
            model_root.mkdir(parents=True)
            custom_entrypoint = provider_root / "vendor" / "launch.py"
            custom_entrypoint.parent.mkdir(parents=True)
            custom_entrypoint.write_text("print('stub')\n", encoding="utf-8")
            runtime_config_path = provider_root / "runtime.json"
            runtime_config_path.write_text(
                '{"entrypoint": "vendor/launch.py", "python_executable": "C:/Tools/FasterWhisper/python.exe", "timeout_seconds": 45}',
                encoding="utf-8",
            )

            with patch.dict(os.environ, {}, clear=True):
                binding = FasterWhisperTranscriptionAdapter(app_paths=app_paths).binding_for(
                    SpeechTranscriptionRequest(
                        audio_reference="session://speech-sample/transcription.wav",
                        locale="en-US",
                        profile_id=STT_BASELINE_PROFILE_IDS[0],
                    )
                )

        self.assertEqual(custom_entrypoint.resolve(), binding.invocation_entrypoint)
        self.assertEqual(runtime_config_path, binding.runtime_config_path)
        self.assertEqual("C:/Tools/FasterWhisper/python.exe", binding.python_executable)
        self.assertEqual(45, binding.timeout_seconds)
        self.assertTrue(binding.configured)


if __name__ == "__main__":
    unittest.main()