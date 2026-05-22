from __future__ import annotations

import sys
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import MagicMock, PropertyMock, patch


BACKEND_ROOT = Path(__file__).resolve().parents[1]
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from app.core.settings import AppPaths
from app.services.resource_monitor import (
    OwnedProcessSnapshot,
    SubsystemStatus,
    _label_owned_process,
    _apply_owned_process_gpu_fallbacks,
)
from app.services.speech import SpeechSynthesisRequest
from app.services.tts_server import (
    GPTSoVITSServerConfig,
    GPTSoVITSServerError,
    GPTSoVITSServerManager,
    load_server_config,
)
from app.services.tts_worker import TTSWorker, TTSWorkerState


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


class _FakeTracker:
    def __init__(self) -> None:
        self.loaded = False
        self.vram_allocated_mb = None
        self.requests_processed = 0
        self.average_latency_ms = None

    def snapshot(self):
        class _Snap:
            requests_processed = 0
            average_latency_ms = None
            vram_allocated_mb = None

        return _Snap()

    def mark_loaded(self, model_name: str, vram_mb: float | None = None, ram_mb: float | None = None) -> None:
        del model_name, ram_mb
        self.loaded = True
        self.vram_allocated_mb = vram_mb

    def record_request(self, latency_ms: float) -> None:
        del latency_ms

    def mark_unloaded(self) -> None:
        self.loaded = False
        self.vram_allocated_mb = None


class _FakeMonitor:
    def __init__(self) -> None:
        self._tracker = _FakeTracker()

    def tracker(self, subsystem: str):
        self.last_subsystem = subsystem
        return self._tracker

    def can_load_subsystem(self, subsystem: str, estimated_vram_mb: float) -> bool:
        del subsystem, estimated_vram_mb
        return True


class _FakeServerManager:
    def __init__(self, *, configured: bool = True, start_result: bool = False) -> None:
        self.server_configured = configured
        self._start_result = start_result
        self.config = type(
            "Config",
            (),
            {
                "provider_root": Path("provider-root"),
                "model_root": Path("model-root"),
                "base_url": "http://127.0.0.1:9880",
            },
        )()

    def start(self) -> bool:
        return self._start_result


class TTSWorkerSidecarRuntimeTests(unittest.TestCase):
    def test_worker_keeps_unavailable_state_when_sidecar_start_fails(self) -> None:
        fake_monitor = _FakeMonitor()
        fake_manager = _FakeServerManager(configured=True, start_result=False)

        with patch("app.services.tts_worker.get_resource_monitor", return_value=fake_monitor), patch(
            "app.services.tts_worker.get_server_manager",
            return_value=fake_manager,
        ):
            worker = TTSWorker()
            loaded = worker._load_model()
            contract = worker._synthesize(
                SpeechSynthesisRequest(
                    text="Sidecar failed to start.",
                    locale="en-US",
                )
            )

        self.assertFalse(loaded)
        self.assertEqual(TTSWorkerState.ERROR, worker.state)
        self.assertEqual("TTS sidecar failed to start", worker.status().last_error)
        self.assertEqual("unavailable", contract.status)
        self.assertEqual("Sidecar failed to start.", contract.text)


