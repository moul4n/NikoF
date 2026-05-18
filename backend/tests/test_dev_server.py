from __future__ import annotations

from contextlib import redirect_stderr
from io import StringIO
from pathlib import Path
from tempfile import TemporaryDirectory
import sys
import unittest
from unittest.mock import patch


BACKEND_ROOT = Path(__file__).resolve().parents[1]
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from app import dev_server
from app.core.settings import AppPaths, BootstrapProviderPrerequisite, get_startup_runtime_prerequisites


REPO_ROOT = BACKEND_ROOT.parents[0]


def build_app_paths(local_root: Path) -> AppPaths:
    assets_root = REPO_ROOT / "assets"
    models_root = local_root / "models"
    return AppPaths(
        repo_root=REPO_ROOT,
        assets_root=assets_root,
        character_assets_root=assets_root / "characters",
        local_data_root=local_root,
        models_root=models_root,
        llm_models_root=models_root / "llm",
        stt_models_root=models_root / "stt",
        tts_models_root=models_root / "tts",
        embeddings_root=models_root / "embeddings",
        providers_root=local_root / "providers",
        cache_root=local_root / "cache",
    )


class DevServerStartupGuardTests(unittest.TestCase):
    def test_allows_start_when_port_is_available(self) -> None:
        with patch("app.dev_server._is_port_available", return_value=True):
            dev_server.ensure_startup_ready()

    def test_rejects_duplicate_start_when_backend_is_healthy(self) -> None:
        with patch("app.dev_server._is_port_available", return_value=False), patch(
            "app.dev_server._healthcheck_responding", return_value=True
        ):
            with self.assertRaises(SystemExit) as raised:
                dev_server.ensure_startup_ready()

        self.assertIn("already running", str(raised.exception))

    def test_rejects_stale_listener_when_healthcheck_fails(self) -> None:
        with patch("app.dev_server._is_port_available", return_value=False), patch(
            "app.dev_server._healthcheck_responding", return_value=False
        ):
            with self.assertRaises(SystemExit) as raised:
                dev_server.ensure_startup_ready()

        self.assertIn("stale listener", str(raised.exception))

    def test_prerequisite_guidance_includes_resume_hook_and_hint_file(self) -> None:
        stderr = StringIO()
        prerequisite = BootstrapProviderPrerequisite(
            id="tts-provider-entrypoint",
            display_name="GPT-SoVITS provider entrypoint",
            root_key="providers_root",
            expected_path=Path("C:/Users/fletc/AppData/Local/NikoF/providers/tts/gpt-sovits/synthesize.py"),
            expected_paths=(Path("C:/Users/fletc/AppData/Local/NikoF/providers/tts/gpt-sovits/synthesize.py"),),
            present=False,
            state="scaffolded",
            required=True,
            upstream="Project-local adapter wrapper under the configured providers root.",
            manual_install="Place a provider-local Python entrypoint under the configured providers root.",
            hook_id="tts-provider-manual",
            hook_command="powershell -ExecutionPolicy Bypass -File .\\scripts\\bootstrap\\bootstrap.ps1 -RunHook tts-provider-manual",
            runtime_config_path=Path("C:/Users/fletc/AppData/Local/NikoF/providers/tts/gpt-sovits/runtime.json"),
            install_plan_path=Path("C:/Users/fletc/AppData/Local/NikoF/providers/tts/gpt-sovits/install-plan.json"),
            hint_path=Path("C:/Users/fletc/Sources/NikoF/.local/bootstrap/hints/tts-provider-entrypoint.txt"),
        )

        with patch("app.dev_server.get_startup_runtime_prerequisites", return_value=(prerequisite,)), redirect_stderr(stderr):
            dev_server._emit_runtime_prerequisite_guidance()

        output = stderr.getvalue()
        self.assertIn("State: scaffolded", output)
        self.assertIn("Resume hook:", output)
        self.assertIn(str(prerequisite.hook_command), output)
        self.assertIn("Hint file:", output)
        self.assertIn(str(prerequisite.hint_path), output)

    def test_prerequisite_guidance_lists_both_gpt_sovits_blockers_for_scaffolded_setup(self) -> None:
        with TemporaryDirectory() as temp_dir:
            app_paths = build_app_paths(Path(temp_dir) / "local")
            model_root = app_paths.tts_models_root / "gpt-sovits"
            provider_root = app_paths.providers_root / "tts" / "gpt-sovits"
            model_root.mkdir(parents=True)
            provider_root.mkdir(parents=True)
            (model_root / "runtime.json").write_text("{}", encoding="utf-8")
            (model_root / "install-plan.json").write_text("{}", encoding="utf-8")
            (provider_root / "runtime.json").write_text("{}", encoding="utf-8")

            prerequisites = get_startup_runtime_prerequisites(app_paths=app_paths)
            stderr = StringIO()
            with patch("app.dev_server.get_startup_runtime_prerequisites", return_value=prerequisites), redirect_stderr(stderr):
                dev_server._emit_runtime_prerequisite_guidance()

        output = stderr.getvalue()
        self.assertIn("GPT-SoVITS model/runtime payload root", output)
        self.assertIn("GPT-SoVITS provider entrypoint", output)
        self.assertIn("State: scaffolded", output)
        self.assertIn(str(model_root / "install-plan.json"), output)
        self.assertIn("Install or extract the approved GPT-SoVITS payload", output)
        self.assertIn("Place a provider-local Python entrypoint", output)

    def test_prerequisite_guidance_lists_faster_whisper_blockers_for_scaffolded_setup(self) -> None:
        with TemporaryDirectory() as temp_dir:
            app_paths = build_app_paths(Path(temp_dir) / "local")
            model_root = app_paths.stt_models_root / "faster-whisper-medium"
            provider_root = app_paths.providers_root / "stt" / "faster-whisper"
            model_root.mkdir(parents=True)
            provider_root.mkdir(parents=True)
            (model_root / "runtime.json").write_text("{}", encoding="utf-8")
            (model_root / "install-plan.json").write_text("{}", encoding="utf-8")
            (provider_root / "runtime.json").write_text("{}", encoding="utf-8")

            prerequisites = get_startup_runtime_prerequisites(app_paths=app_paths)
            stderr = StringIO()
            with patch("app.dev_server.get_startup_runtime_prerequisites", return_value=prerequisites), redirect_stderr(stderr):
                dev_server._emit_runtime_prerequisite_guidance()

        output = stderr.getvalue()
        self.assertIn("Faster-Whisper Medium", output)
        self.assertIn("Faster-Whisper provider entrypoint", output)
        self.assertIn("State: scaffolded", output)
        self.assertIn(str(model_root / "install-plan.json"), output)
        self.assertIn("Install or extract the approved Faster-Whisper Medium payload", output)
        self.assertIn("Place a provider-local Python entrypoint", output)


if __name__ == "__main__":
    unittest.main()