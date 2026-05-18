from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from app.api.response_builders import derive_operator_command_status
from app.schemas.session import (
    LLM_BASELINE_PROFILE_IDS,
    OperatorCommandRequest,
    OperatorCommandResponse,
    TTS_BASELINE_PROFILE_IDS,
)
from app.services.character import CharacterService
from app.services.llm import TextGenerationRequest, TextGenerationService
from app.services.session import SessionService
from app.services.speech import (
    SPEECH_LIFECYCLE_STREAM,
    SessionEventFactory,
    SpeechSynthesisRequest,
    SpeechSynthesisService,
    project_public_session_event,
    project_public_speech_lifecycle_envelope,
)


def _build_spoken_reply_prompt(
    text: str,
    *,
    character_id: str,
    voice_profile: Any,
) -> str:
    prompt_lines = [
        "You are preparing the final spoken reply for local text-to-speech synthesis.",
        "Return only the exact reply text to speak.",
        "Do not include markdown, bullets, stage directions, speaker labels, or surrounding quotes.",
        "Keep the answer concise, natural aloud, and easy to synthesize in one to three short sentences.",
        f"Active character id: {character_id}.",
    ]
    if getattr(voice_profile, "style", None):
        prompt_lines.append(f"Preferred delivery style: {voice_profile.style}.")
    if getattr(voice_profile, "notes", None):
        prompt_lines.append(f"Voice notes: {voice_profile.notes}")
    prompt_lines.extend(
        [
            "User message:",
            text,
        ]
    )
    return "\n".join(prompt_lines)


def _build_degraded_synthesis_contract(
    assistant: Any,
    *,
    locale: str,
    voice_profile_id: str | None,
) -> Any:
    from app.schemas.session import SpeechSynthesisContract

    synthesis_status = assistant.status if assistant.status in {"error", "unavailable", "degraded"} else "unavailable"
    return SpeechSynthesisContract(
        profile_id=voice_profile_id or TTS_BASELINE_PROFILE_IDS[0],
        status=synthesis_status,
        text=assistant.text,
        locale=locale,
    )


@dataclass(slots=True)
class OperatorCommandRouteServices:
    session_service: SessionService
    character_service: CharacterService
    text_generation_service: TextGenerationService
    synthesis_service: SpeechSynthesisService
    session_event_factory: SessionEventFactory


def _build_text_question_response(
    command: OperatorCommandRequest,
    *,
    normalized_text: str,
    services: OperatorCommandRouteServices,
) -> OperatorCommandResponse:
    snapshot = services.session_service.get_snapshot()
    active_character = services.character_service.get_character_summary(snapshot.active_character_id)
    voice_profile = services.character_service.get_character_voice_profile(active_character.character_id)
    assistant = services.text_generation_service.generate(
        TextGenerationRequest(
            prompt=_build_spoken_reply_prompt(
                normalized_text,
                character_id=active_character.character_id,
                voice_profile=voice_profile,
            ),
            locale=command.locale,
            profile_id=LLM_BASELINE_PROFILE_IDS[0],
        )
    )
    assistant_envelope = services.session_service.event_store.append(
        SPEECH_LIFECYCLE_STREAM,
        services.session_event_factory.build_event(
            snapshot,
            character_id=active_character.character_id,
            event_type="assistant.message",
            status=assistant.status,
            assistant=assistant,
        ),
    )
    speech_lifecycle_events = [
        project_public_speech_lifecycle_envelope(assistant_envelope)
    ]
    if assistant.status == "ready":
        synthesis = services.synthesis_service.synthesize(
            SpeechSynthesisRequest(
                text=assistant.text,
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
            )
        )
    else:
        synthesis = _build_degraded_synthesis_contract(
            assistant,
            locale=command.locale,
            voice_profile_id=voice_profile.profile_id,
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
    speech_lifecycle_events.append(project_public_speech_lifecycle_envelope(synthesis_envelope))
    command_status = derive_operator_command_status(assistant.status, synthesis.status)
    session_event = services.session_event_factory.build_event(
        snapshot,
        character_id=active_character.character_id,
        event_type="session.operator.text-question",
        status=command_status,
        assistant=assistant,
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
        status=command_status,
        session_event=public_session_event,
        next_speech_cursor=services.session_service.event_store.next_cursor(
            SPEECH_LIFECYCLE_STREAM,
            session_id=snapshot.session_id,
        ),
        speech_lifecycle_events=tuple(speech_lifecycle_events),
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