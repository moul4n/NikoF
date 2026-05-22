from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from app.api.response_builders import derive_operator_command_status
from app.schemas.session import (
    AssistantMessageContract,
    LLM_BASELINE_PROFILE_IDS,
    TTS_BASELINE_PROFILE_IDS,
    SpeechTranscriptionContract,
    SpeechLifecycleEventEnvelope,
    SpeechSynthesisContract,
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
    assistant: AssistantMessageContract,
    *,
    locale: str,
    voice_profile_id: str | None,
) -> SpeechSynthesisContract:
    synthesis_status = assistant.status if assistant.status in {"error", "unavailable", "degraded"} else "unavailable"
    return SpeechSynthesisContract(
        profile_id=voice_profile_id or TTS_BASELINE_PROFILE_IDS[0],
        status=synthesis_status,
        text=assistant.text,
        locale=locale,
    )


@dataclass(slots=True)
class UserTurnServices:
    session_service: SessionService
    character_service: CharacterService
    text_generation_service: TextGenerationService
    synthesis_service: SpeechSynthesisService
    session_event_factory: SessionEventFactory


@dataclass(slots=True, frozen=True)
class UserTurnRequest:
    text: str
    locale: str = "en-US"
    session_event_type: str = "session.operator.text-question"
    transcription: SpeechTranscriptionContract | None = None


@dataclass(slots=True, frozen=True)
class UserTurnResult:
    session_id: str
    character_id: str
    status: str
    session_event: Any
    next_speech_cursor: str
    speech_lifecycle_events: tuple[SpeechLifecycleEventEnvelope, ...]


def run_user_text_turn(
    request: UserTurnRequest,
    *,
    services: UserTurnServices,
) -> UserTurnResult:
    snapshot = services.session_service.get_snapshot()
    active_character = services.character_service.get_character_summary(snapshot.active_character_id)
    voice_profile = services.character_service.get_character_voice_profile(active_character.character_id)
    lip_sync_preferences = services.character_service.get_character_lip_sync_preferences(active_character.character_id)

    speech_lifecycle_events: list[SpeechLifecycleEventEnvelope] = []
    if request.transcription is not None:
        transcription_envelope = services.session_service.event_store.append(
            SPEECH_LIFECYCLE_STREAM,
            services.session_event_factory.build_event(
                snapshot,
                character_id=active_character.character_id,
                event_type="transcription.status",
                status=request.transcription.status,
                transcription=request.transcription,
            ),
        )
        speech_lifecycle_events.append(project_public_speech_lifecycle_envelope(transcription_envelope))

    assistant = services.text_generation_service.generate(
        TextGenerationRequest(
            prompt=_build_spoken_reply_prompt(
                request.text,
                character_id=active_character.character_id,
                voice_profile=voice_profile,
            ),
            locale=request.locale,
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
    speech_lifecycle_events.append(project_public_speech_lifecycle_envelope(assistant_envelope))

    if assistant.status == "ready":
        synthesis = services.synthesis_service.synthesize(
            SpeechSynthesisRequest(
                text=assistant.text,
                locale=request.locale,
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
    else:
        synthesis = _build_degraded_synthesis_contract(
            assistant,
            locale=request.locale,
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

    statuses = [assistant.status, synthesis.status]
    if request.transcription is not None:
        statuses.insert(0, request.transcription.status)
    turn_status = derive_operator_command_status(*statuses)
    session_event = services.session_event_factory.build_event(
        snapshot,
        character_id=active_character.character_id,
        event_type=request.session_event_type,
        status=turn_status,
        transcription=request.transcription,
        assistant=assistant,
        synthesis=synthesis,
    )
    services.session_service.event_store.append("session", session_event)

    return UserTurnResult(
        session_id=snapshot.session_id,
        character_id=active_character.character_id,
        status=turn_status,
        session_event=project_public_session_event(
            session_event,
            audio_event_id=synthesis_envelope.event_id,
        ),
        next_speech_cursor=services.session_service.event_store.next_cursor(
            SPEECH_LIFECYCLE_STREAM,
            session_id=snapshot.session_id,
        ),
        speech_lifecycle_events=tuple(speech_lifecycle_events),
    )