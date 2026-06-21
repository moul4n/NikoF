"""Structured-output parsing for LLM replies (extracted from llm.py).

Turns raw model text into an AssistantMessageContract: lenient JSON-object
extraction (handles fenced or embedded JSON) plus field normalization. Pure
aside from the shared contracts it imports; llm.py re-exports these for its
Ollama adapter.
"""

from __future__ import annotations

import json
import re
from typing import Any

from app.schemas.session import (
    AssistantAnimationCueContract,
    AssistantFeelingContract,
    AssistantMemoryWriteContract,
    AssistantMessageContract,
    AssistantVoiceToneContract,
)
from app.services.llm_contracts import TextGenerationInvocationError, TextGenerationRequest


def _normalize_contract_status(raw_status: Any, *, has_reply_text: bool) -> str:
    normalized = str(raw_status or "").strip().lower()
    if normalized in {"unavailable", "missing", "not_configured"}:
        return "unavailable"

    if normalized in {"degraded"}:
        return "degraded"

    if normalized in {"error", "failed"}:
        return "error"

    if normalized in {"ready", "ok", "success", "completed"}:
        return "ready" if has_reply_text else "error"

    return "ready" if has_reply_text else "error"
def _extract_json_object(raw_text: str) -> dict[str, Any] | None:
    stripped = raw_text.strip()
    if not stripped:
        return None

    candidates = [stripped]
    fenced_match = re.search(r"```(?:json)?\s*(\{.*\})\s*```", stripped, re.DOTALL)
    if fenced_match is not None:
        candidates.insert(0, fenced_match.group(1).strip())

    start_index = stripped.find("{")
    if start_index >= 0:
        depth = 0
        in_string = False
        escaped = False
        for index in range(start_index, len(stripped)):
            character = stripped[index]
            if in_string:
                if escaped:
                    escaped = False
                elif character == "\\":
                    escaped = True
                elif character == '"':
                    in_string = False
                continue

            if character == '"':
                in_string = True
            elif character == "{":
                depth += 1
            elif character == "}":
                depth -= 1
                if depth == 0:
                    candidates.append(stripped[start_index : index + 1])
                    break

    for candidate in candidates:
        try:
            decoded = json.loads(candidate)
        except json.JSONDecodeError:
            continue
        if isinstance(decoded, dict):
            return decoded

    return None


def _coerce_optional_text(raw_value: Any) -> str | None:
    if raw_value is None:
        return None
    normalized = str(raw_value).strip()
    return normalized or None


def _coerce_optional_float(raw_value: Any) -> float | None:
    try:
        return float(raw_value)
    except (TypeError, ValueError):
        return None


def _normalize_structured_contract(
    request: TextGenerationRequest,
    payload: dict[str, Any],
) -> AssistantMessageContract:
    reply_text = _coerce_optional_text(payload.get("reply_text") or payload.get("text"))
    if reply_text is None:
        raise TextGenerationInvocationError("invalid-structured-response")

    feeling_payload = payload.get("feeling") if isinstance(payload.get("feeling"), dict) else None
    feeling = None
    if feeling_payload is not None:
        feeling_name = _coerce_optional_text(feeling_payload.get("name") or feeling_payload.get("label"))
        if feeling_name is not None:
            feeling = AssistantFeelingContract(
                name=feeling_name,
                intensity=_coerce_optional_float(feeling_payload.get("intensity")),
            )

    voice_payload = payload.get("voice_tone") if isinstance(payload.get("voice_tone"), dict) else None
    voice_tone = None
    if voice_payload is not None:
        voice_tone = AssistantVoiceToneContract(
            style=_coerce_optional_text(voice_payload.get("style")),
            pace=_coerce_optional_text(voice_payload.get("pace")),
            energy=_coerce_optional_float(voice_payload.get("energy")),
        )

    animation_cues: list[AssistantAnimationCueContract] = []
    raw_animation_cues = payload.get("animation_cues")
    if isinstance(raw_animation_cues, list):
        for raw_cue in raw_animation_cues:
            if not isinstance(raw_cue, dict):
                continue
            cue = _coerce_optional_text(raw_cue.get("cue") or raw_cue.get("name"))
            if cue is None:
                continue
            duration_ms = raw_cue.get("duration_ms")
            animation_cues.append(
                AssistantAnimationCueContract(
                    cue=cue,
                    layer=_coerce_optional_text(raw_cue.get("layer")) or "face",
                    intensity=_coerce_optional_float(raw_cue.get("intensity") or raw_cue.get("weight")),
                    duration_ms=int(duration_ms) if isinstance(duration_ms, (int, float)) else None,
                )
            )

    memory_writebacks: list[AssistantMemoryWriteContract] = []
    raw_writebacks = payload.get("memory_writebacks")
    if isinstance(raw_writebacks, list):
        for raw_writeback in raw_writebacks:
            if not isinstance(raw_writeback, dict):
                continue
            summary = _coerce_optional_text(raw_writeback.get("summary"))
            if summary is None:
                continue
            namespace = _coerce_optional_text(raw_writeback.get("namespace")) or "memory"
            raw_tags = raw_writeback.get("tags") if isinstance(raw_writeback.get("tags"), list) else []
            memory_writebacks.append(
                AssistantMemoryWriteContract(
                    namespace=namespace.lower(),
                    summary=summary,
                    salience=_coerce_optional_float(raw_writeback.get("salience")),
                    source=_coerce_optional_text(raw_writeback.get("source")),
                    tags=tuple(str(tag).strip().lower() for tag in raw_tags if str(tag).strip()),
                )
            )

    return AssistantMessageContract(
        profile_id=request.profile_id,
        status="ready",
        text=reply_text,
        locale=request.locale,
        thinking_summary=_coerce_optional_text(payload.get("thinking_summary")),
        feeling=feeling,
        voice_tone=voice_tone,
        animation_cues=tuple(animation_cues),
        memory_writebacks=tuple(memory_writebacks),
    )
