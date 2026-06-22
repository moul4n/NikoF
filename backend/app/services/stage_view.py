from __future__ import annotations

from dataclasses import dataclass

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
    writes it; the stage window polls it and applies it to the renderer."""

    background_id: str = DEFAULT_STAGE_BACKGROUND_ID

    def set_background(self, background_id: str) -> str:
        self.background_id = background_id
        return self.background_id


_stage_view_state = StageViewState()


def get_stage_view_state() -> StageViewState:
    return _stage_view_state
