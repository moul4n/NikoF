"""Durable ambient-context settings for the companion planner prompt.

Live-info Stage A (docs/LIVE_INFO_TOOLS.md). The operator/control surface writes
these; the turn pipeline reads them live (per turn) when building the advisory
`[AMBIENT]` block, so a change applies without a backend restart.

Persisted to disk so the choice survives a restart — mirrors the durable
presentation settings in stage_view.py / display_settings.py. This is NOT part of
the session animation/speech contracts; it only influences prompt text.

Shape on disk / over the wire:
    { "enabled": false, "timezone": "Europe/London", "location": "" }

`timezone` is an optional IANA name; empty means "fall back to the default"
(Europe/London) at render time. `location` is a free-text label (empty = omitted
from the prompt; no geocoding here — that arrives with Stage B weather).
"""
from __future__ import annotations

from dataclasses import dataclass
import json
import logging
from pathlib import Path

logger = logging.getLogger(__name__)

# GB / London is the configured home zone by default (single-machine UK box).
# An empty stored timezone falls back to this at render time.
DEFAULT_AMBIENT_TIMEZONE = "Europe/London"


@dataclass(slots=True)
class AmbientContextState:
    """Enabled flag + timezone + location for the ambient prompt block,
    optionally persisted to `state_path` (None = in-memory only, for tests)."""

    state_path: Path | None = None
    enabled: bool = False
    timezone: str = DEFAULT_AMBIENT_TIMEZONE
    location: str = ""

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
        if isinstance(data.get("enabled"), bool):
            self.enabled = data["enabled"]
        if isinstance(data.get("timezone"), str):
            self.timezone = data["timezone"].strip()
        if isinstance(data.get("location"), str):
            self.location = data["location"].strip()

    def _persist(self) -> None:
        if self.state_path is None:
            return
        try:
            self.state_path.parent.mkdir(parents=True, exist_ok=True)
            self.state_path.write_text(json.dumps(self.to_document()), encoding="utf-8")
        except OSError:
            logger.warning("Failed to persist ambient-context settings to %s", self.state_path, exc_info=True)

    def to_document(self) -> dict:
        return {
            "enabled": self.enabled,
            "timezone": self.timezone,
            "location": self.location,
        }

    def snapshot(self) -> dict:
        return self.to_document()

    def update(
        self,
        *,
        enabled: bool | None = None,
        timezone: str | None = None,
        location: str | None = None,
    ) -> dict:
        """Merge a partial update and persist. `timezone`/`location` are trimmed;
        an empty timezone is allowed (render falls back to the default zone)."""
        if isinstance(enabled, bool):
            self.enabled = enabled
        if isinstance(timezone, str):
            self.timezone = timezone.strip()
        if isinstance(location, str):
            self.location = location.strip()
        self._persist()
        return self.to_document()


_ambient_context_state: AmbientContextState | None = None


def get_ambient_context_state() -> AmbientContextState:
    """Process-wide durable ambient-context settings, created lazily under the
    app's local data root (same root as the persisted display/stage settings).

    First-run defaults are seeded from the NIKOF_AMBIENT_* env knobs (so a
    headless/backend-only run can still configure them), then any persisted file
    overrides; after that the control surface is the source of truth."""
    global _ambient_context_state
    if _ambient_context_state is None:
        from app.core.settings import get_app_paths
        from app.core.runtime_tuning import get_runtime_tuning

        tuning = get_runtime_tuning()
        _ambient_context_state = AmbientContextState(
            state_path=get_app_paths().local_data_root / "session" / "ambient-context.json",
            enabled=tuning.ambient_context_enabled,
            timezone=(tuning.ambient_timezone.strip() or DEFAULT_AMBIENT_TIMEZONE),
            location=tuning.ambient_location.strip(),
        )
    return _ambient_context_state
