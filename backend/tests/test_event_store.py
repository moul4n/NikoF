from __future__ import annotations

import asyncio
import json
import types
from unittest.mock import patch
import threading
import time
from pathlib import Path
import sys
from tempfile import TemporaryDirectory
import unittest
from typing import cast


BACKEND_ROOT = Path(__file__).resolve().parents[1]
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from app.api.router import _build_speech_lifecycle_sse_frame, _serialize_dataclass_payload, build_api_router
from app.schemas.animation import SessionAnimationSnapshot
from app.schemas.session import (
    AssistantMessageContract,
    OperatorCommandRequest,
    SessionSnapshot,
    SessionLifecycleUpdateRequest,
    SpeechSynthesisContract,
    SpeechTranscriptionContract,
)
from app.services.animation import (
    InMemorySessionAnimationLiveDeliveryService,
    SESSION_ANIMATION_STREAM,
)
from app.services.character import CharacterService, FileSystemCharacterManifestSource
from app.services.llm import TextGenerationRequest
from app.services.session import InMemorySessionService
from app.services.session import InMemorySessionEventStore
from app.services.memory import SqliteSessionMemoryService
from app.services.speech import (
    BackendTurnRequest,
    DefaultSessionEventFactory,
    DefaultTurnPipelinePublisher,
    PollingSpeechLifecycleLiveDeliveryService,
    SpeechSynthesisService,
    SpeechSynthesisRequest,
    SpeechTranscriptionService,
    SpeechTranscriptionRequest,
    SPEECH_LIFECYCLE_STREAM,
    StubSpeechLifecycleSnapshotService,
    StubSpeechSynthesisService,
    StubSpeechTranscriptionService,
)


class StaticSpeechTranscriptionService:
    def __init__(self, contract: SpeechTranscriptionContract) -> None:
        self._contract = contract

    def transcribe(self, request: SpeechTranscriptionRequest) -> SpeechTranscriptionContract:
        return self._contract


class StaticSpeechSynthesisService:
    def __init__(self, contract: SpeechSynthesisContract) -> None:
        self._contract = contract

    def synthesize(self, request: SpeechSynthesisRequest) -> SpeechSynthesisContract:
        return self._contract


class CapturingSpeechTranscriptionService(StubSpeechTranscriptionService):
    def __init__(self) -> None:
        super().__init__()
        self.requests: list[SpeechTranscriptionRequest] = []

    def transcribe(self, request: SpeechTranscriptionRequest) -> SpeechTranscriptionContract:
        self.requests.append(request)
        return super().transcribe(request)


class StaticTextGenerationService:
    def __init__(self, contract: AssistantMessageContract) -> None:
        self._contract = contract

    def generate(self, request: TextGenerationRequest) -> AssistantMessageContract:
        return AssistantMessageContract(
            profile_id=self._contract.profile_id,
            status=self._contract.status,
            locale=request.locale,
            text=self._contract.text,
        )


class FiniteSpeechLifecycleLiveDeliveryService:
    def __init__(self, snapshot_service: StubSpeechLifecycleSnapshotService) -> None:
        self._snapshot_service = snapshot_service
        self.cursors: list[str | None] = []

    def iter_live_events(
        self,
        snapshot: SessionSnapshot,
        *,
        character_id: str,
        cursor: str | None = None,
        poll_interval_seconds: float = 0.25,
    ):
        del poll_interval_seconds
        self.cursors.append(cursor)
        transport_snapshot = self._snapshot_service.get_snapshot(
            snapshot,
            character_id=character_id,
            cursor=cursor,
        )
        for envelope in transport_snapshot.events:
            yield envelope


class FiniteSessionAnimationLiveDeliveryService:
    def __init__(self) -> None:
        self._live_delivery = InMemorySessionAnimationLiveDeliveryService()
        self.cursors: list[str | None] = []

    def publish_snapshot(self, snapshot: SessionAnimationSnapshot):
        return self._live_delivery.publish_snapshot(snapshot)

    def read_updates(self, session_id: str, *, after_cursor: str | None = None):
        return self._live_delivery.read_updates(session_id, after_cursor=after_cursor)

    def iter_live_updates(
        self,
        session_id: str,
        *,
        cursor: str | None = None,
        poll_interval_seconds: float = 0.25,
    ):
        del poll_interval_seconds
        self.cursors.append(cursor)
        for update in self._live_delivery.read_updates(session_id, after_cursor=cursor):
            yield update


def parse_sse_messages(payload: str) -> list[dict[str, str]]:
    messages: list[dict[str, str]] = []

    for block in payload.replace("\r\n", "\n").strip().split("\n\n"):
        if not block:
            continue

        message: dict[str, str] = {}
        for line in block.split("\n"):
            field, separator, value = line.partition(":")
            if not separator:
                continue
            message[field] = value.lstrip()

        messages.append(message)

    return messages


def canonicalize_transport_payload(value: object) -> object:
    return json.loads(json.dumps(value))


class FakeHTTPException(Exception):
    def __init__(self, *, status_code: int, detail: str) -> None:
        super().__init__(detail)
        self.status_code = status_code
        self.detail = detail


class FakeRequest:
    def __init__(self, *, headers: dict[str, str] | None = None, disconnected: bool = False) -> None:
        self.headers = headers or {}
        self._disconnected = disconnected

    async def is_disconnected(self) -> bool:
        return self._disconnected


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


def collect_streaming_payload(streaming_response: FakeStreamingResponse) -> str:
    async def consume() -> str:
        parts: list[str] = []
        async for chunk in streaming_response.body_iterator:
            parts.append(chunk)
        return "".join(parts)

    return cast(str, asyncio.run(consume()))


