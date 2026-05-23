from __future__ import annotations

import asyncio
import inspect
import sys
import unittest
from pathlib import Path
from unittest.mock import patch


BACKEND_ROOT = Path(__file__).resolve().parents[1]
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from app.api.llm_routes import LLMControlRequest, register_llm_routes
from app.schemas.session import AssistantMessageContract
from app.services.llm import TextGenerationSidecarState, TextGenerationSidecarStatus


class FakeRoute:
    def __init__(self, path: str, endpoint, methods: tuple[str, ...]) -> None:
        self.path = path
        self.endpoint = endpoint
        self.methods = methods


class FakeAPIRouter:
    def __init__(self) -> None:
        self.routes: list[FakeRoute] = []

    def get(self, path: str, **kwargs):
        del kwargs
        return self._register(path, "GET")

    def post(self, path: str, **kwargs):
        del kwargs
        return self._register(path, "POST")

    def _register(self, path: str, method: str):
        def decorator(endpoint):
            self.routes.append(FakeRoute(path=path, endpoint=endpoint, methods=(method,)))
            return endpoint

        return decorator


def get_route(router: FakeAPIRouter, *, path: str, method: str) -> FakeRoute:
    return next(route for route in router.routes if route.path == path and method in route.methods)


def invoke_endpoint(endpoint, **provided_arguments):
    result = endpoint(**provided_arguments)
    if inspect.isawaitable(result):
        return asyncio.run(result)
    return result


class FakeLLMManager:
    def __init__(self) -> None:
        self.started = False
        self.warmed = False
        self.restart_count = 0

    def start(self, request=None) -> bool:
        del request
        self.started = True
        return True

    def stop(self) -> None:
        self.started = False

    def restart(self, request=None) -> bool:
        del request
        self.restart_count += 1
        self.started = True
        return True

    def warmup(self, request=None) -> AssistantMessageContract:
        del request
        self.warmed = True
        self.started = True
        return AssistantMessageContract(
            profile_id="llm.ollama.llama3.1-8b-2026",
            status="ready",
            text="READY",
            locale="en-US",
        )

    def status(self, request=None) -> TextGenerationSidecarStatus:
        del request
        return TextGenerationSidecarStatus(
            state=TextGenerationSidecarState.READY if self.started else TextGenerationSidecarState.IDLE,
            profile_id="llm.ollama.llama3.1-8b-2026",
            family="ollama",
            configured=True,
            available=self.started,
            loaded=self.started,
            model_name="llama3.1:8b",
            endpoint="http://127.0.0.1:11434/api/generate",
            timeout_seconds=90,
            last_error=None,
            requests_processed=1 if self.warmed else 0,
            average_latency_ms=12.5 if self.warmed else None,
            last_request_epoch=1234.5 if self.warmed else None,
            vram_allocated_mb=5500.0 if self.started else None,
            ram_allocated_mb=1024.0 if self.started else None,
            process_managed=True,
            process_running=self.started,
            process_healthy=self.started,
            started_by_backend=self.started,
            owner_pid=4321 if self.started else None,
            health_url="http://127.0.0.1:11434/api/tags",
            startup_timeout_seconds=30.0,
            stdout_log_path="stdout.log" if self.started else None,
            stderr_log_path="stderr.log" if self.started else None,
        )


class LLMRouteTests(unittest.TestCase):
    def test_session_llm_route_serializes_status(self) -> None:
        router = FakeAPIRouter()
        manager = FakeLLMManager()

        with patch("app.api.llm_routes.get_text_generation_sidecar_manager", return_value=manager):
            register_llm_routes(router)
            response = invoke_endpoint(get_route(router, path="/session/llm", method="GET").endpoint)

        self.assertEqual(1, response["schema_version"])
        self.assertEqual("idle", response["state"])
        self.assertTrue(response["process_managed"])
        self.assertFalse(response["process_running"])

    def test_session_llm_control_warmup_returns_warmup_payload(self) -> None:
        router = FakeAPIRouter()
        manager = FakeLLMManager()

        with patch("app.api.llm_routes.get_text_generation_sidecar_manager", return_value=manager):
            register_llm_routes(router)
            response = invoke_endpoint(
                get_route(router, path="/session/llm/control", method="POST").endpoint,
                payload=LLMControlRequest(action="warmup"),
            )

        self.assertEqual("warmup", response["action"])
        self.assertEqual("ready", response["llm"]["state"])
        self.assertEqual("ready", response["warmup"]["status"])
        self.assertEqual("READY", response["warmup"]["text"])

    def test_session_llm_control_stop_updates_state(self) -> None:
        router = FakeAPIRouter()
        manager = FakeLLMManager()
        manager.start()

        with patch("app.api.llm_routes.get_text_generation_sidecar_manager", return_value=manager):
            register_llm_routes(router)
            response = invoke_endpoint(
                get_route(router, path="/session/llm/control", method="POST").endpoint,
                payload=LLMControlRequest(action="stop"),
            )

        self.assertEqual("stop", response["action"])
        self.assertEqual("idle", response["llm"]["state"])
        self.assertFalse(response["llm"]["process_running"])


if __name__ == "__main__":
    unittest.main()