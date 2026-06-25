"""Last-interaction timestamp for the companion's "time since we last talked".

Pure local, no network (live-info Stage A). The turn pipeline marks an
interaction on each user turn (while ambient context is enabled); the ambient
block reads the elapsed time so the companion can greet a return naturally
("welcome back, it's been a few days"). Persisted to disk so the gap survives a
restart — mirrors the other small session stores.

Shape on disk: { "last_epoch": 1750000000.0 }
"""
from __future__ import annotations

from dataclasses import dataclass
import json
import logging
from pathlib import Path

logger = logging.getLogger(__name__)


@dataclass(slots=True)
class LastInteractionState:
    """The wall-clock epoch of the last user turn, optionally persisted to
    `state_path` (None = in-memory only, for tests)."""

    state_path: Path | None = None
    last_epoch: float | None = None

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
        if isinstance(data, dict):
            value = data.get("last_epoch")
            if isinstance(value, (int, float)) and not isinstance(value, bool):
                self.last_epoch = float(value)

    def _persist(self) -> None:
        if self.state_path is None:
            return
        try:
            self.state_path.parent.mkdir(parents=True, exist_ok=True)
            self.state_path.write_text(json.dumps({"last_epoch": self.last_epoch}), encoding="utf-8")
        except OSError:
            logger.debug("Failed to persist last-interaction timestamp to %s", self.state_path, exc_info=True)

    def seconds_since(self, now_epoch: float) -> float | None:
        """Elapsed seconds since the last marked interaction, or None when there
        is no prior interaction (or the clock went backwards)."""
        if self.last_epoch is None:
            return None
        delta = now_epoch - self.last_epoch
        return delta if delta >= 0 else None

    def mark(self, now_epoch: float) -> None:
        self.last_epoch = now_epoch
        self._persist()


_last_interaction_state: LastInteractionState | None = None


def get_last_interaction_state() -> LastInteractionState:
    """Process-wide durable last-interaction timestamp, under the app data root."""
    global _last_interaction_state
    if _last_interaction_state is None:
        from app.core.settings import get_app_paths

        _last_interaction_state = LastInteractionState(
            state_path=get_app_paths().local_data_root / "session" / "last-interaction.json"
        )
    return _last_interaction_state
