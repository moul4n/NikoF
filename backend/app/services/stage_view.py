from __future__ import annotations

from dataclasses import dataclass
import json
import logging
from pathlib import Path

logger = logging.getLogger(__name__)

# Backdrop options for the stage / display window. Presentation-only: this is
# deliberately NOT part of the session animation/speech contracts. Keep this set
# in sync with the frontend STAGE_BACKGROUND_PRESETS as future scenes are added.
KNOWN_STAGE_BACKGROUND_IDS: tuple[str, ...] = ("plain", "transparent")
DEFAULT_STAGE_BACKGROUND_ID = "plain"


def is_known_stage_background_id(background_id: str) -> bool:
    return background_id in KNOWN_STAGE_BACKGROUND_IDS


@dataclass(slots=True)
class StageViewState:
    """In-memory backdrop selection for the stage window. The control surface
    writes it; the stage window polls it and applies it to the renderer.

    Persisted to disk when ``state_path`` is set (None = in-memory only, for
    tests) so the transparent/plain choice survives a backend restart — mirrors
    the durable display settings in display_settings.py."""

    state_path: Path | None = None
    background_id: str = DEFAULT_STAGE_BACKGROUND_ID

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
        stored = data.get("background_id")
        # Guard against a stale/corrupt file pinning an id we no longer ship.
        if isinstance(stored, str) and is_known_stage_background_id(stored):
            self.background_id = stored

    def _persist(self) -> None:
        if self.state_path is None:
            return
        try:
            self.state_path.parent.mkdir(parents=True, exist_ok=True)
            self.state_path.write_text(json.dumps({"background_id": self.background_id}), encoding="utf-8")
        except OSError:
            logger.warning("Failed to persist stage view state to %s", self.state_path, exc_info=True)

    def set_background(self, background_id: str) -> str:
        self.background_id = background_id
        self._persist()
        return self.background_id


_stage_view_state: StageViewState | None = None


def get_stage_view_state() -> StageViewState:
    """Process-wide durable stage backdrop selection, created lazily under the
    app's local data root (same root as the persisted display settings and
    active-character selection)."""
    global _stage_view_state
    if _stage_view_state is None:
        from app.core.settings import get_app_paths

        _stage_view_state = StageViewState(
            state_path=get_app_paths().local_data_root / "session" / "stage-view.json"
        )
    return _stage_view_state