def build_transport_route_endpoint() -> tuple[object, BackendTurnPublication, FiniteSpeechLifecycleLiveDeliveryService]:
    fake_fastapi = types.ModuleType("fastapi")
    fake_fastapi.APIRouter = FakeAPIRouter
    fake_fastapi.HTTPException = FakeHTTPException
    fake_fastapi.Request = FakeRequest
    fake_fastapi.Response = FakeResponse
    fake_fastapi.status = types.SimpleNamespace(HTTP_400_BAD_REQUEST=400)
    fake_fastapi_responses = types.ModuleType("fastapi.responses")
    fake_fastapi_responses.StreamingResponse = FakeStreamingResponse

    session_service = InMemorySessionService(default_character_id="test-vrm-01")
    snapshot = session_service.get_snapshot()
    transcription_service = StubSpeechTranscriptionService()
    synthesis_service = StubSpeechSynthesisService()
    text_generation_service = StaticTextGenerationService(build_assistant_message_contract("ready"))
    session_event_factory = DefaultSessionEventFactory()
    turn_pipeline_publisher = DefaultTurnPipelinePublisher(
        transcription_service=transcription_service,
        synthesis_service=synthesis_service,
        session_event_factory=session_event_factory,
        event_store=session_service.event_store,
    )
    publication = turn_pipeline_publisher.publish_turn(snapshot, build_turn_request())
    character_service = CharacterService(FileSystemCharacterManifestSource())
    speech_lifecycle_service = StubSpeechLifecycleSnapshotService(event_store=session_service.event_store)
    speech_lifecycle_live_delivery = FiniteSpeechLifecycleLiveDeliveryService(
        snapshot_service=speech_lifecycle_service
    )

    with patch.dict(
        sys.modules,
        {
            "fastapi": fake_fastapi,
            "fastapi.responses": fake_fastapi_responses,
        },
    ):
        with patch(
            "app.api.router._build_services",
            return_value=(
                session_service,
                character_service,
                transcription_service,
                synthesis_service,
                text_generation_service,
                speech_lifecycle_service,
                speech_lifecycle_live_delivery,
                session_event_factory,
                turn_pipeline_publisher,
            ),
        ):
            router = build_api_router()

    speech_lifecycle_route = next(
        route
        for route in router.routes
        if route.path == "/session/speech-lifecycle" and "GET" in route.methods
    )
    return speech_lifecycle_route.endpoint, publication, speech_lifecycle_live_delivery


def build_session_animation_route_endpoints() -> tuple[object, object, FiniteSessionAnimationLiveDeliveryService]:
    fake_fastapi = types.ModuleType("fastapi")
    fake_fastapi.APIRouter = FakeAPIRouter
    fake_fastapi.HTTPException = FakeHTTPException
    fake_fastapi.Request = FakeRequest
    fake_fastapi.Response = FakeResponse
    fake_fastapi.status = types.SimpleNamespace(HTTP_400_BAD_REQUEST=400)
    fake_fastapi_responses = types.ModuleType("fastapi.responses")
    fake_fastapi_responses.StreamingResponse = FakeStreamingResponse

    session_service = InMemorySessionService(default_character_id="test-vrm-01")
    character_service = CharacterService(FileSystemCharacterManifestSource())
    transcription_service = StubSpeechTranscriptionService()
    synthesis_service = StubSpeechSynthesisService()
    text_generation_service = StaticTextGenerationService(build_assistant_message_contract("ready"))
    session_event_factory = DefaultSessionEventFactory()
    speech_lifecycle_service = StubSpeechLifecycleSnapshotService(event_store=session_service.event_store)
    speech_lifecycle_live_delivery = FiniteSpeechLifecycleLiveDeliveryService(
        snapshot_service=speech_lifecycle_service
    )
    turn_pipeline_publisher = DefaultTurnPipelinePublisher(
        transcription_service=transcription_service,
        synthesis_service=synthesis_service,
        session_event_factory=session_event_factory,
        event_store=session_service.event_store,
    )
    session_animation_live_delivery = FiniteSessionAnimationLiveDeliveryService()

    with patch.dict(
        sys.modules,
        {
            "fastapi": fake_fastapi,
            "fastapi.responses": fake_fastapi_responses,
        },
    ):
        with patch(
            "app.api.router._build_services",
            return_value=(
                session_service,
                character_service,
                transcription_service,
                synthesis_service,
                text_generation_service,
                speech_lifecycle_service,
                speech_lifecycle_live_delivery,
                session_event_factory,
                turn_pipeline_publisher,
            ),
        ):
            with patch(
                "app.api.router._build_session_animation_live_delivery_service",
                return_value=session_animation_live_delivery,
            ):
                router = build_api_router()

    animation_route = next(
        route
        for route in router.routes
        if route.path == "/session/animation" and "GET" in route.methods
    )
    lifecycle_route = next(
        route
        for route in router.routes
        if route.path == "/session/lifecycle-state" and "PUT" in route.methods
    )
    return animation_route.endpoint, lifecycle_route.endpoint, session_animation_live_delivery


