from __future__ import annotations

from dataclasses import dataclass

from pydantic.dataclasses import dataclass as pydantic_dataclass


@dataclass(slots=True, frozen=True)
class CharacterManifest:
    schema_version: int
    character_id: str
    display_name: str
    identity_source: str
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
    schema_version: int
    character_id: str
    display_name: str
    identity_source: str
    vrm_spec_version: str
    shared_animation_set: str
    supported_states: list[str]


@dataclass(slots=True, frozen=True)
class CharacterCatalogResponse:
    schema_version: int
    active_character_id: str
    characters: list[CharacterSummary]


@pydantic_dataclass(slots=True, frozen=True)
class ActiveCharacterSelection:
    character_id: str
    reason: str = "user_selected"
