from __future__ import annotations

from dataclasses import dataclass
import time
from typing import Any

from app.api.response_builders import derive_operator_command_status
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


def _build_spoken_reply_prompt(
    text: str,
    *,
    character_id: str,
    voice_profile: Any,
    memory_context: CompanionMemoryContext | None = None,
    input_source: str = "manual_text",
) -> str:
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
    memory_context = None
    if services.memory_service is not None:
        services.memory_service.ensure_persona_core(
            persona_id=active_character.character_id,
            display_name=active_character.display_name,
            speech_style=voice_profile.style,
        )
        memory_context = services.memory_service.get_prompt_context(
            persona_id=active_character.character_id,
            query_text=request.text,
            include_appearance_context=_should_include_appearance_context(request.text),
        )

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
                memory_context=memory_context,
                input_source="stt" if request.transcription is not None else "manual_text",
            ),
            locale=request.locale,
            profile_id=LLM_BASELINE_PROFILE_IDS[0],
            expect_structured_output=True,
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
        synthesis = services.synthesis_service.synthesize(
            SpeechSynthesisRequest(
                text=assistant.text,
                locale=request.locale,
                profile_id=TTS_BASELINE_PROFILE_IDS[0],
                voice_profile_id=voice_profile.profile_id or TTS_BASELINE_PROFILE_IDS[0],
                voice_profile=voice_profile_payload,
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

    if services.animation_service is not None and services.session_animation_live_delivery is not None:
        animation_snapshot = _build_assistant_animation_snapshot(
            assistant,
            snapshot=snapshot,
            character_id=active_character.character_id,
            animation_service=services.animation_service,
        )
        if animation_snapshot is not None:
            services.session_animation_live_delivery.publish_snapshot(animation_snapshot)

    if services.memory_service is not None:
        services.memory_service.store_turn(
            persona_id=active_character.character_id,
            session_id=snapshot.session_id,
            locale=request.locale,
            user_text=request.text,
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