def build_operator_command_route_endpoint(
    *,
    text_generation_service: StaticTextGenerationService | None = None,
) -> tuple[object, InMemorySessionService]:
    fake_fastapi = types.ModuleType("fastapi")
    fake_fastapi.APIRouter = FakeAPIRouter
    fake_fastapi.HTTPException = FakeHTTPException
    fake_fastapi.Request = FakeRequest
    fake_fastapi.Response = FakeResponse
    fake_fastapi.status = types.SimpleNamespace(HTTP_400_BAD_REQUEST=400)
    fake_fastapi_responses = types.ModuleType("fastapi.responses")
    fake_fastapi_responses.StreamingResponse = FakeStreamingResponse

    session_service = InMemorySessionService(default_character_id="test-vrm-01")
    character_service = CharacterService(FileSystemCharacterManifestSource())
    transcription_service = StubSpeechTranscriptionService()
    synthesis_service = StubSpeechSynthesisService()
    resolved_text_generation_service = text_generation_service or StaticTextGenerationService(
        build_assistant_message_contract("ready")
    )
    session_event_factory = DefaultSessionEventFactory()
    speech_lifecycle_service = StubSpeechLifecycleSnapshotService(event_store=session_service.event_store)
    speech_lifecycle_live_delivery = FiniteSpeechLifecycleLiveDeliveryService(
        snapshot_service=speech_lifecycle_service
    )
    turn_pipeline_publisher = DefaultTurnPipelinePublisher(
        transcription_service=transcription_service,
        synthesis_service=synthesis_service,
        session_event_factory=session_event_factory,
        event_store=session_service.event_store,
    )

    with patch.dict(
        sys.modules,
        {
            "fastapi": fake_fastapi,
            "fastapi.responses": fake_fastapi_responses,
        },
    ):
        with patch(
            "app.api.router._build_services",
            return_value=(
                session_service,
                character_service,
                transcription_service,
                synthesis_service,
                resolved_text_generation_service,
                speech_lifecycle_service,
                speech_lifecycle_live_delivery,
                session_event_factory,
                turn_pipeline_publisher,
            ),
        ):
            router = build_api_router()

    operator_command_route = next(
        route
        for route in router.routes
        if route.path == "/session/operator-command" and "POST" in route.methods
    )
    return operator_command_route.endpoint, session_service


def build_turn_request() -> BackendTurnRequest:
    return BackendTurnRequest(
        character_id="test-vrm-01",
        transcription=SpeechTranscriptionRequest(
            audio_reference="session://speech-sample/transcription.wav",
            locale="en-US",
            transcript_hint="Hey Niko, can you wave after you answer?",
            confidence_hint=0.98,
        ),
        synthesis=SpeechSynthesisRequest(
            text="Sure. I can wave once I finish speaking.",
            locale="en-US",
        ),
    )


def build_transcription_contract(status: str) -> SpeechTranscriptionContract:
    return SpeechTranscriptionContract(
        profile_id="stt.faster-whisper.medium-2026",
        status=status,
        locale="en-US",
        transcript="Hey Niko, can you wave after you answer?",
        confidence=0.98,
    )


def build_synthesis_contract(
    status: str,
    *,
    audio_reference: str | None = None,
) -> SpeechSynthesisContract:
    return SpeechSynthesisContract(
        profile_id="tts.gpt-sovits.2026-stable",
        status=status,
        text="Sure. I can wave once I finish speaking.",
        locale="en-US",
        audio_reference=audio_reference,
    )


def build_assistant_message_contract(
    status: str,
    text: str = "You should keep iterating on the backend seam.",
) -> AssistantMessageContract:
    return AssistantMessageContract(
        profile_id="llm.ollama.llama3.1-8b-2026",
        status=status,
        text=text,
        locale="en-US",
    )


class InMemorySessionEventStoreTests(unittest.TestCase):
    def test_append_and_cursor_reads_are_ordered(self) -> None:
        snapshot = SessionSnapshot(
            session_id="session-scaffold-01",
            active_character_id="test-vrm-01",
        )
        store = InMemorySessionEventStore()
        factory = DefaultSessionEventFactory()

        first_event = factory.build_event(
            snapshot,
            character_id="test-vrm-01",
            event_type="transcription.status",
            status="final",
        )
        second_event = factory.build_event(
            snapshot,
            character_id="test-vrm-01",
            event_type="speech.synthesis",
            status="ready",
        )

        first_envelope = store.append("speech.lifecycle", first_event)
        second_envelope = store.append("speech.lifecycle", second_event)

        all_events = store.read("speech.lifecycle", session_id=snapshot.session_id)
        after_first = store.read(
            "speech.lifecycle",
            session_id=snapshot.session_id,
            after_cursor=first_envelope.cursor,
        )

        self.assertEqual([1, 2], [event.sequence for event in all_events])
        self.assertEqual(second_envelope.cursor, after_first[0].cursor)
        self.assertEqual(
            "speech.lifecycle:session-scaffold-01:3",
            store.next_cursor("speech.lifecycle", session_id=snapshot.session_id),
        )


class StubSpeechLifecycleSnapshotServiceTests(unittest.TestCase):
    def test_snapshot_reads_do_not_seed_events_before_turn_publication(self) -> None:
        snapshot = SessionSnapshot(
            session_id="session-scaffold-01",
            active_character_id="test-vrm-01",
        )
        store = InMemorySessionEventStore()
        service = StubSpeechLifecycleSnapshotService(event_store=store)

        initial_snapshot = service.get_snapshot(snapshot, character_id="test-vrm-01")

        self.assertEqual((), initial_snapshot.events)
        self.assertEqual(
            "speech.lifecycle:session-scaffold-01:1",
            initial_snapshot.next_cursor,
        )

        publisher = DefaultTurnPipelinePublisher(
            transcription_service=StubSpeechTranscriptionService(),
            synthesis_service=StubSpeechSynthesisService(),
            session_event_factory=DefaultSessionEventFactory(),
            event_store=store,
        )
        publisher.publish_turn(snapshot, build_turn_request())

        published_snapshot = service.get_snapshot(snapshot, character_id="test-vrm-01")

        self.assertEqual(
            ["transcription.status", "speech.synthesis"],
            [event.event.event_type for event in published_snapshot.events],
        )

    def test_snapshot_reads_published_events_and_support_cursor_reads(self) -> None:
        snapshot = SessionSnapshot(
            session_id="session-scaffold-01",
            active_character_id="test-vrm-01",
        )
        store = InMemorySessionEventStore()
        publisher = DefaultTurnPipelinePublisher(
            transcription_service=StubSpeechTranscriptionService(),
            synthesis_service=StubSpeechSynthesisService(),
            session_event_factory=DefaultSessionEventFactory(),
            event_store=store,
        )
        publisher.publish_turn(snapshot, build_turn_request())
        service = StubSpeechLifecycleSnapshotService(
            event_store=store,
        )

        first_snapshot = service.get_snapshot(snapshot, character_id="test-vrm-01")
        after_first_snapshot = service.get_snapshot(
            snapshot,
            character_id="test-vrm-01",
            cursor=first_snapshot.events[0].cursor,
        )
        publisher.publish_turn(
            snapshot,
            BackendTurnRequest(
                character_id="test-vrm-02",
                transcription=build_turn_request().transcription,
                synthesis=build_turn_request().synthesis,
            ),
        )
        changed_character_snapshot = service.get_snapshot(snapshot, character_id="test-vrm-02")

        self.assertEqual(2, len(first_snapshot.events))
        self.assertEqual(1, len(after_first_snapshot.events))
        self.assertEqual("speech.synthesis", after_first_snapshot.events[0].event.event_type)
        self.assertEqual(4, len(changed_character_snapshot.events))
        self.assertEqual("test-vrm-02", changed_character_snapshot.events[-1].event.character_id)
        self.assertEqual(
            "speech.lifecycle:session-scaffold-01:5",
            changed_character_snapshot.next_cursor,
        )


