from __future__ import annotations

import json
import socket
from pathlib import Path
import subprocess
from tempfile import TemporaryDirectory
import sys
import time
import unittest
from unittest.mock import patch


BACKEND_ROOT = Path(__file__).resolve().parents[1]
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from app.api.resource_routes import build_resource_status_response
from app.core.settings import AppPaths
from app.services.llm import (
    TextGenerationRequest,
    build_text_generation_sidecar_manager,
)
from app.services.process_supervision import process_exists
from app.services.resource_monitor import get_resource_monitor


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


class TextGenerationSidecarManagerTests(unittest.TestCase):
    def setUp(self) -> None:
        get_resource_monitor().tracker("llm").mark_unloaded()

    def test_status_transitions_from_idle_to_ready_after_successful_generate(self) -> None:
        with TemporaryDirectory() as temp_dir:
            app_paths = build_app_paths(Path(temp_dir))
            provider_root = app_paths.providers_root / "llm" / "ollama"
            model_root = app_paths.llm_models_root / "ollama-llama3.1-8b"
            provider_root.mkdir(parents=True)
            model_root.mkdir(parents=True)
            manager = build_text_generation_sidecar_manager(app_paths)
            request = TextGenerationRequest(prompt="What is next?", locale="en-US")

            initial_status = manager.status(request)

            with patch(
                "app.services.llm._read_json_response",
                return_value={"status": "ready", "response": "Keep the backend seam narrow."},
            ):
                contract = manager.resolve(request).generate(request)

            final_status = manager.status(request)

        self.assertEqual("idle", initial_status.state.value)
        self.assertTrue(initial_status.configured)
        self.assertFalse(initial_status.loaded)
        self.assertEqual("ready", contract.status)
        self.assertEqual("ready", final_status.state.value)
        self.assertTrue(final_status.configured)
        self.assertTrue(final_status.available)
        self.assertTrue(final_status.loaded)
        self.assertEqual("llama3.1:8b", final_status.model_name)
        self.assertGreaterEqual(final_status.requests_processed, 1)

    def test_managed_sidecar_starts_on_first_generate_and_tracks_process_state(self) -> None:
        with TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            app_paths = build_app_paths(root)
            provider_root = app_paths.providers_root / "llm" / "ollama"
            model_root = app_paths.llm_models_root / "ollama-llama3.1-8b"
            provider_root.mkdir(parents=True)
            model_root.mkdir(parents=True)
            port = _reserve_local_port()
            server_script = root / "fake_ollama_sidecar.py"
            server_script.write_text(_FAKE_OLLAMA_SERVER_SCRIPT, encoding="utf-8")
            (provider_root / "runtime.json").write_text(
                json.dumps(
                    {
                        "endpoint": f"http://127.0.0.1:{port}",
                        "health_url": f"http://127.0.0.1:{port}/api/tags",
                        "model": "llama3.1:8b",
                        "manage_process": True,
                        "startup_timeout_seconds": 10,
                        "health_timeout_seconds": 1,
                        "serve_command": [sys.executable, str(server_script), str(port)],
                    }
                ),
                encoding="utf-8",
            )
            manager = build_text_generation_sidecar_manager(app_paths)
            request = TextGenerationRequest(prompt="What is next?", locale="en-US")

            initial_status = manager.status(request)
            contract = manager.resolve(request).generate(request)
            started_status = manager.status(request)
            owner_pid = started_status.owner_pid

            manager.stop()
            stopped_status = manager.status(request)

        self.assertTrue(initial_status.process_managed)
        self.assertFalse(initial_status.process_running)
        self.assertEqual("ready", contract.status)
        self.assertEqual("Keep the backend seam narrow.", contract.text)
        self.assertTrue(started_status.process_running)
        self.assertTrue(started_status.process_healthy)
        self.assertTrue(started_status.started_by_backend)
        self.assertIsNotNone(owner_pid)
        self.assertFalse(stopped_status.process_running)
        self.assertFalse(stopped_status.started_by_backend)
        self.assertFalse(process_exists(owner_pid))

    def test_managed_start_reclaims_external_listener_and_takes_ownership(self) -> None:
        with TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            app_paths = build_app_paths(root)
            provider_root = app_paths.providers_root / "llm" / "ollama"
            model_root = app_paths.llm_models_root / "ollama-llama3.1-8b"
            provider_root.mkdir(parents=True)
            model_root.mkdir(parents=True)
            port = _reserve_local_port()
            server_script = root / "fake_ollama_sidecar.py"
            server_script.write_text(_FAKE_OLLAMA_SERVER_SCRIPT, encoding="utf-8")
            (provider_root / "runtime.json").write_text(
                json.dumps(
                    {
                        "endpoint": f"http://127.0.0.1:{port}",
                        "health_url": f"http://127.0.0.1:{port}/api/tags",
                        "model": "llama3.1:8b",
                        "manage_process": True,
                        "startup_timeout_seconds": 10,
                        "health_timeout_seconds": 1,
                        "serve_command": [sys.executable, str(server_script), str(port)],
                    }
                ),
                encoding="utf-8",
            )
            external_process = subprocess.Popen([sys.executable, str(server_script), str(port)])
            self.addCleanup(lambda: process_exists(external_process.pid) and external_process.kill())
            _wait_for_port_health(port)

            manager = build_text_generation_sidecar_manager(app_paths)
            started = manager.start(TextGenerationRequest(prompt="", locale="en-US"))
            status = manager.status(TextGenerationRequest(prompt="", locale="en-US"))
            owner_pid = status.owner_pid

            manager.stop()
            try:
                external_process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                external_process.kill()
                external_process.wait(timeout=5)

        self.assertTrue(started)
        self.assertTrue(status.process_running)
        self.assertTrue(status.process_healthy)
        self.assertTrue(status.started_by_backend)
        self.assertIsNotNone(owner_pid)
        self.assertNotEqual(owner_pid, external_process.pid)
        self.assertFalse(process_exists(external_process.pid))

    def test_resource_status_response_includes_llm_sidecar_payload(self) -> None:
        with TemporaryDirectory() as temp_dir:
            app_paths = build_app_paths(Path(temp_dir))
            provider_root = app_paths.providers_root / "llm" / "ollama"
            model_root = app_paths.llm_models_root / "ollama-llama3.1-8b"
            provider_root.mkdir(parents=True)
            model_root.mkdir(parents=True)
            manager = build_text_generation_sidecar_manager(app_paths)
            request = TextGenerationRequest(prompt="Respond.", locale="en-US")

            with patch(
                "app.services.llm._read_json_response",
                return_value={"status": "ready", "response": "Structured lane is active."},
            ):
                manager.resolve(request).generate(request)

            response = build_resource_status_response(llm_sidecar_manager=manager)

        self.assertIn("state", response.llm_sidecar)
        self.assertEqual("ready", response.llm_sidecar["state"])
        self.assertEqual("llama3.1:8b", response.llm_sidecar["model_name"])
        self.assertTrue(response.llm_sidecar["loaded"])
        self.assertIn("process_managed", response.llm_sidecar)
        self.assertIn("process_running", response.llm_sidecar)

    def test_status_does_not_probe_health_for_unmanaged_runtime(self) -> None:
        with TemporaryDirectory() as temp_dir:
            app_paths = build_app_paths(Path(temp_dir))
            provider_root = app_paths.providers_root / "llm" / "ollama"
            model_root = app_paths.llm_models_root / "ollama-llama3.1-8b"
            provider_root.mkdir(parents=True)
            model_root.mkdir(parents=True)
            manager = build_text_generation_sidecar_manager(app_paths)

            with patch("app.services.llm._read_health_response") as read_health_response:
                status = manager.status(TextGenerationRequest(prompt="", locale="en-US"))

        self.assertEqual("idle", status.state.value)
        self.assertFalse(status.process_managed)
        self.assertFalse(status.process_healthy)
        read_health_response.assert_not_called()


