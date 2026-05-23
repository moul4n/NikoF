from __future__ import annotations

import sys
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest


BACKEND_ROOT = Path(__file__).resolve().parents[1]
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from app.schemas.session import (
    AssistantAnimationCueContract,
    AssistantFeelingContract,
    AssistantMemoryWriteContract,
    AssistantMessageContract,
    AssistantVoiceToneContract,
    SpeechSynthesisContract,
)
from app.schemas.animation import AnimationCommand, AnimationPlayback, AnimationResolution, SessionAnimationSnapshot
from app.services.character import CharacterService, FileSystemCharacterManifestSource
from app.services.companion_memory import SqliteCompanionMemoryService
from app.services.session import InMemorySessionService
from app.services.speech import DefaultSessionEventFactory, SpeechSynthesisRequest
from app.services.turns import UserTurnRequest, UserTurnServices, run_user_text_turn


class StaticStructuredTextGenerationService:
    def generate(self, request):
        del request
        return AssistantMessageContract(
            profile_id="llm.ollama.llama3.1-8b-2026",
            status="ready",
            text="I can keep this reply short and warm.",
            locale="en-US",
            thinking_summary="User asked for a concise spoken answer.",
            feeling=AssistantFeelingContract(name="warm", intensity=0.6),
            voice_tone=AssistantVoiceToneContract(style="gentle", pace="steady", energy=0.35),
            animation_cues=(
                AssistantAnimationCueContract(
                    cue="wave",
                    layer="upper",
                    intensity=0.45,
                    duration_ms=1200,
                ),
            ),
            memory_writebacks=(
                AssistantMemoryWriteContract(
                    namespace="memory",
                    summary="User wants concise spoken answers.",
                    salience=0.85,
                    source="player",
                    tags=("preference",),
                ),
            ),
        )


class KeywordPriorityStructuredTextGenerationService:
    def generate(self, request):
        del request
        return AssistantMessageContract(
            profile_id="llm.ollama.llama3.1-8b-2026",
            status="ready",
            text="I can give a quick little wave after I answer.",
            locale="en-US",
            thinking_summary="Friendly greeting with a brief wave after the reply.",
            feeling=AssistantFeelingContract(name="warm", intensity=0.45),
            voice_tone=AssistantVoiceToneContract(style="gentle", pace="steady", energy=0.3),
            animation_cues=(),
            memory_writebacks=(),
        )


class IdlePriorityStructuredTextGenerationService:
    def generate(self, request):
        del request
        return AssistantMessageContract(
            profile_id="llm.ollama.llama3.1-8b-2026",
            status="ready",
            text="I can keep the tone warm and happy while I answer.",
            locale="en-US",
            thinking_summary="A calm, friendly reply is the better fit than a big celebratory motion.",
            feeling=AssistantFeelingContract(name="warm", intensity=0.4),
            voice_tone=AssistantVoiceToneContract(style="gentle", pace="steady", energy=0.25),
            animation_cues=(),
            memory_writebacks=(),
        )


class CapturingSynthesisService:
    def __init__(self) -> None:
        self.requests: list[SpeechSynthesisRequest] = []

    def synthesize(self, request: SpeechSynthesisRequest) -> SpeechSynthesisContract:
        self.requests.append(request)
        return SpeechSynthesisContract(
            profile_id=request.profile_id,
            status="ready",
            text=request.text,
            locale=request.locale,
            audio_reference="session://speech/test.wav",
        )


class StaticAnimationService:
    def resolve_intent(self, intent) -> AnimationCommand:
        return AnimationCommand(
            command_id=f"cmd:{intent.intent_id}",
            intent_id=intent.intent_id,
            session_id=intent.session_id,
            character_id=intent.character_id,
            semantic_id=intent.semantic_id,
            resolved_state="queued",
            resolution=AnimationResolution(
                selected_source="shared_library",
                selected_asset_id=intent.semantic_id,
            ),
            playback=AnimationPlayback(mode="oneshot", blend_hint="upper_body_additive", loop=False),
            intensity=intent.intensity,
            parameters=dict(intent.parameters),
        )

    def resolve_session_command(self, snapshot):
        del snapshot
        raise NotImplementedError


class CapturingAnimationLiveDelivery:
    def __init__(self) -> None:
        self.snapshots: list[SessionAnimationSnapshot] = []

    def publish_snapshot(self, snapshot: SessionAnimationSnapshot) -> None:
        self.snapshots.append(snapshot)


