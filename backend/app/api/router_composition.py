from __future__ import annotations

from dataclasses import asdict, dataclass, replace
from typing import Any, Callable

from app.api.active_character_routes import ActiveCharacterRouteServices, register_active_character_routes
from app.api.attention_routes import register_attention_routes
from app.api.llm_routes import register_llm_routes
from app.api.operator_routes import OperatorCommandRouteServices, register_operator_command_routes
from app.api.read_routes import ReadRouteServices, register_read_routes
from app.api.resource_routes import register_resource_routes
from app.api.stt_routes import register_stt_routes
from app.api.tts_settings_routes import register_tts_settings_routes
from app.api.session_routes import SessionTransportRouteServices, register_session_transport_routes
from app.services.animation_commands import AnimationCommandTranslator
from app.core.settings import get_app_paths
from app.schemas.animation import SessionAnimationSnapshot
from app.schemas.character import ActiveCharacterSelection, CharacterCatalogResponse
from app.schemas.health import HealthPayload
from app.schemas.session import ActiveCharacterResponse
from app.schemas.session import (
    SessionEvent,
    SessionLifecycleUpdateRequest,
    SpeechLifecycleTransportSnapshot,
)
from app.services.animation import (
    AnimationService,
    DefaultAnimationService,
    InMemorySessionAnimationLiveDeliveryService,
    SessionAnimationLiveDeliveryService,
)
from app.services.character import CharacterService, FileSystemCharacterManifestSource
from app.services.companion_memory import CompanionMemoryService, build_companion_memory_service
from app.services.llm import (
    TextGenerationRequest,
    TextGenerationService,
    TextGenerationSidecarManager,
    get_text_generation_sidecar_manager,
)
from app.services.session import InMemorySessionService, SessionService
from app.services.speech import (
    DefaultSessionEventFactory,
    DefaultTurnPipelinePublisher,
    PollingSpeechLifecycleLiveDeliveryService,
    SessionEventFactory,
    SpeechLifecycleLiveDeliveryService,
    SpeechLifecycleSnapshotService,
    SpeechSynthesisRequest,
    SpeechTranscriptionRequest,
    SpeechTranscriptionService,
    SpeechSynthesisService,
    build_speech_service_registry,
    StubSpeechLifecycleSnapshotService,
    StubSpeechSynthesisService,
    StubSpeechTranscriptionService,
    TurnPipelinePublisher,
)
from app.services.stt_worker import get_stt_worker
from app.services.tts_worker import QueuedSynthesisService, get_tts_worker
from app.services.turns import UserTurnServices


BuildActiveCharacterResponse = Callable[..., ActiveCharacterResponse]
SerializePayload = Callable[[Any], dict[str, Any]]


BuildHealthPayload = Callable[[CharacterService], HealthPayload]
BuildCharacterCatalogResponse = Callable[[SessionService, list[Any]], CharacterCatalogResponse]
BuildSpeechContractExamples = Callable[[SpeechLifecycleTransportSnapshot], dict[str, Any]]
BuildSessionAnimationResponse = Callable[[Any, AnimationService], SessionAnimationSnapshot]


CONTRACT_SPEECH_STATUS = "unavailable"
CONTRACT_SPEECH_REASON = "turn.pipeline"


@dataclass(slots=True, frozen=True)
class RouteDefinition:
    method: str
    path: str
    name: str


@dataclass(slots=True)
class RouterShell:
    routes: list[RouteDefinition]


@dataclass(slots=True)
class ApiRouteRegistrationServices:
    session_service: SessionService
    character_service: CharacterService
    animation_service: AnimationService
    session_animation_live_delivery: SessionAnimationLiveDeliveryService
    speech_lifecycle_service: SpeechLifecycleSnapshotService
    speech_lifecycle_live_delivery: SpeechLifecycleLiveDeliveryService
    text_generation_service: TextGenerationService
    synthesis_service: SpeechSynthesisService
    session_event_factory: SessionEventFactory
    memory_service: CompanionMemoryService | None = None


