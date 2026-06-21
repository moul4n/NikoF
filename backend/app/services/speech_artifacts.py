"""Public speech-audio artifact projection helpers.

Extracted from speech.py: the logic that turns a machine-local synthesis
``audio_reference`` into a browser-safe public ``/api/session/speech-artifacts``
URL, and projects session events / lifecycle envelopes / snapshots so the
frontend never receives a raw filesystem path. Pure functions over the session
schema + app paths — no adapters, registries, or event store.

speech.py re-exports these so existing ``app.services.speech.X`` imports
(operator_routes, turns, tts_worker, session_routes) keep resolving.
"""

from __future__ import annotations

from dataclasses import replace
from pathlib import Path
from typing import Any

from app.core.settings import get_app_paths
from app.schemas.session import (
    SessionEvent,
    SpeechLifecycleEventEnvelope,
    SpeechLifecycleTransportSnapshot,
)


PUBLIC_SESSION_SPEECH_ARTIFACT_PREFIX = "/api/session/speech-artifacts"


def _normalize_audio_reference(raw_value: Any, *, provider_root: Path, model_root: Path) -> str | None:
    if not isinstance(raw_value, str) or not raw_value.strip():
        return None

    normalized_value = raw_value.strip()
    if "://" in normalized_value:
        return normalized_value

    raw_path = Path(normalized_value)
    if raw_path.is_absolute():
        return str(raw_path) if raw_path.exists() else None

    for base_root in (provider_root, model_root):
        resolved = (base_root / raw_path).resolve()
        if resolved.exists():
            return str(resolved)

    return None


def _looks_like_machine_local_audio_reference(raw_value: str) -> bool:
    normalized_value = raw_value.strip()
    if not normalized_value or normalized_value.startswith("session://"):
        return False

    if "://" in normalized_value:
        return False

    return Path(normalized_value).is_absolute()


def _is_relative_to(path: Path, root: Path) -> bool:
    try:
        path.relative_to(root)
    except ValueError:
        return False

    return True


def _resolve_public_speech_audio_artifact_path(audio_reference: str) -> Path | None:
    if not _looks_like_machine_local_audio_reference(audio_reference):
        return None

    audio_path = Path(audio_reference).resolve()
    if not audio_path.is_file():
        return None

    app_paths = get_app_paths()
    allowed_roots = (
        app_paths.tts_models_root.resolve(),
        app_paths.cache_root.resolve(),
    )
    if not any(_is_relative_to(audio_path, root) for root in allowed_roots):
        return None

    return audio_path


def build_public_speech_audio_reference(*, event_id: str) -> str:
    return f"{PUBLIC_SESSION_SPEECH_ARTIFACT_PREFIX}/{event_id}/audio"


def project_public_session_event(
    event: SessionEvent,
    *,
    audio_event_id: str | None = None,
) -> SessionEvent:
    synthesis = event.synthesis
    if synthesis is None or synthesis.audio_reference is None or audio_event_id is None:
        return event

    if _resolve_public_speech_audio_artifact_path(synthesis.audio_reference) is None:
        return event

    return replace(
        event,
        synthesis=replace(
            synthesis,
            audio_reference=build_public_speech_audio_reference(event_id=audio_event_id),
        ),
    )


def project_public_speech_lifecycle_envelope(
    envelope: SpeechLifecycleEventEnvelope,
) -> SpeechLifecycleEventEnvelope:
    projected_event = project_public_session_event(
        envelope.event,
        audio_event_id=envelope.event_id,
    )
    if projected_event == envelope.event:
        return envelope

    return replace(envelope, event=projected_event)


def project_public_speech_lifecycle_snapshot(
    snapshot: SpeechLifecycleTransportSnapshot,
) -> SpeechLifecycleTransportSnapshot:
    return replace(
        snapshot,
        events=tuple(project_public_speech_lifecycle_envelope(envelope) for envelope in snapshot.events),
    )
