"""Durable "last used audio output device" preference for avatar speech playback.

Selecting an output device (speaker/headphones) is a browser concern — playback
runs in the front-end via ``HTMLAudioElement.setSinkId``. This store keeps only
the *choice* (the device id + a human label) so it survives a backend restart and
is served to every front-end surface on load, rather than living in one page's
localStorage. The browser enumerates the actual devices and applies the sink id.

Presentation-only: deliberately NOT part of the session animation/speech
contracts. Mirrors the durable stage backdrop selection in stage_view.py.

Shape on disk / over the wire:
    { "device_id": "<deviceId>" | null, "device_label": "<label>" | null }
A null ``device_id`` means "use the system default output device".
"""
from __future__ import annotations

from dataclasses import dataclass
import json
import logging
from pathlib import Path

logger = logging.getLogger(__name__)


@dataclass(slots=True)
class AudioOutputSettingsState:
    """Selected audio output device for avatar speech playback. The control
    surface writes it; every surface that plays audio reads it and applies the
    sink id to its playback elements.

    Persisted to disk when ``state_path`` is set (None = in-memory only, for
    tests) so the choice survives a backend restart."""

    state_path: Path | None = None
    device_id: str | None = None
    device_label: str | None = None

    def __post_init__(self) -> None:
        self._restore()

    def _restore(self) -> None:
        if self.state_path is None:
            return
        try:
            raw = self.state_path.read_text(encoding="utf-8")
        except (FileNotFoundError, OSError):
            return
        try:
            data = json.loads(raw)
        except ValueError:
            return
        if not isinstance(data, dict):
            return
        stored_id = data.get("device_id")
        if isinstance(stored_id, str) and stored_id:
            self.device_id = stored_id
        stored_label = data.get("device_label")
        if isinstance(stored_label, str) and stored_label:
            self.device_label = stored_label

    def _persist(self) -> None:
        if self.state_path is None:
            return
        try:
            self.state_path.parent.mkdir(parents=True, exist_ok=True)
            self.state_path.write_text(json.dumps(self.to_document()), encoding="utf-8")
        except OSError:
            logger.warning("Failed to persist audio output settings to %s", self.state_path, exc_info=True)

    def to_document(self) -> dict:
        return {"device_id": self.device_id, "device_label": self.device_label}

    def snapshot(self) -> dict:
        return self.to_document()

    def set_device(self, device_id: str | None, device_label: str | None = None) -> dict:
        """Set the selected output device (None = system default) and persist."""
        self.device_id = device_id or None
        self.device_label = (device_label or None) if self.device_id else None
        self._persist()
        return self.to_document()


_audio_output_settings_state: AudioOutputSettingsState | None = None


def get_audio_output_settings_state() -> AudioOutputSettingsState:
    """Process-wide durable audio-output selection, created lazily under the app's
    local data root (same root as the persisted display settings and stage view)."""
    global _audio_output_settings_state
    if _audio_output_settings_state is None:
        from app.core.settings import get_app_paths

        _audio_output_settings_state = AudioOutputSettingsState(
            state_path=get_app_paths().local_data_root / "session" / "audio-output.json"
        )
    return _audio_output_settings_state
