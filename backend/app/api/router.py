from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from app.schemas.animation import AnimationCommand
from app.schemas.character import ActiveCharacterSelection, CharacterSummary
from app.schemas.session import SessionSnapshot
from app.services.animation import AnimationService, StubAnimationService
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


def _build_services() -> tuple[SessionService, CharacterService, AnimationService]:
    character_service = CharacterService(FileSystemCharacterManifestSource())
    session_service = InMemorySessionService(default_character_id="test-vrm-01")
    animation_service = StubAnimationService()
    return session_service, character_service, animation_service


def build_api_router() -> Any:
    session_service, character_service, animation_service = _build_services()
    route_definitions = [
        RouteDefinition(method="GET", path="/health", name="healthcheck"),
        RouteDefinition(method="GET", path="/characters", name="list_characters"),
        RouteDefinition(method="GET", path="/session/active-character", name="get_active_character"),
        RouteDefinition(method="PUT", path="/session/active-character", name="set_active_character"),
        RouteDefinition(method="POST", path="/animations/commands", name="queue_animation_command"),
    ]

    try:
        from fastapi import APIRouter
    except ImportError:
        return RouterShell(routes=route_definitions)

    router = APIRouter()

    @router.get("/health")
    def healthcheck() -> dict[str, str]:
        return {"status": "ok", "mode": "scaffold"}

    @router.get("/characters", response_model=list[CharacterSummary])
    def list_characters() -> list[CharacterSummary]:
        return character_service.list_character_summaries()

    @router.get("/session/active-character", response_model=SessionSnapshot)
    def get_active_character() -> SessionSnapshot:
        return session_service.get_snapshot()

    @router.put("/session/active-character", response_model=SessionSnapshot)
    def set_active_character(selection: ActiveCharacterSelection) -> SessionSnapshot:
        character_service.get_character_summary(selection.character_id)
        return session_service.set_active_character(selection)

    @router.post("/animations/commands", response_model=AnimationCommand)
    def queue_animation_command(command: AnimationCommand) -> AnimationCommand:
        return animation_service.accept_command(command)

    return router