class PollingSpeechLifecycleLiveDeliveryServiceTests(unittest.TestCase):
    def test_live_delivery_replays_existing_canonical_envelopes(self) -> None:
        snapshot = SessionSnapshot(
            session_id="session-scaffold-01",
            active_character_id="test-vrm-01",
        )
        store = InMemorySessionEventStore()
        publisher = DefaultTurnPipelinePublisher(
            transcription_service=StubSpeechTranscriptionService(),
            synthesis_service=StubSpeechSynthesisService(),
            session_event_factory=DefaultSessionEventFactory(),
            event_store=store,
        )
        publisher.publish_turn(snapshot, build_turn_request())
        live_delivery = PollingSpeechLifecycleLiveDeliveryService(
            snapshot_service=StubSpeechLifecycleSnapshotService(event_store=store)
        )

        stream = live_delivery.iter_live_events(
            snapshot,
            character_id="test-vrm-01",
            poll_interval_seconds=0.001,
        )

        try:
            first_envelope = next(stream)
            second_envelope = next(stream)
        finally:
            stream.close()

        self.assertEqual([1, 2], [first_envelope.sequence, second_envelope.sequence])
        self.assertEqual(
            ["transcription.status", "speech.synthesis"],
            [first_envelope.event.event_type, second_envelope.event.event_type],
        )

    def test_live_delivery_waits_for_new_events_after_cursor(self) -> None:
        snapshot = SessionSnapshot(
            session_id="session-scaffold-01",
            active_character_id="test-vrm-01",
        )
        store = InMemorySessionEventStore()
        publisher = DefaultTurnPipelinePublisher(
            transcription_service=StubSpeechTranscriptionService(),
            synthesis_service=StubSpeechSynthesisService(),
            session_event_factory=DefaultSessionEventFactory(),
            event_store=store,
        )
        initial_publication = publisher.publish_turn(snapshot, build_turn_request())
        live_delivery = PollingSpeechLifecycleLiveDeliveryService(
            snapshot_service=StubSpeechLifecycleSnapshotService(event_store=store)
        )
        received_sequences: list[int] = []

        def collect_live_events() -> None:
            stream = live_delivery.iter_live_events(
                snapshot,
                character_id="test-vrm-01",
                cursor=initial_publication.speech_lifecycle_events[-1].cursor,
                poll_interval_seconds=0.001,
            )
            try:
                received_sequences.append(next(stream).sequence)
                received_sequences.append(next(stream).sequence)
            finally:
                stream.close()

        collector = threading.Thread(target=collect_live_events)
        collector.start()
        time.sleep(0.01)
        publisher.publish_turn(snapshot, build_turn_request())
        collector.join(timeout=1)

        self.assertFalse(collector.is_alive())
        self.assertEqual([3, 4], received_sequences)


class SpeechLifecycleSseFormattingTests(unittest.TestCase):
    def test_sse_frame_reuses_existing_envelope_shape(self) -> None:
        snapshot = SessionSnapshot(
            session_id="session-scaffold-01",
            active_character_id="test-vrm-01",
        )
        store = InMemorySessionEventStore()
        publisher = DefaultTurnPipelinePublisher(
            transcription_service=StubSpeechTranscriptionService(),
            synthesis_service=StubSpeechSynthesisService(),
            session_event_factory=DefaultSessionEventFactory(),
            event_store=store,
        )
        publication = publisher.publish_turn(snapshot, build_turn_request())

        frame = _build_speech_lifecycle_sse_frame(publication.speech_lifecycle_events[0])

        self.assertIn(f"event: {SPEECH_LIFECYCLE_STREAM}", frame)
        self.assertIn(f"id: {publication.speech_lifecycle_events[0].cursor}", frame)
        self.assertIn('"sequence":1', frame)
        self.assertIn('"event_type":"transcription.status"', frame)

    def test_snapshot_cursor_reads_keep_the_transport_reuse_envelope_shape(self) -> None:
        snapshot = SessionSnapshot(
            session_id="session-scaffold-01",
            active_character_id="test-vrm-01",
        )
        store = InMemorySessionEventStore()
        publisher = DefaultTurnPipelinePublisher(
            transcription_service=StubSpeechTranscriptionService(),
            synthesis_service=StubSpeechSynthesisService(),
            session_event_factory=DefaultSessionEventFactory(),
            event_store=store,
        )
        publisher.publish_turn(snapshot, build_turn_request())
        service = StubSpeechLifecycleSnapshotService(event_store=store)

        full_snapshot = service.get_snapshot(snapshot, character_id="test-vrm-01")
        incremental_snapshot = service.get_snapshot(
            snapshot,
            character_id="test-vrm-01",
            cursor=full_snapshot.events[0].cursor,
        )

        self.assertEqual(
            ["event_id", "sequence", "cursor", "event"],
            list(type(full_snapshot.events[0]).__dataclass_fields__.keys()),
        )
        self.assertEqual(
            ["event_id", "sequence", "cursor", "event"],
            list(type(incremental_snapshot.events[0]).__dataclass_fields__.keys()),
        )
        self.assertEqual([1, 2], [event.sequence for event in full_snapshot.events])
        self.assertEqual(
            ["speech.lifecycle:session-scaffold-01:1", "speech.lifecycle:session-scaffold-01:2"],
            [event.cursor for event in full_snapshot.events],
        )
        self.assertEqual([2], [event.sequence for event in incremental_snapshot.events])
        self.assertEqual(
            ["speech.lifecycle:session-scaffold-01:2"],
            [event.cursor for event in incremental_snapshot.events],
        )
        self.assertEqual(full_snapshot.next_cursor, incremental_snapshot.next_cursor)


