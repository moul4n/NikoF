from __future__ import annotations

from typing import Any

from app.api.router_composition import (
    RouteDefinition,
    build_api_route_definitions,
    build_default_animation_service,
    build_default_api_runtime_services,
    build_default_session_animation_live_delivery_service,
    compose_api_contract_snapshot,
    compose_api_router,
)
from app.api.response_builders import (
    build_active_character_response as _build_active_character_response,
    build_character_catalog_response as _build_character_catalog_response,
    build_health_payload as _build_health_payload,
    build_speech_contract_examples as _build_speech_contract_examples,
    build_speech_lifecycle_sse_frame as _build_speech_lifecycle_sse_frame_impl,
    serialize_dataclass_payload as _serialize_dataclass_payload_impl,
)
from app.api.session_routes import (
    build_session_animation_response,
)
from app.schemas.animation import SessionAnimationSnapshot
from app.schemas.session import SessionSnapshot
from app.services.animation import (
    AnimationService,
    SessionAnimationLiveDeliveryService,
)
from app.services.character import CharacterService
from app.services.llm import TextGenerationService
from app.services.session import SessionService
from app.services.speech import (
    SpeechLifecycleLiveDeliveryService,
    SessionEventFactory,
    SpeechLifecycleSnapshotService,
    SpeechSynthesisService,
    SpeechTranscriptionService,
    TurnPipelinePublisher,
)


def _serialize_dataclass_payload(value: Any) -> dict[str, Any]:
    return _serialize_dataclass_payload_impl(value)


def _route_definitions() -> list[RouteDefinition]:
    return build_api_route_definitions()


def _build_services() -> tuple[
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
    return build_default_api_runtime_services().as_legacy_tuple()


def _build_animation_service() -> AnimationService:
    return build_default_animation_service()


def _build_session_animation_live_delivery_service() -> SessionAnimationLiveDeliveryService:
    return build_default_session_animation_live_delivery_service()


def _build_session_animation_response(
    snapshot: SessionSnapshot,
    animation_service: AnimationService,
) -> SessionAnimationSnapshot:
    return build_session_animation_response(snapshot, animation_service)


def _build_speech_lifecycle_sse_frame(envelope: Any) -> str:
    return _build_speech_lifecycle_sse_frame_impl(envelope)


def build_api_contract_snapshot() -> dict[str, Any]:
    (
        session_service,
        character_service,
        _transcription_service,
        _synthesis_service,
        _text_generation_service,
        speech_lifecycle_service,
        _speech_lifecycle_live_delivery,
        session_event_factory,
        _turn_pipeline_publisher,
    ) = _build_services()
    route_definitions = _route_definitions()
    animation_service = _build_animation_service()

    return compose_api_contract_snapshot(
        route_definitions=route_definitions,
        session_service=session_service,
        character_service=character_service,
        speech_lifecycle_service=speech_lifecycle_service,
        session_event_factory=session_event_factory,
        animation_service=animation_service,
        build_active_character_response=_build_active_character_response,
        build_character_catalog_response=_build_character_catalog_response,
        # The contract snapshot must stay deterministic: keep the subsystems
        # key in the surface but exclude live worker state from the payload.
        build_health_payload=lambda character_service: _build_health_payload(
            character_service, include_subsystems=False
        ),
        build_speech_contract_examples=_build_speech_contract_examples,
        build_session_animation_response=_build_session_animation_response,
        serialize_dataclass_payload=_serialize_dataclass_payload,
    )


def build_api_router() -> Any:
    runtime_services = build_default_api_runtime_services()
    route_definitions = _route_definitions()

    return compose_api_router(
        route_definitions=route_definitions,
        session_service=runtime_services.session_service,
        character_service=runtime_services.character_service,
        animation_service=runtime_services.animation_service,
        session_animation_live_delivery=runtime_services.session_animation_live_delivery,
        speech_lifecycle_service=runtime_services.speech_lifecycle_service,
        speech_lifecycle_live_delivery=runtime_services.speech_lifecycle_live_delivery,
        text_generation_service=runtime_services.text_generation_service,
        synthesis_service=runtime_services.synthesis_service,
        session_event_factory=runtime_services.session_event_factory,
        memory_service=runtime_services.memory_service,
        build_active_character_response=_build_active_character_response,
        serialize_dataclass_payload=_serialize_dataclass_payload,
    )