@dataclass(slots=True)
class DefaultApiRuntimeServices:
    session_service: SessionService
    character_service: CharacterService
    animation_service: AnimationService
    session_animation_live_delivery: SessionAnimationLiveDeliveryService
    transcription_service: SpeechTranscriptionService
    synthesis_service: SpeechSynthesisService
    text_generation_service: TextGenerationService
    llm_sidecar_manager: TextGenerationSidecarManager
    speech_lifecycle_service: SpeechLifecycleSnapshotService
    speech_lifecycle_live_delivery: SpeechLifecycleLiveDeliveryService
    session_event_factory: SessionEventFactory
    turn_pipeline_publisher: TurnPipelinePublisher
    memory_service: CompanionMemoryService | None = None

    def as_legacy_tuple(self) -> tuple[
        SessionService,
        CharacterService,
        SpeechTranscriptionService,
        SpeechSynthesisService,
        TextGenerationService,
        SpeechLifecycleSnapshotService,
        SpeechLifecycleLiveDeliveryService,
        SessionEventFactory,
        TurnPipelinePublisher,
    ]:
        return (
            self.session_service,
            self.character_service,
            self.transcription_service,
            self.synthesis_service,
            self.text_generation_service,
            self.speech_lifecycle_service,
            self.speech_lifecycle_live_delivery,
            self.session_event_factory,
            self.turn_pipeline_publisher,
        )


@dataclass(slots=True)
class ApiContractSnapshotServices:
    session_service: SessionService
    character_service: CharacterService
    speech_lifecycle_service: SpeechLifecycleSnapshotService
    session_event_factory: SessionEventFactory
    animation_service: AnimationService


def build_api_route_definitions() -> list[RouteDefinition]:
    return [
        RouteDefinition(method="GET", path="/health", name="healthcheck"),
        RouteDefinition(method="GET", path="/characters", name="list_characters"),
        RouteDefinition(method="GET", path="/session/active-character", name="get_active_character"),
        RouteDefinition(method="GET", path="/session/animation", name="get_session_animation"),
        RouteDefinition(method="PUT", path="/session/lifecycle-state", name="set_session_lifecycle_state"),
        RouteDefinition(
            method="GET",
            path="/session/speech-artifacts/{event_id}/audio",
            name="get_session_speech_artifact_audio",
        ),
        RouteDefinition(method="GET", path="/session/speech-lifecycle", name="get_speech_lifecycle"),
        RouteDefinition(method="POST", path="/session/operator-command", name="post_operator_command"),
        RouteDefinition(method="GET", path="/session/stt", name="get_session_stt_state"),
        RouteDefinition(method="GET", path="/session/stt/devices", name="get_session_stt_devices"),
        RouteDefinition(method="PUT", path="/session/stt/device", name="put_session_stt_device"),
        RouteDefinition(method="PUT", path="/session/stt/listening", name="put_session_stt_listening"),
        RouteDefinition(method="POST", path="/session/stt/control", name="post_session_stt_control"),
        RouteDefinition(method="GET", path="/session/llm", name="get_session_llm_state"),
        RouteDefinition(method="POST", path="/session/llm/control", name="post_session_llm_control"),
        RouteDefinition(method="GET", path="/session/attention", name="get_session_attention_state"),
        RouteDefinition(method="GET", path="/session/attention/live", name="get_session_attention_live"),
        RouteDefinition(method="GET", path="/session/attention/devices", name="get_session_attention_devices"),
        RouteDefinition(method="PUT", path="/session/attention/device", name="put_session_attention_device"),
        RouteDefinition(method="PUT", path="/session/attention/enabled", name="put_session_attention_enabled"),
        RouteDefinition(method="PUT", path="/session/attention/tracking", name="put_session_attention_tracking"),
        RouteDefinition(method="POST", path="/session/attention/observations", name="post_session_attention_observations"),
        RouteDefinition(method="GET", path="/session/tts/settings", name="get_session_tts_settings"),
        RouteDefinition(method="PUT", path="/session/tts/settings", name="put_session_tts_settings"),
        RouteDefinition(method="POST", path="/session/tts/control", name="post_session_tts_control"),
        RouteDefinition(method="PUT", path="/session/active-character", name="set_active_character"),
        RouteDefinition(method="GET", path="/system/resources", name="get_system_resources"),
        RouteDefinition(method="POST", path="/system/shutdown", name="post_system_shutdown"),
    ]


def build_default_animation_service() -> AnimationService:
    return DefaultAnimationService()


def build_default_session_animation_live_delivery_service() -> SessionAnimationLiveDeliveryService:
    return InMemorySessionAnimationLiveDeliveryService()


