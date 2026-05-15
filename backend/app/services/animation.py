from __future__ import annotations

from dataclasses import dataclass, field, replace
import time
from typing import Iterator, Protocol

from app.schemas.animation import (
    DEFAULT_FALLBACK_SEMANTIC_ID,
    AnimationCommand,
    AnimationIntent,
    AnimationPlayback,
    AnimationResolution,
    SessionAnimationSnapshot,
)
from app.schemas.session import SessionSnapshot
from app.services.session import InvalidEventCursor


DEFAULT_SHARED_ANIMATION_IDS = frozenset(
    {
        DEFAULT_FALLBACK_SEMANTIC_ID,
        "listen.attentive.loop",
        "listen.loop",
        "speak.loop",
        "reply.speaking.loop",
        "greet.wave.once",
    }
)

SESSION_ANIMATION_STREAM = "session.animation"

SESSION_LIFECYCLE_TO_SEMANTIC_ID = {
    "idle": DEFAULT_FALLBACK_SEMANTIC_ID,
    "listen": "listen.loop",
    "speak": "speak.loop",
}

DEFAULT_PLAYBACK_LIBRARY = {
    DEFAULT_FALLBACK_SEMANTIC_ID: AnimationPlayback(
        mode="loop",
        blend_hint="base_full_body",
        expected_duration_ms=8333,
        loop=True,
    ),
    "listen.loop": AnimationPlayback(
        mode="loop",
        blend_hint="base_full_body",
        expected_duration_ms=8333,
        loop=True,
    ),
    "speak.loop": AnimationPlayback(
        mode="loop",
        blend_hint="speech_support",
        expected_duration_ms=8333,
        loop=True,
    ),
    "reply.speaking.loop": AnimationPlayback(
        mode="loop",
        blend_hint="speech_support",
        loop=True,
    ),
    "greet.wave.once": AnimationPlayback(
        mode="oneshot",
        blend_hint="upper_body_additive",
        expected_duration_ms=1400,
        loop=False,
    ),
}


def _clamp_intensity(value: float) -> float:
    return max(0.0, min(1.0, value))


def _build_command_id(intent: AnimationIntent) -> str:
    return f"anim-cmd:{intent.intent_id}"


def _build_session_intent_id(snapshot: SessionSnapshot) -> str:
    return (
        f"session-animation:{snapshot.session_id}:"
        f"{snapshot.active_character_id}:{snapshot.lifecycle_state}"
    )


def _resolve_session_semantic_id(lifecycle_state: str) -> str:
    return SESSION_LIFECYCLE_TO_SEMANTIC_ID.get(lifecycle_state, DEFAULT_FALLBACK_SEMANTIC_ID)


def _default_playback_for(semantic_id: str) -> AnimationPlayback:
    if semantic_id.endswith(".loop"):
        return AnimationPlayback(
            mode="loop",
            blend_hint="base_full_body",
            loop=True,
        )

    return AnimationPlayback(
        mode="oneshot",
        blend_hint="upper_body_additive",
        expected_duration_ms=900,
        loop=False,
    )


def _parse_animation_cursor(
    *,
    session_id: str,
    cursor: str | None,
) -> int:
    if cursor is None:
        return 0

    cursor_stream, separator, remainder = cursor.partition(":")
    if not separator:
        raise InvalidEventCursor(f"Invalid cursor format: {cursor}")

    cursor_session_id, separator, sequence_text = remainder.partition(":")
    if not separator:
        raise InvalidEventCursor(f"Invalid cursor format: {cursor}")

    if cursor_stream != SESSION_ANIMATION_STREAM or cursor_session_id != session_id:
        raise InvalidEventCursor(
            f"Cursor {cursor} does not belong to {SESSION_ANIMATION_STREAM} for session {session_id}."
        )

    try:
        sequence = int(sequence_text)
    except ValueError as error:
        raise InvalidEventCursor(f"Invalid cursor sequence: {cursor}") from error

    if sequence < 0:
        raise InvalidEventCursor(f"Cursor sequence must be non-negative: {cursor}")

    return sequence


@dataclass(slots=True, frozen=True)
class SessionAnimationUpdate:
    sequence: int
    cursor: str
    snapshot: SessionAnimationSnapshot


class AnimationService(Protocol):
    """Boundary for engine-neutral animation intent resolution."""

    def resolve_intent(self, intent: AnimationIntent) -> AnimationCommand:
        raise NotImplementedError

    def resolve_session_command(self, snapshot: SessionSnapshot) -> AnimationCommand:
        raise NotImplementedError


class SessionAnimationLiveDeliveryService(Protocol):
    """Boundary for streaming backend-owned session animation snapshots."""

    def publish_snapshot(self, snapshot: SessionAnimationSnapshot) -> SessionAnimationUpdate:
        raise NotImplementedError

    def read_updates(
        self,
        session_id: str,
        *,
        after_cursor: str | None = None,
    ) -> tuple[SessionAnimationUpdate, ...]:
        raise NotImplementedError

    def iter_live_updates(
        self,
        session_id: str,
        *,
        cursor: str | None = None,
        poll_interval_seconds: float = 0.25,
    ) -> Iterator[SessionAnimationUpdate]:
        raise NotImplementedError


