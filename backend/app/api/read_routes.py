from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from app.api.response_builders import build_character_catalog_response, build_health_payload
from app.schemas.character import CharacterCatalogResponse
from app.schemas.health import HealthPayload
from app.services.character import CharacterService
from app.services.session import SessionService


@dataclass(slots=True)
class ReadRouteServices:
    session_service: SessionService
    character_service: CharacterService


def register_read_routes(
    router: Any,
    *,
    services: ReadRouteServices,
) -> None:
    @router.get("/health", response_model=HealthPayload)
    def healthcheck() -> HealthPayload:
        return build_health_payload(services.character_service)

    @router.get("/characters", response_model=CharacterCatalogResponse)
    def list_characters() -> CharacterCatalogResponse:
        snapshot = services.session_service.get_snapshot()
        return build_character_catalog_response(
            snapshot,
            services.character_service.list_character_summaries(),
        )