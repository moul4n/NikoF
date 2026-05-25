from __future__ import annotations

import asyncio
import inspect
import os
import os
import sys
import types
from tempfile import TemporaryDirectory
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import patch


BACKEND_ROOT = Path(__file__).resolve().parents[1]
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from app.api.router import _serialize_dataclass_payload, build_api_router
from app.api.router_composition import build_default_api_runtime_services
from app.schemas.character import ActiveCharacterSelection
from app.schemas.session import OperatorCommandRequest, SessionLifecycleUpdateRequest, SpeechSynthesisContract


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
    def __init__(self, body_iterator, media_type: str, headers: dict[str, str] | None = None) -> None:
        self.body_iterator = body_iterator
        self.media_type = media_type
        self.headers = headers or {}


class FakeFileResponse:
    def __init__(self, path, media_type: str | None = None, filename: str | None = None) -> None:
        self.path = path
        self.media_type = media_type
        self.filename = filename


class FakeFileResponse:
    def __init__(self, path, **kwargs) -> None:
        self.path = path
        self.kwargs = kwargs
        self.media_type = kwargs.get("media_type")


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


class StaticSynthesisService:
    def __init__(self, contract: SpeechSynthesisContract) -> None:
        self._contract = contract

    def synthesize(self, request) -> SpeechSynthesisContract:
        del request
        return self._contract


def build_router_under_fake_fastapi(*, services_override=None):
    fake_fastapi = types.ModuleType("fastapi")
    fake_fastapi.APIRouter = FakeAPIRouter
    fake_fastapi.HTTPException = FakeHTTPException
    fake_fastapi.Request = FakeRequest
    fake_fastapi.Response = FakeResponse
    fake_fastapi.status = types.SimpleNamespace(HTTP_400_BAD_REQUEST=400)
    fake_fastapi_responses = types.ModuleType("fastapi.responses")
    fake_fastapi_responses.FileResponse = FakeFileResponse
    fake_fastapi_responses.StreamingResponse = FakeStreamingResponse
    fake_fastapi_responses.FileResponse = FakeFileResponse

    with patch.dict(
        sys.modules,
        {
            "fastapi": fake_fastapi,
            "fastapi.responses": fake_fastapi_responses,
        },
    ):
        if services_override is None:
            return build_api_router()

        with patch("app.api.router._build_services", return_value=services_override):
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


def write_tts_provider_script(*, provider_root: Path, audio_path: Path) -> None:
    synthesize_script = provider_root / "synthesize.py"
    synthesize_script.write_text(
        "import json\n"
        "from pathlib import Path\n"
        "import sys\n"
        "request = json.loads(sys.stdin.read())\n"
        f"audio_path = Path(r'{audio_path}')\n"
        "audio_path.parent.mkdir(parents=True, exist_ok=True)\n"
        "audio_path.write_bytes(b'RIFF')\n"
        "sys.stdout.write(json.dumps({\n"
        "    'status': 'ready',\n"
        "    'text': request['text'],\n"
        "    'locale': request['locale'],\n"
        "    'audio_reference': str(audio_path),\n"
        "    'timing': {'utterance_duration_ms': 640}\n"
        "}))\n",
        encoding="utf-8",
    )


