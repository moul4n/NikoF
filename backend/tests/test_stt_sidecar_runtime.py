from __future__ import annotations

import sys
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import Mock, PropertyMock, patch


BACKEND_ROOT = Path(__file__).resolve().parents[1]
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from app.core.settings import AppPaths
from app.services.stt_server import load_server_config, FasterWhisperServerManager


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


class FasterWhisperServerRuntimeTests(unittest.TestCase):
    def test_server_not_configured_for_scaffolded_model_root_only(self) -> None:
        with TemporaryDirectory() as temp_dir:
            app_paths = build_app_paths(Path(temp_dir))
            model_root = app_paths.stt_models_root / "faster-whisper-medium"
            model_root.mkdir(parents=True)
            (model_root / "runtime.json").write_text("{}\n", encoding="utf-8")
            (model_root / "install-plan.json").write_text("{}\n", encoding="utf-8")

            manager = FasterWhisperServerManager(load_server_config(app_paths))

        self.assertFalse(manager.server_configured)

    def test_server_configured_when_payload_and_server_script_exist(self) -> None:
        with TemporaryDirectory() as temp_dir:
            app_paths = build_app_paths(Path(temp_dir))
            model_root = app_paths.stt_models_root / "faster-whisper-medium"
            provider_root = app_paths.providers_root / "stt" / "faster-whisper"
            model_root.mkdir(parents=True)
            provider_root.mkdir(parents=True)
            (model_root / "model.bin").write_text("payload\n", encoding="utf-8")
            (provider_root / "main.py").write_text("print('stub')\n", encoding="utf-8")

            manager = FasterWhisperServerManager(load_server_config(app_paths))
            self.assertTrue(manager.server_configured)

    def test_start_reclaims_existing_healthy_sidecar_before_launch(self) -> None:
        with TemporaryDirectory() as temp_dir:
            app_paths = build_app_paths(Path(temp_dir))
            manager = FasterWhisperServerManager(load_server_config(app_paths))

            with patch.object(FasterWhisperServerManager, "is_running", new_callable=PropertyMock, return_value=False), \
                patch.object(FasterWhisperServerManager, "is_healthy", new_callable=PropertyMock, return_value=True), \
                patch.object(FasterWhisperServerManager, "server_configured", new_callable=PropertyMock, return_value=True), \
                patch.object(manager, "_reclaim_external_server", return_value=True) as reclaim_mock, \
                patch.object(manager, "_wait_for_healthy", return_value=True), \
                patch("app.services.stt_server.subprocess.Popen") as popen_mock:
                process = Mock()
                process.poll.return_value = None
                popen_mock.return_value = process

                self.assertTrue(manager.start(allow_gpu=False))

            reclaim_mock.assert_called_once_with()
            popen_mock.assert_called_once()

    def test_start_fails_when_existing_healthy_sidecar_cannot_be_reclaimed(self) -> None:
        with TemporaryDirectory() as temp_dir:
            app_paths = build_app_paths(Path(temp_dir))
            manager = FasterWhisperServerManager(load_server_config(app_paths))

            with patch.object(FasterWhisperServerManager, "is_running", new_callable=PropertyMock, return_value=False), \
                patch.object(FasterWhisperServerManager, "is_healthy", new_callable=PropertyMock, return_value=True), \
                patch.object(manager, "_reclaim_external_server", return_value=False), \
                patch("app.services.stt_server.subprocess.Popen") as popen_mock:
                self.assertFalse(manager.start(allow_gpu=False))

            popen_mock.assert_not_called()

    def test_kill_process_uses_tree_termination(self) -> None:
        manager = FasterWhisperServerManager()
        process = Mock()
        process.pid = 1234
        manager._process = process

        with patch("app.services.stt_server.terminate_process_tree") as terminate_mock:
            manager._kill_process()

        terminate_mock.assert_called_once_with(process)
        self.assertIsNone(manager._process)


if __name__ == "__main__":
    unittest.main()