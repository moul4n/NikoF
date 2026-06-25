from __future__ import annotations

from dataclasses import dataclass
import logging
import time
from typing import Any

from app.api.response_builders import derive_operator_command_status
from app.core.runtime_tuning import get_runtime_tuning
from app.schemas.session import (
    AssistantMessageContract,
    LLM_BASELINE_PROFILE_IDS,
    SpeechTranscriptionContract,
    SpeechLifecycleEventEnvelope,
)
from app.services.animation import AnimationService, SessionAnimationLiveDeliveryService
from app.services.character import CharacterService
from app.services.companion_memory import CompanionMemoryService
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
from app.services.text_segmentation import iter_sentence_segments
from app.services.turn_telemetry import get_turn_telemetry
# Planner prompt builders (extracted). Re-exported so callers/tests keep
# importing them from app.services.turns.
from app.services.turns_prompts import (  # noqa: F401  (re-exported for callers)
    _build_lean_reply_prompt,
    _build_spoken_reply_prompt,
    _should_include_appearance_context,
)
# Ambient context block (live-info Stage A): cheap local time/date/location facts
# injected into the planner prompt every turn. Off unless NIKOF_AMBIENT_CONTEXT=1.
from app.services.turns_ambient import build_ambient_block
# Assistant-reply animation resolution (extracted); used by the turn pipeline.
from app.services.turns_animation import (
    _build_assistant_animation_snapshot,
    _build_llm_thinking_animation_snapshot,
)
# Durable memory writeback extraction + async persistence (extracted); used by
# the turn pipeline (the sync path uses _writebacks_to_dicts).
from app.services.turns_memory import (  # noqa: F401  (re-exported for callers)
    _dispatch_async_memory_store,
    _extract_memory_writebacks,
    _writebacks_to_dicts,
)
# Per-turn synthesis dispatch + streaming generation (extracted); driven by the
# pipeline below.
from app.services.turns_synthesis import (
    _append_synthesis_event,
    _build_degraded_synthesis_contract,
    _build_queued_synthesis_contract,
    _build_turn_synthesis_request,
    _dispatch_deferred_synthesis,
    _dispatch_segmented_synthesis,
    _new_utterance_id,
    _run_streamed_generation,
    _run_synthesis_request,
    _stamp_segment_fields,
)


logger = logging.getLogger(__name__)



@dataclass(slots=True)
class UserTurnServices:
    session_service: SessionService
    character_service: CharacterService
    text_generation_service: TextGenerationService
    synthesis_service: SpeechSynthesisService
    session_event_factory: SessionEventFactory
    memory_service: CompanionMemoryService | None = None
    animation_service: AnimationService | None = None
    session_animation_live_delivery: SessionAnimationLiveDeliveryService | None = None


@dataclass(slots=True, frozen=True)
class UserTurnRequest:
    text: str
    locale: str = "en-US"
    session_event_type: str = "session.operator.text-question"
    transcription: SpeechTranscriptionContract | None = None
    defer_synthesis: bool = False


@dataclass(slots=True, frozen=True)
class UserTurnResult:
    session_id: str
    character_id: str
    status: str
    session_event: Any
    next_speech_cursor: str
    speech_lifecycle_events: tuple[SpeechLifecycleEventEnvelope, ...]


def _resolve_turn_input_text(request: UserTurnRequest) -> str:
    if request.transcription is not None:
        transcript = str(request.transcription.transcript or "").strip()
        if transcript:
            return transcript
    return request.text.strip()


