"""Companion reply-planner prompt builders (extracted from turns.py).

Pure string construction of the LLM planner prompt — the full planner and the
lean variant — from the user text, character id, voice profile, and memory
context. No turn state, services, or I/O. Re-exported from turns.py so callers
and tests keep importing them from app.services.turns.
"""

from __future__ import annotations

from typing import Any

from app.services.companion_memory import CompanionMemoryContext


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
        "feeling.name: one mood word.",
        "animation_cues[].cue: a single animation id from this set — idle.neutral, idle.happy, "
        "idle.sad, idle.confident, greet.wave.once, gesture.clap.once, dance.hiphop.loop, "
        "emote.happy.once, emote.excited.once, emote.surprised.once, emote.angry.once.",
        "If the user asks you to perform a gesture (wave, clap, dance, etc.), you MUST include the "
        "matching cue; otherwise pick one that fits the mood, or omit the array if none fits.",
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
