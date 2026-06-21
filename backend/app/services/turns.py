from __future__ import annotations

from dataclasses import dataclass, replace
import logging
import queue
import threading
import time
from typing import Any

from app.api.response_builders import derive_operator_command_status
from app.core.runtime_tuning import get_runtime_tuning
from app.schemas.animation import AnimationIntent, SessionAnimationSnapshot
from app.schemas.session import (
    AssistantAnimationCueContract,
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
from app.services.text_segmentation import StreamingSentenceSegmenter, iter_sentence_segments
from app.services.turn_telemetry import get_turn_telemetry


logger = logging.getLogger(__name__)


_ANIMATION_CUE_ALIAS_TO_SEMANTIC_ID = {
    "angry": "emote.angry.once",
    "applaud": "gesture.clap.once",
    "applause": "gesture.clap.once",
    "clap": "gesture.clap.once",
    "clapping": "gesture.clap.once",
    "confident": "idle.confident",
    "dance": "dance.hiphop.loop",
    "excited": "emote.excited.once",
    "greet": "greet.wave.once",
    "greeting": "greet.wave.once",
    "happy": "idle.happy",
    "happy_alt": "emote.happy.alt.once",
    "hello": "greet.wave.once",
    "idle_confident": "idle.confident",
    "idle_happy": "idle.happy",
    "idle_sad": "idle.sad",
    "neutral": "idle.neutral",
    "reject": "emote.reject.once",
    "reply_speaking": "reply.speaking.loop",
    "sad": "idle.sad",
    "small_wave": "greet.wave.small.once",
    "smile": "idle.happy",
    "surprise": "emote.surprised.once",
    "subtle_wink": "idle.happy",
    "surprised": "emote.surprised.once",
    "wave": "greet.wave.once",
    "wink": "idle.happy",
}


@dataclass(slots=True, frozen=True)
class _AnimationCueKeywordRule:
    semantic_id: str
    keywords: tuple[str, ...]
    layer: str
    priority: int
    default_duration_ms: int | None = None


_ANIMATION_CUE_KEYWORD_RULES: tuple[_AnimationCueKeywordRule, ...] = (
    _AnimationCueKeywordRule(
        semantic_id="greet.wave.small.once",
        keywords=("small wave", "little wave", "brief wave", "quick wave", "tiny wave"),
        layer="upper",
        priority=120,
        default_duration_ms=5100,
    ),
    _AnimationCueKeywordRule(
        semantic_id="greet.wave.once",
        keywords=("wave", "waving", "hello", "greet", "greeting"),
        layer="upper",
        priority=110,
        default_duration_ms=533,
    ),
    _AnimationCueKeywordRule(
        semantic_id="gesture.clap.once",
        keywords=("clap", "clapping", "applaud", "applause"),
        layer="upper",
        priority=105,
        default_duration_ms=1167,
    ),
    _AnimationCueKeywordRule(
        semantic_id="dance.hiphop.loop",
        keywords=("dance", "dancing", "hip hop", "groove"),
        layer="base",
        priority=100,
        default_duration_ms=5200,
    ),
    _AnimationCueKeywordRule(
        semantic_id="emote.excited.once",
        keywords=("excited", "thrilled", "hyped", "energetic", "pumped"),
        layer="base",
        priority=78,
        default_duration_ms=6567,
    ),
    _AnimationCueKeywordRule(
        semantic_id="emote.surprised.once",
        keywords=("surprised", "surprise", "shocked", "astonished", "wow"),
        layer="base",
        priority=92,
        default_duration_ms=4000,
    ),
    _AnimationCueKeywordRule(
        semantic_id="emote.angry.once",
        keywords=("angry", "mad", "annoyed", "frustrated"),
        layer="base",
        priority=90,
        default_duration_ms=19167,
    ),
    _AnimationCueKeywordRule(
        semantic_id="emote.reject.once",
        keywords=("reject", "refuse", "decline", "dismiss", "no way"),
        layer="upper",
        priority=88,
        default_duration_ms=4800,
    ),
    _AnimationCueKeywordRule(
        semantic_id="emote.happy.alt.once",
        keywords=("delighted", "beaming", "grinning", "radiant"),
        layer="base",
        priority=67,
        default_duration_ms=10000,
    ),
    _AnimationCueKeywordRule(
        semantic_id="idle.confident",
        keywords=("confident", "assured", "poised", "self assured", "hand on hip"),
        layer="base",
        priority=92,
        default_duration_ms=33,
    ),
    _AnimationCueKeywordRule(
        semantic_id="idle.happy",
        keywords=("happy", "joyful", "cheerful", "warm", "friendly", "gentle", "smile", "smiling", "relaxed"),
        layer="base",
        priority=90,
        default_duration_ms=2000,
    ),
    _AnimationCueKeywordRule(
        semantic_id="idle.sad",
        keywords=("sad", "sorry", "somber", "melancholy", "downcast"),
        layer="base",
        priority=88,
        default_duration_ms=2800,
    ),
    _AnimationCueKeywordRule(
        semantic_id="emote.happy.once",
        keywords=("celebrate", "celebrating", "cheer", "cheering", "victory", "big smile"),
        layer="base",
        priority=64,
        default_duration_ms=10000,
    ),
)


def _normalize_animation_semantic_id(cue: AssistantAnimationCueContract) -> str:
    cue_name = cue.cue.strip().lower().replace("-", "_").replace(" ", "_")
    if "." in cue_name:
        return cue_name
    return _ANIMATION_CUE_ALIAS_TO_SEMANTIC_ID.get(cue_name, cue_name)


def _resolve_animation_keyword_rule(assistant: AssistantMessageContract) -> _AnimationCueKeywordRule | None:
    cue_text = assistant.animation_cues[0].cue if assistant.animation_cues else ""
    feeling_name = assistant.feeling.name if assistant.feeling is not None else ""
    haystack = " ".join(
        segment.strip().lower()
        for segment in (cue_text, assistant.thinking_summary or "", assistant.text, feeling_name)
        if segment and segment.strip()
    )

    best_rule: _AnimationCueKeywordRule | None = None
    best_score = -1

    for rule in _ANIMATION_CUE_KEYWORD_RULES:
        match_count = sum(1 for keyword in rule.keywords if keyword in haystack)
        if match_count == 0:
            continue

        longest_keyword = max(len(keyword) for keyword in rule.keywords if keyword in haystack)
        score = rule.priority + match_count * 10 + longest_keyword

        if score > best_score:
            best_rule = rule
            best_score = score

    return best_rule


def _resolve_assistant_animation_choice(
    assistant: AssistantMessageContract,
) -> tuple[str, str, float | None, int | None, str] | None:
    cue = assistant.animation_cues[0] if assistant.animation_cues else None

    if cue is not None and "." in cue.cue.strip().lower():
        return cue.cue.strip().lower(), cue.layer, cue.intensity, cue.duration_ms, "explicit_semantic"

    keyword_rule = _resolve_animation_keyword_rule(assistant)
    if keyword_rule is not None:
        return (
            keyword_rule.semantic_id,
            keyword_rule.layer,
            cue.intensity if cue is not None else assistant.feeling.intensity if assistant.feeling is not None else None,
            cue.duration_ms if cue is not None and cue.duration_ms is not None else keyword_rule.default_duration_ms,
            "keyword_priority",
        )

    if cue is None:
        return None

    return _normalize_animation_semantic_id(cue), cue.layer, cue.intensity, cue.duration_ms, "alias"


def _build_assistant_animation_snapshot(
    assistant: AssistantMessageContract,
    *,
    snapshot: Any,
    character_id: str,
    animation_service: AnimationService,
) -> SessionAnimationSnapshot | None:
    if assistant.status != "ready":
        return None

    resolved_animation_choice = _resolve_assistant_animation_choice(assistant)
    if resolved_animation_choice is None:
        return None

    cue = assistant.animation_cues[0] if assistant.animation_cues else None
    semantic_id, layer, intensity, duration_ms, cue_source = resolved_animation_choice
    requested_state = "replace" if layer == "base" or semantic_id.startswith("idle.") else "enqueue"
    command = animation_service.resolve_intent(
        AnimationIntent(
            intent_id=f"assistant-cue:{snapshot.session_id}:{character_id}:{time.time_ns()}",
            session_id=snapshot.session_id,
            character_id=character_id,
            intent_type="gesture",
            semantic_id=semantic_id,
            source="assistant_turn",
            requested_state=requested_state,
            intensity=intensity,
            parameters={
                "assistant_cue": cue.cue if cue is not None else semantic_id,
                "assistant_cue_source": cue_source,
                "assistant_layer": layer,
                "duration_ms": "" if duration_ms is None else str(duration_ms),
            },
            reason="Structured assistant animation cue.",
        )
    )
    return SessionAnimationSnapshot(
        session_id=snapshot.session_id,
        lifecycle_state=snapshot.lifecycle_state,
        active_character_id=character_id,
        command=command,
    )


def _build_llm_thinking_animation_snapshot(
    *,
    snapshot: Any,
    character_id: str,
    animation_service: AnimationService,
) -> SessionAnimationSnapshot:
    command = animation_service.resolve_intent(
        AnimationIntent(
            intent_id=f"assistant-thinking:{snapshot.session_id}:{character_id}:{time.time_ns()}",
            session_id=snapshot.session_id,
            character_id=character_id,
            intent_type="gesture",
            semantic_id="think.considering.once",
            source="assistant_turn",
            requested_state="enqueue",
            parameters={
                "assistant_phase": "llm_wait",
            },
            reason="Backend triggered the shared thinking animation while waiting for the LLM response.",
        )
    )
    return SessionAnimationSnapshot(
        session_id=snapshot.session_id,
        lifecycle_state=snapshot.lifecycle_state,
        active_character_id=character_id,
        command=command,
    )


def _build_lean_reply_prompt(
    text: str,
    *,
    character_id: str,
    voice_profile: Any,
    memory_context: CompanionMemoryContext | None = None,
) -> str:
    """Slim planner prompt (Phase: LLM latency). Requests only reply_text +
    feeling + a single animation cue, dropping thinking_summary / voice_tone /
    memory_writebacks and the verbose guidance to cut generation tokens."""
    lines = [
        "You are a companion. Return exactly one JSON object and nothing else.",
        'Schema: {"reply_text":"string","feeling":{"name":"string","intensity":0.0},"animation_cues":[{"cue":"string"}]}',
        "reply_text: concise and natural aloud, one to three short sentences.",
        "feeling.name: one mood word. animation_cues[].cue: one id like idle.neutral, idle.happy, "
        "greet.wave.once, emote.excited.once (omit the array if none fits).",
    ]
    if memory_context is not None:
        persona = memory_context.persona
        if persona.display_name:
            lines.append(f"You are {persona.display_name}.")
        if persona.speech_style:
            lines.append(f"Speech style: {persona.speech_style}.")
        if persona.core_traits:
            lines.append(f"Traits: {'; '.join(persona.core_traits)}.")
        lines.append(
            f"Mood: {memory_context.demeanor.mood}, energy {memory_context.demeanor.energy_level:.2f}."
        )
        retrieved = [f"- {entry.summary}" for entry in memory_context.retrieved_memories]
        if retrieved:
            lines.append("Relevant memory:")
            lines.extend(retrieved)
    if getattr(voice_profile, "style", None):
        lines.append(f"Delivery style: {voice_profile.style}.")
    lines.extend(["User message:", text])
    return "\n".join(lines)


def _build_spoken_reply_prompt(
    text: str,
    *,
    character_id: str,
    voice_profile: Any,
    memory_context: CompanionMemoryContext | None = None,
    input_source: str = "manual_text",
    lean: bool = False,
) -> str:
    if lean:
        return _build_lean_reply_prompt(
            text,
            character_id=character_id,
            voice_profile=voice_profile,
            memory_context=memory_context,
        )
    persona_lines = [f"persona_id: {character_id}"]
    if memory_context is not None:
        persona_lines = [
            f"persona_id: {memory_context.persona.persona_id}",
            f"display_name: {memory_context.persona.display_name}",
        ]
        if memory_context.persona.speech_style:
            persona_lines.append(f"speech_style: {memory_context.persona.speech_style}")
        if memory_context.persona.core_traits:
            persona_lines.append(f"core_traits: {'; '.join(memory_context.persona.core_traits)}")
        if memory_context.persona.moral_constraints:
            persona_lines.append(f"moral_constraints: {'; '.join(memory_context.persona.moral_constraints)}")
        if memory_context.persona.long_term_goals:
            persona_lines.append(f"long_term_goals: {'; '.join(memory_context.persona.long_term_goals)}")
        persona_lines.append(f"memory_policy: {memory_context.persona.memory_policy}")
        persona_lines.append(f"privacy_policy: {memory_context.persona.privacy_policy}")

    demeanor_lines: list[str] = []
    if memory_context is not None:
        demeanor_lines.extend(
            [
                f"mood: {memory_context.demeanor.mood}",
                f"energy_level: {memory_context.demeanor.energy_level:.2f}",
                f"conversation_mode: {memory_context.demeanor.conversation_mode}",
            ]
        )

    retrieved_lines = [
        f"- [{entry.source}] {entry.summary} (salience={entry.salience:.2f}, at={entry.created_at})"
        for entry in (memory_context.retrieved_memories if memory_context is not None else ())
    ]
    recent_lines = [
        f"- [{entry.source}] {entry.summary}"
        for entry in (memory_context.recent_memories if memory_context is not None else ())
    ]

    prompt_lines = [
        "You are the local companion response planner for a backend-owned turn pipeline.",
        "Return exactly one JSON object and nothing else.",
        "The JSON object must contain these fields:",
        '{"reply_text":"string","thinking_summary":"string","feeling":{"name":"string","intensity":0.0},"voice_tone":{"style":"string","pace":"string","energy":0.0},"animation_cues":[{"cue":"string","layer":"base|upper|face","intensity":0.0,"duration_ms":0}],"memory_writebacks":[{"namespace":"persona|memory|appearance","summary":"string","salience":0.0,"source":"player|assistant|system","tags":["tag"]}]}',
        "reply_text must be concise, natural aloud, and easy to synthesize in one to three short sentences.",
        "thinking_summary must be a brief user-visible planning note, not hidden chain-of-thought.",
        "For animation_cues[].cue, prefer semantic ids or close aliases that map onto known shared animations such as idle.neutral, idle.happy, idle.sad, idle.confident, greet.wave.once, greet.wave.small.once, gesture.clap.once, emote.happy.once, emote.happy.alt.once, emote.excited.once, emote.reject.once, emote.surprised.once, emote.angry.once, dance.hiphop.loop, or reply.speaking.loop.",
        "Prefer calm idle.* semantics before stronger one-shot emotes when the reply only needs emotional color; reserve bigger emotes for clearly emphatic wording or explicit semantic ids.",
        "When multiple animation words fit, choose the single best cue from the reply, feeling, and thinking_summary; words such as wave, small wave, clap, smile, happy, sad, confident, excited, surprised, angry, reject, greeting, hello, or dance are all valid guidance.",
        "memory_writebacks should only include durable facts, promises, preferences, plans, emotional milestones, or explicit appearance notes.",
        "Never store raw images, raw screenshots, meshes, or transient outfit details unless they are explicitly memorable.",
        f"Active character id: {character_id}.",
        f"Input source: {input_source}.",
        "[PERSONA]",
        *persona_lines,
    ]
    if getattr(voice_profile, "style", None):
        prompt_lines.append(f"Preferred delivery style: {voice_profile.style}.")
    if getattr(voice_profile, "notes", None):
        prompt_lines.append(f"Voice notes: {voice_profile.notes}")
    if demeanor_lines:
        prompt_lines.extend(["[DEMEANOR]", *demeanor_lines])
    if retrieved_lines:
        prompt_lines.extend(["[RETRIEVED_MEMORY]", *retrieved_lines])
    if recent_lines:
        prompt_lines.extend(["[RECENT_BUFFER]", *recent_lines])
    if memory_context is not None and memory_context.active_appearance is not None:
        prompt_lines.extend(
            [
                "[ACTIVE_APPEARANCE]",
                f"summary: {memory_context.active_appearance.summary}",
            ]
        )
    prompt_lines.extend(
        [
            "[CURRENT_INPUT]",
            "User message:",
            text,
        ]
    )
    return "\n".join(prompt_lines)


def _should_include_appearance_context(text: str) -> bool:
    normalized = text.lower()
    return any(token in normalized for token in ("appearance", "dress", "hair", "look", "outfit", "style", "wear"))


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
    return services.session_service.event_store.append(
        SPEECH_LIFECYCLE_STREAM,
        services.session_event_factory.build_event(
            snapshot,
            character_id=character_id,
            event_type="speech.synthesis",
            status=synthesis.status,
            synthesis=synthesis,
        ),
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
        try:
            services.memory_service.store_turn(
                persona_id=active_character.character_id,
                session_id=snapshot.session_id,
                locale=request.locale,
                user_text=turn_input_text,
                assistant_text=assistant.text,
                assistant_status=assistant.status,
                memory_writebacks=tuple(
                    {
                        "namespace": writeback.namespace,
                        "summary": writeback.summary,
                        "salience": writeback.salience,
                        "source": writeback.source,
                        "tags": list(writeback.tags),
                    }
                    for writeback in assistant.memory_writebacks
                ),
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