class SpeechLifecycleRouteTransportTests(unittest.TestCase):
    def test_route_keeps_snapshot_delivery_without_event_stream_accept(self) -> None:
        endpoint, publication, _live_delivery = build_transport_route_endpoint()

        response = cast(
            object,
            asyncio.run(endpoint(FakeRequest(headers={"accept": "application/json"}), cursor=None)),
        )

        payload = _serialize_dataclass_payload(response)
        canonical_payload = cast(dict[str, object], canonicalize_transport_payload(payload))
        self.assertEqual("snapshot", payload["delivery"])
        self.assertEqual(
            [envelope.cursor for envelope in publication.speech_lifecycle_events],
            [event["cursor"] for event in cast(list[dict[str, object]], canonical_payload["events"])],
        )
        self.assertEqual(
            [envelope.event.event_type for envelope in publication.speech_lifecycle_events],
            [
                event["event"]["event_type"]
                for event in cast(list[dict[str, object]], canonical_payload["events"])
            ],
        )
        self.assertEqual(
            "speech.lifecycle:session-scaffold-01:3",
            payload["next_cursor"],
        )

    def test_route_returns_sse_frames_with_existing_cursor_and_envelope_shape(self) -> None:
        endpoint, publication, live_delivery = build_transport_route_endpoint()

        response = cast(
            FakeStreamingResponse,
            asyncio.run(
                endpoint(FakeRequest(headers={"accept": "text/event-stream"}), cursor=None)
            ),
        )

        self.assertEqual("text/event-stream", response.media_type)

        messages = parse_sse_messages(collect_streaming_payload(response))
        self.assertEqual([None], live_delivery.cursors)
        expected_envelopes = [
            canonicalize_transport_payload(_serialize_dataclass_payload(envelope))
            for envelope in publication.speech_lifecycle_events
        ]

        self.assertEqual(2, len(messages))
        self.assertEqual(
            [envelope.cursor for envelope in publication.speech_lifecycle_events],
            [message["id"] for message in messages],
        )
        self.assertEqual(
            [SPEECH_LIFECYCLE_STREAM, SPEECH_LIFECYCLE_STREAM],
            [message["event"] for message in messages],
        )
        self.assertEqual(
            expected_envelopes,
            [canonicalize_transport_payload(json.loads(message["data"])) for message in messages],
        )

    def test_route_sse_resume_reuses_existing_cursor_query_seam(self) -> None:
        endpoint, publication, live_delivery = build_transport_route_endpoint()
        resume_cursor = publication.speech_lifecycle_events[0].cursor

        response = cast(
            FakeStreamingResponse,
            asyncio.run(
                endpoint(
                    FakeRequest(headers={"accept": "text/event-stream"}),
                    cursor=resume_cursor,
                )
            ),
        )

        self.assertEqual("text/event-stream", response.media_type)

        messages = parse_sse_messages(collect_streaming_payload(response))
        self.assertEqual([resume_cursor], live_delivery.cursors)

        self.assertEqual(1, len(messages))
        self.assertEqual(publication.speech_lifecycle_events[1].cursor, messages[0]["id"])
        self.assertEqual(
            canonicalize_transport_payload(
                _serialize_dataclass_payload(publication.speech_lifecycle_events[1])
            ),
            canonicalize_transport_payload(json.loads(messages[0]["data"])),
        )

    def test_route_rejects_invalid_cursor_before_transport_negotiation(self) -> None:
        endpoint, _publication, _live_delivery = build_transport_route_endpoint()

        with self.assertRaises(FakeHTTPException) as raised:
            asyncio.run(
                endpoint(
                    FakeRequest(headers={"accept": "text/event-stream"}),
                    cursor="speech.lifecycle:wrong-session:1",
                )
            )

        self.assertEqual(400, raised.exception.status_code)
        self.assertIn("does not belong", raised.exception.detail)


