from __future__ import annotations

from dataclasses import asdict, dataclass
from typing import Any

from app.core.settings import get_app_paths
from app.schemas.character import ActiveCharacterSelection, CharacterCatalogResponse, CharacterSummary
from app.schemas.health import DiagnosticProbe, HealthDiagnostics, HealthPayload
from app.schemas.session import (
    ActiveCharacterResponse,
    ActiveCharacterSelectionResult,
    SessionEvent,
    SessionSnapshot,
    SpeechLifecycleTransportSnapshot,
    build_baseline_speech_adapter_profiles,
)
from app.services.character import CharacterService, FileSystemCharacterManifestSource, UnknownCharacterError
from app.services.session import InvalidEventCursor, InMemorySessionService, SessionService
from app.services.speech import (
    BackendTurnRequest,
    DefaultSessionEventFactory,
    DefaultTurnPipelinePublisher,
    SPEECH_LIFECYCLE_STREAM,
    SessionEventFactory,
    SpeechLifecycleSnapshotService,
    SpeechSynthesisRequest,
    SpeechSynthesisService,
    SpeechTranscriptionRequest,
    SpeechTranscriptionService,
    StubSpeechLifecycleSnapshotService,
    TurnPipelinePublisher,
    build_speech_service_registry,
)


@dataclass(slots=True, frozen=True)
class RouteDefinition:
    method: str
    path: str
    name: str


@dataclass(slots=True)
class RouterShell:
    routes: list[RouteDefinition]


def _strip_none(value: Any) -> Any:
    if isinstance(value, dict):
        return {
            key: _strip_none(item)
            for key, item in value.items()
            if item is not None
        }

    if isinstance(value, list):
        return [_strip_none(item) for item in value]

    return value


def _serialize_dataclass_payload(value: Any) -> dict[str, Any]:
    return _strip_none(asdict(value))


def _route_definitions() -> list[RouteDefinition]:
    return [
        RouteDefinition(method="GET", path="/health", name="healthcheck"),
        RouteDefinition(method="GET", path="/characters", name="list_characters"),
        RouteDefinition(method="GET", path="/session/active-character", name="get_active_character"),
        RouteDefinition(method="GET", path="/session/speech-lifecycle", name="get_speech_lifecycle"),
        RouteDefinition(method="PUT", path="/session/active-character", name="set_active_character"),
    ]


def _build_services() -> tuple[
    SessionService,
    CharacterService,
    SpeechTranscriptionService,
    SpeechSynthesisService,
    SpeechLifecycleSnapshotService,
    SessionEventFactory,
    TurnPipelinePublisher,
]:
    character_service = CharacterService(FileSystemCharacterManifestSource())
    session_service = InMemorySessionService(default_character_id="test-vrm-01")
    speech_registry = build_speech_service_registry(get_app_paths())
    transcription_service = speech_registry.transcription_services.get(
        "faster-whisper",
        speech_registry.fallback_transcription_service,
    )
    synthesis_service = speech_registry.synthesis_services.get(
        "gpt-sovits",
        speech_registry.fallback_synthesis_service,
    )
    session_event_factory = DefaultSessionEventFactory()
    speech_lifecycle_service = StubSpeechLifecycleSnapshotService(
        event_store=session_service.event_store,
    )
    turn_pipeline_publisher = DefaultTurnPipelinePublisher(
        transcription_service=transcription_service,
        synthesis_service=synthesis_service,
        session_event_factory=session_event_factory,
        event_store=session_service.event_store,
    )
    return (
        session_service,
        character_service,
        transcription_service,
        synthesis_service,
        speech_lifecycle_service,
        session_event_factory,
        turn_pipeline_publisher,
    )


def _build_health_payload(character_service: CharacterService) -> HealthPayload:
    app_paths = get_app_paths()
    character_count = len(character_service.list_character_summaries())

    diagnostics = HealthDiagnostics(
        character_packages_available=character_count,
        storage_probes=[
            DiagnosticProbe(
                name="character-assets",
                configured_by="repo-layout",
                required_for_stage="stage-1",
                available=app_paths.character_assets_root.exists() and character_count > 0,
            ),
            DiagnosticProbe(
                name="models-root",
                configured_by="NIKOF_MODELS_ROOT",
                required_for_stage="stage-3",
                available=app_paths.models_root.exists(),
            ),
            DiagnosticProbe(
                name="providers-root",
                configured_by="NIKOF_PROVIDERS_ROOT",
                required_for_stage="stage-3",
                available=app_paths.providers_root.exists(),
            ),
            DiagnosticProbe(
                name="cache-root",
                configured_by="NIKOF_CACHE_ROOT",
                required_for_stage="stage-3",
                available=app_paths.cache_root.exists(),
            ),
        ],
        notes=[
            "Scaffold diagnostics are provider-agnostic in Stage 1.",
            "Create the local model and provider roots through bootstrap before Stage 3 integrations.",
        ],
    )
    return HealthPayload(status="ok", mode="scaffold", diagnostics=diagnostics)


