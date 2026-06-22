"""Idle memory consolidation worker — Stage 3 (docs/MEMORY_ARCHITECTURE.md).

A background thread that, when the LLM has been idle long enough that no live turn
is competing for it, runs one cheapest-first consolidation pass over each persona's
memory:

  1. dedup — merge durable facts with identical normalized text into one row
     (no LLM, pure SQLite); and
  2. episodic rollup — summarize a batch of the oldest raw dialog turns (those
     past the verbatim working window) into a single episodic memory using the
     now-idle LLM, then mark the raw turns superseded so recall stays lean.

The cycle is a pure function (`run_consolidation_cycle`) with the summarizer and
the "keep going?" idle check injected, so it is fully unit-testable without a live
LLM or GPU. The worker wraps it in a poll loop and is OFF by default
(`NIKOF_MEMORY_CONSOLIDATION`).
"""

from __future__ import annotations

from dataclasses import dataclass
import logging
import threading
import time
from typing import Callable

from app.core.runtime_tuning import get_runtime_tuning
from app.services.companion_memory import (
    CompanionMemoryService,
    MemoryEntryRecord,
    build_companion_memory_service,
)


logger = logging.getLogger(__name__)

# How often the loop wakes to check for idle work. Cheap (a clock read + an idle
# check); the actual consolidation only runs when idle.
_POLL_INTERVAL_SECONDS = 5.0

# A summarizer turns a batch of raw dialog turns into one episodic note. Returns
# an empty string to signal "could not summarize" (e.g. LLM unavailable) — the
# cycle then leaves those turns untouched for a later pass.
Summarizer = Callable[[tuple[MemoryEntryRecord, ...]], str]


@dataclass(slots=True, frozen=True)
class MemoryConsolidationConfig:
    enabled: bool
    idle_seconds: float
    keep_recent: int
    min_batch: int
    max_batch: int

    @classmethod
    def from_runtime_tuning(cls) -> "MemoryConsolidationConfig":
        tuning = get_runtime_tuning()
        return cls(
            enabled=tuning.memory_consolidation_enabled,
            idle_seconds=tuning.memory_consolidation_idle_seconds,
            keep_recent=tuning.memory_rollup_keep_recent,
            min_batch=tuning.memory_rollup_min_batch,
            max_batch=tuning.memory_rollup_max_batch,
        )


@dataclass(slots=True, frozen=True)
class ConsolidationCycleResult:
    personas_processed: int = 0
    duplicates_removed: int = 0
    rollups_created: int = 0


def _build_rollup_prompt(batch: tuple[MemoryEntryRecord, ...]) -> str:
    transcript_lines: list[str] = []
    for entry in batch:
        speaker = "User" if entry.source == "player" else "Companion"
        transcript_lines.append(f"{speaker}: {entry.content}")
    return "\n".join(
        [
            "Summarize the following conversation excerpts into a single concise "
            "third-person episodic memory note for a companion character.",
            "Capture durable facts, recurring topics, and emotional tone; drop "
            "small talk and exact wording. Two to four sentences. Plain prose, no "
            "lists, no preamble.",
            "",
            *transcript_lines,
        ]
    )


def build_llm_summarizer(
    text_generation_service: object,
    *,
    locale: str = "en-US",
) -> Summarizer:
    """A summarizer backed by the local LLM. Best-effort: any failure or empty
    reply yields an empty string so the cycle skips that batch."""
    from app.services.llm import TextGenerationRequest

    def _summarize(batch: tuple[MemoryEntryRecord, ...]) -> str:
        if not batch:
            return ""
        generate = getattr(text_generation_service, "generate", None)
        if not callable(generate):
            return ""
        try:
            contract = generate(
                TextGenerationRequest(
                    prompt=_build_rollup_prompt(batch),
                    locale=locale,
                    expect_structured_output=False,
                )
            )
        except Exception:  # pragma: no cover - summarization is best-effort
            logger.exception("Episodic rollup summarization failed")
            return ""
        if getattr(contract, "status", None) not in {"ready", "degraded"}:
            return ""
        return str(getattr(contract, "text", "") or "").strip()

    return _summarize