def _reserve_local_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as candidate:
        candidate.bind(("127.0.0.1", 0))
        return int(candidate.getsockname()[1])


def _wait_for_port_health(port: int, timeout_seconds: float = 5.0) -> None:
    deadline = time.monotonic() + timeout_seconds
    while time.monotonic() < deadline:
        candidate = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        try:
            candidate.settimeout(0.25)
            candidate.connect(("127.0.0.1", port))
            return
        except OSError:
            time.sleep(0.05)
        finally:
            candidate.close()

    raise AssertionError(f"Timed out waiting for test server on port {port}")


_FAKE_OLLAMA_SERVER_SCRIPT = """
from __future__ import annotations

import json
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse


PORT = int(sys.argv[1])


class Handler(BaseHTTPRequestHandler):
    def log_message(self, format, *args):
        del format, args

    def _write_json(self, payload: dict[str, object], status: int = 200) -> None:
        body = json.dumps(payload).encode('utf-8')
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:
        parsed = urlparse(self.path)
        if parsed.path == '/api/tags':
            self._write_json({'models': [{'name': 'llama3.1:8b'}]})
            return
        self._write_json({'detail': 'Not Found'}, status=404)

    def do_POST(self) -> None:
        parsed = urlparse(self.path)
        length = int(self.headers.get('Content-Length', '0'))
        raw = self.rfile.read(length) if length else b'{}'
        payload = json.loads(raw.decode('utf-8')) if raw else {}
        if parsed.path == '/api/generate':
            self._write_json({'status': 'ready', 'response': 'Keep the backend seam narrow.'})
            return
        if parsed.path == '/shutdown':
            self._write_json({'status': 'shutdown'})
            threading.Thread(target=self.server.shutdown, daemon=True).start()
            return
        self._write_json({'detail': 'Not Found', 'payload': payload}, status=404)


server = ThreadingHTTPServer(('127.0.0.1', PORT), Handler)
try:
    server.serve_forever()
finally:
    server.server_close()
"""