def _build_speech_contract_examples(
    speech_lifecycle_snapshot: SpeechLifecycleTransportSnapshot,
) -> dict[str, Any]:
    return {
        "speech_adapter_profiles": [
            asdict(profile) for profile in build_baseline_speech_adapter_profiles()
        ],
        "canonical_transcription_event": _serialize_dataclass_payload(
            speech_lifecycle_snapshot.events[0].event
        ),
        "canonical_speech_synthesis_event": _serialize_dataclass_payload(
            speech_lifecycle_snapshot.events[1].event
        ),
        "speech_lifecycle_transport_snapshot": _serialize_dataclass_payload(speech_lifecycle_snapshot),
    }


def _build_character_catalog_response(
    snapshot: SessionSnapshot,
    characters: list[CharacterSummary],
) -> CharacterCatalogResponse:
    return CharacterCatalogResponse(
        schema_version=1,
        active_character_id=snapshot.active_character_id,
        characters=characters,
    )


def _build_active_character_response(
    snapshot: SessionSnapshot,
    active_character: CharacterSummary,
    *,
    requested_character_id: str,
    selection_applied: bool,
    session_event: SessionEvent,
    error_code: str | None = None,
    message: str | None = None,
) -> ActiveCharacterResponse:
    return ActiveCharacterResponse(
        schema_version=1,
        session_id=snapshot.session_id,
        lifecycle_state=snapshot.lifecycle_state,
        active_character=active_character,
        selection=ActiveCharacterSelectionResult(
            requested_character_id=requested_character_id,
            applied=selection_applied,
            error_code=error_code,
            message=message,
        ),
        session_event=session_event,
    )


def _build_session_event(
    snapshot: SessionSnapshot,
    session_event_factory: SessionEventFactory,
    *,
    character_id: str,
    event_type: str,
    status: str,
    reason: str | None = None,
) -> SessionEvent:
    return session_event_factory.build_event(
        snapshot,
        character_id=character_id,
        event_type=event_type,
        status=status,
        reason=reason,
    )


def _append_session_event(
    session_service: SessionService,
    session_event: SessionEvent,
) -> SessionEvent:
    session_service.event_store.append("session", session_event)
    return session_event


