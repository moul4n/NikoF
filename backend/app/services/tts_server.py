"""Persistent GPT-SoVITS inference server management.

This module manages a long-running GPT-SoVITS server process that:
- Loads the model once into GPU memory on first request
- Exposes a local HTTP API for synthesis
- Is managed (start/stop/restart/health-check) by the TTSWorker
- Reports resource usage back to the monitor

The server contract:
  POST /synthesize  -> JSON body with text, locale, voice_profile, etc.
                    <- JSON response with audio_reference, timing, status
  GET  /health      <- {"status": "ready", "model_loaded": true, "vram_mb": ...}
  POST /shutdown    <- graceful shutdown
"""

from __future__ import annotations

import json
import logging
import os
import shutil
import subprocess
import sys
import time
import threading
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any
from urllib import error as urllib_error
from urllib import request as urllib_request

from app.core.settings import AppPaths, get_app_paths
from app.services.process_supervision import find_listening_pid, process_exists, terminate_process_tree, terminate_process_tree_by_pid

logger = logging.getLogger(__name__)

DEFAULT_SERVER_HOST = "127.0.0.1"
DEFAULT_SERVER_PORT = 9880
HEALTH_CHECK_TIMEOUT_SECONDS = 2.0
SYNTHESIS_TIMEOUT_SECONDS = 30.0
SERVER_STARTUP_TIMEOUT_SECONDS = 60.0
SERVER_STARTUP_POLL_INTERVAL_SECONDS = 1.0
SERVER_RECOVERY_TIMEOUT_SECONDS = 5.0
SERVER_RECOVERY_POLL_INTERVAL_SECONDS = 0.5
PREFERRED_SERVER_SCRIPT_CANDIDATES = ("api_v2.py", "api.py", "api_server.py")


def _default_log_root(app_paths: AppPaths | None = None) -> Path:
    paths = app_paths or get_app_paths()
    return paths.local_data_root / "logs" / "tts"


def _backend_root() -> Path:
    return Path(__file__).resolve().parents[2]


def _repo_server_script_source() -> Path:
    return Path(__file__).resolve().parents[3] / "scripts" / "tts_server" / "api_server.py"


def _sync_repo_server_script(provider_root: Path, server_script: str) -> None:
    if server_script != "api_server.py":
        return

    source_path = _repo_server_script_source()
    if not source_path.is_file():
        return

    provider_root.mkdir(parents=True, exist_ok=True)
    destination_path = provider_root / server_script
    try:
        if destination_path.is_file() and destination_path.read_text(encoding="utf-8") == source_path.read_text(encoding="utf-8"):
            return
    except OSError:
        pass

    shutil.copyfile(source_path, destination_path)


def _resolve_default_server_script(provider_root: Path) -> str:
    for candidate in PREFERRED_SERVER_SCRIPT_CANDIDATES:
        if (provider_root / candidate).is_file():
            return candidate

    return PREFERRED_SERVER_SCRIPT_CANDIDATES[-1]


@dataclass(slots=True, frozen=True)
class GPTSoVITSServerConfig:
    """Configuration for the GPT-SoVITS inference server process."""

    host: str = DEFAULT_SERVER_HOST
    port: int = DEFAULT_SERVER_PORT
    python_executable: str = ""
    server_script: str = "api_server.py"
    model_root: Path = Path(".")
    provider_root: Path = Path(".")
    weights_root: str = "./weights"
    reference_audio_root: str = "./reference-audio"
    speaker_manifest: str = "./speakers/default.json"
    startup_timeout_seconds: float = SERVER_STARTUP_TIMEOUT_SECONDS
    log_root: Path = Path(".")

    @property
    def base_url(self) -> str:
        return f"http://{self.host}:{self.port}"

    @property
    def health_url(self) -> str:
        return f"{self.base_url}/health"

    @property
    def synthesize_url(self) -> str:
        return f"{self.base_url}/synthesize"

    @property
    def shutdown_url(self) -> str:
        return f"{self.base_url}/shutdown"


