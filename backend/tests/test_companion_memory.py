from __future__ import annotations

import sys
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest


BACKEND_ROOT = Path(__file__).resolve().parents[1]
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from app.services.companion_memory import SqliteCompanionMemoryService


class CompanionMemoryServiceTests(unittest.TestCase):
    def test_store_turn_creates_player_and_assistant_memory_entries(self) -> None:
        with TemporaryDirectory() as temp_dir:
            service = SqliteCompanionMemoryService(Path(temp_dir) / "companion-memory.sqlite3")
            service.ensure_persona_core(
                persona_id="maria",
                display_name="Maria",
                speech_style="warm and concise",
            )

            service.store_turn(
                persona_id="maria",
                session_id="session-01",
                locale="en-US",
                user_text="Please remember that I dislike coffee and that my birthday is June fifth.",
                assistant_text="I will remember that you dislike coffee.",
                assistant_status="ready",
                memory_writebacks=(
                    {
                        "namespace": "memory",
                        "summary": "User dislikes coffee.",
                        "salience": 0.9,
                        "source": "player",
                        "tags": ["preference"],
                    },
                ),
                feeling_name="caring",
                voice_energy=0.3,
            )

            context = service.get_prompt_context(
                persona_id="maria",
                query_text="What drink should I avoid offering the user?",
            )

        self.assertEqual("Maria", context.persona.display_name)
        self.assertEqual("caring", context.demeanor.mood)
        self.assertGreaterEqual(len(context.retrieved_memories), 1)
        self.assertIn("coffee", " ".join(entry.summary.lower() for entry in context.retrieved_memories))

    def test_prompt_context_keeps_persona_and_memory_namespaces_separate(self) -> None:
        with TemporaryDirectory() as temp_dir:
            service = SqliteCompanionMemoryService(Path(temp_dir) / "companion-memory.sqlite3")
            service.ensure_persona_core(
                persona_id="test-vrm-01",
                display_name="Test Persona",
                speech_style="playful",
                core_traits=("warm", "protective"),
            )
            service.append_memory(
                persona_id="test-vrm-01",
                namespace="memory",
                source="player",
                role="user_turn",
                summary="User likes rainy walks.",
                content="User said they like rainy walks.",
                salience=0.7,
                tags=("preference",),
            )

            context = service.get_prompt_context(
                persona_id="test-vrm-01",
                query_text="Do you remember my rainy walks?",
            )

        self.assertEqual("playful", context.persona.speech_style)
        self.assertEqual(("warm", "protective"), context.persona.core_traits)
        self.assertEqual("memory", context.retrieved_memories[0].namespace)


if __name__ == "__main__":
    unittest.main()