def run_user_text_turn(
    request: UserTurnRequest,
    *,
    services: UserTurnServices,
) -> UserTurnResult:
    turn_started_perf = time.perf_counter()
    turn_started_epoch = time.time()
    memory_ms: float | None = None
    llm_ms: float | None = None
    tts_ms: float | None = None
    snapshot = services.session_service.get_snapshot()
    active_character = services.character_service.get_character_summary(snapshot.active_character_id)
    voice_profile = services.character_service.get_character_voice_profile(active_character.character_id)
    lip_sync_preferences = services.character_service.get_character_lip_sync_preferences(active_character.character_id)
    turn_input_text = _resolve_turn_input_text(request)
    memory_context = None
    if services.memory_service is not None:
        memory_started = time.perf_counter()
        try:
            services.memory_service.ensure_persona_core(
                persona_id=active_character.character_id,
                display_name=active_character.display_name,
                speech_style=voice_profile.style,
            )
            memory_context = services.memory_service.get_prompt_context(
                persona_id=active_character.character_id,
                query_text=turn_input_text,
                include_appearance_context=_should_include_appearance_context(turn_input_text),
                prompt_token_budget=get_runtime_tuning().memory_prompt_token_budget,
            )
        except Exception:
            logger.exception("User turn memory context preparation failed")
            memory_context = None
        memory_ms = (time.perf_counter() - memory_started) * 1000.0

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

    if services.animation_service is not None and services.session_animation_live_delivery is not None:
        try:
            services.session_animation_live_delivery.publish_snapshot(
                _build_llm_thinking_animation_snapshot(
                    snapshot=snapshot,
                    character_id=active_character.character_id,
                    animation_service=services.animation_service,
                )
            )
        except Exception:
            logger.exception("User turn thinking animation publication failed")

    tuning = get_runtime_tuning()
    generation_request = TextGenerationRequest(
        prompt=_build_spoken_reply_prompt(
            turn_input_text,
            character_id=active_character.character_id,
            voice_profile=voice_profile,
            memory_context=memory_context,
            input_source="stt" if request.transcription is not None else "manual_text",
            lean=tuning.llm_lean_planner,
            ambient_lines=build_ambient_block(),
        ),
        locale=request.locale,
        profile_id=LLM_BASELINE_PROFILE_IDS[0],
        expect_structured_output=True,
    )
    # Phase 1b: stream the reply and dispatch sentence segments to TTS while the
    # LLM is still generating. Falls back to the buffered generate() path when
    # streaming is off, segmentation is off, or the service can't stream.
    streaming_active = (
        tuning.llm_streaming_enabled
        and tuning.tts_segmentation_enabled
        and hasattr(services.text_generation_service, "generate_stream")
    )
    streamed_segments_dispatched = False
    streamed_utterance_id: str | None = None

    llm_started = time.perf_counter()
    if streaming_active:
        streamed_utterance_id = _new_utterance_id(snapshot, active_character.character_id)
        try:
            assistant, streamed_segments_dispatched = _run_streamed_generation(
                generation_request,
                services=services,
                snapshot=snapshot,
                character_id=active_character.character_id,
                voice_profile=voice_profile,
                lip_sync_preferences=lip_sync_preferences,
                utterance_id=streamed_utterance_id,
                tuning=tuning,
            )
        except Exception:
            logger.exception("User turn streamed text generation failed")
            assistant = AssistantMessageContract(
                profile_id=LLM_BASELINE_PROFILE_IDS[0],
                status="error",
                text="Local text generation failed.",
                locale=request.locale,
            )
    else:
        try:
            assistant = services.text_generation_service.generate(generation_request)
        except Exception:
            logger.exception("User turn text generation failed")
            assistant = AssistantMessageContract(
                profile_id=LLM_BASELINE_PROFILE_IDS[0],
                status="error",
                text="Local text generation failed.",
                locale=request.locale,
            )
    llm_ms = (time.perf_counter() - llm_started) * 1000.0
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

    synthesis_envelope: SpeechLifecycleEventEnvelope | None = None
    # Phase 1a: when segmentation is enabled and the reply has >1 sentence
    # segments, synthesize per-segment so the first sentence plays while later
    # ones synthesize. Flag OFF (or a single segment) -> original behavior.
    utterance_id = assistant_envelope.event_id
    segment_requests: list[SpeechSynthesisRequest] = []
    use_segmentation = False
    if streamed_segments_dispatched:
        # Phase 1b: segments were already synthesized and published to the
        # lifecycle during streaming; record a queued placeholder for the
        # session event (the lifecycle stream carries the actual audio).
        synthesis = _stamp_segment_fields(
            _build_queued_synthesis_contract(
                assistant,
                locale=request.locale,
                voice_profile_id=voice_profile.profile_id,
            ),
            utterance_id=streamed_utterance_id or utterance_id,
            segment_index=0,
            segment_count=None,
            is_final=False,
        )
    elif assistant.status == "ready":
        synthesis_request = _build_turn_synthesis_request(
            assistant,
            locale=request.locale,
            voice_profile=voice_profile,
            lip_sync_preferences=lip_sync_preferences,
        )
        segment_texts: list[str] = []
        if tuning.tts_segmentation_enabled:
            segment_texts = iter_sentence_segments(
                assistant.text,
                min_chars=tuning.tts_segment_min_chars,
                max_chars=tuning.tts_segment_max_chars,
            )
        use_segmentation = len(segment_texts) > 1
        if use_segmentation:
            segment_requests = [
                _build_turn_synthesis_request(
                    assistant,
                    locale=request.locale,
                    voice_profile=voice_profile,
                    lip_sync_preferences=lip_sync_preferences,
                    text_override=segment_text,
                )
                for segment_text in segment_texts
            ]
            segment_count = len(segment_requests)
            if request.defer_synthesis:
                # Session-event placeholder; segments dispatched after the
                # session event is appended (see below).
                synthesis = _stamp_segment_fields(
                    _build_queued_synthesis_contract(
                        assistant,
                        locale=request.locale,
                        voice_profile_id=voice_profile.profile_id,
                    ),
                    utterance_id=utterance_id,
                    segment_index=0,
                    segment_count=segment_count,
                )
            else:
                # Synthesize segment 0 inline so the command response carries
                # first audio; defer the rest in order.
                tts_started = time.perf_counter()
                synthesis = _stamp_segment_fields(
                    _run_synthesis_request(segment_requests[0], services=services),
                    utterance_id=utterance_id,
                    segment_index=0,
                    segment_count=segment_count,
                )
                tts_ms = (time.perf_counter() - tts_started) * 1000.0
                synthesis_envelope = _append_synthesis_event(
                    synthesis,
                    services=services,
                    snapshot=snapshot,
                    character_id=active_character.character_id,
                )
                speech_lifecycle_events.append(project_public_speech_lifecycle_envelope(synthesis_envelope))
                _dispatch_segmented_synthesis(
                    segment_requests[1:],
                    services=services,
                    snapshot=snapshot,
                    character_id=active_character.character_id,
                    utterance_id=utterance_id,
                    segment_count=segment_count,
                    start_index=1,
                )
        elif request.defer_synthesis:
            synthesis = _build_queued_synthesis_contract(
                assistant,
                locale=request.locale,
                voice_profile_id=voice_profile.profile_id,
            )
        else:
            tts_started = time.perf_counter()
            synthesis = _run_synthesis_request(synthesis_request, services=services)
            tts_ms = (time.perf_counter() - tts_started) * 1000.0
            synthesis_envelope = _append_synthesis_event(
                synthesis,
                services=services,
                snapshot=snapshot,
                character_id=active_character.character_id,
            )
            speech_lifecycle_events.append(project_public_speech_lifecycle_envelope(synthesis_envelope))
    else:
        synthesis = _build_degraded_synthesis_contract(
            assistant,
            locale=request.locale,
            voice_profile_id=voice_profile.profile_id,
        )
        synthesis_envelope = _append_synthesis_event(
            synthesis,
            services=services,
            snapshot=snapshot,
            character_id=active_character.character_id,
        )
        speech_lifecycle_events.append(project_public_speech_lifecycle_envelope(synthesis_envelope))

    statuses = [assistant.status, synthesis.status]
    if request.defer_synthesis and assistant.status == "ready":
        statuses = [assistant.status]
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
    next_speech_cursor = services.session_service.event_store.next_cursor(
        SPEECH_LIFECYCLE_STREAM,
        session_id=snapshot.session_id,
    )

    if assistant.status == "ready" and request.defer_synthesis and not streamed_segments_dispatched:
        if use_segmentation:
            _dispatch_segmented_synthesis(
                segment_requests,
                services=services,
                snapshot=snapshot,
                character_id=active_character.character_id,
                utterance_id=utterance_id,
                segment_count=len(segment_requests),
                start_index=0,
            )
        else:
            _dispatch_deferred_synthesis(
                synthesis_request,
                services=services,
                snapshot=snapshot,
                character_id=active_character.character_id,
            )

    if services.animation_service is not None and services.session_animation_live_delivery is not None:
        try:
            animation_snapshot = _build_assistant_animation_snapshot(
                assistant,
                snapshot=snapshot,
                character_id=active_character.character_id,
                animation_service=services.animation_service,
                user_text=turn_input_text,
            )
            if animation_snapshot is not None:
                services.session_animation_live_delivery.publish_snapshot(animation_snapshot)
        except Exception:
            logger.exception("User turn animation publication failed")

    if services.memory_service is not None:
        if tuning.llm_lean_planner:
            # Lean planner omits memory_writebacks from the reply; persist memory
            # in the background and (optionally) recover durable writebacks via a
            # separate LLM call, keeping it off the turn's latency path.
            _dispatch_async_memory_store(
                services=services,
                snapshot=snapshot,
                character_id=active_character.character_id,
                locale=request.locale,
                user_text=turn_input_text,
                assistant=assistant,
                extract_writebacks=tuning.llm_async_memory,
            )
        else:
            try:
                services.memory_service.store_turn(
                    persona_id=active_character.character_id,
                    session_id=snapshot.session_id,
                    locale=request.locale,
                    user_text=turn_input_text,
                    assistant_text=assistant.text,
                    assistant_status=assistant.status,
                    memory_writebacks=_writebacks_to_dicts(assistant),
                    feeling_name=assistant.feeling.name if assistant.feeling is not None else None,
                    voice_energy=assistant.voice_tone.energy if assistant.voice_tone is not None else None,
                )
            except Exception:
                logger.exception("User turn memory persistence failed")

    get_turn_telemetry().record(
        input_source="stt" if request.transcription is not None else "manual_text",
        status=turn_status,
        character_id=active_character.character_id,
        deferred_synthesis=bool(request.defer_synthesis and assistant.status == "ready"),
        total_ms=(time.perf_counter() - turn_started_perf) * 1000.0,
        started_epoch=turn_started_epoch,
        llm_ms=llm_ms,
        tts_ms=tts_ms,
        memory_ms=memory_ms,
    )

    return UserTurnResult(
        session_id=snapshot.session_id,
        character_id=active_character.character_id,
        status=turn_status,
        session_event=project_public_session_event(
            session_event,
            audio_event_id=synthesis_envelope.event_id if synthesis_envelope is not None else None,
        ),
        next_speech_cursor=next_speech_cursor,
        speech_lifecycle_events=tuple(speech_lifecycle_events),
    )