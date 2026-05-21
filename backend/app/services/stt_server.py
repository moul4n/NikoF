from __future__ import annotations

import json
import logging
import os
import subprocess
import sys
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any
from urllib import error as urllib_error
from urllib import request as urllib_request

from app.core.settings import AppPaths, _has_faster_whisper_payload_proof, get_app_paths


logger = logging.getLogger(__name__)

DEFAULT_SERVER_HOST = "127.0.0.1"
DEFAULT_SERVER_PORT = 8767
SERVER_STARTUP_TIMEOUT_SECONDS = 45.0
SERVER_POLL_INTERVAL_SECONDS = 0.5
HEALTH_CHECK_TIMEOUT_SECONDS = 2.0
SERVER_RECLAIM_TIMEOUT_SECONDS = 10.0


def _default_log_root(app_paths: AppPaths | None = None) -> Path:
    paths = app_paths or get_app_paths()
    return paths.local_data_root / "logs" / "stt"


def _backend_root() -> Path:
    return Path(__file__).resolve().parents[2]


def _ensure_runtime_files(provider_root: Path) -> None:
    provider_root.mkdir(parents=True, exist_ok=True)
    runtime_path = provider_root / "runtime.json"
    transcribe_path = provider_root / "transcribe.py"
    main_path = provider_root / "main.py"

    if not transcribe_path.exists():
        transcribe_path.write_text(
            "from __future__ import annotations\n"
            "import os\n"
            "import sys\n"
            "from pathlib import Path\n"
            "backend_root = os.environ.get('NIKOF_BACKEND_ROOT', '').strip()\n"
            "if backend_root:\n"
            "    sys.path.insert(0, str(Path(backend_root)))\n"
            "from app.providers.faster_whisper_runtime import run_stdin_transcribe\n"
            "raise SystemExit(run_stdin_transcribe())\n",
            encoding="utf-8",
        )

    if not main_path.exists():
        main_path.write_text(
            "from __future__ import annotations\n"
            "import os\n"
            "import sys\n"
            "from pathlib import Path\n"
            "backend_root = os.environ.get('NIKOF_BACKEND_ROOT', '').strip()\n"
            "if backend_root:\n"
            "    sys.path.insert(0, str(Path(backend_root)))\n"
            "from app.providers.faster_whisper_runtime import run_server_cli\n"
            "raise SystemExit(run_server_cli())\n",
            encoding="utf-8",
        )

    if not runtime_path.exists():
        runtime_path.write_text(
            json.dumps(
                {
                    "entrypoint": "transcribe.py",
                    "server_script": "main.py",
                    "python_executable": sys.executable,
                    "server_host": DEFAULT_SERVER_HOST,
                    "server_port": DEFAULT_SERVER_PORT,
                    "timeout_seconds": 60,
                },
                indent=2,
            ),
            encoding="utf-8",
        )


@dataclass(slots=True, frozen=True)
class FasterWhisperServerConfig:
    host: str = DEFAULT_SERVER_HOST
    port: int = DEFAULT_SERVER_PORT
    python_executable: str = ""
    server_script: str = "main.py"
    model_root: Path = Path(".")
    provider_root: Path = Path(".")
    log_root: Path = Path(".")

    @property
    def base_url(self) -> str:
        return f"http://{self.host}:{self.port}"

    @property
    def health_url(self) -> str:
        return f"{self.base_url}/health"

    @property
    def state_url(self) -> str:
        return f"{self.base_url}/state"

    @property
    def devices_url(self) -> str:
        return f"{self.base_url}/devices"

    @property
    def events_url(self) -> str:
        return f"{self.base_url}/events"

    @property
    def listening_start_url(self) -> str:
        return f"{self.base_url}/listening/start"

    @property
    def listening_stop_url(self) -> str:
        return f"{self.base_url}/listening/stop"

    @property
    def device_url(self) -> str:
        return f"{self.base_url}/device"

    @property
    def shutdown_url(self) -> str:
        return f"{self.base_url}/shutdown"


