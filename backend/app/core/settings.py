from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path


def _repo_root_from_file() -> Path:
    return Path(__file__).resolve().parents[3]


@dataclass(slots=True, frozen=True)
class AppPaths:
    repo_root: Path
    assets_root: Path
    character_assets_root: Path


def get_app_paths() -> AppPaths:
    repo_root = _repo_root_from_file()
    assets_root = repo_root / "assets"
    return AppPaths(
        repo_root=repo_root,
        assets_root=assets_root,
        character_assets_root=assets_root / "characters",
    )
