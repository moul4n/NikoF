from __future__ import annotations

from dataclasses import dataclass, replace
import logging
from pathlib import Path
import queue
import threading
import time
from typing import Any

from app.api.response_builders import derive_operator_command_status
from app.core.runtime_tuning import get_runtime_tuning
from app.schemas.session import (
    AssistantMessageContract,
    LLM_BASELINE_PROFILE_IDS,
    TTS_BASELINE_PROFILE_IDS,
    SpeechTranscriptionContract,
    SpeechLifecycleEventEnvelope,
    SpeechSynthesisContract,
)
from app.services.animation import AnimationService, SessionAnimationLiveDeliveryService
from app.services.character import CharacterService
from app.services.companion_memory import CompanionMemoryContext, CompanionMemoryService
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
from app.services.speech_audio_broadcast import get_speech_audio_broadcaster
from app.services.text_segmentation import StreamingSentenceSegmenter, iter_sentence_segments
from app.services.turn_telemetry import get_turn_telemetry
# Planner prompt builders (extracted). Re-exported so callers/tests keep
# importing them from app.services.turns.
from app.services.turns_prompts import (  # noqa: F401  (re-exported for callers)
    _build_lean_reply_prompt,
    _build_spoken_reply_prompt,
    _should_include_appearance_context,
)
# Assistant-reply animation resolution (extracted); used by the turn pipeline.
from app.services.turns_animation import (
    _build_assistant_animation_snapshot,
    _build_llm_thinking_animation_snapshot,
)


logger = logging.getLogger(__name__)



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


def _build_queued_synthesis_contract(
    assistant: AssistantMessageContract,
    *,
    locale: str,
    voice_profile_id: str | None,
) -> SpeechSynthesisContract:
    return SpeechSynthesisContract(
        profile_id=voice_profile_id or TTS_BASELINE_PROFILE_IDS[0],
        status="queued",
        text=assistant.text,
        locale=locale,
    )


def _build_turn_synthesis_request(
    assistant: AssistantMessageContract,
    *,
    locale: str,
    voice_profile: Any,
    lip_sync_preferences: Any,
    text_override: str | None = None,
) -> SpeechSynthesisRequest:
    voice_profile_payload = {
        "profile_id": voice_profile.profile_id,
        "provider": voice_profile.provider,
        "style": assistant.voice_tone.style if assistant.voice_tone is not None and assistant.voice_tone.style else voice_profile.style,
        "notes": voice_profile.notes,
        **voice_profile.settings,
    }
    if assistant.voice_tone is not None:
        voice_profile_payload["llm_voice_tone"] = {
            "style": assistant.voice_tone.style,
            "pace": assistant.voice_tone.pace,
            "energy": assistant.voice_tone.energy,
        }

    return SpeechSynthesisRequest(
        text=text_override if text_override is not None else assistant.text,
        locale=locale,
        profile_id=TTS_BASELINE_PROFILE_IDS[0],
        voice_profile_id=voice_profile.profile_id or TTS_BASELINE_PROFILE_IDS[0],
        voice_profile=voice_profile_payload,
        preferred_lip_sync_track_id=lip_sync_preferences.preferred_track_id,
    )


def _run_synthesis_request(
    synthesis_request: SpeechSynthesisRequest,
    *,
    services: UserTurnServices,
) -> SpeechSynthesisContract:
    try:
        return services.synthesis_service.synthesize(synthesis_request)
    except Exception:
        logger.exception("User turn synthesis failed")
        return SpeechSynthesisContract(
            profile_id=synthesis_request.voice_profile_id or synthesis_request.profile_id,
            status="error",
            text=synthesis_request.text,
            locale=synthesis_request.locale,
        )


def _append_synthesis_event(
    synthesis: SpeechSynthesisContract,
    *,
    services: UserTurnServices,
    snapshot: Any,
    character_id: str,
) -> SpeechLifecycleEventEnvelope:
    envelope = services.session_service.event_store.append(
        SPEECH_LIFECYCLE_STREAM,
        services.session_event_factory.build_event(
            snapshot,
            character_id=character_id,
            event_type="speech.synthesis",
            status=synthesis.status,
            synthesis=synthesis,
        ),
    )
    _publish_segment_audio(snapshot, synthesis)
    return envelope


def _publish_segment_audio(snapshot: Any, synthesis: SpeechSynthesisContract) -> None:
    """Phase 2: push the segment's WAV bytes to any connected WebSocket clients
    (no-op when none are listening). The lifecycle event + artifact fetch remain
    the source of truth; this just lets a client start audio without a fetch."""
    broadcaster = get_speech_audio_broadcaster()
    if not broadcaster.has_subscribers:
        return
    reference = synthesis.audio_reference
    if not reference:
        return
    path = Path(reference)
    if not path.is_file():  # session:// or non-file references aren't pushed
        return
    try:
        audio = path.read_bytes()
    except OSError:
        return
    broadcaster.publish(
        snapshot.session_id,
        {
            "event": "speech.audio",
            "utterance_id": synthesis.utterance_id,
            "segment_index": synthesis.segment_index,
            "is_final": synthesis.is_final,
            "mime": "audio/wav",
            "bytes": len(audio),
        },
        audio,
    )


