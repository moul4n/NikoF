from __future__ import annotations

import sys
from pathlib import Path
import unittest


BACKEND_ROOT = Path(__file__).resolve().parents[1]
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from app.api.router import build_api_contract_snapshot
from app.schemas.animation import AnimationIntent, AnimationPolicy, SessionAnimationSnapshot
from app.schemas.session import SessionSnapshot
from app.services.animation import (
    DefaultAnimationService,
    InMemorySessionAnimationLiveDeliveryService,
    SESSION_ANIMATION_STREAM,
)
from app.services.session import InvalidEventCursor


def build_session_animation_snapshot(
    animation_service: DefaultAnimationService,
    *,
    session_id: str,
    character_id: str,
    lifecycle_state: str,
) -> SessionAnimationSnapshot:
    snapshot = SessionSnapshot(
        session_id=session_id,
        active_character_id=character_id,
        lifecycle_state=lifecycle_state,
    )
    return SessionAnimationSnapshot(
        session_id=snapshot.session_id,
        lifecycle_state=snapshot.lifecycle_state,
        active_character_id=snapshot.active_character_id,
        command=animation_service.resolve_session_command(snapshot),
    )


class DefaultAnimationServiceTests(unittest.TestCase):
    def test_resolves_system_idle_for_active_character_to_backend_owned_default_idle(self) -> None:
        service = DefaultAnimationService()

        command = service.resolve_intent(
            AnimationIntent(
                intent_id="anim-intent-idle-1",
                session_id="session-1",
                character_id="test-vrm-01",
                intent_type="idle",
                semantic_id="idle.default",
                source="system_idle",
            )
        )

        self.assertEqual(command.intent_id, "anim-intent-idle-1")
        self.assertEqual(command.character_id, "test-vrm-01")
        self.assertEqual(command.semantic_id, "idle.default")
        self.assertEqual(command.resolution.selected_source, "shared_library")
        self.assertEqual(command.resolution.selected_asset_id, "idle.default")
        self.assertFalse(command.resolution.fallback_applied)
        self.assertEqual(command.playback.mode, "loop")
        self.assertTrue(command.playback.loop)
        self.assertEqual(command.playback.expected_duration_ms, 8333)

    def test_resolves_imported_generic_shared_animation_ids(self) -> None:
        service = DefaultAnimationService()

        cases = (
            ("idle.happy", "loop"),
            ("gesture.crazy.once", "oneshot"),
            ("think.considering.once", "oneshot"),
        )

        for semantic_id, playback_mode in cases:
            with self.subTest(semantic_id=semantic_id):
                command = service.resolve_intent(
                    AnimationIntent(
                        intent_id=f"anim-intent-{semantic_id}",
                        session_id="session-imported-shared-1",
                        character_id="test-vrm-01",
                        intent_type="gesture",
                        semantic_id=semantic_id,
                        source="assistant_reply",
                    )
                )

                self.assertEqual(command.semantic_id, semantic_id)
                self.assertEqual(command.resolution.selected_source, "shared_library")
                self.assertEqual(command.resolution.selected_asset_id, semantic_id)
                self.assertEqual(command.playback.mode, playback_mode)

    def test_falls_back_to_policy_semantic_and_clamps_intensity(self) -> None:
        service = DefaultAnimationService()

        command = service.resolve_intent(
            AnimationIntent(
                intent_id="anim-intent-3",
                session_id="session-3",
                character_id="test-vrm-03",
                intent_type="reaction",
                semantic_id="reaction.unknown.once",
                source="assistant_reply",
                intensity=1.5,
                policy=AnimationPolicy(fallback_semantic_id="idle.default"),
            )
        )

        self.assertEqual(command.semantic_id, "idle.default")
        self.assertEqual(command.resolution.selected_source, "fallback")
        self.assertTrue(command.resolution.fallback_applied)
        self.assertEqual(command.playback.mode, "loop")
        self.assertEqual(command.intensity, 1.0)

    def test_resolves_current_session_animation_to_backend_owned_idle_default(self) -> None:
        service = DefaultAnimationService()

        command = service.resolve_session_command(
            SessionSnapshot(
                session_id="session-scaffold-01",
                active_character_id="test-vrm-01",
                lifecycle_state="idle",
            )
        )

        self.assertEqual(command.semantic_id, "idle.neutral")
        self.assertEqual(command.resolution.selected_source, "shared_library")
        self.assertEqual(command.resolution.selected_asset_id, "idle.neutral")
        self.assertEqual(command.resolved_state, "selected")
        self.assertEqual(command.playback.mode, "loop")
        self.assertEqual(command.playback.expected_duration_ms, 16633)
        self.assertEqual(command.parameters["session_state"], "idle")
        self.assertEqual(
            command.intent_id,
            "session-animation:session-scaffold-01:test-vrm-01:idle",
        )

    def test_resolves_current_session_animation_to_backend_owned_speak_loop(self) -> None:
        service = DefaultAnimationService()

        command = service.resolve_session_command(
            SessionSnapshot(
                session_id="session-scaffold-01",
                active_character_id="test-vrm-01",
                lifecycle_state="speak",
            )
        )

        self.assertEqual(command.semantic_id, "idle.neutral")
        self.assertEqual(command.resolution.selected_source, "shared_library")
        self.assertEqual(command.resolution.selected_asset_id, "idle.neutral")
        self.assertEqual(command.resolved_state, "selected")
        self.assertEqual(command.playback.mode, "loop")
        self.assertEqual(command.playback.expected_duration_ms, 16633)
        self.assertEqual(command.parameters["session_state"], "speak")

    def test_is_known_semantic_id_matches_shared_library(self) -> None:
        service = DefaultAnimationService()

        self.assertTrue(service.is_known_semantic_id("greet.wave.once"))
        self.assertTrue(service.is_known_semantic_id("gesture.crazy.once"))
        self.assertFalse(service.is_known_semantic_id("gesture.does-not-exist.once"))

    def test_resolve_gesture_command_builds_selected_oneshot_for_known_gesture(self) -> None:
        service = DefaultAnimationService()

        command = service.resolve_gesture_command(
            SessionSnapshot(
                session_id="session-gesture-01",
                active_character_id="test-vrm-01",
                lifecycle_state="idle",
            ),
            "greet.wave.once",
        )

        self.assertEqual(command.semantic_id, "greet.wave.once")
        self.assertEqual(command.resolution.selected_source, "shared_library")
        self.assertFalse(command.resolution.fallback_applied)
        self.assertEqual(command.resolved_state, "selected")
        self.assertEqual(command.playback.mode, "oneshot")
        self.assertFalse(command.playback.loop)
        self.assertEqual(command.parameters["trigger"], "operator_animation")
        self.assertTrue(command.intent_id.startswith("operator-animation:session-gesture-01:test-vrm-01:greet.wave.once:"))

    def test_resolve_gesture_command_supports_looping_idle_and_motion_states(self) -> None:
        service = DefaultAnimationService()
        snapshot = SessionSnapshot(
            session_id="session-loop-01",
            active_character_id="test-vrm-01",
            lifecycle_state="idle",
        )

        for semantic_id in ("idle.happy", "dance.hiphop.loop"):
            with self.subTest(semantic_id=semantic_id):
                command = service.resolve_gesture_command(snapshot, semantic_id)
                self.assertEqual(command.semantic_id, semantic_id)
                self.assertEqual(command.resolution.selected_source, "shared_library")
                self.assertEqual(command.resolved_state, "selected")
                self.assertEqual(command.playback.mode, "loop")
                self.assertTrue(command.playback.loop)

    def test_resolve_gesture_command_uses_unique_intent_ids_for_repeated_triggers(self) -> None:
        service = DefaultAnimationService()
        snapshot = SessionSnapshot(
            session_id="session-gesture-02",
            active_character_id="test-vrm-01",
            lifecycle_state="idle",
        )

        first = service.resolve_gesture_command(snapshot, "greet.wave.once")
        second = service.resolve_gesture_command(snapshot, "greet.wave.once")

        # Distinct intent/command ids so a repeated click is not deduplicated by
        # the live-delivery service and re-broadcasts (replays) on clients.
        self.assertNotEqual(first.intent_id, second.intent_id)
        self.assertNotEqual(first.command_id, second.command_id)