class GPTSoVITSServerOwnershipTests(unittest.TestCase):
    def test_load_server_config_prefers_headless_api_entrypoints_when_present(self) -> None:
        with TemporaryDirectory() as temp_dir:
            app_paths = build_app_paths(Path(temp_dir))
            provider_root = app_paths.providers_root / "tts" / "gpt-sovits"
            provider_root.mkdir(parents=True)
            (provider_root / "api_server.py").write_text("print('server')\n", encoding="utf-8")
            (provider_root / "api_v2.py").write_text("print('api v2')\n", encoding="utf-8")

            config = load_server_config(app_paths)

        self.assertEqual("api_v2.py", config.server_script)

    def test_load_server_config_falls_back_to_api_server_when_no_headless_api_exists(self) -> None:
        with TemporaryDirectory() as temp_dir:
            app_paths = build_app_paths(Path(temp_dir))
            provider_root = app_paths.providers_root / "tts" / "gpt-sovits"
            provider_root.mkdir(parents=True)
            (provider_root / "api_server.py").write_text("print('server')\n", encoding="utf-8")

            config = load_server_config(app_paths)

        self.assertEqual("api_server.py", config.server_script)

    def test_load_server_config_uses_runtime_timeout_override(self) -> None:
        with TemporaryDirectory() as temp_dir:
            app_paths = build_app_paths(Path(temp_dir))
            provider_root = app_paths.providers_root / "tts" / "gpt-sovits"
            provider_root.mkdir(parents=True)
            (provider_root / "runtime.json").write_text('{"timeout_seconds": 90}', encoding="utf-8")

            config = load_server_config(app_paths)

        self.assertEqual(90, config.startup_timeout_seconds)

    def test_start_refuses_external_healthy_listener(self) -> None:
        with TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            config = GPTSoVITSServerConfig(
                host="127.0.0.1",
                port=19980,
                python_executable=sys.executable,
                server_script="api_server.py",
                model_root=root / "model",
                provider_root=root / "provider",
                log_root=root / "logs",
            )
            manager = GPTSoVITSServerManager(config=config)

            with patch.object(GPTSoVITSServerManager, "is_healthy", new_callable=PropertyMock, return_value=True):
                started = manager.start()

        self.assertFalse(started)
        self.assertIsNone(manager.owner_pid)

    def test_wait_for_healthy_uses_configured_startup_timeout(self) -> None:
        config = GPTSoVITSServerConfig(startup_timeout_seconds=1.0)
        manager = GPTSoVITSServerManager(config=config)
        manager._process = MagicMock()
        manager._process.poll.return_value = None

        with patch("app.services.tts_server._http_json_request") as http_request, patch(
            "app.services.tts_server.time.time",
            side_effect=[10.0, 10.0, 11.1],
        ), patch("app.services.tts_server.time.sleep"):
            http_request.side_effect = [GPTSoVITSServerError("still loading"), {"status": "ready"}]

            healthy = manager._wait_for_healthy()

        self.assertFalse(healthy)
        self.assertEqual(1, http_request.call_count)

    def test_synthesize_waits_for_transient_recovery_before_restart(self) -> None:
        manager = GPTSoVITSServerManager()
        manager._started = True
        manager._process = MagicMock()
        manager._process.poll.return_value = None

        with patch("app.services.tts_server._http_json_request") as http_request, patch.object(
            manager,
            "restart",
            return_value=True,
        ) as restart:
            http_request.side_effect = [
                GPTSoVITSServerError("Connection failed: [WinError 10054]"),
                {"status": "ready"},
                {"status": "ready", "audio_reference": "artifact.wav"},
            ]

            response = manager.synthesize({"text": "Recover without restart"})

        self.assertEqual("artifact.wav", response["audio_reference"])
        restart.assert_not_called()


class ResourceMonitorFallbackTests(unittest.TestCase):
    def test_label_owned_process_treats_headless_api_entrypoints_as_tts_sidecar(self) -> None:
        self.assertEqual(
            "tts-sidecar",
            _label_owned_process("python api_v2.py", "python.exe", current_pid=100, pid=101),
        )
        self.assertEqual(
            "tts-sidecar",
            _label_owned_process("python api.py", "python.exe", current_pid=100, pid=101),
        )

    def test_owned_processes_use_subsystem_vram_when_gpu_process_memory_is_hidden(self) -> None:
        owned = (
            OwnedProcessSnapshot(
                pid=25016,
                parent_pid=9648,
                label="tts-sidecar",
                process_name="python.exe",
                executable="D:/GPT-SoVITS/runtime/python.exe",
                command="python api_server.py",
                status="running",
                rss_mb=1600.0,
                gpu_memory_mb=None,
            ),
            OwnedProcessSnapshot(
                pid=9648,
                parent_pid=33560,
                label="backend",
                process_name="python.exe",
                executable="python.exe",
                command="python -m app.dev_server",
                status="running",
                rss_mb=58.0,
                gpu_memory_mb=None,
            ),
        )
        subsystems = (
            SubsystemStatus(
                subsystem="tts",
                loaded=True,
                model_name="gpt-sovits server",
                vram_allocated_mb=3500.0,
                ram_allocated_mb=512.0,
                last_request_epoch=None,
                requests_processed=1,
                average_latency_ms=925.5,
            ),
            SubsystemStatus(
                subsystem="llm",
                loaded=False,
                model_name=None,
                vram_allocated_mb=None,
                ram_allocated_mb=None,
                last_request_epoch=None,
                requests_processed=0,
                average_latency_ms=None,
            ),
        )

        adjusted = _apply_owned_process_gpu_fallbacks(owned, subsystems)

        self.assertEqual(3500.0, adjusted[0].gpu_memory_mb)
        self.assertIsNone(adjusted[1].gpu_memory_mb)


if __name__ == "__main__":
    unittest.main()