class OperatorCommandSurfaceTests(unittest.TestCase):
    def test_router_exposes_operator_command_route_alongside_backend_owned_animation_lifecycle_routes(self) -> None:
        router = build_router_under_fake_fastapi()
        routes = {(route.path, method) for route in router.routes for method in route.methods}

        self.assertIn(("/session/operator-command", "POST"), routes)
        self.assertIn(("/session/active-character", "GET"), routes)
        self.assertIn(("/session/active-character", "PUT"), routes)
        self.assertIn(("/session/animation", "GET"), routes)
        self.assertIn(("/session/lifecycle-state", "PUT"), routes)
        self.assertIn(("/api/session/speech-artifacts/{event_id}/audio", "GET"), routes)
        self.assertIn(("/session/speech-artifacts/{event_id}/audio", "GET"), routes)
        self.assertEqual(
            1,
            sum(1 for route in router.routes if route.path == "/session/operator-command" and "POST" in route.methods),
        )
        self.assertEqual(
            1,
            sum(1 for route in router.routes if route.path == "/session/active-character" and "GET" in route.methods),
        )
        self.assertEqual(
            1,
            sum(1 for route in router.routes if route.path == "/session/active-character" and "PUT" in route.methods),
        )
        self.assertEqual(
            1,
            sum(
                1
                for route in router.routes
                if route.path == "/api/session/speech-artifacts/{event_id}/audio" and "GET" in route.methods
            ),
        )
        self.assertEqual(
            1,
            sum(
                1
                for route in router.routes
                if route.path == "/session/speech-artifacts/{event_id}/audio" and "GET" in route.methods
            ),
        )

    def test_tts_preview_uses_public_audio_reference_and_audio_route_resolves_current_session_artifact(self) -> None:
        with TemporaryDirectory() as temp_dir:
            with patch.dict(os.environ, {"NIKOF_TTS_MODELS_ROOT": temp_dir}, clear=False):
                audio_path = Path(temp_dir) / "preview.wav"
                audio_path.write_bytes(b"RIFF")
                default_services = build_default_api_runtime_services()
                router = build_router_under_fake_fastapi(
                    services_override=(
                        default_services.session_service,
                        default_services.character_service,
                        default_services.transcription_service,
                        StaticSynthesisService(
                            SpeechSynthesisContract(
                                profile_id="tts.gpt-sovits.2026-stable",
                                status="ready",
                                text="This is a voice preview.",
                                locale="en-US",
                                audio_reference=str(audio_path),
                            )
                        ),
                        default_services.text_generation_service,
                        default_services.speech_lifecycle_service,
                        default_services.speech_lifecycle_live_delivery,
                        default_services.session_event_factory,
                        default_services.turn_pipeline_publisher,
                    )
                )
                operator_command_route = get_route(router, path="/session/operator-command", method="POST")
                speech_lifecycle_route = get_route(router, path="/session/speech-lifecycle", method="GET")
                speech_artifact_route = get_route(
                    router,
                    path="/api/session/speech-artifacts/{event_id}/audio",
                    method="GET",
                )

                response = invoke_endpoint(
                    operator_command_route.endpoint,
                    command=OperatorCommandRequest(
                        command_type="tts_preview",
                        text="This is a voice preview.",
                        locale="en-US",
                    ),
                )
                speech_snapshot = invoke_endpoint(speech_lifecycle_route.endpoint)
                artifact_response = invoke_endpoint(
                    speech_artifact_route.endpoint,
                    event_id=response.speech_lifecycle_events[0].event_id,
                )

        expected_audio_reference = (
            f"/api/session/speech-artifacts/{response.speech_lifecycle_events[0].event_id}/audio"
        )

        self.assertEqual(
            expected_audio_reference,
            response.speech_lifecycle_events[0].event.synthesis.audio_reference,
        )
        self.assertEqual(expected_audio_reference, response.session_event.synthesis.audio_reference)
        self.assertEqual(
            expected_audio_reference,
            speech_snapshot.events[0].event.synthesis.audio_reference,
        )
        self.assertIsInstance(artifact_response, FakeFileResponse)
        self.assertEqual(audio_path.resolve(), Path(artifact_response.path).resolve())

    def test_active_character_routes_preserve_selection_envelope_for_success_and_rejection(self) -> None:
        router = build_router_under_fake_fastapi()
        get_active_character_route = get_route(router, path="/session/active-character", method="GET")
        set_active_character_route = get_route(router, path="/session/active-character", method="PUT")

        self.assertEqual([], list(inspect.signature(get_active_character_route.endpoint).parameters.keys()))
        self.assertEqual(
            ["selection", "response"],
            list(inspect.signature(set_active_character_route.endpoint).parameters.keys()),
        )

        initial_payload = _serialize_dataclass_payload(invoke_endpoint(get_active_character_route.endpoint))

        applied_response = FakeResponse()
        applied_payload = _serialize_dataclass_payload(
            invoke_endpoint(
                set_active_character_route.endpoint,
                selection=ActiveCharacterSelection(
                    character_id="test-vrm-02",
                    reason="user_selected",
                ),
                response=applied_response,
            )
        )

        rejected_response = FakeResponse()
        rejected_payload = _serialize_dataclass_payload(
            invoke_endpoint(
                set_active_character_route.endpoint,
                selection=ActiveCharacterSelection(
                    character_id="missing-character",
                    reason="user_selected",
                ),
                response=rejected_response,
            )
        )
        refreshed_payload = _serialize_dataclass_payload(invoke_endpoint(get_active_character_route.endpoint))

        self.assertEqual(list(initial_payload.keys()), list(applied_payload.keys()))
        self.assertEqual(list(initial_payload.keys()), list(rejected_payload.keys()))
        self.assertEqual(list(applied_payload.keys()), list(refreshed_payload.keys()))
        self.assertEqual("test-vrm-01", initial_payload["active_character"]["character_id"])
        self.assertTrue(initial_payload["selection"]["applied"])
        self.assertEqual("test-vrm-01", initial_payload["selection"]["requested_character_id"])
        self.assertEqual(200, applied_response.status_code)
        self.assertEqual("test-vrm-02", applied_payload["active_character"]["character_id"])
        self.assertTrue(applied_payload["selection"]["applied"])
        self.assertEqual("test-vrm-02", applied_payload["selection"]["requested_character_id"])
        self.assertEqual("session.character.selected", applied_payload["session_event"]["event_type"])
        self.assertEqual("applied", applied_payload["session_event"]["status"])
        self.assertEqual(400, rejected_response.status_code)
        self.assertEqual("test-vrm-02", rejected_payload["active_character"]["character_id"])
        self.assertFalse(rejected_payload["selection"]["applied"])
        self.assertEqual("missing-character", rejected_payload["selection"]["requested_character_id"])
        self.assertEqual("unknown_character", rejected_payload["selection"]["error_code"])
        self.assertEqual("Requested character is unavailable.", rejected_payload["selection"]["message"])
        self.assertEqual("session.character.rejected", rejected_payload["session_event"]["event_type"])
        self.assertEqual("rejected", rejected_payload["session_event"]["status"])
        self.assertEqual("test-vrm-02", refreshed_payload["active_character"]["character_id"])
        self.assertTrue(refreshed_payload["selection"]["applied"])
        self.assertEqual("test-vrm-02", refreshed_payload["selection"]["requested_character_id"])
        self.assertEqual("session.state", refreshed_payload["session_event"]["event_type"])
        self.assertEqual("idle", refreshed_payload["session_event"]["status"])

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
        self.assertEqual("idle.neutral", initial_snapshot["command"]["semantic_id"])
        self.assertEqual("speak", updated_snapshot["lifecycle_state"])
        self.assertEqual("idle.neutral", updated_snapshot["command"]["semantic_id"])
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
            "assistant.message",
            operator_payload["speech_lifecycle_events"][0]["event"]["event_type"],
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
            1,
            len(operator_payload["speech_lifecycle_events"]),
        )
        self.assertEqual(
            "queued",
            operator_payload["session_event"]["synthesis"]["status"],
        )
        self.assertGreaterEqual(
            len(speech_lifecycle_payload["events"]),
            1,
        )
        self.assertEqual(
            "assistant.message",
            speech_lifecycle_payload["events"][0]["event"]["event_type"],
        )

    def test_tts_preview_projects_browser_safe_audio_reference_and_route_serves_expected_artifact(self) -> None:
        with TemporaryDirectory() as temp_dir:
            temp_root = Path(temp_dir)
            provider_root = temp_root / "providers" / "tts" / "gpt-sovits"
            model_root = temp_root / "models" / "tts" / "gpt-sovits"
            provider_root.mkdir(parents=True)
            model_root.mkdir(parents=True)
            audio_path = model_root / "preview.wav"
            write_tts_provider_script(provider_root=provider_root, audio_path=audio_path)

            with patch.dict(
                os.environ,
                {
                    "NIKOF_LOCAL_ROOT": str(temp_root),
                    "NIKOF_TTS_MODELS_ROOT": str(temp_root / "models" / "tts"),
                    "NIKOF_PROVIDERS_ROOT": str(temp_root / "providers"),
                    "NIKOF_CACHE_ROOT": str(temp_root / "cache"),
                },
                clear=False,
            ):
                router = build_router_under_fake_fastapi()
                operator_command_route = get_route(router, path="/session/operator-command", method="POST")
                speech_lifecycle_route = get_route(router, path="/session/speech-lifecycle", method="GET")
                speech_artifact_route = get_route(
                    router,
                    path="/api/session/speech-artifacts/{event_id}/audio",
                    method="GET",
                )

                operator_payload = _serialize_dataclass_payload(
                    invoke_endpoint(
                        operator_command_route.endpoint,
                        command=OperatorCommandRequest(
                            command_type="tts_preview",
                            text="Preview this voice.",
                            locale="en-US",
                        ),
                    )
                )
                speech_lifecycle_payload = _serialize_dataclass_payload(
                    invoke_endpoint(
                        speech_lifecycle_route.endpoint,
                        request=FakeRequest(headers={"accept": "application/json"}),
                        cursor=None,
                    )
                )

                synthesis_envelope = operator_payload["speech_lifecycle_events"][0]
                expected_audio_reference = f"/api/session/speech-artifacts/{synthesis_envelope['event_id']}/audio"
                artifact_response = invoke_endpoint(
                    speech_artifact_route.endpoint,
                    event_id=synthesis_envelope["event_id"],
                )

        self.assertEqual(expected_audio_reference, synthesis_envelope["event"]["synthesis"]["audio_reference"])
        self.assertEqual(expected_audio_reference, operator_payload["session_event"]["synthesis"]["audio_reference"])
        self.assertEqual(expected_audio_reference, speech_lifecycle_payload["events"][0]["event"]["synthesis"]["audio_reference"])
        self.assertIsInstance(artifact_response, FakeFileResponse)
        self.assertEqual(audio_path, Path(artifact_response.path))
        self.assertIn(artifact_response.media_type, {"audio/wav", "audio/x-wav"})

    def test_tts_preview_does_not_turn_foreign_absolute_paths_into_public_artifacts(self) -> None:
        with TemporaryDirectory() as temp_dir:
            temp_root = Path(temp_dir)
            provider_root = temp_root / "providers" / "tts" / "gpt-sovits"
            model_root = temp_root / "models" / "tts" / "gpt-sovits"
            foreign_root = temp_root / "foreign-artifacts"
            provider_root.mkdir(parents=True)
            model_root.mkdir(parents=True)
            foreign_root.mkdir(parents=True)
            audio_path = foreign_root / "preview.wav"
            write_tts_provider_script(provider_root=provider_root, audio_path=audio_path)

            with patch.dict(
                os.environ,
                {
                    "NIKOF_LOCAL_ROOT": str(temp_root),
                    "NIKOF_TTS_MODELS_ROOT": str(temp_root / "models" / "tts"),
                    "NIKOF_PROVIDERS_ROOT": str(temp_root / "providers"),
                    "NIKOF_CACHE_ROOT": str(temp_root / "cache"),
                },
                clear=False,
            ):
                router = build_router_under_fake_fastapi()
                operator_command_route = get_route(router, path="/session/operator-command", method="POST")
                speech_artifact_route = get_route(
                    router,
                    path="/api/session/speech-artifacts/{event_id}/audio",
                    method="GET",
                )

                operator_payload = _serialize_dataclass_payload(
                    invoke_endpoint(
                        operator_command_route.endpoint,
                        command=OperatorCommandRequest(
                            command_type="tts_preview",
                            text="Preview this voice.",
                            locale="en-US",
                        ),
                    )
                )
                synthesis_envelope = operator_payload["speech_lifecycle_events"][0]

                with self.assertRaises(FakeHTTPException) as raised_error:
                    invoke_endpoint(
                        speech_artifact_route.endpoint,
                        event_id=synthesis_envelope["event_id"],
                    )

        self.assertEqual(str(audio_path), synthesis_envelope["event"]["synthesis"]["audio_reference"])
        self.assertEqual(404, raised_error.exception.status_code)
        self.assertEqual(
            "Speech audio artifact is unavailable for the current session.",
            raised_error.exception.detail,
        )


if __name__ == "__main__":
    unittest.main()