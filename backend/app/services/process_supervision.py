from __future__ import annotations

import os
import signal
import subprocess
import sys
import time
from typing import Any


_NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0)


def _run_kwargs(*, capture_output: bool) -> dict[str, Any]:
    kwargs: dict[str, Any] = {"check": False}
    if capture_output:
        kwargs["capture_output"] = True
        kwargs["text"] = True
    else:
        kwargs["stdout"] = subprocess.DEVNULL
        kwargs["stderr"] = subprocess.DEVNULL
    if _NO_WINDOW:
        kwargs["creationflags"] = _NO_WINDOW
    return kwargs


def process_exists(pid: int | None) -> bool:
    if pid is None or pid <= 0:
        return False

    try:
        import psutil
    except ImportError:
        psutil = None  # type: ignore[assignment]

    if psutil is not None:
        return bool(psutil.pid_exists(pid))

    if sys.platform == "win32":
        try:
            completed = subprocess.run(
                ["tasklist", "/FI", f"PID eq {pid}", "/FO", "CSV", "/NH"],
                **_run_kwargs(capture_output=True),
            )
        except OSError:
            return False

        output = (completed.stdout or "").strip()
        return completed.returncode == 0 and output and "No tasks are running" not in output and f'"{pid}"' in output

    try:
        os.kill(pid, 0)
    except OSError:
        return False
    return True


def find_listening_pid(host: str, port: int) -> int | None:
    del host

    try:
        import psutil
    except ImportError:
        psutil = None  # type: ignore[assignment]

    if psutil is not None:
        try:
            for connection in psutil.net_connections(kind="tcp"):
                local_address = getattr(connection, "laddr", None)
                if connection.status != getattr(psutil, "CONN_LISTEN", "LISTEN"):
                    continue
                if local_address is None or getattr(local_address, "port", None) != port:
                    continue
                if connection.pid is not None:
                    return int(connection.pid)
        except Exception:
            return None
        return None

    if sys.platform != "win32":
        return None

    try:
        completed = subprocess.run(
            ["netstat", "-ano", "-p", "tcp"],
            **_run_kwargs(capture_output=True),
        )
    except OSError:
        return None

    for raw_line in (completed.stdout or "").splitlines():
        line = raw_line.strip()
        if not line or f":{port}" not in line:
            continue
        columns = line.split()
        if len(columns) < 5:
            continue
        if columns[3].upper() != "LISTENING":
            continue
        try:
            return int(columns[4])
        except ValueError:
            continue

    return None


def terminate_process_tree(process: subprocess.Popen[Any] | None, *, wait_timeout: float = 5.0) -> None:
    if process is None:
        return

    try:
        pid = int(process.pid)
    except (TypeError, ValueError, OSError):
        pid = None

    terminate_process_tree_by_pid(pid)

    try:
        process.wait(timeout=wait_timeout)
    except (subprocess.TimeoutExpired, OSError, ValueError):
        pass


def terminate_process_tree_by_pid(pid: int | None, *, wait_timeout: float = 5.0) -> None:
    if pid is None or pid <= 0:
        return

    if sys.platform == "win32":
        try:
            subprocess.run(
                ["taskkill", "/PID", str(pid), "/T", "/F"],
                **_run_kwargs(capture_output=False),
            )
        except OSError:
            pass
        return

    try:
        os.kill(pid, signal.SIGTERM)
    except OSError:
        return

    deadline = time.monotonic() + wait_timeout
    while time.monotonic() < deadline:
        if not process_exists(pid):
            return
        time.sleep(0.1)

    try:
        os.kill(pid, signal.SIGKILL)
    except OSError:
        pass