class SessionAnimationRouteTransportTests(unittest.TestCase):
    def test_route_keeps_snapshot_delivery_without_event_stream_accept(self) -> None:
        animation_endpoint, _lifecycle_endpoint, _live_delivery = build_session_animation_route_endpoints()

        response = cast(
            object,
            asyncio.run(
                animation_endpoint(FakeRequest(headers={"accept": "application/json"}), cursor=None)
            ),
        )

        payload = _serialize_dataclass_payload(response)
        self.assertEqual("session-scaffold-01", payload["session_id"])
        self.assertEqual("idle", payload["lifecycle_state"])
        self.assertEqual("idle.default", payload["command"]["semantic_id"])
        self.assertEqual("selected", payload["command"]["resolved_state"])

    def test_route_returns_sse_frames_with_existing_cursor_and_snapshot_shape(self) -> None:
        animation_endpoint, lifecycle_endpoint, live_delivery = build_session_animation_route_endpoints()

        lifecycle_endpoint(SessionLifecycleUpdateRequest(lifecycle_state="listen"))
        lifecycle_endpoint(SessionLifecycleUpdateRequest(lifecycle_state="speak"))

        expected_updates = live_delivery.read_updates("session-scaffold-01")
        response = cast(
            FakeStreamingResponse,
            asyncio.run(
                animation_endpoint(FakeRequest(headers={"accept": "text/event-stream"}), cursor=None)
            ),
        )

        self.assertEqual("text/event-stream", response.media_type)

        messages = parse_sse_messages(collect_streaming_payload(response))
        self.assertEqual([None], live_delivery.cursors)
        self.assertEqual(2, len(messages))
        self.assertEqual([update.cursor for update in expected_updates], [message["id"] for message in messages])
        self.assertEqual(
            [SESSION_ANIMATION_STREAM, SESSION_ANIMATION_STREAM],
            [message["event"] for message in messages],
        )
        self.assertEqual(
            [
                canonicalize_transport_payload(_serialize_dataclass_payload(update.snapshot))
                for update in expected_updates
            ],
            [canonicalize_transport_payload(json.loads(message["data"])) for message in messages],
        )

    def test_route_sse_resume_reuses_existing_cursor_query_seam(self) -> None:
        animation_endpoint, lifecycle_endpoint, live_delivery = build_session_animation_route_endpoints()

        lifecycle_endpoint(SessionLifecycleUpdateRequest(lifecycle_state="listen"))
        lifecycle_endpoint(SessionLifecycleUpdateRequest(lifecycle_state="speak"))
        expected_updates = live_delivery.read_updates("session-scaffold-01")
        resume_cursor = expected_updates[0].cursor

        response = cast(
            FakeStreamingResponse,
            asyncio.run(
                animation_endpoint(
                    FakeRequest(headers={"accept": "text/event-stream"}),
                    cursor=resume_cursor,
                )
            ),
        )

        messages = parse_sse_messages(collect_streaming_payload(response))
        self.assertEqual([resume_cursor], live_delivery.cursors)
        self.assertEqual(1, len(messages))
        self.assertEqual(expected_updates[1].cursor, messages[0]["id"])
        self.assertEqual(
            canonicalize_transport_payload(_serialize_dataclass_payload(expected_updates[1].snapshot)),
            canonicalize_transport_payload(json.loads(messages[0]["data"])),
        )

    def test_route_rejects_invalid_cursor_before_transport_negotiation(self) -> None:
        animation_endpoint, _lifecycle_endpoint, _live_delivery = build_session_animation_route_endpoints()

        with self.assertRaises(FakeHTTPException) as raised:
            asyncio.run(
                animation_endpoint(
                    FakeRequest(headers={"accept": "text/event-stream"}),
                    cursor=f"{SESSION_ANIMATION_STREAM}:wrong-session:1",
                )
            )

        self.assertEqual(400, raised.exception.status_code)
        self.assertIn("does not belong", raised.exception.detail)


