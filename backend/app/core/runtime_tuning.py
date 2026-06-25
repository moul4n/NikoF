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

# Phase 3: selectable STT recognizer. "faster-whisper" (default) keeps the
# current sidecar engine; "parakeet" selects the NVIDIA Parakeet TDT 0.6B v2
# ONNX engine. Faster-Whisper stays the default until the WER A/B gate passes.
_DEFAULT_STT_ENGINE = "faster-whisper"

# Phase 3 Increment 4: emit interim transcript.partial events while the user is
# still speaking so the frontend can show live captions. Display-only — the LLM
# turn still fires on the confirmed final. Off by default (adds repeated decode
# work during speech); enable with NIKOF_STT_PARTIALS=1.
_DEFAULT_STT_PARTIALS_ENABLED = False

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


def _str_env(name: str, default: str, *, choices: frozenset[str] | None = None) -> str:
    raw_value = os.environ.get(name)
    if raw_value is None or not raw_value.strip():
        return default
    value = raw_value.strip().lower()
    if choices is not None and value not in choices:
        return default
    return value


def _raw_str_env(name: str, default: str) -> str:
    """Like _str_env but case-preserving (no lowercasing, no choices). For
    free-form values such as an IANA timezone ("Europe/London") or a location
    label ("Brighton, UK") where casing is significant."""
    raw_value = os.environ.get(name)
    if raw_value is None or not raw_value.strip():
        return default
    return raw_value.strip()


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

# Phase 1b: stream the LLM reply so the first sentence dispatches to TTS before
# generation finishes. OFF by default and only effective when segmentation is
# also enabled. Requires a text-generation service that supports generate_stream.
_DEFAULT_LLM_STREAMING_ENABLED = False

# Lean planner: request a slim JSON planner (reply_text + feeling + animation
# cue only — drop thinking_summary, voice_tone, memory_writebacks and the verbose
# guidance) to cut generation tokens/latency. Off by default (full planner).
_DEFAULT_LLM_LEAN_PLANNER = False

# When the lean planner is on (no memory_writebacks in the reply), recover
# durable memory by extracting writebacks in a background thread via a separate
# LLM call — off the turn's latency path. Default on.
_DEFAULT_LLM_ASYNC_MEMORY = True

# Memory/context architecture Stage 1 (docs/MEMORY_ARCHITECTURE.md): make the
# Ollama context window explicit instead of relying on the small provider default
# (historically 2048/4096), which silently front-truncates a growing prompt.
# num_ctx is the KV-cache size (context-size vs VRAM trade-off); num_predict caps
# generated tokens (0 = use the model default / unbounded). The memory token
# budget trims retrieved memory by estimated tokens, highest-scored first, so the
# injected prompt stays bounded as recall breadth grows.
_DEFAULT_LLM_NUM_CTX = 8192
_DEFAULT_LLM_NUM_PREDICT = 0
_DEFAULT_MEMORY_PROMPT_TOKEN_BUDGET = 1024

# Memory/context architecture Stage 3 (docs/MEMORY_ARCHITECTURE.md): the idle
# consolidation worker. OFF by default — it mutates the memory DB (merges
# duplicate facts, rolls old raw dialog turns into episodic summaries) and uses
# the idle LLM, so it is opt-in like the other behaviour-changing levers. It only
# acts when the LLM has been idle for `idle_seconds` (no live turn competing).
# keep_recent dialog turns stay verbatim; a rollup runs once at least `min_batch`
# older turns have accumulated, summarizing up to `max_batch` of them per pass.
_DEFAULT_MEMORY_CONSOLIDATION_ENABLED = False
_DEFAULT_MEMORY_CONSOLIDATION_IDLE_SECONDS = 20.0
_DEFAULT_MEMORY_ROLLUP_KEEP_RECENT = 40
_DEFAULT_MEMORY_ROLLUP_MIN_BATCH = 20
_DEFAULT_MEMORY_ROLLUP_MAX_BATCH = 40

# Live-info Stage A (docs/LIVE_INFO_TOOLS.md): an advisory "[AMBIENT]" block of
# cheap *local* facts (current local time, date, day-type, configured location)
# injected into the planner prompt every turn so the companion is always aware of
# "now" without a tool call or any network access. OFF by default like every
# other behaviour-changing lever; enable with NIKOF_AMBIENT_CONTEXT=1. The block
# is intentionally tiny (a few short lines) so it needs no runtime token budget.
# Timezone is an optional IANA name override (empty = system local time);
# location is an optional free-text label (empty = omitted, no geocoding here).
_DEFAULT_AMBIENT_CONTEXT_ENABLED = False
_DEFAULT_AMBIENT_TIMEZONE = ""
_DEFAULT_AMBIENT_LOCATION = ""


