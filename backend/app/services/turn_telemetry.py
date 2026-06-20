"""Per-turn latency telemetry (in-memory, process-local).

Phase 0 of the streaming performance plan (docs/STREAMING_PERFORMANCE_PLAN.md):
a measurement harness so later streaming phases can be proven against a
baseline. ``run_user_text_turn`` records one sample per turn with the wall-clock
cost of each inline stage (memory retrieval, LLM generation, inline TTS) plus
the total time spent orchestrating the turn.

This is deliberately lightweight: a bounded ring buffer of recent samples plus
running averages, surfaced read-only through ``GET /system/resources``. It is
*not* a locked contract — it is volatile monitoring data alongside the existing
GPU/process telemetry on that endpoint.

Note on deferred synthesis: the STT voice path runs TTS in a background thread
(``defer_synthesis=True``), so ``tts_ms`` is ``None`` for those turns and
``total_ms`` reflects orchestration only. Background synthesis latency is still
captured by the TTS subsystem tracker (``tts_worker.average_latency_ms``).
"""

from __future__ import annotations

from collections import deque
from dataclasses import asdict, dataclass
import threading
from typing import Any


_DEFAULT_WINDOW_SIZE = 50
_RECENT_PAYLOAD_LIMIT = 10


@dataclass(slots=True, frozen=True)
class TurnTimingSample:
    turn_index: int
    started_epoch: float
    input_source: str
    status: str
    character_id: str
    deferred_synthesis: bool
    total_ms: float
    llm_ms: float | None = None
    tts_ms: float | None = None
    memory_ms: float | None = None


def _round_optional(value: float | None) -> float | None:
    return round(value, 1) if value is not None else None


class TurnTelemetry:
    """Thread-safe ring buffer of recent turn timing samples."""

    def __init__(self, window_size: int = _DEFAULT_WINDOW_SIZE) -> None:
        self._lock = threading.Lock()
        self._samples: deque[TurnTimingSample] = deque(maxlen=window_size)
        self._total_recorded = 0
        self._sums: dict[str, float] = {"total_ms": 0.0, "llm_ms": 0.0, "tts_ms": 0.0, "memory_ms": 0.0}
        self._counts: dict[str, int] = {"total_ms": 0, "llm_ms": 0, "tts_ms": 0, "memory_ms": 0}

    def record(
        self,
        *,
        input_source: str,
        status: str,
        character_id: str,
        deferred_synthesis: bool,
        total_ms: float,
        started_epoch: float,
        llm_ms: float | None = None,
        tts_ms: float | None = None,
        memory_ms: float | None = None,
    ) -> TurnTimingSample:
        with self._lock:
            self._total_recorded += 1
            sample = TurnTimingSample(
                turn_index=self._total_recorded,
                started_epoch=started_epoch,
                input_source=input_source,
                status=status,
                character_id=character_id,
                deferred_synthesis=deferred_synthesis,
                total_ms=round(total_ms, 1),
                llm_ms=_round_optional(llm_ms),
                tts_ms=_round_optional(tts_ms),
                memory_ms=_round_optional(memory_ms),
            )
            self._samples.append(sample)
            for key, value in (
                ("total_ms", total_ms),
                ("llm_ms", llm_ms),
                ("tts_ms", tts_ms),
                ("memory_ms", memory_ms),
            ):
                if value is not None:
                    self._sums[key] += value
                    self._counts[key] += 1
            return sample

    def _averages_unlocked(self) -> dict[str, float | None]:
        return {
            key: round(self._sums[key] / self._counts[key], 1) if self._counts[key] else None
            for key in self._sums
        }

    def recent(self, limit: int = _RECENT_PAYLOAD_LIMIT) -> tuple[TurnTimingSample, ...]:
        with self._lock:
            samples = tuple(self._samples)
        if limit <= 0:
            return samples
        return samples[-limit:]

    def summary(self, *, recent_limit: int = _RECENT_PAYLOAD_LIMIT) -> dict[str, Any]:
        with self._lock:
            recent = list(self._samples)[-recent_limit:] if recent_limit > 0 else list(self._samples)
            averages = self._averages_unlocked()
            total_recorded = self._total_recorded
            window_size = len(self._samples)
        return {
            "samples_recorded": total_recorded,
            "window_size": window_size,
            "averages": averages,
            "last": asdict(recent[-1]) if recent else None,
            "recent": [asdict(sample) for sample in recent],
        }


_turn_telemetry: TurnTelemetry | None = None
_turn_telemetry_lock = threading.Lock()


def get_turn_telemetry() -> TurnTelemetry:
    global _turn_telemetry
    if _turn_telemetry is None:
        with _turn_telemetry_lock:
            if _turn_telemetry is None:
                _turn_telemetry = TurnTelemetry()
    return _turn_telemetry
