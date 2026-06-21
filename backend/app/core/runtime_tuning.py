"""Runtime performance tuning knobs (env-driven, safe defaults).

Phase 0 of the streaming performance plan (docs/STREAMING_PERFORMANCE_PLAN.md):
centralise the previously-hardcoded poll/wait intervals and startup warmup
toggles so they can be tuned per-deployment without code changes. Every value
has a conservative default and is read once at process start.

These are *operational* knobs, not part of any locked contract — tightening a
poll interval changes responsiveness, never payload shape.
"""

from __future__ import annotations

from dataclasses import dataclass
from functools import lru_cache
import os


# Defaults. The poll intervals are tightened from the historical hardcoded
# values (STT worker 0.35s, speech-lifecycle delivery 0.25s) because both poll
# cheap local sources (the STT sidecar /events endpoint and the in-memory event
# store) where a faster cadence shaves perceived latency at negligible cost.
_DEFAULT_STT_POLL_INTERVAL_SECONDS = 0.10
_DEFAULT_SPEECH_LIFECYCLE_POLL_INTERVAL_SECONDS = 0.10
_DEFAULT_WARM_LLM_ON_START = True
_DEFAULT_WARM_TTS_ON_START = True

# Floor for any poll interval so a misconfigured env var cannot spin a loop.
_MIN_POLL_INTERVAL_SECONDS = 0.01

_TRUTHY = frozenset({"1", "true", "yes", "on"})
_FALSY = frozenset({"0", "false", "no", "off"})


def _float_env(name: str, default: float, *, minimum: float) -> float:
    raw_value = os.environ.get(name)
    if raw_value is None or not raw_value.strip():
        return default
    try:
        value = float(raw_value)
    except ValueError:
        return default
    return value if value >= minimum else minimum


def _bool_env(name: str, default: bool) -> bool:
    raw_value = os.environ.get(name)
    if raw_value is None or not raw_value.strip():
        return default
    normalized = raw_value.strip().lower()
    if normalized in _TRUTHY:
        return True
    if normalized in _FALSY:
        return False
    return default


def _int_env(name: str, default: int, *, minimum: int) -> int:
    raw_value = os.environ.get(name)
    if raw_value is None or not raw_value.strip():
        return default
    try:
        value = int(raw_value)
    except ValueError:
        return default
    return value if value >= minimum else minimum


# Phase 1a TTS sentence-segmentation defaults. Segmentation is OFF by default
# so the backend change can land and be tested before the frontend learns to
# play ordered multi-segment utterances; enable with NIKOF_TTS_SEGMENTATION=1.
# A segment is flushed at a sentence boundary once it reaches min chars, or
# force-flushed at max chars to bound first-segment latency.
_DEFAULT_TTS_SEGMENTATION_ENABLED = False
_DEFAULT_TTS_SEGMENT_MIN_CHARS = 12
_DEFAULT_TTS_SEGMENT_MAX_CHARS = 240


@dataclass(slots=True, frozen=True)
class RuntimeTuning:
    """Resolved runtime tuning values for the current process."""

    stt_poll_interval_seconds: float
    speech_lifecycle_poll_interval_seconds: float
    warm_llm_on_start: bool
    warm_tts_on_start: bool
    tts_segmentation_enabled: bool
    tts_segment_min_chars: int
    tts_segment_max_chars: int


@lru_cache(maxsize=1)
def get_runtime_tuning() -> RuntimeTuning:
    """Resolve runtime tuning from the environment (cached for the process)."""
    return RuntimeTuning(
        stt_poll_interval_seconds=_float_env(
            "NIKOF_STT_POLL_INTERVAL_SECONDS",
            _DEFAULT_STT_POLL_INTERVAL_SECONDS,
            minimum=_MIN_POLL_INTERVAL_SECONDS,
        ),
        speech_lifecycle_poll_interval_seconds=_float_env(
            "NIKOF_SPEECH_LIFECYCLE_POLL_INTERVAL_SECONDS",
            _DEFAULT_SPEECH_LIFECYCLE_POLL_INTERVAL_SECONDS,
            minimum=_MIN_POLL_INTERVAL_SECONDS,
        ),
        warm_llm_on_start=_bool_env("NIKOF_WARM_LLM_ON_START", _DEFAULT_WARM_LLM_ON_START),
        warm_tts_on_start=_bool_env("NIKOF_WARM_TTS_ON_START", _DEFAULT_WARM_TTS_ON_START),
        tts_segmentation_enabled=_bool_env(
            "NIKOF_TTS_SEGMENTATION", _DEFAULT_TTS_SEGMENTATION_ENABLED
        ),
        tts_segment_min_chars=_int_env(
            "NIKOF_TTS_SEGMENT_MIN_CHARS", _DEFAULT_TTS_SEGMENT_MIN_CHARS, minimum=1
        ),
        tts_segment_max_chars=_int_env(
            "NIKOF_TTS_SEGMENT_MAX_CHARS", _DEFAULT_TTS_SEGMENT_MAX_CHARS, minimum=1
        ),
    )