def _dispatch_deferred_synthesis(
    synthesis_request: SpeechSynthesisRequest,
    *,
    services: UserTurnServices,
    snapshot: Any,
    character_id: str,
) -> None:
    def _worker() -> None:
        synthesis = _run_synthesis_request(synthesis_request, services=services)
        _append_synthesis_event(
            synthesis,
            services=services,
            snapshot=snapshot,
            character_id=character_id,
        )

    threading.Thread(
        target=_worker,
        name=f"user-turn-synthesis:{snapshot.session_id}:{character_id}",
        daemon=True,
    ).start()


def _stamp_segment_fields(
    synthesis: SpeechSynthesisContract,
    *,
    utterance_id: str,
    segment_index: int,
    segment_count: int | None,
    is_final: bool | None = None,
) -> SpeechSynthesisContract:
    """Attach multi-segment metadata to a synthesized contract.

    ``is_final`` may be given explicitly (Phase 1b streaming, where the total
    count is unknown until generation ends) or derived from ``segment_count``
    (Phase 1a, where the count is known up front)."""
    resolved_final = is_final if is_final is not None else (segment_index == (segment_count or 1) - 1)
    return replace(
        synthesis,
        utterance_id=utterance_id,
        segment_index=segment_index,
        segment_count=segment_count,
        is_final=resolved_final,
    )


def _dispatch_segmented_synthesis(
    segment_requests: list[SpeechSynthesisRequest],
    *,
    services: UserTurnServices,
    snapshot: Any,
    character_id: str,
    utterance_id: str,
    segment_count: int,
    start_index: int,
) -> None:
    """Synthesize the given segments in a single background thread, preserving
    order so speech-lifecycle events are appended by ascending segment_index."""

    def _worker() -> None:
        for offset, segment_request in enumerate(segment_requests):
            segment_index = start_index + offset
            synthesis = _stamp_segment_fields(
                _run_synthesis_request(segment_request, services=services),
                utterance_id=utterance_id,
                segment_index=segment_index,
                segment_count=segment_count,
            )
            _append_synthesis_event(
                synthesis,
                services=services,
                snapshot=snapshot,
                character_id=character_id,
            )

    threading.Thread(
        target=_worker,
        name=f"user-turn-synthesis:{snapshot.session_id}:{character_id}:{utterance_id}",
        daemon=True,
    ).start()


def _build_segment_request(
    text: str,
    *,
    locale: str,
    voice_profile: Any,
    lip_sync_preferences: Any,
) -> SpeechSynthesisRequest:
    """Per-segment synthesis request for the streaming path (Phase 1b).

    Unlike the batch path this omits the LLM voice-tone hint, which is only known
    once the full reply has been parsed — segments are dispatched before then."""
    voice_profile_payload = {
        "profile_id": voice_profile.profile_id,
        "provider": voice_profile.provider,
        "style": voice_profile.style,
        "notes": voice_profile.notes,
        **voice_profile.settings,
    }
    return SpeechSynthesisRequest(
        text=text,
        locale=locale,
        profile_id=TTS_BASELINE_PROFILE_IDS[0],
        voice_profile_id=voice_profile.profile_id or TTS_BASELINE_PROFILE_IDS[0],
        voice_profile=voice_profile_payload,
        preferred_lip_sync_track_id=lip_sync_preferences.preferred_track_id,
    )


def _new_utterance_id(snapshot: Any, character_id: str) -> str:
    return f"utterance:{snapshot.session_id}:{character_id}:{time.time_ns()}"


class _StreamingSegmentSink:
    """Synthesizes streamed segments in order on a single background thread, so
    audio for sentence N is produced while the LLM is still generating N+1."""

    def __init__(
        self,
        *,
        services: "UserTurnServices",
        snapshot: Any,
        character_id: str,
        utterance_id: str,
        build_request: Any,
    ) -> None:
        self._services = services
        self._snapshot = snapshot
        self._character_id = character_id
        self._utterance_id = utterance_id
        self._build_request = build_request
        self._queue: queue.Queue = queue.Queue()
        self._thread = threading.Thread(
            target=self._worker,
            name=f"user-turn-stream-synth:{snapshot.session_id}:{character_id}",
            daemon=True,
        )
        self._started = False
        self._index = 0

    @property
    def dispatched(self) -> bool:
        return self._started

    def push(self, text: str, *, is_final: bool) -> None:
        if not self._started:
            self._started = True
            self._thread.start()
        self._queue.put((self._index, text, is_final))
        self._index += 1

    def finish(self) -> None:
        if self._started:
            self._queue.put(None)

    def _worker(self) -> None:
        while True:
            item = self._queue.get()
            if item is None:
                break
            index, text, is_final = item
            try:
                synthesis = _stamp_segment_fields(
                    _run_synthesis_request(self._build_request(text), services=self._services),
                    utterance_id=self._utterance_id,
                    segment_index=index,
                    segment_count=None,
                    is_final=is_final,
                )
                _append_synthesis_event(
                    synthesis,
                    services=self._services,
                    snapshot=self._snapshot,
                    character_id=self._character_id,
                )
            except Exception:
                logger.exception("Streamed segment synthesis failed")


