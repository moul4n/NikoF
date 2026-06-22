"""Core text-generation contracts (extracted from llm.py).

The provider-agnostic types shared across the LLM layer: the request, the
service Protocol, the invocation error, and the streaming-step event. Kept in a
leaf module so llm_parsing can use them without importing llm.py (no cycle);
llm.py re-exports them for existing callers.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol

from app.schemas.session import AssistantMessageContract, LLM_BASELINE_PROFILE_IDS


@dataclass(slots=True, frozen=True)
class TextGenerationRequest:
    prompt: str
    locale: str
    profile_id: str = LLM_BASELINE_PROFILE_IDS[0]
    expect_structured_output: bool = False


class TextGenerationService(Protocol):
    """Boundary for provider-agnostic local text-generation adapters."""

    def generate(self, request: TextGenerationRequest) -> AssistantMessageContract:
        raise NotImplementedError


class TextGenerationInvocationError(RuntimeError):
    """Raised when the local text-generation runtime cannot complete a request."""


@dataclass(slots=True, frozen=True)
class TextGenerationStreamEvent:
    """One streamed step (Phase 1b). ``text_delta`` carries decoded reply_text
    characters; the final event also carries the authoritative ``contract``."""

    text_delta: str = ""
    contract: AssistantMessageContract | None = None