def load_server_config(app_paths: AppPaths | None = None) -> GPTSoVITSServerConfig:
    """Load server config from model and provider runtime.json files."""
    paths = app_paths or get_app_paths()
    model_root = paths.tts_models_root / "gpt-sovits"
    provider_root = paths.providers_root / "tts" / "gpt-sovits"

    config_data: dict[str, Any] = {}
    for root in (model_root, provider_root):
        config_path = root / "runtime.json"
        if config_path.is_file():
            try:
                data = json.loads(config_path.read_text(encoding="utf-8"))
                if isinstance(data, dict):
                    config_data.update(data)
            except (OSError, json.JSONDecodeError):
                pass

    python_exe = config_data.get("python_executable", "").strip()
    if not python_exe:
        python_exe = sys.executable

    port = DEFAULT_SERVER_PORT
    raw_port = config_data.get("server_port") or config_data.get("port")
    if raw_port is not None:
        try:
            port = int(raw_port)
        except (TypeError, ValueError):
            pass

    # server_script is deliberately separate from entrypoint:
    # - "entrypoint" = subprocess one-shot adapter (synthesize.py)
    # - "server_script" = persistent HTTP server, preferring dedicated headless API
    #   entrypoints when they exist in the provider root.
    raw_server_script = str(config_data.get("server_script") or "").strip()
    server_script = raw_server_script or _resolve_default_server_script(provider_root)
    _sync_repo_server_script(provider_root, server_script)

    startup_timeout_seconds = SERVER_STARTUP_TIMEOUT_SECONDS
    raw_startup_timeout = config_data.get("timeout_seconds")
    if raw_startup_timeout is None:
        raw_startup_timeout = config_data.get("startup_timeout_seconds")
    if raw_startup_timeout is not None:
        try:
            parsed_startup_timeout = float(raw_startup_timeout)
            if parsed_startup_timeout > 0:
                startup_timeout_seconds = parsed_startup_timeout
        except (TypeError, ValueError):
            pass

    return GPTSoVITSServerConfig(
        host=str(config_data.get("server_host", DEFAULT_SERVER_HOST)).strip() or DEFAULT_SERVER_HOST,
        port=port,
        python_executable=python_exe,
        server_script=server_script,
        model_root=model_root,
        provider_root=provider_root,
        weights_root=str(config_data.get("weights_root", "./weights")),
        reference_audio_root=str(config_data.get("reference_audio_root", "./reference-audio")),
        speaker_manifest=str(config_data.get("speaker_manifest", "./speakers/default.json")),
        startup_timeout_seconds=startup_timeout_seconds,
        log_root=_default_log_root(paths),
    )


class GPTSoVITSServerError(RuntimeError):
    """Raised when the server cannot complete an operation."""


def _extract_owner_pid(payload: dict[str, Any] | None) -> int | None:
    if not isinstance(payload, dict):
        return None
    raw_owner_pid = payload.get("owner_pid")
    try:
        return int(raw_owner_pid) if raw_owner_pid is not None else None
    except (TypeError, ValueError):
        return None


def _http_json_request(
    url: str,
    *,
    payload: dict[str, Any] | None = None,
    method: str = "GET",
    timeout: float = HEALTH_CHECK_TIMEOUT_SECONDS,
) -> dict[str, Any]:
    """Make an HTTP request and return parsed JSON."""
    body = json.dumps(payload).encode("utf-8") if payload else None
    headers: dict[str, str] = {}
    if body:
        headers["Content-Type"] = "application/json"

    req = urllib_request.Request(url, data=body, headers=headers, method=method)

    try:
        with urllib_request.urlopen(req, timeout=timeout) as response:
            raw = response.read().decode("utf-8")
    except (urllib_error.URLError, TimeoutError, OSError) as exc:
        raise GPTSoVITSServerError(f"Connection failed: {exc}") from exc

    try:
        decoded = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise GPTSoVITSServerError("Invalid JSON response") from exc

    if not isinstance(decoded, dict):
        raise GPTSoVITSServerError("Unexpected response format")

    return decoded