class OperatorCommandRouteTests(unittest.TestCase):
    def test_text_question_command_publishes_canonical_assistant_event(self) -> None:
        endpoint, session_service = build_operator_command_route_endpoint()

        response = endpoint(
            OperatorCommandRequest(
                command_type="text_question",
                text="What should I do next?",
                locale="en-US",
            )
        )

        payload = _serialize_dataclass_payload(response)
        speech_events = session_service.event_store.read("speech.lifecycle", session_id="session-scaffold-01")
        session_events = session_service.event_store.read("session", session_id="session-scaffold-01")

        self.assertEqual("text_question", payload["command_type"])
        self.assertEqual("ready", payload["status"])
        self.assertEqual("test-vrm-01", payload["character_id"])
        self.assertEqual("session.operator.text-question", payload["session_event"]["event_type"])
        self.assertEqual("assistant.message", payload["speech_lifecycle_events"][0]["event"]["event_type"])
        self.assertEqual("speech.synthesis", payload["speech_lifecycle_events"][1]["event"]["event_type"])
        self.assertEqual(
            "You should keep iterating on the backend seam.",
            payload["speech_lifecycle_events"][0]["event"]["assistant"]["text"],
        )
        self.assertEqual(
            "You should keep iterating on the backend seam.",
            payload["speech_lifecycle_events"][1]["event"]["synthesis"]["text"],
        )
        self.assertEqual(
            "You should keep iterating on the backend seam.",
            payload["session_event"]["assistant"]["text"],
        )
        self.assertEqual(
            ["assistant.message", "speech.synthesis"],
            [event.event.event_type for event in speech_events],
        )
        self.assertEqual(["session.operator.text-question"], [event.event.event_type for event in session_events])
        self.assertEqual("speech.lifecycle:session-scaffold-01:3", payload["next_speech_cursor"])

    def test_text_question_command_reply_round_trips_through_speech_snapshot(self) -> None:
        endpoint, session_service = build_operator_command_route_endpoint()

        response = endpoint(
            OperatorCommandRequest(
                command_type="text_question",
                text="What should I do next?",
                locale="en-US",
            )
        )

        response_payload = cast(
            dict[str, object],
            canonicalize_transport_payload(_serialize_dataclass_payload(response)),
        )
        snapshot_service = StubSpeechLifecycleSnapshotService(event_store=session_service.event_store)
        transport_snapshot = snapshot_service.get_snapshot(
            session_service.get_snapshot(),
            character_id="test-vrm-01",
        )
        snapshot_payload = cast(
            dict[str, object],
            canonicalize_transport_payload(_serialize_dataclass_payload(transport_snapshot)),
        )

        response_events = cast(list[dict[str, object]], response_payload["speech_lifecycle_events"])
        snapshot_events = cast(list[dict[str, object]], snapshot_payload["events"])

        self.assertEqual(response_events, snapshot_events)
        self.assertEqual(response_payload["next_speech_cursor"], snapshot_payload["next_cursor"])
        self.assertEqual(
            response_payload["session_event"]["assistant"],
            snapshot_events[0]["event"]["assistant"],
        )
        self.assertEqual(
            response_events[1]["event"]["synthesis"],
            snapshot_events[1]["event"]["synthesis"],
        )

    def test_text_question_command_surfaces_unavailable_assistant_status(self) -> None:
        endpoint, session_service = build_operator_command_route_endpoint(
            text_generation_service=StaticTextGenerationService(
                build_assistant_message_contract("unavailable", "Local text generation is unavailable.")
            )
        )

        response = endpoint(
            OperatorCommandRequest(
                command_type="text_question",
                text="What should I do next?",
                locale="en-US",
            )
        )

        payload = _serialize_dataclass_payload(response)
        speech_events = session_service.event_store.read("speech.lifecycle", session_id="session-scaffold-01")

        self.assertEqual("unavailable", payload["status"])
        self.assertEqual("unavailable", payload["session_event"]["assistant"]["status"])
        self.assertEqual(
            "Local text generation is unavailable.",
            payload["session_event"]["assistant"]["text"],
        )
        self.assertEqual(
            ["assistant.message", "speech.synthesis"],
            [event.event.event_type for event in speech_events],
        )
        self.assertEqual(
            "Local text generation is unavailable.",
            speech_events[1].event.synthesis.text,
        )

    def test_tts_preview_command_publishes_canonical_synthesis_event(self) -> None:
        endpoint, session_service = build_operator_command_route_endpoint()

        response = endpoint(
            OperatorCommandRequest(
                command_type="tts_preview",
                text="This is a voice preview.",
                locale="en-US",
            )
        )

        payload = _serialize_dataclass_payload(response)
        speech_events = session_service.event_store.read("speech.lifecycle", session_id="session-scaffold-01")
        session_events = session_service.event_store.read("session", session_id="session-scaffold-01")

        self.assertEqual("tts_preview", payload["command_type"])
        self.assertEqual("ready", payload["status"])
        self.assertEqual("session.operator.tts-preview", payload["session_event"]["event_type"])
        self.assertEqual("speech.synthesis", payload["speech_lifecycle_events"][0]["event"]["event_type"])
        self.assertEqual(
            "This is a voice preview.",
            payload["speech_lifecycle_events"][0]["event"]["synthesis"]["text"],
        )
        self.assertEqual(["speech.synthesis"], [event.event.event_type for event in speech_events])
        self.assertEqual(["session.operator.tts-preview"], [event.event.event_type for event in session_events])
        self.assertEqual("speech.lifecycle:session-scaffold-01:2", payload["next_speech_cursor"])

    def test_operator_command_route_rejects_unknown_command_type(self) -> None:
        endpoint, _session_service = build_operator_command_route_endpoint()

        with self.assertRaises(FakeHTTPException) as raised:
            endpoint(
                OperatorCommandRequest(
                    command_type="wave",
                    text="Wave now.",
                    locale="en-US",
                )
            )

        self.assertEqual(400, raised.exception.status_code)
        self.assertIn("Unsupported operator command type", raised.exception.detail)

    def test_operator_command_route_rejects_blank_text(self) -> None:
        endpoint, _session_service = build_operator_command_route_endpoint()

        with self.assertRaises(FakeHTTPException) as raised:
            endpoint(
                OperatorCommandRequest(
                    command_type="tts_preview",
                    text="   ",
                    locale="en-US",
                )
            )

        self.assertEqual(400, raised.exception.status_code)
        self.assertIn("must not be blank", raised.exception.detail)