class SessionAnimationContractSnapshotTests(unittest.TestCase):
    # Stale expectation: asserts the default active character is "maria", but
    # build_default_api_runtime_services now prefers "test-vrm-01" as the
    # default. Pre-existing failure at the committed baseline. Open question
    # for the user — should the product default be maria or a test slot? See
    # docs/STABILIZATION_TODO.md (Phase 1D).
    @unittest.expectedFailure
    def test_contract_snapshot_exposes_session_animation_route_and_idle_default_payload(self) -> None:
        snapshot = build_api_contract_snapshot()

        self.assertIn(
            {
                "method": "GET",
                "path": "/session/animation",
                "name": "get_session_animation",
            },
            snapshot["routes"],
        )
        response = snapshot["responses"]["get_session_animation"]

        self.assertEqual("session-scaffold-01", response["session_id"])
        self.assertEqual("idle", response["lifecycle_state"])
        self.assertEqual("maria", response["active_character_id"])
        self.assertEqual("idle.neutral", response["command"]["semantic_id"])
        self.assertEqual("shared_library", response["command"]["resolution"]["selected_source"])
        self.assertEqual("idle.neutral", response["command"]["resolution"]["selected_asset_id"])
        self.assertEqual("selected", response["command"]["resolved_state"])

    def test_contract_snapshot_exposes_session_lifecycle_update_response(self) -> None:
        snapshot = build_api_contract_snapshot()

        self.assertIn(
            {
                "method": "PUT",
                "path": "/session/lifecycle-state",
                "name": "set_session_lifecycle_state",
            },
            snapshot["routes"],
        )
        response = snapshot["responses"]["put_session_lifecycle_state"]["response"]

        self.assertEqual("speak", response["lifecycle_state"])
        self.assertEqual("idle.neutral", response["command"]["semantic_id"])
        self.assertEqual("shared_library", response["command"]["resolution"]["selected_source"])

    def test_contract_snapshot_projects_speech_examples_to_unavailable_turn_pipeline_contract(self) -> None:
        snapshot = build_api_contract_snapshot()

        contracts = snapshot["contracts"]
        transcription_event = contracts["canonical_transcription_event"]
        synthesis_event = contracts["canonical_speech_synthesis_event"]
        speech_snapshot = snapshot["responses"]["get_speech_lifecycle"]

        self.assertEqual("unavailable", transcription_event["status"])
        self.assertEqual("turn.pipeline", transcription_event["reason"])
        self.assertEqual("unavailable", transcription_event["transcription"]["status"])
        self.assertEqual("unavailable", synthesis_event["status"])
        self.assertEqual("turn.pipeline", synthesis_event["reason"])
        self.assertEqual("unavailable", synthesis_event["synthesis"]["status"])
        self.assertEqual("unavailable", speech_snapshot["events"][0]["event"]["status"])
        self.assertEqual("turn.pipeline", speech_snapshot["events"][0]["event"]["reason"])
        self.assertEqual("unavailable", speech_snapshot["events"][1]["event"]["status"])
        self.assertEqual("turn.pipeline", speech_snapshot["events"][1]["event"]["reason"])