def load_server_config(app_paths: AppPaths | None = None) -> FasterWhisperServerConfig:
    paths = app_paths or get_app_paths()
    model_root = paths.stt_models_root / "faster-whisper-medium"
    provider_root = paths.providers_root / "stt" / "faster-whisper"
    _ensure_runtime_files(provider_root)

    config_data: dict[str, Any] = {}
    runtime_path = provider_root / "runtime.json"
    if runtime_path.is_file():
        try:
            decoded = json.loads(runtime_path.read_text(encoding="utf-8"))
            if isinstance(decoded, dict):
                config_data.update(decoded)
        except (OSError, json.JSONDecodeError):
            pass

    python_executable = str(config_data.get("python_executable") or sys.executable).strip() or sys.executable
    raw_port = config_data.get("server_port") or config_data.get("port") or DEFAULT_SERVER_PORT
    try:
        port = int(raw_port)
    except (TypeError, ValueError):
        port = DEFAULT_SERVER_PORT

    return FasterWhisperServerConfig(
        host=str(config_data.get("server_host") or DEFAULT_SERVER_HOST).strip() or DEFAULT_SERVER_HOST,
        port=port,
        python_executable=python_executable,
        server_script=str(config_data.get("server_script") or "main.py").strip() or "main.py",
        model_root=model_root,
        provider_root=provider_root,
        log_root=_default_log_root(paths),
    )


class FasterWhisperServerError(RuntimeError):
    pass


def _http_json_request(
    url: str,
    *,
    payload: dict[str, Any] | None = None,
    method: str = "GET",
    timeout: float = HEALTH_CHECK_TIMEOUT_SECONDS,
) -> dict[str, Any]:
    body = json.dumps(payload).encode("utf-8") if payload is not None else None
    headers: dict[str, str] = {}
    if body is not None:
        headers["Content-Type"] = "application/json"

    request_obj = urllib_request.Request(url, data=body, headers=headers, method=method)
    try:
        with urllib_request.urlopen(request_obj, timeout=timeout) as response:
            raw = response.read().decode("utf-8")
    except (urllib_error.URLError, TimeoutError, OSError) as exc:
        raise FasterWhisperServerError(f"Connection failed: {exc}") from exc

    decoded = json.loads(raw)
    if not isinstance(decoded, dict):
        raise FasterWhisperServerError("Unexpected response format")
    return decoded