@dataclass(slots=True)
class DefaultAnimationService:
    """Resolves semantic animation intents into normalized playback commands."""

    shared_animation_ids: frozenset[str] = field(default_factory=lambda: DEFAULT_SHARED_ANIMATION_IDS)
    character_overrides: dict[str, dict[str, str]] = field(default_factory=dict)
    playback_library: dict[str, AnimationPlayback] = field(default_factory=lambda: dict(DEFAULT_PLAYBACK_LIBRARY))

    def resolve_intent(self, intent: AnimationIntent) -> AnimationCommand:
        resolution, semantic_id = self._resolve_semantic(intent)
        playback = self.playback_library.get(semantic_id) or self.playback_library.get(
            resolution.selected_asset_id
        )

        return AnimationCommand(
            command_id=_build_command_id(intent),
            intent_id=intent.intent_id,
            session_id=intent.session_id,
            character_id=intent.character_id,
            semantic_id=semantic_id,
            resolved_state="queued",
            resolution=resolution,
            playback=playback or _default_playback_for(semantic_id),
            timing=intent.timing,
            policy=intent.policy,
            intensity=_clamp_intensity(intent.intensity),
            parameters=dict(intent.parameters),
        )

    def resolve_session_command(self, snapshot: SessionSnapshot) -> AnimationCommand:
        semantic_id = _resolve_session_semantic_id(snapshot.lifecycle_state)
        command = self.resolve_intent(
            AnimationIntent(
                intent_id=_build_session_intent_id(snapshot),
                session_id=snapshot.session_id,
                character_id=snapshot.active_character_id,
                intent_type="state",
                semantic_id=semantic_id,
                source="session_state",
                requested_state="replace",
                parameters={"session_state": snapshot.lifecycle_state},
                reason="Backend resolved the current session base animation.",
            )
        )
        return replace(command, resolved_state="selected")

    def _resolve_semantic(self, intent: AnimationIntent) -> tuple[AnimationResolution, str]:
        if intent.semantic_id in self.shared_animation_ids:
            return (
                AnimationResolution(
                    selected_source="shared_library",
                    selected_asset_id=intent.semantic_id,
                ),
                intent.semantic_id,
            )

        character_assets = self.character_overrides.get(intent.character_id, {})
        override_asset_id = character_assets.get(intent.semantic_id)
        if override_asset_id is not None:
            return (
                AnimationResolution(
                    selected_source="character_override",
                    selected_asset_id=override_asset_id,
                    override_character_id=intent.character_id,
                ),
                intent.semantic_id,
            )

        fallback_semantic_id = intent.policy.fallback_semantic_id or DEFAULT_FALLBACK_SEMANTIC_ID
        return (
            AnimationResolution(
                selected_source="fallback",
                selected_asset_id=fallback_semantic_id,
                fallback_applied=fallback_semantic_id != intent.semantic_id,
            ),
            fallback_semantic_id,
        )


@dataclass(slots=True)
class InMemorySessionAnimationLiveDeliveryService:
    """Scoped in-memory live delivery for backend-owned animation snapshots."""

    _updates_by_session: dict[str, list[SessionAnimationUpdate]] = field(
        default_factory=dict,
        init=False,
        repr=False,
    )

    def publish_snapshot(self, snapshot: SessionAnimationSnapshot) -> SessionAnimationUpdate:
        updates = self._updates_by_session.setdefault(snapshot.session_id, [])
        if updates and updates[-1].snapshot == snapshot:
            return updates[-1]

        sequence = len(updates) + 1
        update = SessionAnimationUpdate(
            sequence=sequence,
            cursor=f"{SESSION_ANIMATION_STREAM}:{snapshot.session_id}:{sequence}",
            snapshot=snapshot,
        )
        updates.append(update)
        return update

    def read_updates(
        self,
        session_id: str,
        *,
        after_cursor: str | None = None,
    ) -> tuple[SessionAnimationUpdate, ...]:
        after_sequence = _parse_animation_cursor(session_id=session_id, cursor=after_cursor)
        updates = self._updates_by_session.get(session_id, [])
        return tuple(update for update in updates if update.sequence > after_sequence)

    def iter_live_updates(
        self,
        session_id: str,
        *,
        cursor: str | None = None,
        poll_interval_seconds: float = 0.25,
    ) -> Iterator[SessionAnimationUpdate]:
        next_sequence = _parse_animation_cursor(session_id=session_id, cursor=cursor) + 1

        while True:
            updates = self._updates_by_session.get(session_id, [])
            yielded = False

            for update in updates:
                if update.sequence < next_sequence:
                    continue

                yield update
                next_sequence = update.sequence + 1
                yielded = True

            if yielded:
                continue

            time.sleep(poll_interval_seconds)


StubAnimationService = DefaultAnimationService