def run_consolidation_cycle(
    memory_service: CompanionMemoryService,
    *,
    summarize: Summarizer,
    config: MemoryConsolidationConfig,
    persona_ids: tuple[str, ...] | None = None,
    should_continue: Callable[[], bool] = lambda: True,
) -> ConsolidationCycleResult:
    """Run one consolidation pass. Deterministic and idempotent: dedup then a
    single episodic rollup per persona, aborting between steps when
    ``should_continue()`` turns False (a live turn arrived)."""
    targets = persona_ids if persona_ids is not None else memory_service.list_persona_ids()
    personas = 0
    duplicates_removed = 0
    rollups_created = 0

    for persona_id in targets:
        if not should_continue():
            break
        personas += 1

        try:
            duplicates_removed += memory_service.consolidate_durable_duplicates(persona_id=persona_id)
        except Exception:
            logger.exception("Durable dedup failed for persona %s", persona_id)

        if not should_continue():
            break

        try:
            batch = memory_service.select_dialog_rollup_batch(
                persona_id=persona_id,
                keep_recent=config.keep_recent,
                max_batch=config.max_batch,
            )
        except Exception:
            logger.exception("Rollup batch selection failed for persona %s", persona_id)
            continue

        if len(batch) < config.min_batch or not should_continue():
            continue

        summary = summarize(batch)
        if not summary.strip():
            continue

        last = batch[-1]
        try:
            stored = memory_service.store_dialog_rollup(
                persona_id=persona_id,
                summary=summary,
                covered_entry_ids=tuple(entry.entry_id for entry in batch),
                session_id=last.session_id,
                locale=last.locale,
            )
        except Exception:
            logger.exception("Storing episodic rollup failed for persona %s", persona_id)
            continue
        if stored is not None:
            rollups_created += 1

    return ConsolidationCycleResult(
        personas_processed=personas,
        duplicates_removed=duplicates_removed,
        rollups_created=rollups_created,
    )


def build_llm_idle_check(
    config: MemoryConsolidationConfig,
    *,
    now: Callable[[], float] = time.time,
) -> Callable[[], bool]:
    """Idle when the LLM has not served a request within ``idle_seconds`` (so a
    live turn is not in flight). Uses the resource monitor's last-request stamp."""
    from app.services.resource_monitor import get_resource_monitor

    def _is_idle() -> bool:
        snapshot = get_resource_monitor().tracker("llm").snapshot()
        last = snapshot.last_request_epoch
        if last is None:
            return True
        return (now() - last) >= config.idle_seconds

    return _is_idle


class MemoryConsolidationWorker:
    """Threaded poll loop that runs `run_consolidation_cycle` when idle."""

    def __init__(
        self,
        *,
        memory_service: CompanionMemoryService,
        summarize: Summarizer,
        is_idle: Callable[[], bool],
        config: MemoryConsolidationConfig,
        poll_interval_seconds: float = _POLL_INTERVAL_SECONDS,
    ) -> None:
        self._memory_service = memory_service
        self._summarize = summarize
        self._is_idle = is_idle
        self._config = config
        self._poll_interval_seconds = poll_interval_seconds
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None

    def start(self) -> bool:
        if not self._config.enabled:
            return False
        if self._thread is not None and self._thread.is_alive():
            return True
        self._stop.clear()
        self._thread = threading.Thread(
            target=self._run_loop,
            name="memory-consolidation",
            daemon=True,
        )
        self._thread.start()
        return True

    def stop(self) -> None:
        self._stop.set()
        thread = self._thread
        if thread is not None:
            thread.join(timeout=2.0)
        self._thread = None

    def run_once(self) -> ConsolidationCycleResult:
        """Run a single cycle now (used by the loop and by tests)."""
        return run_consolidation_cycle(
            self._memory_service,
            summarize=self._summarize,
            config=self._config,
            should_continue=self._is_idle,
        )

    def _run_loop(self) -> None:
        while not self._stop.is_set():
            try:
                if self._is_idle():
                    result = self.run_once()
                    if result.duplicates_removed or result.rollups_created:
                        logger.info(
                            "Memory consolidation: removed %d duplicate(s), created %d rollup(s) across %d persona(s)",
                            result.duplicates_removed,
                            result.rollups_created,
                            result.personas_processed,
                        )
            except Exception:  # pragma: no cover - loop must never die
                logger.exception("Memory consolidation cycle failed")
            self._stop.wait(self._poll_interval_seconds)


_worker: MemoryConsolidationWorker | None = None
_worker_lock = threading.Lock()


def get_memory_consolidation_worker(
    *,
    text_generation_service: object | None = None,
) -> MemoryConsolidationWorker:
    """Process-wide consolidation worker. Built from runtime tuning; shares the
    companion-memory DB (default app paths) and uses the supplied LLM service for
    rollup summaries (rollups are skipped if none is provided)."""
    global _worker
    with _worker_lock:
        if _worker is None:
            config = MemoryConsolidationConfig.from_runtime_tuning()
            memory_service = build_companion_memory_service()
            summarize: Summarizer = (
                build_llm_summarizer(text_generation_service)
                if text_generation_service is not None
                else (lambda _batch: "")
            )
            _worker = MemoryConsolidationWorker(
                memory_service=memory_service,
                summarize=summarize,
                is_idle=build_llm_idle_check(config),
                config=config,
            )
        return _worker
