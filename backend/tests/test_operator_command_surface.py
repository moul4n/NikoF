from __future__ import annotations

import asyncio
import inspect
import sys
import types
from pathlib import Path
import unittest
from unittest.mock import patch


BACKEND_ROOT = Path(__file__).resolve().parents[1]
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from app.api.router import _serialize_dataclass_payload, build_api_router
from app.schemas.session import OperatorCommandRequest, SessionLifecycleUpdateRequest


class FakeHTTPException(Exception):
    def __init__(self, *, status_code: int, detail: str) -> None:
        super().__init__(detail)
        self.status_code = status_code
        self.detail = detail


class FakeRequest:
    def __init__(self, *, headers: dict[str, str] | None = None) -> None:
        self.headers = headers or {}

    async def is_disconnected(self) -> bool:
        return False


class FakeResponse:
    def __init__(self) -> None:
        self.status_code = 200


class FakeStreamingResponse:
    def __init__(self, body_iterator, media_type: str) -> None:
        self.body_iterator = body_iterator
        self.media_type = media_type


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


def build_router_under_fake_fastapi():
    fake_fastapi = types.ModuleType("fastapi")
    fake_fastapi.APIRouter = FakeAPIRouter
    fake_fastapi.HTTPException = FakeHTTPException
    fake_fastapi.Request = FakeRequest
    fake_fastapi.Response = FakeResponse
    fake_fastapi.status = types.SimpleNamespace(HTTP_400_BAD_REQUEST=400)
    fake_fastapi_responses = types.ModuleType("fastapi.responses")
    fake_fastapi_responses.StreamingResponse = FakeStreamingResponse

    with patch.dict(
        sys.modules,
        {
            "fastapi": fake_fastapi,
            "fastapi.responses": fake_fastapi_responses,
        },
    ):
        return build_api_router()


def get_route(router, *, path: str, method: str):
    return next(
        route
        for route in router.routes
        if route.path == path and method in getattr(route, "methods", ())
    )


def invoke_endpoint(endpoint, **provided_arguments):
    call_arguments: dict[str, object] = {}

    for parameter_name, parameter in inspect.signature(endpoint).parameters.items():
        if parameter_name in provided_arguments:
            call_arguments[parameter_name] = provided_arguments[parameter_name]
        elif parameter_name == "request":
            call_arguments[parameter_name] = FakeRequest()
        elif parameter_name == "response":
            call_arguments[parameter_name] = FakeResponse()
        elif parameter.default is inspect.Signature.empty:
            raise AssertionError(f"Unhandled required endpoint parameter: {parameter_name}")

    result = endpoint(**call_arguments)
    if inspect.isawaitable(result):
        return asyncio.run(result)

    return result


class OperatorCommandSurfaceTests(unittest.TestCase):
    def test_router_exposes_operator_command_route_alongside_backend_owned_animation_lifecycle_routes(self) -> None:
        router = build_router_under_fake_fastapi()
        routes = {(route.path, method) for route in router.routes for method in route.methods}

        self.assertIn(("/session/operator-command", "POST"), routes)
        self.assertIn(("/session/animation", "GET"), routes)
        self.assertIn(("/session/lifecycle-state", "PUT"), routes)
        self.assertEqual(
            1,
            sum(1 for route in router.routes if route.path == "/session/operator-command" and "POST" in route.methods),
        )

    def test_session_animation_route_preserves_snapshot_shape_and_negotiates_live_delivery(self) -> None:
        router = build_router_under_fake_fastapi()
        session_animation_route = get_route(router, path="/session/animation", method="GET")
        lifecycle_update_route = get_route(router, path="/session/lifecycle-state", method="PUT")

        self.assertEqual(["request", "cursor"], list(inspect.signature(session_animation_route.endpoint).parameters.keys()))

        initial_snapshot = _serialize_dataclass_payload(
            invoke_endpoint(
                session_animation_route.endpoint,
                request=FakeRequest(headers={"accept": "application/json"}),
                cursor=None,
            )
        )
        updated_snapshot = _serialize_dataclass_payload(
            invoke_endpoint(
                lifecycle_update_route.endpoint,
                update=SessionLifecycleUpdateRequest(
                    lifecycle_state="speak",
                    reason="speech_playback_started",
                ),
            )
        )
        refreshed_snapshot = _serialize_dataclass_payload(
            invoke_endpoint(
                session_animation_route.endpoint,
                request=FakeRequest(headers={"accept": "application/json"}),
                cursor=None,
            )
        )
        live_response = invoke_endpoint(
            session_animation_route.endpoint,
            request=FakeRequest(headers={"accept": "text/event-stream"}),
            cursor=None,
        )

        self.assertEqual(list(initial_snapshot.keys()), list(updated_snapshot.keys()))
        self.assertEqual(list(initial_snapshot.keys()), list(refreshed_snapshot.keys()))
        self.assertEqual("idle", initial_snapshot["lifecycle_state"])
        self.assertEqual("idle.default", initial_snapshot["command"]["semantic_id"])
        self.assertEqual("speak", updated_snapshot["lifecycle_state"])
        self.assertEqual("speak.loop", updated_snapshot["command"]["semantic_id"])
        self.assertEqual(updated_snapshot, refreshed_snapshot)
        self.assertIsInstance(live_response, FakeStreamingResponse)
        self.assertEqual("text/event-stream", live_response.media_type)

    def test_text_question_round_trips_through_speech_lifecycle_snapshot_for_current_session_character(self) -> None:
        router = build_router_under_fake_fastapi()
        operator_command_route = get_route(router, path="/session/operator-command", method="POST")
        speech_lifecycle_route = get_route(router, path="/session/speech-lifecycle", method="GET")
        session_animation_route = get_route(router, path="/session/animation", method="GET")

        operator_response = invoke_endpoint(
            operator_command_route.endpoint,
            command=OperatorCommandRequest(
                command_type="text_question",
                text="What should I do next?",
                locale="en-US",
            ),
        )
        speech_lifecycle_snapshot = invoke_endpoint(speech_lifecycle_route.endpoint)
        session_animation_snapshot = invoke_endpoint(session_animation_route.endpoint)

        operator_payload = _serialize_dataclass_payload(operator_response)
        speech_lifecycle_payload = _serialize_dataclass_payload(speech_lifecycle_snapshot)
        session_animation_payload = _serialize_dataclass_payload(session_animation_snapshot)

        self.assertEqual(
            operator_payload["speech_lifecycle_events"],
            speech_lifecycle_payload["events"],
        )
        self.assertEqual(
            operator_payload["next_speech_cursor"],
            speech_lifecycle_payload["next_cursor"],
        )
        self.assertEqual(
            session_animation_payload["active_character_id"],
            operator_payload["character_id"],
        )
        self.assertEqual(
            session_animation_payload["session_id"],
            operator_payload["session_id"],
        )
        self.assertEqual(
            "assistant.message",
            operator_payload["speech_lifecycle_events"][0]["event"]["event_type"],
        )
        self.assertEqual(
            "speech.synthesis",
            operator_payload["speech_lifecycle_events"][-1]["event"]["event_type"],
        )


if __name__ == "__main__":
    unittest.main()