def build_api_contract_snapshot() -> dict[str, Any]:
    (
        session_service,
        character_service,
        transcription_service,
        synthesis_service,
        speech_lifecycle_service,
        session_event_factory,
        turn_pipeline_publisher,
    ) = _build_services()
    characters = character_service.list_character_summaries()
    current_snapshot = session_service.get_snapshot()
    current_character = character_service.get_character_summary(current_snapshot.active_character_id)
    turn_pipeline_publisher.publish_turn(
        current_snapshot,
        BackendTurnRequest(
            character_id=current_character.character_id,
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
        ),
    )
    speech_lifecycle_snapshot = speech_lifecycle_service.get_snapshot(
        current_snapshot,
        character_id=current_character.character_id,
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
    updated_snapshot = session_service.set_active_character(selection)

    return {
        "routes": [asdict(route) for route in _route_definitions()],
        "contracts": _build_speech_contract_examples(speech_lifecycle_snapshot),
        "responses": {
            "health": asdict(_build_health_payload(character_service)),
            "characters": asdict(_build_character_catalog_response(current_snapshot, characters)),
            "get_active_character": _serialize_dataclass_payload(
                _build_active_character_response(
                    current_snapshot,
                    current_character,
                    requested_character_id=current_character.character_id,
                    selection_applied=True,
                    session_event=_build_session_event(
                        current_snapshot,
                        session_event_factory,
                        character_id=current_character.character_id,
                        event_type="session.state",
                        status=current_snapshot.lifecycle_state,
                    ),
                    message="Active character resolved.",
                )
            ),
            "get_speech_lifecycle": _serialize_dataclass_payload(speech_lifecycle_snapshot),
            "put_active_character": {
                "request": asdict(selection),
                "response": _serialize_dataclass_payload(
                    _build_active_character_response(
                        updated_snapshot,
                        selected_character,
                        requested_character_id=selection.character_id,
                        selection_applied=True,
                        session_event=_append_session_event(
                            session_service,
                            _build_session_event(
                                updated_snapshot,
                                session_event_factory,
                                character_id=selected_character.character_id,
                                event_type="session.character.selected",
                                status="applied",
                                reason=selection.reason,
                            ),
                        ),
                        message="Active character updated.",
                    )
                ),
            },
            "put_active_character_invalid": {
                "request": asdict(invalid_selection),
                "http_status": 400,
                "response": _serialize_dataclass_payload(
                    _build_active_character_response(
                        current_snapshot,
                        current_character,
                        requested_character_id=invalid_selection.character_id,
                        selection_applied=False,
                        session_event=_append_session_event(
                            session_service,
                            _build_session_event(
                                current_snapshot,
                                session_event_factory,
                                character_id=invalid_selection.character_id,
                                event_type="session.character.rejected",
                                status="rejected",
                                reason=invalid_selection.reason,
                            ),
                        ),
                        error_code="unknown_character",
                        message="Requested character is unavailable.",
                    )
                ),
            },
        },
    }


def build_api_router() -> Any:
    (
        session_service,
        character_service,
        _transcription_service,
        _synthesis_service,
        speech_lifecycle_service,
        session_event_factory,
        _turn_pipeline_publisher,
    ) = _build_services()
    route_definitions = _route_definitions()

    try:
        from fastapi import APIRouter
    except ImportError:
        return RouterShell(routes=route_definitions)

    router = APIRouter()
    from fastapi import HTTPException, Response, status

    @router.get("/health", response_model=HealthPayload)
    def healthcheck() -> HealthPayload:
        return _build_health_payload(character_service)

    @router.get("/characters", response_model=CharacterCatalogResponse)
    def list_characters() -> CharacterCatalogResponse:
        snapshot = session_service.get_snapshot()
        return _build_character_catalog_response(snapshot, character_service.list_character_summaries())

    @router.get(
        "/session/active-character",
        response_model=ActiveCharacterResponse,
        response_model_exclude_none=True,
    )
    def get_active_character() -> ActiveCharacterResponse:
        snapshot = session_service.get_snapshot()
        active_character = character_service.get_character_summary(snapshot.active_character_id)
        return _build_active_character_response(
            snapshot,
            active_character,
            requested_character_id=active_character.character_id,
            selection_applied=True,
            session_event=_build_session_event(
                snapshot,
                session_event_factory,
                character_id=active_character.character_id,
                event_type="session.state",
                status=snapshot.lifecycle_state,
            ),
            message="Active character resolved.",
        )

    @router.get(
        "/session/speech-lifecycle",
        response_model=SpeechLifecycleTransportSnapshot,
        response_model_exclude_none=True,
    )
    def get_speech_lifecycle(cursor: str | None = None) -> SpeechLifecycleTransportSnapshot:
        snapshot = session_service.get_snapshot()
        active_character = character_service.get_character_summary(snapshot.active_character_id)
        try:
            return speech_lifecycle_service.get_snapshot(
                snapshot,
                character_id=active_character.character_id,
                cursor=cursor,
            )
        except InvalidEventCursor as error:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(error)) from error

    @router.put(
        "/session/active-character",
        response_model=ActiveCharacterResponse,
        response_model_exclude_none=True,
    )
    def set_active_character(selection: ActiveCharacterSelection, response: Response) -> ActiveCharacterResponse:
        current_snapshot = session_service.get_snapshot()

        try:
            active_character = character_service.get_character_summary(selection.character_id)
        except UnknownCharacterError:
            response.status_code = status.HTTP_400_BAD_REQUEST
            current_character = character_service.get_character_summary(current_snapshot.active_character_id)
            return _build_active_character_response(
                current_snapshot,
                current_character,
                requested_character_id=selection.character_id,
                selection_applied=False,
                session_event=_append_session_event(
                    session_service,
                    _build_session_event(
                        current_snapshot,
                        session_event_factory,
                        character_id=selection.character_id,
                        event_type="session.character.rejected",
                        status="rejected",
                        reason=selection.reason,
                    ),
                ),
                error_code="unknown_character",
                message="Requested character is unavailable.",
            )

        snapshot = session_service.set_active_character(selection)
        return _build_active_character_response(
            snapshot,
            active_character,
            requested_character_id=selection.character_id,
            selection_applied=True,
            session_event=_append_session_event(
                session_service,
                _build_session_event(
                    snapshot,
                    session_event_factory,
                    character_id=active_character.character_id,
                    event_type="session.character.selected",
                    status="applied",
                    reason=selection.reason,
                ),
            ),
            message="Active character updated.",
        )

    return router