def _run_streamed_generation(
    request: TextGenerationRequest,
    *,
    services: "UserTurnServices",
    snapshot: Any,
    character_id: str,
    voice_profile: Any,
    lip_sync_preferences: Any,
    utterance_id: str,
    tuning: Any,
) -> tuple[AssistantMessageContract, bool]:
    """Consume the streamed reply, dispatching sentence segments to TTS as they
    complete. Returns the final contract and whether any segment was dispatched."""
    segmenter = StreamingSentenceSegmenter(
        min_chars=tuning.tts_segment_min_chars,
        max_chars=tuning.tts_segment_max_chars,
    )
    sink = _StreamingSegmentSink(
        services=services,
        snapshot=snapshot,
        character_id=character_id,
        utterance_id=utterance_id,
        build_request=lambda text: _build_segment_request(
            text,
            locale=request.locale,
            voice_profile=voice_profile,
            lip_sync_preferences=lip_sync_preferences,
        ),
    )

    final_contract: AssistantMessageContract | None = None
    for event in services.text_generation_service.generate_stream(request):
        if event.text_delta:
            for segment_text in segmenter.feed(event.text_delta):
                sink.push(segment_text, is_final=False)
        if event.contract is not None:
            final_contract = event.contract

    tail = segmenter.flush()
    for offset, segment_text in enumerate(tail):
        sink.push(segment_text, is_final=offset == len(tail) - 1)
    sink.finish()

    if final_contract is None:
        final_contract = AssistantMessageContract(
            profile_id=request.profile_id,
            status="error",
            text="Local text generation returned no reply.",
            locale=request.locale,
        )
    return final_contract, sink.dispatched


def _writebacks_to_dicts(assistant: AssistantMessageContract) -> tuple[dict[str, object], ...]:
    return tuple(
        {
            "namespace": writeback.namespace,
            "summary": writeback.summary,
            "salience": writeback.salience,
            "source": writeback.source,
            "tags": list(writeback.tags),
        }
        for writeback in assistant.memory_writebacks
    )


def _extract_memory_writebacks(
    text_generation_service: TextGenerationService,
    *,
    user_text: str,
    assistant_text: str,
    locale: str,
) -> tuple[dict[str, object], ...]:
    """Separate, off-critical-path LLM call to recover durable memory writebacks
    when the lean planner omitted them. Reuses the structured generate() parser
    (reply_text is a throwaway placeholder)."""
    prompt = "\n".join(
        [
            "Extract durable long-term memory writebacks from this exchange for a companion.",
            'Return exactly one JSON object: {"reply_text":"ok","memory_writebacks":'
            '[{"namespace":"persona|memory|appearance","summary":"string","salience":0.0,'
            '"source":"player|assistant|system","tags":["tag"]}]}',
            "Only durable facts, preferences, promises, plans, or emotional milestones. "
            "Use an empty array if nothing is durable.",
            f"User: {user_text}",
            f"Assistant: {assistant_text}",
        ]
    )
    try:
        contract = text_generation_service.generate(
            TextGenerationRequest(
                prompt=prompt,
                locale=locale,
                profile_id=LLM_BASELINE_PROFILE_IDS[0],
                expect_structured_output=True,
            )
        )
    except Exception:
        logger.exception("Async memory writeback extraction failed")
        return ()
    return _writebacks_to_dicts(contract)


def _dispatch_async_memory_store(
    *,
    services: "UserTurnServices",
    snapshot: Any,
    character_id: str,
    locale: str,
    user_text: str,
    assistant: AssistantMessageContract,
    extract_writebacks: bool,
) -> None:
    """Persist the turn's memory in a background thread (off the latency path),
    extracting durable writebacks via a separate LLM call when asked."""

    def _worker() -> None:
        try:
            writebacks: tuple[dict[str, object], ...] = ()
            if extract_writebacks and assistant.status == "ready":
                writebacks = _extract_memory_writebacks(
                    services.text_generation_service,
                    user_text=user_text,
                    assistant_text=assistant.text,
                    locale=locale,
                )
            services.memory_service.store_turn(
                persona_id=character_id,
                session_id=snapshot.session_id,
                locale=locale,
                user_text=user_text,
                assistant_text=assistant.text,
                assistant_status=assistant.status,
                memory_writebacks=writebacks,
                feeling_name=assistant.feeling.name if assistant.feeling is not None else None,
                voice_energy=assistant.voice_tone.energy if assistant.voice_tone is not None else None,
            )
        except Exception:
            logger.exception("Async memory store failed")

    threading.Thread(
        target=_worker,
        name=f"user-turn-memory:{snapshot.session_id}:{character_id}",
        daemon=True,
    ).start()


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