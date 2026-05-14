from __future__ import annotations

from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from typing import Any

from app.core.settings import get_app_paths
from app.schemas.character import ActiveCharacterSelection, CharacterSummary
from app.schemas.health import DiagnosticProbe, HealthDiagnostics, HealthPayload
from app.schemas.session import ActiveCharacterResponse, SessionEvent, SessionSnapshot
from app.services.character import CharacterService, FileSystemCharacterManifestSource
from app.services.session import InMemorySessionService, SessionService


@dataclass(slots=True, frozen=True)
class RouteDefinition:
    method: str
    path: str
    name: str


@dataclass(slots=True)
class RouterShell:
    routes: list[RouteDefinition]


def _route_definitions() -> list[RouteDefinition]:
    return [
        RouteDefinition(method="GET", path="/health", name="healthcheck"),
        RouteDefinition(method="GET", path="/characters", name="list_characters"),
        RouteDefinition(method="GET", path="/session/active-character", name="get_active_character"),
        RouteDefinition(method="PUT", path="/session/active-character", name="set_active_character"),
    ]


def _build_services() -> tuple[SessionService, CharacterService]:
    character_service = CharacterService(FileSystemCharacterManifestSource())
    session_service = InMemorySessionService(default_character_id="test-vrm-01")
    return session_service, character_service


def _timestamp_now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


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


def _build_session_event(
    snapshot: SessionSnapshot,
    *,
    character_id: str,
    event_type: str,
    status: str,
    reason: str | None = None,
) -> SessionEvent:
    return SessionEvent(
        schema_version=1,
        event_type=event_type,
        session_id=snapshot.session_id,
        character_id=character_id,
        status=status,
        timestamp=_timestamp_now(),
        reason=reason,
    )


def _build_active_character_response(
    snapshot: SessionSnapshot,
    active_character: CharacterSummary,
    *,
    event_type: str,
    status: str,
    reason: str | None = None,
) -> ActiveCharacterResponse:
    return ActiveCharacterResponse(
        schema_version=1,
        session_id=snapshot.session_id,
        lifecycle_state=snapshot.lifecycle_state,
        active_character=active_character,
        session_event=_build_session_event(
            snapshot,
            character_id=active_character.character_id,
            event_type=event_type,
            status=status,
            reason=reason,
        ),
    )


def build_api_contract_snapshot() -> dict[str, Any]:
    session_service, character_service = _build_services()
    characters = character_service.list_character_summaries()
    current_snapshot = session_service.get_snapshot()
    current_character = character_service.get_character_summary(current_snapshot.active_character_id)
    selected_character = characters[-1] if characters else current_character
    selection = ActiveCharacterSelection(
        character_id=selected_character.character_id,
        reason="user_selected",
    )
    updated_snapshot = session_service.set_active_character(selection)

    return {
        "routes": [asdict(route) for route in _route_definitions()],
        "responses": {
            "health": asdict(_build_health_payload(character_service)),
            "characters": [asdict(character) for character in characters],
            "get_active_character": asdict(
                _build_active_character_response(
                    current_snapshot,
                    current_character,
                    event_type="session.state",
                    status=current_snapshot.lifecycle_state,
                )
            ),
            "put_active_character": {
                "request": asdict(selection),
                "response": asdict(
                    _build_active_character_response(
                        updated_snapshot,
                        selected_character,
                        event_type="session.character.selected",
                        status="applied",
                        reason=selection.reason,
                    )
                ),
            },
        },
    }


def build_api_router() -> Any:
    session_service, character_service = _build_services()
    route_definitions = _route_definitions()

    try:
        from fastapi import APIRouter
    except ImportError:
        return RouterShell(routes=route_definitions)

    router = APIRouter()

    @router.get("/health", response_model=HealthPayload)
    def healthcheck() -> HealthPayload:
        return _build_health_payload(character_service)

    @router.get("/characters", response_model=list[CharacterSummary])
    def list_characters() -> list[CharacterSummary]:
        return character_service.list_character_summaries()

    @router.get("/session/active-character", response_model=ActiveCharacterResponse)
    def get_active_character() -> ActiveCharacterResponse:
        snapshot = session_service.get_snapshot()
        active_character = character_service.get_character_summary(snapshot.active_character_id)
        return _build_active_character_response(
            snapshot,
            active_character,
            event_type="session.state",
            status=snapshot.lifecycle_state,
        )

    @router.put("/session/active-character", response_model=ActiveCharacterResponse)
    def set_active_character(selection: ActiveCharacterSelection) -> ActiveCharacterResponse:
        active_character = character_service.get_character_summary(selection.character_id)
        snapshot = session_service.set_active_character(selection)
        return _build_active_character_response(
            snapshot,
            active_character,
            event_type="session.character.selected",
            status="applied",
            reason=selection.reason,
        )

    return router
