from __future__ import annotations

from pathlib import Path
import sys
import time
import unittest
from unittest.mock import patch


BACKEND_ROOT = Path(__file__).resolve().parents[1]
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from app.core import runtime_tuning
from app.schemas.session import (
    AssistantFeelingContract,
    AssistantMemoryWriteContract,
    AssistantMessageContract,
    SpeechSynthesisContract,
)
from app.services.character import CharacterService, FileSystemCharacterManifestSource
from app.services.session import InMemorySessionService
from app.services.speech import DefaultSessionEventFactory, SpeechSynthesisRequest
from app.services.turns import UserTurnRequest, UserTurnServices, run_user_text_turn


class StaticStructuredTextGenerationService:
    def generate(self, request):
        del request
        return AssistantMessageContract(
            profile_id="llm.ollama.llama3.1-8b-2026",
            status="ready",
            text="Sure, I can keep it short.",
            locale="en-US",
            feeling=AssistantFeelingContract(name="warm", intensity=0.6),
            memory_writebacks=(
                AssistantMemoryWriteContract(
                    namespace="memory",
                    summary="User prefers short answers.",
                    salience=0.85,
                    source="player",
                    tags=("preference",),
                ),
            ),
        )


class CapturingSynthesisService:
    def synthesize(self, request: SpeechSynthesisRequest) -> SpeechSynthesisContract:
        return SpeechSynthesisContract(
            profile_id=request.profile_id,
            status="ready",
            text=request.text,
            locale=request.locale,
            audio_reference="session://speech/test.wav",
        )


class CapturingMemoryService:
    def __init__(self) -> None:
        self.store_calls: list[dict] = []

    def ensure_persona_core(self, **kwargs):
        del kwargs
        return None

    def get_prompt_context(self, **kwargs):
        del kwargs
        return None

    def store_turn(self, **kwargs) -> None:
        self.store_calls.append(kwargs)


class AsyncMemoryTests(unittest.TestCase):
    def setUp(self) -> None:
        runtime_tuning.get_runtime_tuning.cache_clear()
        self.addCleanup(runtime_tuning.get_runtime_tuning.cache_clear)

    def _run(self, memory: CapturingMemoryService) -> None:
        session_service = InMemorySessionService(default_character_id="test-vrm-01")
        run_user_text_turn(
            UserTurnRequest(text="Remember I like short answers.", locale="en-US"),
            services=UserTurnServices(
                session_service=session_service,
                character_service=CharacterService(FileSystemCharacterManifestSource()),
                text_generation_service=StaticStructuredTextGenerationService(),
                synthesis_service=CapturingSynthesisService(),
                session_event_factory=DefaultSessionEventFactory(),
                memory_service=memory,
            ),
        )

    def _wait_for_store(self, memory: CapturingMemoryService, timeout: float = 3.0) -> bool:
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if memory.store_calls:
                return True
            time.sleep(0.01)
        return bool(memory.store_calls)

    def test_lean_extracts_and_stores_writebacks_async(self) -> None:
        with patch.dict(
            runtime_tuning.os.environ,
            {"NIKOF_LLM_LEAN_PLANNER": "1", "NIKOF_LLM_ASYNC_MEMORY": "1"},
            clear=False,
        ):
            runtime_tuning.get_runtime_tuning.cache_clear()
            memory = CapturingMemoryService()
            self._run(memory)
            self.assertTrue(self._wait_for_store(memory))
        # The background extraction call recovered durable writebacks.
        self.assertGreaterEqual(len(memory.store_calls[0]["memory_writebacks"]), 1)

    def test_lean_without_async_memory_stores_without_writebacks(self) -> None:
        with patch.dict(
            runtime_tuning.os.environ,
            {"NIKOF_LLM_LEAN_PLANNER": "1", "NIKOF_LLM_ASYNC_MEMORY": "0"},
            clear=False,
        ):
            runtime_tuning.get_runtime_tuning.cache_clear()
            memory = CapturingMemoryService()
            self._run(memory)
            self.assertTrue(self._wait_for_store(memory))
        self.assertEqual(memory.store_calls[0]["memory_writebacks"], ())

    def test_non_lean_stores_synchronously_with_planner_writebacks(self) -> None:
        with patch.dict(runtime_tuning.os.environ, {"NIKOF_LLM_LEAN_PLANNER": "0"}, clear=False):
            runtime_tuning.get_runtime_tuning.cache_clear()
            memory = CapturingMemoryService()
            self._run(memory)
        # Non-lean path is synchronous: the store has already happened on return.
        self.assertEqual(len(memory.store_calls), 1)
        self.assertGreaterEqual(len(memory.store_calls[0]["memory_writebacks"]), 1)


if __name__ == "__main__":
    unittest.main()
