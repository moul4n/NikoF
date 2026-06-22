"""Durable display + wardrobe settings for the stage / display window.

The control surface writes these; the stage/display window polls them and
applies them (bone-overlay debug guide, captions on/off, and per-character
wardrobe control values). Persisted to disk so they survive restarts —
mirrors the active-character persistence in session.py, and the poll-based
control→display delivery of stage_view.py. Presentation-only: deliberately
NOT part of the session animation/speech contracts.

Shape on disk / over the wire:
    {
      "global": { "bone_overlay": false, "captions": true },
      "characters": { "<characterId>": { "<controlId>": <0..1 value> } }
    }
Bone overlay + captions are global; wardrobe control values are per character
(toggles are 0/1, sliders 0..1 — clamped to [0, 1]).
"""
from __future__ import annotations

from dataclasses import dataclass, field
import json
import logging
from pathlib import Path

logger = logging.getLogger(__name__)

DEFAULT_BONE_OVERLAY = False
DEFAULT_CAPTIONS = True


def _clamp_unit(value: float) -> float:
    return max(0.0, min(1.0, value))


@dataclass(slots=True)
class DisplaySettingsService:
    """Global display toggles + per-character wardrobe values, optionally
    persisted to `state_path` (None = in-memory only, for tests)."""

    state_path: Path | None = None
    bone_overlay: bool = DEFAULT_BONE_OVERLAY
    captions: bool = DEFAULT_CAPTIONS
    _wardrobe: dict[str, dict[str, float]] = field(default_factory=dict)

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
        global_settings = data.get("global")
        if isinstance(global_settings, dict):
            if isinstance(global_settings.get("bone_overlay"), bool):
                self.bone_overlay = global_settings["bone_overlay"]
            if isinstance(global_settings.get("captions"), bool):
                self.captions = global_settings["captions"]
        characters = data.get("characters")
        if isinstance(characters, dict):
            for character_id, controls in characters.items():
                if not isinstance(character_id, str) or not isinstance(controls, dict):
                    continue
                resolved = {
                    control_id: _clamp_unit(float(value))
                    for control_id, value in controls.items()
                    if isinstance(control_id, str) and isinstance(value, (int, float)) and not isinstance(value, bool)
                }
                if resolved:
                    self._wardrobe[character_id] = resolved

    def _persist(self) -> None:
        if self.state_path is None:
            return
        try:
            self.state_path.parent.mkdir(parents=True, exist_ok=True)
            self.state_path.write_text(json.dumps(self.to_document()), encoding="utf-8")
        except OSError:
            logger.warning("Failed to persist display settings to %s", self.state_path, exc_info=True)

    def to_document(self) -> dict:
        return {
            "global": {"bone_overlay": self.bone_overlay, "captions": self.captions},
            "characters": {character_id: dict(controls) for character_id, controls in self._wardrobe.items()},
        }

    def snapshot(self) -> dict:
        return self.to_document()

    def update(
        self,
        *,
        bone_overlay: bool | None = None,
        captions: bool | None = None,
        wardrobe: dict[str, dict[str, float]] | None = None,
    ) -> dict:
        """Merge a partial update and persist. `wardrobe` is keyed by character
        id then control id; values are clamped to [0, 1]."""
        if isinstance(bone_overlay, bool):
            self.bone_overlay = bone_overlay
        if isinstance(captions, bool):
            self.captions = captions
        if isinstance(wardrobe, dict):
            for character_id, controls in wardrobe.items():
                if not isinstance(character_id, str) or not isinstance(controls, dict):
                    continue
                resolved = {
                    control_id: _clamp_unit(float(value))
                    for control_id, value in controls.items()
                    if isinstance(control_id, str) and isinstance(value, (int, float)) and not isinstance(value, bool)
                }
                if resolved:
                    self._wardrobe.setdefault(character_id, {}).update(resolved)
        self._persist()
        return self.to_document()


_display_settings_state: DisplaySettingsService | None = None


def get_display_settings_state() -> DisplaySettingsService:
    """Process-wide durable display settings, created lazily under the app's
    local data root (same root as the persisted active-character selection)."""
    global _display_settings_state
    if _display_settings_state is None:
        from app.core.settings import get_app_paths

        _display_settings_state = DisplaySettingsService(
            state_path=get_app_paths().local_data_root / "session" / "display-settings.json"
        )
    return _display_settings_state
