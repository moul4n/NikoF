from __future__ import annotations

from dataclasses import dataclass


@dataclass(slots=True, frozen=True)
class CharacterManifest:
    character_id: str
    display_name: str
    asset_version: str
    vrm_spec_version: str
    model_file: str
    metadata_file: str
    supported_states: list[str]
    shared_animation_set: str
    expression_map: str
    animation_overrides: str
    voice_profile_id: str
    voice_profile_path: str


@dataclass(slots=True, frozen=True)
class CharacterSummary:
    character_id: str
    display_name: str
    asset_version: str
    vrm_spec_version: str
    shared_animation_set: str
    supported_states: list[str]


@dataclass(slots=True, frozen=True)
class ActiveCharacterSelection:
    character_id: str
    reason: str = "user_selected"