def build_default_api_runtime_services() -> DefaultApiRuntimeServices:
    app_paths = get_app_paths()
    character_service = CharacterService(FileSystemCharacterManifestSource())
    animation_service = build_default_animation_service()
    session_animation_live_delivery = build_default_session_animation_live_delivery_service()
    character_summaries = character_service.list_character_summaries()
    available_character_ids = [summary.character_id for summary in character_summaries]
    default_character_id = next(
        (character_id for character_id in ("test-vrm-01", "maria") if character_id in available_character_ids),
        available_character_ids[0] if available_character_ids else "maria",
    )
    session_service = InMemorySessionService(default_character_id=default_character_id)
    speech_services = build_speech_service_registry(app_paths=app_paths)
    transcription_service = speech_services.resolve_transcription(
        SpeechTranscriptionRequest(
            audio_reference="",
            locale="en-US",
        )
    )
    # Phase 3/4: NIKOF_TTS_ENGINE selects the synthesis engine (gpt-sovits
    # default via the TTS worker; kokoro / xtts as in-process adapters) so we can
    # benchmark speed/quality. An unconfigured alternate engine returns
    # status="unavailable" rather than breaking the turn.
    from app.services.tts_engines import build_alternate_synthesis_service, resolve_tts_engine_name

    _alternate_synthesis_service = build_alternate_synthesis_service(
        resolve_tts_engine_name(), app_paths=app_paths
    )
    synthesis_service: SpeechSynthesisService = (
        _alternate_synthesis_service
        if _alternate_synthesis_service is not None
        else QueuedSynthesisService(get_tts_worker(app_paths), eager=False)
    )
    llm_sidecar_manager = get_text_generation_sidecar_manager(app_paths)
    text_generation_service = llm_sidecar_manager.resolve(
        TextGenerationRequest(prompt="", locale="en-US")
    )
    session_event_factory = DefaultSessionEventFactory()
    memory_service = build_companion_memory_service(app_paths=app_paths)
    speech_lifecycle_service = StubSpeechLifecycleSnapshotService(
        event_store=session_service.event_store,
        transcription_service=StubSpeechTranscriptionService(),
        synthesis_service=StubSpeechSynthesisService(),
        session_event_factory=session_event_factory,
        fallback_on_empty=True,
    )
    speech_lifecycle_live_delivery = PollingSpeechLifecycleLiveDeliveryService(
        snapshot_service=speech_lifecycle_service
    )
    turn_pipeline_publisher = DefaultTurnPipelinePublisher(
        transcription_service=transcription_service,
        synthesis_service=synthesis_service,
        session_event_factory=session_event_factory,
        event_store=session_service.event_store,
    )
    get_stt_worker(app_paths).configure_turn_services(
        UserTurnServices(
            session_service=session_service,
            character_service=character_service,
            text_generation_service=text_generation_service,
            synthesis_service=synthesis_service,
            session_event_factory=session_event_factory,
            memory_service=memory_service,
            animation_service=animation_service,
            session_animation_live_delivery=session_animation_live_delivery,
        )
    )
    return DefaultApiRuntimeServices(
        session_service=session_service,
        character_service=character_service,
        animation_service=animation_service,
        session_animation_live_delivery=session_animation_live_delivery,
        transcription_service=transcription_service,
        synthesis_service=synthesis_service,
        text_generation_service=text_generation_service,
        llm_sidecar_manager=llm_sidecar_manager,
        speech_lifecycle_service=speech_lifecycle_service,
        speech_lifecycle_live_delivery=speech_lifecycle_live_delivery,
        session_event_factory=session_event_factory,
        turn_pipeline_publisher=turn_pipeline_publisher,
        memory_service=memory_service,
    )


def _project_contract_session_event(event: SessionEvent) -> SessionEvent:
    transcription = event.transcription
    synthesis = event.synthesis

    if transcription is not None:
        transcription = replace(transcription, status=CONTRACT_SPEECH_STATUS)

    if synthesis is not None:
        synthesis = replace(synthesis, status=CONTRACT_SPEECH_STATUS)

    return replace(
        event,
        status=CONTRACT_SPEECH_STATUS,
        reason=CONTRACT_SPEECH_REASON,
        transcription=transcription,
        synthesis=synthesis,
    )