@dataclass
class GPTSoVITSServerManager:
    """Manages the lifecycle of a persistent GPT-SoVITS inference server process.

    The server is started as a subprocess and communicated with via HTTP.
    """

    config: GPTSoVITSServerConfig = field(default_factory=load_server_config)
    _process: subprocess.Popen[str] | None = field(default=None, init=False, repr=False)
    _lock: threading.Lock = field(default_factory=threading.Lock, init=False, repr=False)
    _started: bool = field(default=False, init=False)
    _stdout_log_path: Path | None = field(default=None, init=False, repr=False)
    _stderr_log_path: Path | None = field(default=None, init=False, repr=False)

    @property
    def owner_pid(self) -> int | None:
        if self._process is None:
            return None
        return self._process.pid

    @property
    def is_running(self) -> bool:
        """Check if the server process is still alive."""
        if self._process is None:
            return False
        return self._process.poll() is None

    @property
    def is_healthy(self) -> bool:
        """Check if the server responds to health checks."""
        try:
            response = _http_json_request(self.config.health_url, timeout=HEALTH_CHECK_TIMEOUT_SECONDS)
            return response.get("status") == "ready"
        except GPTSoVITSServerError:
            return False

    @property
    def server_configured(self) -> bool:
        """Check if the server script exists and model root is present."""
        script_path = self.config.provider_root / self.config.server_script
        return (
            self.config.provider_root.exists()
            and self.config.model_root.exists()
            and script_path.exists()
        )

    def start(self) -> bool:
        """Start the server process. Returns True if started successfully."""
        with self._lock:
            if self.is_running and self.is_healthy:
                self._started = True
                return True

            if self.is_healthy:
                logger.warning(
                    "Reclaiming pre-existing GPT-SoVITS server on %s before starting a managed sidecar",
                    self.config.base_url,
                )
                if not self._reclaim_external_server():
                    logger.error("Failed to reclaim GPT-SoVITS server on %s", self.config.base_url)
                    self._started = False
                    return False

            if self.is_running:
                self._kill_process()

            if not self.server_configured:
                logger.warning(
                    f"GPT-SoVITS server not configured: "
                    f"provider_root={self.config.provider_root}, "
                    f"model_root={self.config.model_root}, "
                    f"script={self.config.server_script}"
                )
                return False

            script_path = self.config.provider_root / self.config.server_script
            cmd = [
                self.config.python_executable,
                str(script_path),
                "--host", self.config.host,
                "--port", str(self.config.port),
                "--model-root", str(self.config.model_root),
                "--weights-root", self.config.weights_root,
                "--reference-audio-root", self.config.reference_audio_root,
            ]

            logger.info(f"Starting GPT-SoVITS server: {' '.join(cmd)}")
            self.config.log_root.mkdir(parents=True, exist_ok=True)
            timestamp = time.strftime("%Y%m%d-%H%M%S")
            self._stdout_log_path = self.config.log_root / f"tts-server-{timestamp}.stdout.log"
            self._stderr_log_path = self.config.log_root / f"tts-server-{timestamp}.stderr.log"

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
                            env={
                                **os.environ,
                                "NIKOF_BACKEND_ROOT": str(_backend_root()),
                                "NIKOF_TTS_OWNER_PID": str(os.getpid()),
                            },
                        )
            except OSError as exc:
                logger.error(f"Failed to start GPT-SoVITS server: {exc}")
                return False

            # Wait for the server to become healthy
            if self._wait_for_healthy():
                self._started = True
                logger.info(f"GPT-SoVITS server started on {self.config.base_url}")
                return True
            else:
                logger.error("GPT-SoVITS server failed to become healthy within timeout")
                self._kill_process()
                return False

    def stop(self) -> None:
        """Gracefully stop the server."""
        with self._lock:
            if not self.is_running:
                self._started = False
                return

            # Try graceful shutdown via HTTP
            try:
                _http_json_request(
                    self.config.shutdown_url,
                    method="POST",
                    timeout=5.0,
                )
                # Wait briefly for graceful exit
                if self._process:
                    try:
                        self._process.wait(timeout=10.0)
                    except subprocess.TimeoutExpired:
                        pass
            except GPTSoVITSServerError:
                pass

            self._kill_process()
            self._started = False
            logger.info("GPT-SoVITS server stopped")

    def restart(self) -> bool:
        """Stop and restart the server."""
        self.stop()
        return self.start()

    def _reclaim_external_server(self) -> bool:
        external_health: dict[str, Any] | None = None
        try:
            external_health = _http_json_request(self.config.health_url, timeout=5.0)
        except GPTSoVITSServerError:
            external_health = None

        owner_pid = _extract_owner_pid(external_health)
        if owner_pid is not None and not process_exists(owner_pid):
            logger.warning(
                "Reclaiming orphaned GPT-SoVITS sidecar whose owner pid %s is no longer alive",
                owner_pid,
            )

        try:
            _http_json_request(self.config.shutdown_url, method="POST", timeout=5.0)
        except GPTSoVITSServerError as exc:
            logger.warning("Graceful shutdown request for the existing GPT-SoVITS server failed: %s", exc)

        deadline = time.time() + SERVER_RECOVERY_TIMEOUT_SECONDS
        while time.time() < deadline:
            if not self.is_healthy:
                return True
            time.sleep(SERVER_RECOVERY_POLL_INTERVAL_SECONDS)

        external_pid = find_listening_pid(self.config.host, self.config.port)
        if external_pid is None:
            return False

        logger.warning(
            "Force-killing stale GPT-SoVITS listener pid=%s on %s",
            external_pid,
            self.config.base_url,
        )
        terminate_process_tree_by_pid(external_pid)

        deadline = time.time() + SERVER_RECOVERY_TIMEOUT_SECONDS
        while time.time() < deadline:
            if not self.is_healthy:
                return True
            time.sleep(SERVER_RECOVERY_POLL_INTERVAL_SECONDS)
        return False

    def synthesize(self, payload: dict[str, Any]) -> dict[str, Any]:
        """Send a synthesis request to the running server.

        Raises GPTSoVITSServerError if the server isn't running or fails.
        """
        if not self._started:
            # Try to start on demand
            if not self.start():
                raise GPTSoVITSServerError("Server not available")

        try:
            return _http_json_request(
                self.config.synthesize_url,
                payload=payload,
                method="POST",
                timeout=SYNTHESIS_TIMEOUT_SECONDS,
            )
        except GPTSoVITSServerError:
            # A dropped synthesis response can be transient while the sidecar is
            # still alive. Give it a brief recovery window before tearing down a
            # warm model and forcing a full restart.
            if self._wait_for_recovery():
                return _http_json_request(
                    self.config.synthesize_url,
                    payload=payload,
                    method="POST",
                    timeout=SYNTHESIS_TIMEOUT_SECONDS,
                )

            logger.warning("GPT-SoVITS server appears dead, attempting restart...")
            if self.restart():
                return _http_json_request(
                    self.config.synthesize_url,
                    payload=payload,
                    method="POST",
                    timeout=SYNTHESIS_TIMEOUT_SECONDS,
                )
            raise

    def health(self) -> dict[str, Any]:
        """Get server health status."""
        if not self._started or not self.is_running:
            return {
                "status": "stopped",
                "model_loaded": False,
                "vram_mb": None,
            }

        try:
            return _http_json_request(self.config.health_url, timeout=HEALTH_CHECK_TIMEOUT_SECONDS)
        except GPTSoVITSServerError:
            return {
                "status": "unreachable",
                "model_loaded": False,
                "vram_mb": None,
            }

    def _wait_for_healthy(self) -> bool:
        """Poll the server until it responds healthy or timeout."""
        deadline = time.time() + self.config.startup_timeout_seconds
        while time.time() < deadline:
            if self._process is not None and self._process.poll() is not None:
                logger.error(
                    "GPT-SoVITS server exited during startup (pid=%s, stderr_log=%s)",
                    self._process.pid,
                    self._stderr_log_path,
                )
                return False

            try:
                response = _http_json_request(self.config.health_url, timeout=2.0)
                if response.get("status") in ("ready", "ok"):
                    return True
            except GPTSoVITSServerError:
                pass

            time.sleep(SERVER_STARTUP_POLL_INTERVAL_SECONDS)

        return False

    def _wait_for_recovery(self) -> bool:
        """Allow brief transient request failures to recover without restart."""
        if not self.is_running:
            return False

        deadline = time.time() + SERVER_RECOVERY_TIMEOUT_SECONDS
        while time.time() < deadline:
            if self._process is not None and self._process.poll() is not None:
                return False

            try:
                response = _http_json_request(self.config.health_url, timeout=HEALTH_CHECK_TIMEOUT_SECONDS)
                if response.get("status") in ("ready", "ok"):
                    return True
            except GPTSoVITSServerError:
                pass

            time.sleep(SERVER_RECOVERY_POLL_INTERVAL_SECONDS)

        return False

    def _kill_process(self) -> None:
        """Force-kill the server process."""
        if self._process is None:
            return
        terminate_process_tree(self._process)
        self._process = None


# Module-level singleton
_server_manager: GPTSoVITSServerManager | None = None
_server_manager_lock = threading.Lock()


def get_server_manager(app_paths: AppPaths | None = None) -> GPTSoVITSServerManager:
    """Get or create the global server manager."""
    global _server_manager
    resolved_paths = app_paths or get_app_paths()
    if _server_manager is None:
        with _server_manager_lock:
            if _server_manager is None:
                config = load_server_config(resolved_paths)
                _server_manager = GPTSoVITSServerManager(config=config)
    elif app_paths is not None:
        expected_config = load_server_config(resolved_paths)
        if _server_manager.config.provider_root != expected_config.provider_root or _server_manager.config.model_root != expected_config.model_root:
            _server_manager = GPTSoVITSServerManager(config=expected_config)
    return _server_manager