class StructuredTurnFlowTests(unittest.TestCase):
    def test_turn_flow_writes_memory_and_passes_voice_tone_to_tts(self) -> None:
        with TemporaryDirectory() as temp_dir:
            memory_service = SqliteCompanionMemoryService(Path(temp_dir) / "companion-memory.sqlite3")
            session_service = InMemorySessionService(default_character_id="test-vrm-01")
            character_service = CharacterService(FileSystemCharacterManifestSource())
            synthesis_service = CapturingSynthesisService()
            animation_live_delivery = CapturingAnimationLiveDelivery()

            result = run_user_text_turn(
                UserTurnRequest(
                    text="Please keep the answer short from now on.",
                    locale="en-US",
                ),
                services=UserTurnServices(
                    session_service=session_service,
                    character_service=character_service,
                    text_generation_service=StaticStructuredTextGenerationService(),
                    synthesis_service=synthesis_service,
                    session_event_factory=DefaultSessionEventFactory(),
                    memory_service=memory_service,
                    animation_service=StaticAnimationService(),
                    session_animation_live_delivery=animation_live_delivery,
                ),
            )

            context = memory_service.get_prompt_context(
                persona_id="test-vrm-01",
                query_text="Do I want short answers?",
            )

        self.assertEqual("ready", result.status)
        self.assertEqual("steady", synthesis_service.requests[0].voice_profile["llm_voice_tone"]["pace"])
        self.assertEqual(1, len(animation_live_delivery.snapshots))
        self.assertEqual("greet.wave.once", animation_live_delivery.snapshots[0].command.semantic_id)
        self.assertEqual("upper", animation_live_delivery.snapshots[0].command.parameters["assistant_layer"])
        summaries = " ".join(entry.summary.lower() for entry in context.retrieved_memories)
        self.assertIn("short", summaries)
        self.assertEqual("warm", context.demeanor.mood)

    def test_turn_flow_infers_prioritized_animation_from_assistant_text(self) -> None:
        session_service = InMemorySessionService(default_character_id="test-vrm-01")
        character_service = CharacterService(FileSystemCharacterManifestSource())
        synthesis_service = CapturingSynthesisService()
        animation_live_delivery = CapturingAnimationLiveDelivery()

        result = run_user_text_turn(
            UserTurnRequest(
                text="Say hello and keep it upbeat.",
                locale="en-US",
            ),
            services=UserTurnServices(
                session_service=session_service,
                character_service=character_service,
                text_generation_service=KeywordPriorityStructuredTextGenerationService(),
                synthesis_service=synthesis_service,
                session_event_factory=DefaultSessionEventFactory(),
                animation_service=StaticAnimationService(),
                session_animation_live_delivery=animation_live_delivery,
            ),
        )

        self.assertEqual("ready", result.status)
        self.assertEqual(1, len(animation_live_delivery.snapshots))
        self.assertEqual("greet.wave.small.once", animation_live_delivery.snapshots[0].command.semantic_id)
        self.assertEqual("upper", animation_live_delivery.snapshots[0].command.parameters["assistant_layer"])
        self.assertEqual("keyword_priority", animation_live_delivery.snapshots[0].command.parameters["assistant_cue_source"])

    def test_turn_flow_prefers_idle_animation_over_stronger_positive_emote(self) -> None:
        session_service = InMemorySessionService(default_character_id="test-vrm-01")
        character_service = CharacterService(FileSystemCharacterManifestSource())
        synthesis_service = CapturingSynthesisService()
        animation_live_delivery = CapturingAnimationLiveDelivery()

        result = run_user_text_turn(
            UserTurnRequest(
                text="Keep it warm and reassuring.",
                locale="en-US",
            ),
            services=UserTurnServices(
                session_service=session_service,
                character_service=character_service,
                text_generation_service=IdlePriorityStructuredTextGenerationService(),
                synthesis_service=synthesis_service,
                session_event_factory=DefaultSessionEventFactory(),
                animation_service=StaticAnimationService(),
                session_animation_live_delivery=animation_live_delivery,
            ),
        )

        self.assertEqual("ready", result.status)
        self.assertEqual(1, len(animation_live_delivery.snapshots))
        self.assertEqual("idle.happy", animation_live_delivery.snapshots[0].command.semantic_id)
        self.assertEqual("base", animation_live_delivery.snapshots[0].command.parameters["assistant_layer"])
        self.assertEqual("keyword_priority", animation_live_delivery.snapshots[0].command.parameters["assistant_cue_source"])


if __name__ == "__main__":
    unittest.main()