@dataclass(slots=True, frozen=True)
class RuntimeTuning:
    """Resolved runtime tuning values for the current process."""

    stt_poll_interval_seconds: float
    stt_engine: str
    stt_partials_enabled: bool
    speech_lifecycle_poll_interval_seconds: float
    warm_llm_on_start: bool
    warm_tts_on_start: bool
    tts_segmentation_enabled: bool
    tts_segment_min_chars: int
    tts_segment_max_chars: int
    llm_streaming_enabled: bool
    llm_lean_planner: bool
    llm_async_memory: bool
    llm_num_ctx: int
    llm_num_predict: int
    memory_prompt_token_budget: int
    memory_consolidation_enabled: bool
    memory_consolidation_idle_seconds: float
    memory_rollup_keep_recent: int
    memory_rollup_min_batch: int
    memory_rollup_max_batch: int
    ambient_context_enabled: bool
    ambient_timezone: str
    ambient_location: str


@lru_cache(maxsize=1)
def get_runtime_tuning() -> RuntimeTuning:
    """Resolve runtime tuning from the environment (cached for the process)."""
    return RuntimeTuning(
        stt_poll_interval_seconds=_float_env(
            "NIKOF_STT_POLL_INTERVAL_SECONDS",
            _DEFAULT_STT_POLL_INTERVAL_SECONDS,
            minimum=_MIN_POLL_INTERVAL_SECONDS,
        ),
        stt_engine=_str_env(
            "NIKOF_STT_ENGINE",
            _DEFAULT_STT_ENGINE,
            choices=frozenset({"faster-whisper", "parakeet"}),
        ),
        stt_partials_enabled=_bool_env("NIKOF_STT_PARTIALS", _DEFAULT_STT_PARTIALS_ENABLED),
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
        llm_streaming_enabled=_bool_env("NIKOF_LLM_STREAMING", _DEFAULT_LLM_STREAMING_ENABLED),
        llm_lean_planner=_bool_env("NIKOF_LLM_LEAN_PLANNER", _DEFAULT_LLM_LEAN_PLANNER),
        llm_async_memory=_bool_env("NIKOF_LLM_ASYNC_MEMORY", _DEFAULT_LLM_ASYNC_MEMORY),
        llm_num_ctx=_int_env("NIKOF_LLM_NUM_CTX", _DEFAULT_LLM_NUM_CTX, minimum=512),
        llm_num_predict=_int_env("NIKOF_LLM_NUM_PREDICT", _DEFAULT_LLM_NUM_PREDICT, minimum=0),
        memory_prompt_token_budget=_int_env(
            "NIKOF_MEMORY_PROMPT_TOKEN_BUDGET", _DEFAULT_MEMORY_PROMPT_TOKEN_BUDGET, minimum=0
        ),
        memory_consolidation_enabled=_bool_env(
            "NIKOF_MEMORY_CONSOLIDATION", _DEFAULT_MEMORY_CONSOLIDATION_ENABLED
        ),
        memory_consolidation_idle_seconds=_float_env(
            "NIKOF_MEMORY_CONSOLIDATION_IDLE_SECONDS",
            _DEFAULT_MEMORY_CONSOLIDATION_IDLE_SECONDS,
            minimum=1.0,
        ),
        memory_rollup_keep_recent=_int_env(
            "NIKOF_MEMORY_ROLLUP_KEEP_RECENT", _DEFAULT_MEMORY_ROLLUP_KEEP_RECENT, minimum=0
        ),
        memory_rollup_min_batch=_int_env(
            "NIKOF_MEMORY_ROLLUP_MIN_BATCH", _DEFAULT_MEMORY_ROLLUP_MIN_BATCH, minimum=1
        ),
        memory_rollup_max_batch=_int_env(
            "NIKOF_MEMORY_ROLLUP_MAX_BATCH", _DEFAULT_MEMORY_ROLLUP_MAX_BATCH, minimum=1
        ),
        ambient_context_enabled=_bool_env(
            "NIKOF_AMBIENT_CONTEXT", _DEFAULT_AMBIENT_CONTEXT_ENABLED
        ),
        ambient_timezone=_raw_str_env("NIKOF_AMBIENT_TIMEZONE", _DEFAULT_AMBIENT_TIMEZONE),
        ambient_location=_raw_str_env("NIKOF_AMBIENT_LOCATION", _DEFAULT_AMBIENT_LOCATION),
    )
