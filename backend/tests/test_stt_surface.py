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

from app.api.stt_routes import STTListeningRequest, register_stt_routes
from app.services.stt_worker import STTTranscriptChunk, STTWorkerState, STTWorkerStatus


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


class FakeSTTWorker:
    def __init__(self) -> None:
        self._status = STTWorkerStatus(
            state=STTWorkerState.UNAVAILABLE,
            model_name=None,
            available=False,
            listening=False,
            selected_device_id=None,
            selected_device_label=None,
            latest_confirmed_text=None,
            latest_confirmed_at=None,
            total_processed=0,
            total_submitted=0,
            average_latency_ms=None,
            last_error="STT sidecar is unavailable",
            compute_device=None,
            compute_type=None,
            next_sequence=1,
        )

    def status(self) -> STTWorkerStatus:
        return self._status

    async def set_listening(self, enabled: bool) -> STTWorkerStatus:
        self._status.listening = enabled
        return self._status


class STTRouteTests(unittest.TestCase):
    def test_session_stt_route_serializes_slotted_response(self) -> None:
        router = FakeAPIRouter()
        worker = FakeSTTWorker()

        with patch("app.api.stt_routes.get_stt_worker", return_value=worker):
            register_stt_routes(router)

            response = invoke_endpoint(get_route(router, path="/session/stt", method="GET").endpoint)

        self.assertEqual(1, response["schema_version"])
        self.assertEqual("unavailable", response["state"])
        self.assertFalse(response["listening"])
        self.assertEqual("STT sidecar is unavailable", response["last_error"])

    def test_session_stt_route_serializes_transcript_chunk_processing_time(self) -> None:
        router = FakeAPIRouter()
        worker = FakeSTTWorker()
        worker._status.transcript_chunks = (
            STTTranscriptChunk(
                chunk_id="stt-chunk-1",
                transcript="test transcript",
                locale="en-US",
                captured_at=1234.5,
                duration_ms=860,
                processing_ms=412.0,
                confidence=0.91,
                accepted_for_dispatch=True,
                dispatch_state="submitted",
                dispatch_target="llm",
                dispatch_detail="Transcript submitted through the shared user-text turn workflow.",
            ),
        )

        with patch("app.api.stt_routes.get_stt_worker", return_value=worker):
            register_stt_routes(router)

            response = invoke_endpoint(get_route(router, path="/session/stt", method="GET").endpoint)

        self.assertEqual(412.0, response["transcript_chunks"][0]["processing_ms"])
        self.assertEqual(860, response["transcript_chunks"][0]["duration_ms"])

    def test_session_stt_listening_route_serializes_slotted_response(self) -> None:
        router = FakeAPIRouter()
        worker = FakeSTTWorker()

        with patch("app.api.stt_routes.get_stt_worker", return_value=worker):
            register_stt_routes(router)

            response = invoke_endpoint(
                get_route(router, path="/session/stt/listening", method="PUT").endpoint,
                update=STTListeningRequest(enabled=True),
            )

        self.assertTrue(response["listening"])
        self.assertEqual("unavailable", response["state"])


if __name__ == "__main__":
    unittest.main()