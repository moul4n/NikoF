"""Durable memory writeback extraction + async persistence (extracted from turns.py).

When the lean planner omits memory_writebacks, a separate off-critical-path LLM
call recovers durable writebacks; the turn's memory is then persisted in a
background thread so enrichment never sits on the reply latency path. Re-exported
from turns.py for the pipeline.
"""

from __future__ import annotations

import logging
import threading
from typing import Any

from app.schemas.session import AssistantMessageContract, LLM_BASELINE_PROFILE_IDS
from app.services.llm import TextGenerationRequest, TextGenerationService


logger = logging.getLogger(__name__)


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
    services: Any,
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