def project_contract_speech_lifecycle_snapshot(
    speech_lifecycle_snapshot: SpeechLifecycleTransportSnapshot,
) -> SpeechLifecycleTransportSnapshot:
    return replace(
        speech_lifecycle_snapshot,
        events=tuple(
            replace(
                envelope,
                event=_project_contract_session_event(envelope.event),
            )
            for envelope in speech_lifecycle_snapshot.events
        ),
    )


def build_api_contract_snapshot_payload(
    *,
    route_definitions: list[dict[str, str]],
    services: ApiContractSnapshotServices,
    build_active_character_response: BuildActiveCharacterResponse,
    build_character_catalog_response: BuildCharacterCatalogResponse,
    build_health_payload: BuildHealthPayload,
    build_speech_contract_examples: BuildSpeechContractExamples,
    build_session_animation_response: BuildSessionAnimationResponse,
    serialize_dataclass_payload: SerializePayload,
) -> dict[str, Any]:
    characters = services.character_service.list_character_summaries()
    current_snapshot = services.session_service.get_snapshot()
    current_character = services.character_service.get_character_summary(current_snapshot.active_character_id)
    speech_lifecycle_snapshot = services.speech_lifecycle_service.get_snapshot(
        current_snapshot,
        character_id=current_character.character_id,
    )
    contract_speech_lifecycle_snapshot = project_contract_speech_lifecycle_snapshot(
        speech_lifecycle_snapshot
    )
    invalid_selection = ActiveCharacterSelection(
        character_id="missing-character",
        reason="user_selected",
    )
    selected_character = characters[-1] if characters else current_character
    selection = ActiveCharacterSelection(
        character_id=selected_character.character_id,
        reason="user_selected",
    )
    updated_snapshot = services.session_service.set_active_character(selection)

    return {
        "routes": route_definitions,
        "contracts": build_speech_contract_examples(contract_speech_lifecycle_snapshot),
        "responses": {
            "health": asdict(build_health_payload(services.character_service)),
            "characters": asdict(build_character_catalog_response(current_snapshot, characters)),
            "get_active_character": serialize_dataclass_payload(
                build_active_character_response(
                    current_snapshot,
                    current_character,
                    services.session_event_factory,
                    requested_character_id=current_character.character_id,
                    selection_applied=True,
                    event_type="session.state",
                    status=current_snapshot.lifecycle_state,
                    message="Active character resolved.",
                )
            ),
            "get_session_animation": serialize_dataclass_payload(
                build_session_animation_response(current_snapshot, services.animation_service)
            ),
            "put_session_lifecycle_state": {
                "request": asdict(SessionLifecycleUpdateRequest(lifecycle_state="speak", reason="speech_playback_started")),
                "response": serialize_dataclass_payload(
                    build_session_animation_response(
                        services.session_service.set_lifecycle_state("speak"),
                        services.animation_service,
                    )
                ),
            },
            "get_speech_lifecycle": serialize_dataclass_payload(contract_speech_lifecycle_snapshot),
            "put_active_character": {
                "request": asdict(selection),
                "response": serialize_dataclass_payload(
                    build_active_character_response(
                        updated_snapshot,
                        selected_character,
                        services.session_event_factory,
                        requested_character_id=selection.character_id,
                        selection_applied=True,
                        event_type="session.character.selected",
                        status="applied",
                        message="Active character updated.",
                        reason=selection.reason,
                    )
                ),
            },
            "put_active_character_invalid": {
                "request": asdict(invalid_selection),
                "http_status": 400,
                "response": serialize_dataclass_payload(
                    build_active_character_response(
                        current_snapshot,
                        current_character,
                        services.session_event_factory,
                        requested_character_id=invalid_selection.character_id,
                        selection_applied=False,
                        event_type="session.character.rejected",
                        status="rejected",
                        error_code="unknown_character",
                        message="Requested character is unavailable.",
                        event_character_id=invalid_selection.character_id,
                        reason=invalid_selection.reason,
                    )
                ),
            },
        },
    }


