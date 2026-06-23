"""Manager-level lifecycle gate: drive the real FasterWhisperServerManager through
start -> health -> stop against a tiny stub sidecar (no models, no GPU).

This exercises the wrapper that production uses — spawning an owned process,
polling /health until ready, owned-PID identity, and graceful /shutdown that
leaves no orphan — without needing the ~2GB Parakeet/Faster-Whisper payloads.
Complements test_process_lifecycle.py (the raw primitives) for Phase 1D.
"""

import socket
import tempfile
import time
import unittest
from pathlib import Path

from app.services.process_supervision import process_exists
from app.services.stt_server import FasterWhisperServerConfig, FasterWhisperServerManager

# A self-contained stub that speaks just enough of the sidecar HTTP contract the
# manager needs: GET /health -> {"status":"ready"} and POST /shutdown -> exit.
_STUB_SIDECAR = """\
import argparse, json, sys, threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

parser = argparse.ArgumentParser()
parser.add_argument("--host", default="127.0.0.1")
parser.add_argument("--port", type=int, required=True)
parser.add_argument("--model-root", default="")
args = parser.parse_args()


class Handler(BaseHTTPRequestHandler):
    def _json(self, payload):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == "/state":
            self._json({"status": "ready", "listening": False, "next_sequence": 1})
        else:
            self._json({"status": "ready"})

    def do_POST(self):
        length = int(self.headers.get("Content-Length") or 0)
        if length:
            self.rfile.read(length)
        self._json({"status": "stopping" if self.path == "/shutdown" else "ready"})
        if self.path == "/shutdown":
            threading.Thread(target=server.shutdown, daemon=True).start()

    def log_message(self, *args):
        pass


server = ThreadingHTTPServer((args.host, args.port), Handler)
server.serve_forever()
"""


def _free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
        probe.bind(("127.0.0.1", 0))
        return probe.getsockname()[1]


def _wait_until(predicate, *, timeout: float = 10.0, interval: float = 0.1) -> bool:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return True
        time.sleep(interval)
    return predicate()


class SidecarManagerLifecycleTests(unittest.TestCase):
    def setUp(self) -> None:
        import sys

        self._tmp = tempfile.TemporaryDirectory()
        root = Path(self._tmp.name)
        provider_root = root / "provider"
        model_root = root / "model"
        provider_root.mkdir(parents=True)
        model_root.mkdir(parents=True)
        (provider_root / "main.py").write_text(_STUB_SIDECAR, encoding="utf-8")
        # A non-scaffold payload file so server_configured passes for faster-whisper.
        (model_root / "model.bin").write_text("stub", encoding="utf-8")

        self._config = FasterWhisperServerConfig(
            host="127.0.0.1",
            port=_free_port(),
            python_executable=sys.executable,
            server_script="main.py",
            model_root=model_root,
            provider_root=provider_root,
            log_root=root / "logs",
            engine="faster-whisper",
        )
        self._manager = FasterWhisperServerManager(config=self._config)

    def tearDown(self) -> None:
        try:
            self._manager.stop()
        except Exception:
            pass
        self._tmp.cleanup()

    def test_start_reports_healthy_with_owned_pid(self) -> None:
        self.assertTrue(self._manager.server_configured)
        self.assertTrue(self._manager.start(allow_gpu=False), "manager.start did not report success")
        self.assertTrue(self._manager.is_running)
        self.assertTrue(self._manager.is_healthy)
        owner_pid = self._manager.owner_pid
        self.assertIsNotNone(owner_pid)
        self.assertTrue(process_exists(owner_pid))

    def test_stop_is_graceful_and_leaves_no_orphan(self) -> None:
        self.assertTrue(self._manager.start(allow_gpu=False))
        owner_pid = self._manager.owner_pid
        self.assertTrue(process_exists(owner_pid))

        self._manager.stop()

        self.assertFalse(self._manager.is_running)
        self.assertTrue(
            _wait_until(lambda: not process_exists(owner_pid)),
            "sidecar process was orphaned after stop()",
        )

    def test_start_is_idempotent_when_already_healthy(self) -> None:
        self.assertTrue(self._manager.start(allow_gpu=False))
        first_pid = self._manager.owner_pid
        # Starting again while healthy should be a no-op that keeps the same process.
        self.assertTrue(self._manager.start(allow_gpu=False))
        self.assertEqual(self._manager.owner_pid, first_pid)

    def test_unconfigured_manager_refuses_to_start(self) -> None:
        # Remove the payload proof -> server_configured False -> start returns False
        # instead of spawning a doomed sidecar.
        (self._config.model_root / "model.bin").unlink()
        self.assertFalse(self._manager.server_configured)
        self.assertFalse(self._manager.start(allow_gpu=False))


if __name__ == "__main__":
    unittest.main()
