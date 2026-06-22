from __future__ import annotations

from http import HTTPStatus
import os
import socket
import sys
from urllib.error import HTTPError, URLError
from urllib.request import urlopen

from app.core.settings import get_startup_runtime_prerequisites


HOST = "127.0.0.1"
PORT = 8000
HEALTHCHECK_TIMEOUT_SECONDS = 1.0


def _is_port_available(host: str, port: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as candidate_socket:
        candidate_socket.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            candidate_socket.bind((host, port))
        except OSError:
            return False

    return True


def _healthcheck_responding(host: str, port: int) -> bool:
    health_url = f"http://{host}:{port}/health"

    try:
        with urlopen(health_url, timeout=HEALTHCHECK_TIMEOUT_SECONDS) as response:
            return response.status == HTTPStatus.OK
    except (HTTPError, URLError, TimeoutError, OSError):
        return False


def ensure_startup_ready(host: str = HOST, port: int = PORT) -> None:
    if _is_port_available(host, port):
        return

    if _healthcheck_responding(host, port):
        raise SystemExit(
            f"Backend is already running at http://{host}:{port}. Reuse that instance or stop it before starting another one."
        )

    raise SystemExit(
        f"Port {port} on {host} is already occupied, but /health did not respond. Stop the stale listener on {host}:{port} and rerun the backend from the repo virtual environment."
    )


def _emit_runtime_prerequisite_guidance() -> None:
    missing_prerequisites = [
        prerequisite
        for prerequisite in get_startup_runtime_prerequisites()
        if prerequisite.state != "ready"
    ]
    if not missing_prerequisites:
        return

    print(
        "Startup prerequisites missing for local LLM/STT/TTS integration; backend startup will continue in degraded mode until these paths or hooks are satisfied.",
        file=sys.stderr,
    )
    for prerequisite in missing_prerequisites:
        print(f"- {prerequisite.display_name}", file=sys.stderr)
        print(f"  State: {prerequisite.state}", file=sys.stderr)
        print(f"  Expected path: {prerequisite.expected_path}", file=sys.stderr)
        if prerequisite.acceptance_targets:
            print("  Acceptance targets:", file=sys.stderr)
            for acceptance_target in prerequisite.acceptance_targets:
                target_status = "ready" if acceptance_target.satisfied else "blocked"
                print(f"    - [{target_status}] {acceptance_target.label}", file=sys.stderr)
                print(f"      Expected path: {acceptance_target.expected_path}", file=sys.stderr)
                if len(acceptance_target.accepted_paths) > 1:
                    accepted_paths = ", ".join(str(path) for path in acceptance_target.accepted_paths)
                    print(f"      Accepted paths: {accepted_paths}", file=sys.stderr)
                print(f"      Acceptance proof: {acceptance_target.acceptance_proof}", file=sys.stderr)
        if prerequisite.blocker_details:
            print("  Current blockers:", file=sys.stderr)
            for blocker_detail in prerequisite.blocker_details:
                print(f"    - [{blocker_detail.status}] {blocker_detail.summary}", file=sys.stderr)
                print(f"      Expected path: {blocker_detail.expected_path}", file=sys.stderr)
                if len(blocker_detail.accepted_paths) > 1:
                    accepted_paths = ", ".join(str(path) for path in blocker_detail.accepted_paths)
                    print(f"      Accepted paths: {accepted_paths}", file=sys.stderr)
                print(f"      Remediation: {blocker_detail.remediation}", file=sys.stderr)
        if prerequisite.runtime_config_path is not None:
            print(f"  Runtime config: {prerequisite.runtime_config_path}", file=sys.stderr)
        if prerequisite.install_plan_path is not None:
            print(f"  Install plan: {prerequisite.install_plan_path}", file=sys.stderr)
        if prerequisite.hook_command:
            print(f"  Resume hook: {prerequisite.hook_command}", file=sys.stderr)
        if prerequisite.hint_path:
            print(f"  Hint file: {prerequisite.hint_path}", file=sys.stderr)
        print(f"  Next: {prerequisite.manual_install}", file=sys.stderr)


def main() -> None:
    try:
        import uvicorn
    except ModuleNotFoundError as exc:
        raise SystemExit(
            "uvicorn is not installed in the active backend environment. Install backend dependencies before starting app.dev_server."
        ) from exc

    # Production backend entry point: persist the operator's active-character
    # selection across restarts. Left unset in tests so the suite never reads or
    # overwrites the real on-disk selection.
    os.environ.setdefault("NIKOF_PERSIST_ACTIVE_CHARACTER", "1")

    ensure_startup_ready()
    _emit_runtime_prerequisite_guidance()
    uvicorn.run("app.main:app", host=HOST, port=PORT, reload=False)


if __name__ == "__main__":
    main()