def compose_api_contract_snapshot(
    *,
    route_definitions: list[RouteDefinition],
    session_service: SessionService,
    character_service: CharacterService,
    speech_lifecycle_service: SpeechLifecycleSnapshotService,
    session_event_factory: SessionEventFactory,
    animation_service: AnimationService,
    build_active_character_response: BuildActiveCharacterResponse,
    build_character_catalog_response: BuildCharacterCatalogResponse,
    build_health_payload: BuildHealthPayload,
    build_speech_contract_examples: BuildSpeechContractExamples,
    build_session_animation_response: BuildSessionAnimationResponse,
    serialize_dataclass_payload: SerializePayload,
) -> dict[str, Any]:
    return build_api_contract_snapshot_payload(
        route_definitions=[asdict(route) for route in route_definitions],
        services=ApiContractSnapshotServices(
            session_service=session_service,
            character_service=character_service,
            speech_lifecycle_service=speech_lifecycle_service,
            session_event_factory=session_event_factory,
            animation_service=animation_service,
        ),
        build_active_character_response=build_active_character_response,
        build_character_catalog_response=build_character_catalog_response,
        build_health_payload=build_health_payload,
        build_speech_contract_examples=build_speech_contract_examples,
        build_session_animation_response=build_session_animation_response,
        serialize_dataclass_payload=serialize_dataclass_payload,
    )


def compose_api_router(
    *,
    route_definitions: list[RouteDefinition],
    session_service: SessionService,
    character_service: CharacterService,
    animation_service: AnimationService,
    session_animation_live_delivery: SessionAnimationLiveDeliveryService,
    speech_lifecycle_service: SpeechLifecycleSnapshotService,
    speech_lifecycle_live_delivery: SpeechLifecycleLiveDeliveryService,
    text_generation_service: TextGenerationService,
    synthesis_service: SpeechSynthesisService,
    session_event_factory: SessionEventFactory,
    memory_service: CompanionMemoryService | None = None,
    build_active_character_response: BuildActiveCharacterResponse,
    serialize_dataclass_payload: SerializePayload,
) -> Any:
    try:
        from fastapi import APIRouter
    except ImportError:
        return RouterShell(routes=route_definitions)

    router = APIRouter()

    register_api_routes(
        router,
        services=ApiRouteRegistrationServices(
            session_service=session_service,
            character_service=character_service,
            animation_service=animation_service,
            session_animation_live_delivery=session_animation_live_delivery,
            speech_lifecycle_service=speech_lifecycle_service,
            speech_lifecycle_live_delivery=speech_lifecycle_live_delivery,
            text_generation_service=text_generation_service,
            synthesis_service=synthesis_service,
            session_event_factory=session_event_factory,
            memory_service=memory_service,
        ),
        build_active_character_response=build_active_character_response,
        serialize_dataclass_payload=serialize_dataclass_payload,
    )

    return router


def register_api_routes(
    router: Any,
    *,
    services: ApiRouteRegistrationServices,
    build_active_character_response: BuildActiveCharacterResponse,
    serialize_dataclass_payload: SerializePayload,
) -> None:
    register_read_routes(
        router,
        services=ReadRouteServices(
            session_service=services.session_service,
            character_service=services.character_service,
        ),
    )

    register_active_character_routes(
        router,
        services=ActiveCharacterRouteServices(
            session_service=services.session_service,
            character_service=services.character_service,
            session_event_factory=services.session_event_factory,
        ),
        build_active_character_response=build_active_character_response,
    )

    register_session_transport_routes(
        router,
        services=SessionTransportRouteServices(
            session_service=services.session_service,
            character_service=services.character_service,
            animation_service=services.animation_service,
            session_animation_live_delivery=services.session_animation_live_delivery,
            animation_command_translator=AnimationCommandTranslator(),
            speech_lifecycle_service=services.speech_lifecycle_service,
            speech_lifecycle_live_delivery=services.speech_lifecycle_live_delivery,
        ),
        serialize_dataclass_payload=serialize_dataclass_payload,
    )

    register_operator_command_routes(
        router,
        services=OperatorCommandRouteServices(
            session_service=services.session_service,
            character_service=services.character_service,
            text_generation_service=services.text_generation_service,
            synthesis_service=services.synthesis_service,
            session_event_factory=services.session_event_factory,
            memory_service=services.memory_service,
            animation_service=services.animation_service,
            session_animation_live_delivery=services.session_animation_live_delivery,
        ),
    )

    register_stt_routes(router)
    register_llm_routes(router)
    register_attention_routes(router)
    register_tts_settings_routes(router)
    register_resource_routes(router)