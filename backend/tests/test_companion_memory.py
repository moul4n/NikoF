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

    def test_unrelated_recent_topic_is_not_recalled(self) -> None:
        # Reproduces the "she brings up the last topic for no reason" bug: ask
        # about the UK, then about SpaceX; the UK turn must NOT be recalled into
        # the SpaceX prompt just because it was recent.
        with TemporaryDirectory() as temp_dir:
            service = SqliteCompanionMemoryService(Path(temp_dir) / "companion-memory.sqlite3")
            service.ensure_persona_core(persona_id="niko", display_name="Niko")
            service.store_turn(
                persona_id="niko",
                session_id="session-01",
                locale="en-US",
                user_text="What is the population of the United Kingdom?",
                assistant_text="The United Kingdom has about 67 million people.",
                assistant_status="ready",
            )

            context = service.get_prompt_context(
                persona_id="niko",
                query_text="Tell me about SpaceX.",
            )

        summaries = " ".join(entry.summary.lower() for entry in context.retrieved_memories)
        self.assertNotIn("united kingdom", summaries)
        self.assertNotIn("population", summaries)

    def test_durable_high_salience_fact_is_recalled_without_overlap(self) -> None:
        # Durable preferences must still surface across topic changes even when
        # the current message shares no words with them.
        with TemporaryDirectory() as temp_dir:
            service = SqliteCompanionMemoryService(Path(temp_dir) / "companion-memory.sqlite3")
            service.ensure_persona_core(persona_id="niko", display_name="Niko")
            service.append_memory(
                persona_id="niko",
                namespace="memory",
                source="player",
                role="user_turn",
                summary="User is vegetarian.",
                content="User said they are vegetarian.",
                salience=0.9,
                tags=("preference",),
            )

            context = service.get_prompt_context(
                persona_id="niko",
                query_text="What should we cook tonight?",
            )

        summaries = " ".join(entry.summary.lower() for entry in context.retrieved_memories)
        self.assertIn("vegetarian", summaries)

    def test_important_fact_survives_beyond_recall_window(self) -> None:
        # A durable life fact stored long ago (buried under far more than the
        # 64-entry recent window of later chatter) must STILL be recalled.
        with TemporaryDirectory() as temp_dir:
            service = SqliteCompanionMemoryService(Path(temp_dir) / "companion-memory.sqlite3")
            service.ensure_persona_core(persona_id="niko", display_name="Niko")
            service.store_turn(
                persona_id="niko",
                session_id="session-01",
                locale="en-US",
                user_text="Remember that my birthday is June fifth and I was born in Leeds.",
                assistant_text="Got it, I'll remember your birthday and that you were born in Leeds.",
                assistant_status="ready",
                memory_writebacks=(
                    {
                        "namespace": "memory",
                        "summary": "User's birthday is June 5th; born in Leeds.",
                        "salience": 0.2,  # under-rated on purpose; must be floored
                        "source": "player",
                        "tags": ["bio"],
                    },
                ),
            )
            # Bury it under 80 unrelated later turns (> 64-entry window).
            for i in range(80):
                service.store_turn(
                    persona_id="niko",
                    session_id="session-01",
                    locale="en-US",
                    user_text=f"Let's talk about widget number {i}.",
                    assistant_text=f"Sure, widget {i} is interesting.",
                    assistant_status="ready",
                )

            context = service.get_prompt_context(
                persona_id="niko",
                query_text="When is my birthday?",
            )

        summaries = " ".join(entry.summary.lower() for entry in context.retrieved_memories)
        self.assertIn("birthday", summaries)
        self.assertIn("leeds", summaries)

    def test_important_tokens_floor_salience_to_durable(self) -> None:
        from app.services.companion_memory import estimate_memory_salience, _DURABLE_RECALL_SALIENCE

        # Plain chatter stays low; a life fact is floored to durable salience.
        self.assertLess(estimate_memory_salience("the sky is blue today"), _DURABLE_RECALL_SALIENCE)
        self.assertGreaterEqual(
            estimate_memory_salience("I was born in Leeds"), _DURABLE_RECALL_SALIENCE
        )

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