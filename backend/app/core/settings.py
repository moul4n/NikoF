from __future__ import annotations

from dataclasses import dataclass
import os
from pathlib import Path


def _repo_root_from_file() -> Path:
    return Path(__file__).resolve().parents[3]


def _resolve_path_from_env(name: str, default: Path) -> Path:
    raw_value = os.environ.get(name)
    if not raw_value:
        return default

    return Path(raw_value).expanduser()


def _default_local_root(repo_root: Path) -> Path:
    local_app_data = os.environ.get("LOCALAPPDATA")
    if local_app_data:
        return Path(local_app_data) / "NikoF"

    return repo_root / ".local" / "nikof"


@dataclass(slots=True, frozen=True)
class AppPaths:
    repo_root: Path
    assets_root: Path
    character_assets_root: Path
    local_data_root: Path
    models_root: Path
    llm_models_root: Path
    stt_models_root: Path
    tts_models_root: Path
    embeddings_root: Path
    providers_root: Path
    cache_root: Path


def get_app_paths() -> AppPaths:
    repo_root = _repo_root_from_file()
    assets_root = repo_root / "assets"
    local_data_root = _resolve_path_from_env(
        "NIKOF_LOCAL_ROOT",
        _default_local_root(repo_root),
    )
    models_root = _resolve_path_from_env(
        "NIKOF_MODELS_ROOT",
        local_data_root / "models",
    )

    return AppPaths(
        repo_root=repo_root,
        assets_root=assets_root,
        character_assets_root=assets_root / "characters",
        local_data_root=local_data_root,
        models_root=models_root,
        llm_models_root=_resolve_path_from_env(
            "NIKOF_LLM_MODELS_ROOT",
            models_root / "llm",
        ),
        stt_models_root=_resolve_path_from_env(
            "NIKOF_STT_MODELS_ROOT",
            models_root / "stt",
        ),
        tts_models_root=_resolve_path_from_env(
            "NIKOF_TTS_MODELS_ROOT",
            models_root / "tts",
        ),
        embeddings_root=_resolve_path_from_env(
            "NIKOF_EMBEDDINGS_ROOT",
            models_root / "embeddings",
        ),
        providers_root=_resolve_path_from_env(
            "NIKOF_PROVIDERS_ROOT",
            local_data_root / "providers",
        ),
        cache_root=_resolve_path_from_env(
            "NIKOF_CACHE_ROOT",
            local_data_root / "cache",
        ),
    )