class DefaultTurnPipelinePublisherTests(unittest.TestCase):
    def test_publish_turn_appends_session_and_speech_events_in_fixed_order(self) -> None:
        snapshot = SessionSnapshot(
            session_id="session-scaffold-01",
            active_character_id="test-vrm-01",
        )
        store = InMemorySessionEventStore()
        publisher = DefaultTurnPipelinePublisher(
            transcription_service=StubSpeechTranscriptionService(),
            synthesis_service=StubSpeechSynthesisService(),
            session_event_factory=DefaultSessionEventFactory(),
            event_store=store,
        )

        publication = publisher.publish_turn(snapshot, build_turn_request())

        self.assertEqual(
            [
                "session.turn.started",
                "transcription.status",
                "speech.synthesis",
                "session.turn.published",
            ],
            [envelope.event.event_type for envelope in publication.ordered_events],
        )
        self.assertEqual(
            ["session.turn.started", "session.turn.published"],
            [
                envelope.event.event_type
                for envelope in store.read("session", session_id=snapshot.session_id)
            ],
        )
        self.assertEqual(
            ["transcription.status", "speech.synthesis"],
            [
                envelope.event.event_type
                for envelope in store.read("speech.lifecycle", session_id=snapshot.session_id)
            ],
        )

    def test_publish_turn_forwards_audio_reference_and_serializes_synthesis_timing(self) -> None:
        snapshot = SessionSnapshot(
            session_id="session-scaffold-01",
            active_character_id="test-vrm-01",
        )
        store = InMemorySessionEventStore()
        transcription_service = CapturingSpeechTranscriptionService()
        publisher = DefaultTurnPipelinePublisher(
            transcription_service=transcription_service,
            synthesis_service=StubSpeechSynthesisService(),
            session_event_factory=DefaultSessionEventFactory(),
            event_store=store,
        )
        turn_request = build_turn_request()

        publication = publisher.publish_turn(snapshot, turn_request)

        self.assertEqual([turn_request.transcription], transcription_service.requests)

        synthesis_payload = cast(
            dict[str, object],
            canonicalize_transport_payload(
                _serialize_dataclass_payload(publication.speech_lifecycle_events[1])
            ),
        )
        synthesis_event = cast(dict[str, object], synthesis_payload["event"])
        synthesis_contract = cast(dict[str, object], synthesis_event["synthesis"])
        timing = cast(dict[str, object], synthesis_contract["timing"])
        audio_format = cast(dict[str, object], timing["audio_format"])
        phoneme_slots = cast(list[dict[str, object]], timing["phoneme_slots"])
        viseme_slots = cast(list[dict[str, object]], timing["viseme_slots"])

        self.assertEqual("speech.synthesis", synthesis_event["event_type"])
        self.assertEqual(2120, timing["utterance_duration_ms"])
        self.assertEqual(24000, audio_format["sample_rate_hz"])
        self.assertEqual("S", phoneme_slots[0]["phoneme"])
        self.assertEqual("smile", viseme_slots[1]["viseme"])

    def test_publish_turn_preserves_synthesis_audio_reference_when_present(self) -> None:
        snapshot = SessionSnapshot(
            session_id="session-scaffold-01",
            active_character_id="test-vrm-01",
        )

        with TemporaryDirectory() as temp_dir:
            audio_path = Path(temp_dir) / "reply.wav"
            audio_path.write_bytes(b"RIFF")
            store = InMemorySessionEventStore()
            publisher = DefaultTurnPipelinePublisher(
                transcription_service=cast(
                    SpeechTranscriptionService,
                    StaticSpeechTranscriptionService(build_transcription_contract("final")),
                ),
                synthesis_service=cast(
                    SpeechSynthesisService,
                    StaticSpeechSynthesisService(
                        build_synthesis_contract("ready", audio_reference=str(audio_path))
                    ),
                ),
                session_event_factory=DefaultSessionEventFactory(),
                event_store=store,
            )

            publication = publisher.publish_turn(snapshot, build_turn_request())
            stored_synthesis_event = store.read("speech.lifecycle", session_id=snapshot.session_id)[1]

        self.assertEqual(str(audio_path), publication.speech_lifecycle_events[1].event.synthesis.audio_reference)
        self.assertEqual(str(audio_path), stored_synthesis_event.event.synthesis.audio_reference)

    def test_publish_turn_keeps_speech_lifecycle_order_deterministic_across_publications(self) -> None:
        snapshot = SessionSnapshot(
            session_id="session-scaffold-01",
            active_character_id="test-vrm-01",
        )
        store = InMemorySessionEventStore()
        publisher = DefaultTurnPipelinePublisher(
            transcription_service=StubSpeechTranscriptionService(),
            synthesis_service=StubSpeechSynthesisService(),
            session_event_factory=DefaultSessionEventFactory(),
            event_store=store,
        )

        first_publication = publisher.publish_turn(snapshot, build_turn_request())
        second_publication = publisher.publish_turn(snapshot, build_turn_request())

        speech_events = store.read("speech.lifecycle", session_id=snapshot.session_id)
        session_events = store.read("session", session_id=snapshot.session_id)

        self.assertEqual([1, 2], [event.sequence for event in first_publication.speech_lifecycle_events])
        self.assertEqual([3, 4], [event.sequence for event in second_publication.speech_lifecycle_events])
        self.assertEqual([1, 2, 3, 4], [event.sequence for event in speech_events])
        self.assertEqual(
            [
                "transcription.status",
                "speech.synthesis",
                "transcription.status",
                "speech.synthesis",
            ],
            [event.event.event_type for event in speech_events],
        )
        self.assertEqual(
            [
                "session.turn.started",
                "session.turn.published",
                "session.turn.started",
                "session.turn.published",
            ],
            [event.event.event_type for event in session_events],
        )

    def test_publish_turn_derives_publication_status_from_degraded_speech_outcomes(self) -> None:
        snapshot = SessionSnapshot(
            session_id="session-scaffold-01",
            active_character_id="test-vrm-01",
        )
        cases = (
            ("unavailable", "ready", "degraded"),
            ("final", "unavailable", "degraded"),
            ("error", "ready", "error"),
            ("final", "error", "error"),
        )

        for transcription_status, synthesis_status, publication_status in cases:
            with self.subTest(
                transcription_status=transcription_status,
                synthesis_status=synthesis_status,
                publication_status=publication_status,
            ):
                store = InMemorySessionEventStore()
                publisher = DefaultTurnPipelinePublisher(
                    transcription_service=cast(
                        SpeechTranscriptionService,
                        StaticSpeechTranscriptionService(
                            build_transcription_contract(transcription_status)
                        ),
                    ),
                    synthesis_service=cast(
                        SpeechSynthesisService,
                        StaticSpeechSynthesisService(build_synthesis_contract(synthesis_status)),
                    ),
                    session_event_factory=DefaultSessionEventFactory(),
                    event_store=store,
                )

                publication = publisher.publish_turn(snapshot, build_turn_request())

                self.assertEqual(
                    publication_status,
                    publication.session_events[-1].event.status,
                )
                self.assertEqual(
                    [transcription_status, synthesis_status],
                    [
                        publication.speech_lifecycle_events[0].event.status,
                        publication.speech_lifecycle_events[1].event.status,
                    ],
                )
                self.assertEqual(
                    publication_status,
                    publication.ordered_events[-1].event.status,
                )


if __name__ == "__main__":
    unittest.main()