@dataclass
class FasterWhisperServerManager:
    config: FasterWhisperServerConfig = field(default_factory=load_server_config)
    _process: subprocess.Popen[str] | None = field(default=None, init=False, repr=False)
    _lock: threading.Lock = field(default_factory=threading.Lock, init=False, repr=False)
    _stdout_log_path: Path | None = field(default=None, init=False, repr=False)
    _stderr_log_path: Path | None = field(default=None, init=False, repr=False)

    @property
    def owner_pid(self) -> int | None:
        return None if self._process is None else self._process.pid

    @property
    def is_running(self) -> bool:
        return self._process is not None and self._process.poll() is None

    @property
    def is_healthy(self) -> bool:
        try:
            return _http_json_request(self.config.health_url).get("status") == "ready"
        except FasterWhisperServerError:
            return False

    @property
    def server_configured(self) -> bool:
        script_path = self.config.provider_root / self.config.server_script
        return (
            self.config.provider_root.exists()
            and _has_faster_whisper_payload_proof(self.config.model_root)
            and script_path.exists()
        )

    def start(self, *, allow_gpu: bool) -> bool:
        with self._lock:
            if self.is_running and self.is_healthy:
                return True

            if self.is_running:
                self._kill_process()

            if self.is_healthy:
                logger.warning(
                    "Reclaiming pre-existing Faster-Whisper server on %s before starting a managed sidecar",
                    self.config.base_url,
                )
                if not self._reclaim_external_server():
                    logger.error("Failed to reclaim Faster-Whisper server on %s", self.config.base_url)
                    return False

            if not self.server_configured:
                logger.warning(
                    "Faster-Whisper server not configured: provider_root=%s model_root=%s script=%s",
                    self.config.provider_root,
                    self.config.model_root,
                    self.config.server_script,
                )
                return False

            script_path = self.config.provider_root / self.config.server_script
            cmd = [
                self.config.python_executable,
                str(script_path),
                "--host",
                self.config.host,
                "--port",
                str(self.config.port),
                "--model-root",
                str(self.config.model_root),
            ]
            self.config.log_root.mkdir(parents=True, exist_ok=True)
            timestamp = time.strftime("%Y%m%d-%H%M%S")
            self._stdout_log_path = self.config.log_root / f"stt-server-{timestamp}.stdout.log"
            self._stderr_log_path = self.config.log_root / f"stt-server-{timestamp}.stderr.log"

            env = {
                **os.environ,
                "NIKOF_STT_OWNER_PID": str(os.getpid()),
                "NIKOF_BACKEND_ROOT": str(_backend_root()),
                "NIKOF_STT_ALLOW_GPU": "1" if allow_gpu else "0",
            }

            try:
                with self._stdout_log_path.open("a", encoding="utf-8") as stdout_log:
                    with self._stderr_log_path.open("a", encoding="utf-8") as stderr_log:
                        self._process = subprocess.Popen(
                            cmd,
                            stdout=stdout_log,
                            stderr=stderr_log,
                            text=True,
                            cwd=str(self.config.provider_root),
                            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
                            env=env,
                        )
            except OSError as exc:
                logger.error("Failed to start Faster-Whisper server: %s", exc)
                return False

            if self._wait_for_healthy():
                return True

            self._kill_process()
            return False

    def stop(self) -> None:
        with self._lock:
            if not self.is_running:
                return

            try:
                _http_json_request(self.config.shutdown_url, method="POST", timeout=5.0)
                if self._process is not None:
                    try:
                        self._process.wait(timeout=10.0)
                    except subprocess.TimeoutExpired:
                        pass
            except FasterWhisperServerError:
                pass

            self._kill_process()

    def health(self) -> dict[str, Any]:
        return _http_json_request(self.config.health_url)

    def state(self) -> dict[str, Any]:
        return _http_json_request(self.config.state_url)

    def devices(self) -> dict[str, Any]:
        return _http_json_request(self.config.devices_url)

    def events(self, *, after_sequence: int) -> dict[str, Any]:
        return _http_json_request(f"{self.config.events_url}?after={after_sequence}")

    def start_listening(self) -> dict[str, Any]:
        return _http_json_request(self.config.listening_start_url, payload={}, method="POST", timeout=8.0)

    def stop_listening(self) -> dict[str, Any]:
        return _http_json_request(self.config.listening_stop_url, payload={}, method="POST", timeout=8.0)

    def set_device(self, device_id: str | None) -> dict[str, Any]:
        return _http_json_request(
            self.config.device_url,
            payload={"device_id": device_id},
            method="POST",
            timeout=8.0,
        )

    def _wait_for_healthy(self) -> bool:
        deadline = time.monotonic() + SERVER_STARTUP_TIMEOUT_SECONDS
        while time.monotonic() < deadline:
            if self.is_healthy:
                return True
            if self._process is not None and self._process.poll() is not None:
                return False
            time.sleep(SERVER_POLL_INTERVAL_SECONDS)
        return False

    def _reclaim_external_server(self) -> bool:
        try:
            _http_json_request(self.config.shutdown_url, method="POST", timeout=5.0)
        except FasterWhisperServerError as exc:
            logger.warning("Graceful shutdown request for the existing Faster-Whisper server failed: %s", exc)

        deadline = time.monotonic() + SERVER_RECLAIM_TIMEOUT_SECONDS
        while time.monotonic() < deadline:
            if not self.is_healthy:
                return True
            time.sleep(SERVER_POLL_INTERVAL_SECONDS)
        return False

    def _kill_process(self) -> None:
        if self._process is None:
            return
        try:
            self._process.kill()
            self._process.wait(timeout=5.0)
        except (OSError, subprocess.SubprocessError):
            pass
        self._process = None


_server_manager: FasterWhisperServerManager | None = None
_server_manager_lock = threading.Lock()


def get_server_manager(app_paths: AppPaths | None = None) -> FasterWhisperServerManager:
    global _server_manager
    resolved_paths = app_paths or get_app_paths()
    if _server_manager is None:
        with _server_manager_lock:
            if _server_manager is None:
                _server_manager = FasterWhisperServerManager(load_server_config(resolved_paths))
    elif app_paths is not None:
        expected_config = load_server_config(resolved_paths)
        if _server_manager.config.provider_root != expected_config.provider_root or _server_manager.config.model_root != expected_config.model_root:
            _server_manager = FasterWhisperServerManager(expected_config)
    return _server_manager