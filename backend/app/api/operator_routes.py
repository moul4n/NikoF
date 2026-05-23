from __future__ import annotations

from dataclasses import dataclass

from app.schemas.session import (
    OperatorCommandRequest,
    OperatorCommandResponse,
)
from app.services.animation import AnimationService, SessionAnimationLiveDeliveryService
from app.services.character import CharacterService
from app.services.companion_memory import CompanionMemoryService
from app.services.llm import TextGenerationService
from app.services.session import SessionService
from app.services.speech import (
    SPEECH_LIFECYCLE_STREAM,
    SessionEventFactory,
    SpeechSynthesisRequest,
    SpeechSynthesisService,
    project_public_session_event,
    project_public_speech_lifecycle_envelope,
)
from app.schemas.session import TTS_BASELINE_PROFILE_IDS
from app.services.turns import UserTurnRequest, UserTurnServices, run_user_text_turn


@dataclass(slots=True)
class OperatorCommandRouteServices:
    session_service: SessionService
    character_service: CharacterService
    text_generation_service: TextGenerationService
    synthesis_service: SpeechSynthesisService
    session_event_factory: SessionEventFactory
    memory_service: CompanionMemoryService | None = None
    animation_service: AnimationService | None = None
    session_animation_live_delivery: SessionAnimationLiveDeliveryService | None = None


def _build_text_question_response(
    command: OperatorCommandRequest,
    *,
    normalized_text: str,
    services: OperatorCommandRouteServices,
) -> OperatorCommandResponse:
    turn = run_user_text_turn(
        UserTurnRequest(
            text=normalized_text,
            locale=command.locale,
            session_event_type="session.operator.text-question",
            defer_synthesis=True,
        ),
        services=UserTurnServices(
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
    return OperatorCommandResponse(
        schema_version=1,
        session_id=turn.session_id,
        command_type=command.command_type,
        character_id=turn.character_id,
        status=turn.status,
        session_event=turn.session_event,
        next_speech_cursor=turn.next_speech_cursor,
        speech_lifecycle_events=turn.speech_lifecycle_events,
    )


def _build_tts_preview_response(
    command: OperatorCommandRequest,
    *,
    normalized_text: str,
    services: OperatorCommandRouteServices,
) -> OperatorCommandResponse:
    snapshot = services.session_service.get_snapshot()
    active_character = services.character_service.get_character_summary(snapshot.active_character_id)
    voice_profile = services.character_service.get_character_voice_profile(active_character.character_id)
    lip_sync_preferences = services.character_service.get_character_lip_sync_preferences(active_character.character_id)
    synthesis = services.synthesis_service.synthesize(
        SpeechSynthesisRequest(
            text=normalized_text,
            locale=command.locale,
            profile_id=TTS_BASELINE_PROFILE_IDS[0],
            voice_profile_id=voice_profile.profile_id or TTS_BASELINE_PROFILE_IDS[0],
            voice_profile={
                "profile_id": voice_profile.profile_id,
                "provider": voice_profile.provider,
                "style": voice_profile.style,
                "notes": voice_profile.notes,
                **voice_profile.settings,
            },
            preferred_lip_sync_track_id=lip_sync_preferences.preferred_track_id,
        )
    )
    synthesis_envelope = services.session_service.event_store.append(
        SPEECH_LIFECYCLE_STREAM,
        services.session_event_factory.build_event(
            snapshot,
            character_id=active_character.character_id,
            event_type="speech.synthesis",
            status=synthesis.status,
            synthesis=synthesis,
        ),
    )
    speech_lifecycle_events = [
        project_public_speech_lifecycle_envelope(synthesis_envelope)
    ]
    session_event = services.session_event_factory.build_event(
        snapshot,
        character_id=active_character.character_id,
        event_type="session.operator.tts-preview",
        status=synthesis.status,
        synthesis=synthesis,
    )
    services.session_service.event_store.append("session", session_event)
    public_session_event = project_public_session_event(
        session_event,
        audio_event_id=synthesis_envelope.event_id,
    )
    return OperatorCommandResponse(
        schema_version=1,
        session_id=snapshot.session_id,
        command_type=command.command_type,
        character_id=active_character.character_id,
        status=synthesis.status,
        session_event=public_session_event,
        next_speech_cursor=services.session_service.event_store.next_cursor(
            SPEECH_LIFECYCLE_STREAM,
            session_id=snapshot.session_id,
        ),
        speech_lifecycle_events=tuple(speech_lifecycle_events),
    )


def register_operator_command_routes(
    router: Any,
    *,
    services: OperatorCommandRouteServices,
) -> None:
    from fastapi import HTTPException, status

    @router.post(
        "/session/operator-command",
        response_model=OperatorCommandResponse,
        response_model_exclude_none=True,
    )
    def post_operator_command(command: OperatorCommandRequest) -> OperatorCommandResponse:
        normalized_text = command.text.strip()
        if not normalized_text:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Operator command text must not be blank.",
            )

        if command.command_type not in {"text_question", "tts_preview"}:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"Unsupported operator command type: {command.command_type}",
            )

        if command.command_type == "text_question":
            return _build_text_question_response(
                command,
                normalized_text=normalized_text,
                services=services,
            )

        return _build_tts_preview_response(
            command,
            normalized_text=normalized_text,
            services=services,
        )