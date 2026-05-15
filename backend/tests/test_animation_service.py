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

    def test_prefers_shared_semantic_over_character_override(self) -> None:
        service = DefaultAnimationService(
            character_overrides={
                "test-vrm-01": {
                    "greet.wave.once": "override.wave.once",
                }
            }
        )

        command = service.resolve_intent(
            AnimationIntent(
                intent_id="anim-intent-1",
                session_id="session-1",
                character_id="test-vrm-01",
                intent_type="gesture",
                semantic_id="greet.wave.once",
                source="assistant_reply",
            )
        )

        self.assertEqual(command.semantic_id, "greet.wave.once")
        self.assertEqual(command.resolution.selected_source, "shared_library")
        self.assertEqual(command.resolution.selected_asset_id, "greet.wave.once")
        self.assertIsNone(command.resolution.override_character_id)
        self.assertEqual(command.playback.mode, "oneshot")

    def test_uses_character_override_when_shared_semantic_is_missing(self) -> None:
        service = DefaultAnimationService(
            character_overrides={
                "test-vrm-02": {
                    "gesture.salute.once": "character.salute.once",
                }
            }
        )

        command = service.resolve_intent(
            AnimationIntent(
                intent_id="anim-intent-2",
                session_id="session-2",
                character_id="test-vrm-02",
                intent_type="gesture",
                semantic_id="gesture.salute.once",
                source="assistant_reply",
            )
        )

        self.assertEqual(command.semantic_id, "gesture.salute.once")
        self.assertEqual(command.resolution.selected_source, "character_override")
        self.assertEqual(command.resolution.selected_asset_id, "character.salute.once")
        self.assertEqual(command.resolution.override_character_id, "test-vrm-02")
        self.assertEqual(command.playback.mode, "oneshot")

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

        self.assertEqual(command.semantic_id, "idle.default")
        self.assertEqual(command.resolution.selected_source, "shared_library")
        self.assertEqual(command.resolution.selected_asset_id, "idle.default")
        self.assertEqual(command.resolved_state, "selected")
        self.assertEqual(command.playback.mode, "loop")
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

        self.assertEqual(command.semantic_id, "speak.loop")
        self.assertEqual(command.resolution.selected_source, "shared_library")
        self.assertEqual(command.resolution.selected_asset_id, "speak.loop")
        self.assertEqual(command.resolved_state, "selected")
        self.assertEqual(command.playback.mode, "loop")
        self.assertEqual(command.playback.expected_duration_ms, 8333)
        self.assertEqual(command.parameters["session_state"], "speak")


class SessionAnimationContractSnapshotTests(unittest.TestCase):
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
        self.assertEqual("test-vrm-01", response["active_character_id"])
        self.assertEqual("idle.default", response["command"]["semantic_id"])
        self.assertEqual("shared_library", response["command"]["resolution"]["selected_source"])
        self.assertEqual("idle.default", response["command"]["resolution"]["selected_asset_id"])
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
        self.assertEqual("speak.loop", response["command"]["semantic_id"])
        self.assertEqual("shared_library", response["command"]["resolution"]["selected_source"])


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
        self.assertEqual("speak.loop", resumed_updates[0].snapshot.command.semantic_id)
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