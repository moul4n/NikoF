from __future__ import annotations

import asyncio
from dataclasses import replace
import inspect
import sys
import unittest
from pathlib import Path
from unittest.mock import patch


BACKEND_ROOT = Path(__file__).resolve().parents[1]
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from app.api.attention_routes import (
    AttentionDebugMarkerRequest,
    AttentionEnabledRequest,
    AttentionObservationRequest,
    register_attention_routes,
)
from app.services.attention_worker import AttentionSubjectSnapshot, AttentionWorkerState, AttentionWorkerStatus


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

    def put(self, path: str, **kwargs):
        del kwargs
        return self._register(path, "PUT")

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


class FakeAttentionWorker:
    def __init__(self) -> None:
        self._status = AttentionWorkerStatus(
            state=AttentionWorkerState.DISABLED,
            available=True,
            enabled=False,
            tracking=False,
            selected_device_id="camera-default",
            selected_device_label="Browser default camera",
            confidence=None,
            subject=None,
            last_observed_at=None,
            last_error=None,
            fps_target=8,
            frame_width=320,
            frame_height=240,
            show_tracking_debug_marker=False,
            next_sequence=1,
        )

    def status(self) -> AttentionWorkerStatus:
        return self._status

    async def list_devices(self):
        return tuple()

    async def set_enabled(self, enabled: bool) -> AttentionWorkerStatus:
        self._status = replace(
            self._status,
            enabled=enabled,
            state=AttentionWorkerState.IDLE if enabled else AttentionWorkerState.DISABLED,
        )
        return self._status

    async def set_show_tracking_debug_marker(self, enabled: bool) -> AttentionWorkerStatus:
        self._status = replace(self._status, show_tracking_debug_marker=enabled)
        return self._status

    async def record_observation(self, **kwargs) -> AttentionWorkerStatus:
        del kwargs
        self._status = replace(
            self._status,
            state=AttentionWorkerState.TRACKING,
            tracking=True,
            enabled=True,
            confidence=0.91,
            subject=AttentionSubjectSnapshot(0.62, 0.41, 0.2, 0.25),
            last_observed_at=1234.5,
        )
        return self._status


class AttentionRouteTests(unittest.TestCase):
    def test_session_attention_route_serializes_slotted_response(self) -> None:
        router = FakeAPIRouter()
        worker = FakeAttentionWorker()

        with patch("app.api.attention_routes.get_attention_worker", return_value=worker):
            register_attention_routes(router)
            response = invoke_endpoint(get_route(router, path="/session/attention", method="GET").endpoint)

        self.assertEqual(1, response["schema_version"])
        self.assertEqual("disabled", response["state"])
        self.assertFalse(response["enabled"])
        self.assertEqual("camera-default", response["selected_device_id"])

    def test_session_attention_enabled_route_updates_state(self) -> None:
        router = FakeAPIRouter()
        worker = FakeAttentionWorker()

        with patch("app.api.attention_routes.get_attention_worker", return_value=worker):
            register_attention_routes(router)
            response = invoke_endpoint(
                get_route(router, path="/session/attention/enabled", method="PUT").endpoint,
                update=AttentionEnabledRequest(enabled=True),
            )

        self.assertTrue(response["enabled"])
        self.assertEqual("idle", response["state"])

    def test_session_attention_default_response_includes_debug_marker_flag(self) -> None:
        router = FakeAPIRouter()
        worker = FakeAttentionWorker()

        with patch("app.api.attention_routes.get_attention_worker", return_value=worker):
            register_attention_routes(router)
            response = invoke_endpoint(get_route(router, path="/session/attention", method="GET").endpoint)

        self.assertFalse(response["show_tracking_debug_marker"])

    def test_session_attention_debug_marker_route_updates_state(self) -> None:
        router = FakeAPIRouter()
        worker = FakeAttentionWorker()

        with patch("app.api.attention_routes.get_attention_worker", return_value=worker):
            register_attention_routes(router)
            response = invoke_endpoint(
                get_route(router, path="/session/attention/debug-marker", method="PUT").endpoint,
                update=AttentionDebugMarkerRequest(enabled=True),
            )

        self.assertTrue(response["show_tracking_debug_marker"])

    def test_session_attention_observation_route_serializes_subject(self) -> None:
        router = FakeAPIRouter()
        worker = FakeAttentionWorker()

        with patch("app.api.attention_routes.get_attention_worker", return_value=worker):
            register_attention_routes(router)
            response = invoke_endpoint(
                get_route(router, path="/session/attention/observations", method="POST").endpoint,
                payload=AttentionObservationRequest(
                    device_id="camera-default",
                    captured_at=1234.5,
                    frame_width=320,
                    frame_height=240,
                    subject={
                        "tracked": True,
                        "normalized_x": 0.62,
                        "normalized_y": 0.41,
                        "face_width": 0.2,
                        "face_height": 0.25,
                        "confidence": 0.91,
                    },
                ),
            )

        self.assertEqual("tracking", response["state"])
        self.assertEqual(0.62, response["subject"]["normalized_x"])
        self.assertEqual(0.91, response["confidence"])


if __name__ == "__main__":
    unittest.main()