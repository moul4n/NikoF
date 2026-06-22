from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Callable

from fastapi import Response

from app.schemas.animation import SessionAnimationSnapshot
from app.schemas.character import ActiveCharacterSelection
from app.schemas.session import ActiveCharacterResponse
from app.services.animation import AnimationService, SessionAnimationLiveDeliveryService
from app.services.character import CharacterService, UnknownCharacterError
from app.services.session import SessionService
from app.services.speech import SessionEventFactory


BuildActiveCharacterResponse = Callable[..., ActiveCharacterResponse]


@dataclass(slots=True)
class ActiveCharacterRouteServices:
    session_service: SessionService
    character_service: CharacterService
    session_event_factory: SessionEventFactory
    # Optional so the route degrades gracefully if animation delivery isn't wired.
    animation_service: AnimationService | None = None
    session_animation_live_delivery: SessionAnimationLiveDeliveryService | None = None


def register_active_character_routes(
    router: Any,
    *,
    services: ActiveCharacterRouteServices,
    build_active_character_response: BuildActiveCharacterResponse,
) -> None:
    from fastapi import status

    @router.get(
        "/session/active-character",
        response_model=ActiveCharacterResponse,
        response_model_exclude_none=True,
    )
    def get_active_character() -> ActiveCharacterResponse:
        snapshot = services.session_service.get_snapshot()
        active_character = services.character_service.get_character_summary(snapshot.active_character_id)
        return build_active_character_response(
            snapshot,
            active_character,
            services.session_event_factory,
            requested_character_id=active_character.character_id,
            selection_applied=True,
            event_type="session.state",
            status=snapshot.lifecycle_state,
            message="Active character resolved.",
        )

    @router.put(
        "/session/active-character",
        response_model=ActiveCharacterResponse,
        response_model_exclude_none=True,
    )
    def set_active_character(selection: ActiveCharacterSelection, response: Response) -> ActiveCharacterResponse:
        current_snapshot = services.session_service.get_snapshot()

        try:
            active_character = services.character_service.get_character_summary(selection.character_id)
        except UnknownCharacterError:
            response.status_code = status.HTTP_400_BAD_REQUEST
            current_character = services.character_service.get_character_summary(current_snapshot.active_character_id)
            return build_active_character_response(
                current_snapshot,
                current_character,
                services.session_event_factory,
                requested_character_id=selection.character_id,
                selection_applied=False,
                event_type="session.character.rejected",
                status="rejected",
                error_code="unknown_character",
                message="Requested character is unavailable.",
                event_character_id=selection.character_id,
                reason=selection.reason,
            )

        snapshot = services.session_service.set_active_character(selection)

        # Broadcast the new active character over the session-animation stream so
        # every connected avatar client (the always-on-top stage window, the
        # display surface) reconciles its selection and reloads the model live,
        # without a page refresh. Mirrors set_session_lifecycle_state.
        if services.animation_service is not None and services.session_animation_live_delivery is not None:
            animation_snapshot = SessionAnimationSnapshot(
                session_id=snapshot.session_id,
                lifecycle_state=snapshot.lifecycle_state,
                active_character_id=snapshot.active_character_id,
                command=services.animation_service.resolve_session_command(snapshot),
            )
            services.session_animation_live_delivery.publish_snapshot(animation_snapshot)

        return build_active_character_response(
            snapshot,
            active_character,
            services.session_event_factory,
            requested_character_id=selection.character_id,
            selection_applied=True,
            event_type="session.character.selected",
            status="applied",
            message="Active character updated.",
            reason=selection.reason,
        )