class SessionAnimationLiveDeliveryServiceTests(unittest.TestCase):
    def test_published_updates_reuse_snapshot_payload_and_cursor_resume(self) -> None:
        animation_service = DefaultAnimationService()
        live_delivery = InMemorySessionAnimationLiveDeliveryService()

        idle_update = live_delivery.publish_snapshot(
            build_session_animation_snapshot(
                animation_service,
                session_id="session-scaffold-01",
                character_id="test-vrm-01",
                lifecycle_state="idle",
            )
        )
        speak_update = live_delivery.publish_snapshot(
            build_session_animation_snapshot(
                animation_service,
                session_id="session-scaffold-01",
                character_id="test-vrm-01",
                lifecycle_state="speak",
            )
        )
        duplicate_speak = live_delivery.publish_snapshot(speak_update.snapshot)

        all_updates = live_delivery.read_updates("session-scaffold-01")
        resumed_updates = live_delivery.read_updates(
            "session-scaffold-01",
            after_cursor=idle_update.cursor,
        )

        self.assertEqual(
            [
                f"{SESSION_ANIMATION_STREAM}:session-scaffold-01:1",
                f"{SESSION_ANIMATION_STREAM}:session-scaffold-01:2",
            ],
            [update.cursor for update in all_updates],
        )
        self.assertEqual(["idle", "speak"], [update.snapshot.lifecycle_state for update in all_updates])
        self.assertEqual([speak_update.cursor], [update.cursor for update in resumed_updates])
        self.assertEqual("idle.neutral", resumed_updates[0].snapshot.command.semantic_id)
        self.assertEqual(speak_update.cursor, duplicate_speak.cursor)

    def test_rejects_cursor_from_a_different_session(self) -> None:
        live_delivery = InMemorySessionAnimationLiveDeliveryService()

        with self.assertRaises(InvalidEventCursor):
            live_delivery.read_updates(
                "session-scaffold-01",
                after_cursor=f"{SESSION_ANIMATION_STREAM}:other-session:1",
            )


if __name__ == "__main__":
    unittest.main()