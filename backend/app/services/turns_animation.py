"""Assistant-reply animation cue resolution (extracted from turns.py).

Maps the LLM reply's animation_cues / feeling / text onto a semantic animation
id — via an alias table plus keyword-priority rules — and builds the
SessionAnimation snapshot through the AnimationService, plus the shared
"thinking" wait animation. Re-exported builders are used by the turn pipeline.
"""

from __future__ import annotations

import time
from dataclasses import dataclass
from typing import Any

from app.schemas.animation import AnimationIntent, SessionAnimationSnapshot
from app.schemas.session import AssistantAnimationCueContract, AssistantMessageContract
from app.services.animation import AnimationService


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


def _match_keyword_rule(haystack: str) -> _AnimationCueKeywordRule | None:
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


def _resolve_animation_keyword_rule(assistant: AssistantMessageContract) -> _AnimationCueKeywordRule | None:
    # The bare feeling label is deliberately NOT part of the haystack: the
    # frontend already maps feeling -> resting idle (resolveMoodDrivenIdleCommand),
    # so folding it in here made a steady mood (e.g. the LLM reporting "excited"
    # every turn) fire a one-shot emote gesture on every single reply. Gestures
    # must come from an explicit cue or an action word in the reply/request.
    cue_text = assistant.animation_cues[0].cue if assistant.animation_cues else ""
    haystack = " ".join(
        segment.strip().lower()
        for segment in (cue_text, assistant.thinking_summary or "", assistant.text)
        if segment and segment.strip()
    )
    return _match_keyword_rule(haystack)


def _resolve_assistant_animation_choice(
    assistant: AssistantMessageContract,
    *,
    user_text: str | None = None,
) -> tuple[str, str, float | None, int | None, str] | None:
    cue = assistant.animation_cues[0] if assistant.animation_cues else None

    if cue is not None and "." in cue.cue.strip().lower():
        return cue.cue.strip().lower(), cue.layer, cue.intensity, cue.duration_ms, "explicit_semantic"

    # Prefer a gesture inferred from the assistant's own reply/cue/feeling; only
    # fall back to the user's request when the reply itself implies no gesture,
    # so the assistant's more specific intent (e.g. a small wave) still wins.
    keyword_rule = _resolve_animation_keyword_rule(assistant)
    cue_source = "keyword_priority"
    if keyword_rule is None and user_text:
        keyword_rule = _match_keyword_rule(user_text.strip().lower())
        cue_source = "user_request"
    if keyword_rule is not None:
        return (
            keyword_rule.semantic_id,
            keyword_rule.layer,
            cue.intensity if cue is not None else assistant.feeling.intensity if assistant.feeling is not None else None,
            cue.duration_ms if cue is not None and cue.duration_ms is not None else keyword_rule.default_duration_ms,
            cue_source,
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
    user_text: str | None = None,
) -> SessionAnimationSnapshot | None:
    if assistant.status != "ready":
        return None

    resolved_animation_choice = _resolve_assistant_animation_choice(assistant, user_text=user_text)
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
