from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Protocol

from app.core.settings import get_app_paths
from app.schemas.character import CharacterManifest, CharacterSummary


class UnknownCharacterError(LookupError):
    def __init__(self, character_id: str) -> None:
        super().__init__(f"Unknown character package: {character_id}")
        self.character_id = character_id


class CharacterManifestSource(Protocol):
    """Boundary for loading character asset metadata."""

    def load_manifest(self, character_id: str) -> CharacterManifest:
        raise NotImplementedError

    def list_character_ids(self) -> list[str]:
        raise NotImplementedError

    def load_voice_profile(self, character_id: str) -> dict[str, object]:
        raise NotImplementedError


@dataclass(slots=True)
class CharacterVoiceProfile:
    profile_id: str
    provider: str | None = None
    style: str | None = None
    notes: str | None = None
    settings: dict[str, object] = field(default_factory=dict)


@dataclass(slots=True)
class FileSystemCharacterManifestSource:
    """Reads manifest files from assets without leaking raw path logic upstream."""

    characters_root: Path | None = None

    def __post_init__(self) -> None:
        if self.characters_root is None:
            self.characters_root = get_app_paths().character_assets_root

    def list_character_ids(self) -> list[str]:
        return sorted(
            child.name
            for child in self.characters_root.iterdir()
            if child.is_dir() and (child / "manifest.json").exists()
        )

    def load_manifest(self, character_id: str) -> CharacterManifest:
        manifest_path = self._manifest_path(character_id)
        payload = json.loads(manifest_path.read_text(encoding="utf-8"))
        voice_profile = payload.get("voice_profile", {})
        return CharacterManifest(
            schema_version=payload["schema_version"],
            character_id=payload["character_id"],
            display_name=payload["display_name"],
            identity_source=payload["identity_source"],
            asset_version=payload["asset_version"],
            vrm_spec_version=payload["vrm_spec_version"],
            model_file=payload["model_file"],
            metadata_file=payload["metadata_file"],
            supported_states=list(payload.get("supported_states", [])),
            shared_animation_set=payload["shared_animation_set"],
            expression_map=payload["expression_map"],
            animation_overrides=payload["animation_overrides"],
            voice_profile_id=voice_profile.get("profile_id", ""),
            voice_profile_path=voice_profile.get("path", ""),
        )

    def load_voice_profile(self, character_id: str) -> dict[str, object]:
        manifest = self.load_manifest(character_id)
        if not manifest.voice_profile_path:
            return {}

        voice_profile_path = self._character_root(character_id) / manifest.voice_profile_path
        try:
            payload = json.loads(voice_profile_path.read_text(encoding="utf-8"))
        except (FileNotFoundError, json.JSONDecodeError, OSError):
            return {}

        if not isinstance(payload, dict):
            return {}

        return payload

    def _character_root(self, character_id: str) -> Path:
        manifest_path = self._manifest_path(character_id)
        return manifest_path.parent

    def _manifest_path(self, character_id: str) -> Path:
        manifest_path = self.characters_root / character_id / "manifest.json"

        if not manifest_path.exists():
            raise UnknownCharacterError(character_id)

        return manifest_path


@dataclass(slots=True)
class CharacterService:
    manifest_source: CharacterManifestSource

    def list_character_summaries(self) -> list[CharacterSummary]:
        return [
            self._to_summary(self.manifest_source.load_manifest(character_id))
            for character_id in self.manifest_source.list_character_ids()
        ]

    def get_character_summary(self, character_id: str) -> CharacterSummary:
        manifest = self.manifest_source.load_manifest(character_id)
        return self._to_summary(manifest)

    def get_character_voice_profile(self, character_id: str) -> CharacterVoiceProfile:
        manifest = self.manifest_source.load_manifest(character_id)
        payload = self.manifest_source.load_voice_profile(character_id)
        settings = {
            key: value
            for key, value in payload.items()
            if key not in {"profile_id", "provider", "style", "notes"}
        }
        return CharacterVoiceProfile(
            profile_id=str(payload.get("profile_id") or manifest.voice_profile_id or ""),
            provider=(
                str(payload.get("provider"))
                if payload.get("provider") is not None
                else None
            ),
            style=(str(payload.get("style")) if payload.get("style") is not None else None),
            notes=(str(payload.get("notes")) if payload.get("notes") is not None else None),
            settings=settings,
        )

    @staticmethod
    def _to_summary(manifest: CharacterManifest) -> CharacterSummary:
        return CharacterSummary(
            schema_version=manifest.schema_version,
            character_id=manifest.character_id,
            display_name=manifest.display_name,
            identity_source=manifest.identity_source,
            vrm_spec_version=manifest.vrm_spec_version,
            shared_animation_set=manifest.shared_animation_set,
            supported_states=manifest.supported_states,
        )
