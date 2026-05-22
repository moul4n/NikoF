from __future__ import annotations

from dataclasses import dataclass, replace
from functools import lru_cache
import json
import os
from pathlib import Path
import re
import shutil
from typing import Literal


def _repo_root_from_file() -> Path:
    return Path(__file__).resolve().parents[3]


BOOTSTRAP_TARGETS_PATH = Path("scripts") / "bootstrap" / "bootstrap.targets.json"
STARTUP_PROVIDER_IDS = frozenset(
    {
        "llm-model-ollama-llama3.1-8b",
        "stt-medium",
        "stt-provider-entrypoint",
        "provider-ollama",
        "tts-model-gpt-sovits",
        "tts-provider-entrypoint",
    }
)
FASTER_WHISPER_MEDIUM_PREREQUISITE_ID = "stt-medium"
FASTER_WHISPER_PROVIDER_PREREQUISITE_ID = "stt-provider-entrypoint"
FASTER_WHISPER_SCAFFOLD_ARTIFACT_NAMES = frozenset({"runtime.json", "install-plan.json"})
GPT_SOVITS_MODEL_PREREQUISITE_ID = "tts-model-gpt-sovits"
GPT_SOVITS_PROVIDER_PREREQUISITE_ID = "tts-provider-entrypoint"
GPT_SOVITS_SCAFFOLD_ARTIFACT_NAMES = frozenset({"runtime.json", "install-plan.json"})


BootstrapPrerequisiteState = Literal["missing", "scaffolded", "ready"]
BootstrapBlockerStatus = Literal["missing", "blocked"]


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


@dataclass(slots=True, frozen=True)
class BootstrapProviderPrerequisite:
    @dataclass(slots=True, frozen=True)
    class AcceptanceTarget:
        id: str
        label: str
        satisfied: bool
        expected_path: Path
        accepted_paths: tuple[Path, ...]
        acceptance_proof: str

    @dataclass(slots=True, frozen=True)
    class BlockerDetail:
        id: str
        status: BootstrapBlockerStatus
        summary: str
        expected_path: Path
        accepted_paths: tuple[Path, ...]
        remediation: str
        evidence: tuple[str, ...]

    id: str
    display_name: str
    root_key: str
    expected_path: Path
    expected_paths: tuple[Path, ...]
    present: bool
    required: bool
    upstream: str
    manual_install: str
    hook_id: str | None
    hook_command: str | None
    runtime_config_path: Path | None
    install_plan_path: Path | None
    hint_path: Path | None
    state: BootstrapPrerequisiteState = "missing"
    acceptance_targets: tuple[AcceptanceTarget, ...] = ()
    blocker_details: tuple[BlockerDetail, ...] = ()


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


@lru_cache(maxsize=1)
def _load_bootstrap_targets() -> dict[str, object]:
    config_path = _repo_root_from_file() / BOOTSTRAP_TARGETS_PATH
    try:
        return json.loads(config_path.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError):
        return {}


def _resolve_bootstrap_expected_paths(app_paths: AppPaths, provider: dict[str, object]) -> tuple[Path, ...]:
    root_key = str(provider.get("rootKey") or "")
    if not root_key or not hasattr(app_paths, root_key):
        return ()

    root_path = getattr(app_paths, root_key)
    raw_paths = provider.get("expectedRelativePaths")
    relative_paths = raw_paths if isinstance(raw_paths, list) and raw_paths else [provider.get("expectedRelativePath")]
    return tuple(root_path / Path(str(relative_path)) for relative_path in relative_paths if relative_path)


def _build_bootstrap_hint_path(
    *,
    repo_root: Path,
    targets: dict[str, object],
    provider_id: str,
) -> Path | None:
    storage = targets.get("storage")
    if not isinstance(storage, dict):
        return None

    raw_hints_root = storage.get("providerHintsRoot")
    if not isinstance(raw_hints_root, str) or not raw_hints_root.strip():
        return None

    safe_name = re.sub(r"[^A-Za-z0-9._-]", "-", provider_id)
    return repo_root / Path(raw_hints_root) / f"{safe_name}.txt"


def _match_expected_paths(expected_paths: tuple[Path, ...], match_mode: str) -> tuple[bool, Path | None]:
    if not expected_paths:
        return False, None

    existing_paths = tuple(path for path in expected_paths if path.exists())
    if match_mode == "any":
        present = len(existing_paths) > 0
    else:
        present = len(existing_paths) == len(expected_paths)

    return present, (existing_paths[0] if existing_paths else expected_paths[0])


def _default_prerequisite_state(present: bool) -> BootstrapPrerequisiteState:
    return "ready" if present else "missing"


def _path_exists(path: Path | None) -> bool:
    return path is not None and path.exists()


def _resolve_local_command_path(command: str) -> Path | None:
    resolved = shutil.which(command)
    if resolved:
        return Path(resolved)

    if command.lower() == "ollama":
        local_app_data = os.environ.get("LOCALAPPDATA", "").strip()
        candidates = []
        if local_app_data:
            candidates.append(Path(local_app_data) / "Programs" / "Ollama" / "ollama.exe")
        candidates.append(Path("C:/Program Files/Ollama/ollama.exe"))
        for candidate in candidates:
            if candidate.exists():
                return candidate

    return None


def _expected_root(prerequisite: BootstrapProviderPrerequisite) -> Path:
    if prerequisite.expected_paths:
        return prerequisite.expected_paths[0]

    return prerequisite.expected_path


def _has_non_scaffold_payload_proof(root: Path, scaffold_artifact_names: frozenset[str]) -> bool:
    if not root.is_dir():
        return False

    try:
        return any(child.name not in scaffold_artifact_names for child in root.iterdir())
    except OSError:
        return False


def _has_gpt_sovits_payload_proof(model_root: Path) -> bool:
    return _has_non_scaffold_payload_proof(model_root, GPT_SOVITS_SCAFFOLD_ARTIFACT_NAMES)


def _has_faster_whisper_payload_proof(model_root: Path) -> bool:
    return _has_non_scaffold_payload_proof(model_root, FASTER_WHISPER_SCAFFOLD_ARTIFACT_NAMES)


def _resolve_faster_whisper_prerequisite_state(
    model_prerequisite: BootstrapProviderPrerequisite | None,
    provider_prerequisite: BootstrapProviderPrerequisite | None,
) -> BootstrapPrerequisiteState | None:
    if model_prerequisite is None or provider_prerequisite is None:
        return None

    payload_ready = _has_faster_whisper_payload_proof(_expected_root(model_prerequisite))
    provider_entrypoint_ready = any(path.exists() for path in provider_prerequisite.expected_paths)
    manifests_present = any(
        _path_exists(path)
        for path in (
            model_prerequisite.runtime_config_path,
            model_prerequisite.install_plan_path,
            provider_prerequisite.runtime_config_path,
        )
    )

    if payload_ready and provider_entrypoint_ready:
        return "ready"

    if manifests_present:
        return "scaffolded"

    return "missing"


def _faster_whisper_provider_entrypoint_paths(
    provider_prerequisite: BootstrapProviderPrerequisite,
) -> tuple[Path, ...]:
    if provider_prerequisite.expected_paths:
        return provider_prerequisite.expected_paths

    return (provider_prerequisite.expected_path,)


def _build_faster_whisper_acceptance_targets(
    *,
    model_root: Path,
    provider_entrypoint_paths: tuple[Path, ...],
    payload_ready: bool,
    provider_entrypoint_ready: bool,
) -> tuple[BootstrapProviderPrerequisite.AcceptanceTarget, ...]:
    return (
        BootstrapProviderPrerequisite.AcceptanceTarget(
            id="faster-whisper-medium-model-root",
            label="Faster-Whisper Medium model root",
            satisfied=payload_ready,
            expected_path=model_root,
            accepted_paths=(model_root,),
            acceptance_proof=(
                "At least one non-manifest file or folder must exist under this root; runtime.json and "
                "install-plan.json alone do not count."
            ),
        ),
        BootstrapProviderPrerequisite.AcceptanceTarget(
            id="faster-whisper-provider-entrypoint",
            label="Faster-Whisper provider entrypoint",
            satisfied=provider_entrypoint_ready,
            expected_path=provider_entrypoint_paths[0],
            accepted_paths=provider_entrypoint_paths,
            acceptance_proof="One accepted provider entrypoint file must exist under the managed provider root.",
        ),
    )


def _build_faster_whisper_blocker_details(
    *,
    state: BootstrapPrerequisiteState,
    model_root: Path,
    provider_entrypoint_paths: tuple[Path, ...],
    model_runtime_config_path: Path | None,
    model_install_plan_path: Path | None,
    provider_runtime_config_path: Path | None,
    payload_ready: bool,
    provider_entrypoint_ready: bool,
) -> tuple[BootstrapProviderPrerequisite.BlockerDetail, ...]:
    blockers: list[BootstrapProviderPrerequisite.BlockerDetail] = []
    blocker_status: BootstrapBlockerStatus = "missing" if state == "missing" else "blocked"

    if not payload_ready:
        blockers.append(
            BootstrapProviderPrerequisite.BlockerDetail(
                id="missing-faster-whisper-medium-payload-proof",
                status=blocker_status,
                summary="The approved Faster-Whisper Medium payload has not been placed under the managed STT root yet.",
                expected_path=model_root,
                accepted_paths=(model_root,),
                remediation=(
                    "Place the approved Faster-Whisper Medium model files under this local-only root. Scaffold "
                    "manifests alone do not satisfy readiness."
                ),
                evidence=tuple(
                    entry
                    for entry in (
                        "Bootstrap treats runtime.json and install-plan.json as scaffold markers only.",
                        (
                            f"Model runtime config: {model_runtime_config_path}"
                            if model_runtime_config_path is not None
                            else None
                        ),
                        (
                            f"Install plan: {model_install_plan_path}"
                            if model_install_plan_path is not None
                            else None
                        ),
                    )
                    if entry is not None
                ),
            )
        )

    if not provider_entrypoint_ready:
        blockers.append(
            BootstrapProviderPrerequisite.BlockerDetail(
                id="missing-faster-whisper-provider-entrypoint",
                status=blocker_status,
                summary="The Faster-Whisper provider entrypoint is still missing from the managed provider root.",
                expected_path=provider_entrypoint_paths[0],
                accepted_paths=provider_entrypoint_paths,
                remediation=(
                    "Place one provider entrypoint file under the managed provider root, then rerun bootstrap so "
                    "startup can confirm the proof."
                ),
                evidence=tuple(
                    entry
                    for entry in (
                        "Accepted entrypoints: " + ", ".join(str(path) for path in provider_entrypoint_paths),
                        (
                            f"Provider runtime config: {provider_runtime_config_path}"
                            if provider_runtime_config_path is not None
                            else None
                        ),
                    )
                    if entry is not None
                ),
            )
        )

    return tuple(blockers)


def _resolve_gpt_sovits_prerequisite_state(
    model_prerequisite: BootstrapProviderPrerequisite | None,
    provider_prerequisite: BootstrapProviderPrerequisite | None,
) -> BootstrapPrerequisiteState | None:
    if model_prerequisite is None or provider_prerequisite is None:
        return None

    payload_ready = _has_gpt_sovits_payload_proof(_expected_root(model_prerequisite))
    provider_entrypoint_ready = any(path.exists() for path in provider_prerequisite.expected_paths)
    manifests_present = any(
        _path_exists(path)
        for path in (
            model_prerequisite.runtime_config_path,
            model_prerequisite.install_plan_path,
            provider_prerequisite.runtime_config_path,
        )
    )

    if payload_ready and provider_entrypoint_ready:
        return "ready"

    if manifests_present:
        return "scaffolded"

    return "missing"


def _gpt_sovits_provider_entrypoint_paths(
    provider_prerequisite: BootstrapProviderPrerequisite,
) -> tuple[Path, ...]:
    if provider_prerequisite.expected_paths:
        return provider_prerequisite.expected_paths

    return (provider_prerequisite.expected_path,)


def _build_gpt_sovits_acceptance_targets(
    *,
    model_root: Path,
    provider_entrypoint_paths: tuple[Path, ...],
    payload_ready: bool,
    provider_entrypoint_ready: bool,
) -> tuple[BootstrapProviderPrerequisite.AcceptanceTarget, ...]:
    return (
        BootstrapProviderPrerequisite.AcceptanceTarget(
            id="gpt-sovits-payload-root",
            label="GPT-SoVITS payload root",
            satisfied=payload_ready,
            expected_path=model_root,
            accepted_paths=(model_root,),
            acceptance_proof=(
                "At least one non-manifest file or folder must exist under this root; runtime.json and "
                "install-plan.json alone do not count."
            ),
        ),
        BootstrapProviderPrerequisite.AcceptanceTarget(
            id="gpt-sovits-provider-entrypoint",
            label="GPT-SoVITS provider entrypoint",
            satisfied=provider_entrypoint_ready,
            expected_path=provider_entrypoint_paths[0],
            accepted_paths=provider_entrypoint_paths,
            acceptance_proof="One accepted provider entrypoint file must exist under the managed provider root.",
        ),
    )


def _build_gpt_sovits_blocker_details(
    *,
    state: BootstrapPrerequisiteState,
    model_root: Path,
    provider_entrypoint_paths: tuple[Path, ...],
    model_runtime_config_path: Path | None,
    model_install_plan_path: Path | None,
    provider_runtime_config_path: Path | None,
    payload_ready: bool,
    provider_entrypoint_ready: bool,
) -> tuple[BootstrapProviderPrerequisite.BlockerDetail, ...]:
    blockers: list[BootstrapProviderPrerequisite.BlockerDetail] = []
    blocker_status: BootstrapBlockerStatus = "missing" if state == "missing" else "blocked"

    if not payload_ready:
        blockers.append(
            BootstrapProviderPrerequisite.BlockerDetail(
                id="missing-gpt-sovits-payload-proof",
                status=blocker_status,
                summary="The approved GPT-SoVITS payload has not been placed under the managed TTS root yet.",
                expected_path=model_root,
                accepted_paths=(model_root,),
                remediation=(
                    "Place the approved GPT-SoVITS runtime payload, weights, and any voice-specific assets under "
                    "this local-only root. Scaffold manifests alone do not satisfy readiness."
                ),
                evidence=tuple(
                    entry
                    for entry in (
                        "Bootstrap treats runtime.json and install-plan.json as scaffold markers only.",
                        (
                            f"Model runtime config: {model_runtime_config_path}"
                            if model_runtime_config_path is not None
                            else None
                        ),
                        (
                            f"Install plan: {model_install_plan_path}"
                            if model_install_plan_path is not None
                            else None
                        ),
                    )
                    if entry is not None
                ),
            )
        )

    if not provider_entrypoint_ready:
        blockers.append(
            BootstrapProviderPrerequisite.BlockerDetail(
                id="missing-gpt-sovits-provider-entrypoint",
                status=blocker_status,
                summary="The GPT-SoVITS provider entrypoint is still missing from the managed provider root.",
                expected_path=provider_entrypoint_paths[0],
                accepted_paths=provider_entrypoint_paths,
                remediation=(
                    "Place one provider entrypoint file under the managed provider root, then rerun bootstrap so "
                    "startup can confirm the proof."
                ),
                evidence=tuple(
                    entry
                    for entry in (
                        "Accepted entrypoints: " + ", ".join(str(path) for path in provider_entrypoint_paths),
                        (
                            f"Provider runtime config: {provider_runtime_config_path}"
                            if provider_runtime_config_path is not None
                            else None
                        ),
                    )
                    if entry is not None
                ),
            )
        )

    return tuple(blockers)


def _apply_gpt_sovits_prerequisite_state(
    prerequisites: tuple[BootstrapProviderPrerequisite, ...],
) -> tuple[BootstrapProviderPrerequisite, ...]:
    prerequisites_by_id = {prerequisite.id: prerequisite for prerequisite in prerequisites}
    gpt_sovits_state = _resolve_gpt_sovits_prerequisite_state(
        prerequisites_by_id.get(GPT_SOVITS_MODEL_PREREQUISITE_ID),
        prerequisites_by_id.get(GPT_SOVITS_PROVIDER_PREREQUISITE_ID),
    )
    if gpt_sovits_state is None:
        return prerequisites

    model_prerequisite = prerequisites_by_id[GPT_SOVITS_MODEL_PREREQUISITE_ID]
    provider_prerequisite = prerequisites_by_id[GPT_SOVITS_PROVIDER_PREREQUISITE_ID]
    model_root = _expected_root(model_prerequisite)
    provider_entrypoint_paths = _gpt_sovits_provider_entrypoint_paths(provider_prerequisite)
    payload_ready = _has_gpt_sovits_payload_proof(model_root)
    provider_entrypoint_ready = any(path.exists() for path in provider_entrypoint_paths)
    acceptance_targets = _build_gpt_sovits_acceptance_targets(
        model_root=model_root,
        provider_entrypoint_paths=provider_entrypoint_paths,
        payload_ready=payload_ready,
        provider_entrypoint_ready=provider_entrypoint_ready,
    )
    blocker_details = _build_gpt_sovits_blocker_details(
        state=gpt_sovits_state,
        model_root=model_root,
        provider_entrypoint_paths=provider_entrypoint_paths,
        model_runtime_config_path=model_prerequisite.runtime_config_path,
        model_install_plan_path=model_prerequisite.install_plan_path,
        provider_runtime_config_path=provider_prerequisite.runtime_config_path,
        payload_ready=payload_ready,
        provider_entrypoint_ready=provider_entrypoint_ready,
    )

    return tuple(
        replace(
            prerequisite,
            state=gpt_sovits_state,
            present=gpt_sovits_state == "ready",
            acceptance_targets=acceptance_targets,
            blocker_details=blocker_details,
        )
        if prerequisite.id in {GPT_SOVITS_MODEL_PREREQUISITE_ID, GPT_SOVITS_PROVIDER_PREREQUISITE_ID}
        else prerequisite
        for prerequisite in prerequisites
    )


def _apply_faster_whisper_prerequisite_state(
    prerequisites: tuple[BootstrapProviderPrerequisite, ...],
) -> tuple[BootstrapProviderPrerequisite, ...]:
    prerequisites_by_id = {prerequisite.id: prerequisite for prerequisite in prerequisites}
    faster_whisper_state = _resolve_faster_whisper_prerequisite_state(
        prerequisites_by_id.get(FASTER_WHISPER_MEDIUM_PREREQUISITE_ID),
        prerequisites_by_id.get(FASTER_WHISPER_PROVIDER_PREREQUISITE_ID),
    )
    if faster_whisper_state is None:
        return prerequisites

    model_prerequisite = prerequisites_by_id[FASTER_WHISPER_MEDIUM_PREREQUISITE_ID]
    provider_prerequisite = prerequisites_by_id[FASTER_WHISPER_PROVIDER_PREREQUISITE_ID]
    model_root = _expected_root(model_prerequisite)
    provider_entrypoint_paths = _faster_whisper_provider_entrypoint_paths(provider_prerequisite)
    payload_ready = _has_faster_whisper_payload_proof(model_root)
    provider_entrypoint_ready = any(path.exists() for path in provider_entrypoint_paths)
    acceptance_targets = _build_faster_whisper_acceptance_targets(
        model_root=model_root,
        provider_entrypoint_paths=provider_entrypoint_paths,
        payload_ready=payload_ready,
        provider_entrypoint_ready=provider_entrypoint_ready,
    )
    blocker_details = _build_faster_whisper_blocker_details(
        state=faster_whisper_state,
        model_root=model_root,
        provider_entrypoint_paths=provider_entrypoint_paths,
        model_runtime_config_path=model_prerequisite.runtime_config_path,
        model_install_plan_path=model_prerequisite.install_plan_path,
        provider_runtime_config_path=provider_prerequisite.runtime_config_path,
        payload_ready=payload_ready,
        provider_entrypoint_ready=provider_entrypoint_ready,
    )

    return tuple(
        replace(
            prerequisite,
            state=faster_whisper_state,
            present=faster_whisper_state == "ready",
            acceptance_targets=acceptance_targets,
            blocker_details=blocker_details,
        )
        if prerequisite.id in {FASTER_WHISPER_MEDIUM_PREREQUISITE_ID, FASTER_WHISPER_PROVIDER_PREREQUISITE_ID}
        else prerequisite
        for prerequisite in prerequisites
    )


def _resolve_bootstrap_artifact_path(
    app_paths: AppPaths,
    provider: dict[str, object],
    *,
    key: str,
) -> Path | None:
    artifact = provider.get(key)
    if not isinstance(artifact, dict):
        return None

    relative_path = artifact.get("relativePath")
    if not isinstance(relative_path, str) or not relative_path.strip():
        return None

    root_key = str(provider.get("rootKey") or "")
    if not root_key or not hasattr(app_paths, root_key):
        return None

    return getattr(app_paths, root_key) / Path(relative_path)


def get_bootstrap_provider_prerequisites(
    *,
    include_ids: frozenset[str] | None = None,
    app_paths: AppPaths | None = None,
) -> tuple[BootstrapProviderPrerequisite, ...]:
    resolved_paths = app_paths or get_app_paths()
    targets = _load_bootstrap_targets()
    providers = targets.get("providers")
    if not isinstance(providers, list):
        return ()

    bootstrap_script = resolved_paths.repo_root / "scripts" / "bootstrap" / "bootstrap.ps1"
    prerequisites: list[BootstrapProviderPrerequisite] = []
    for provider in providers:
        if not isinstance(provider, dict):
            continue

        provider_id = str(provider.get("id") or "")
        if include_ids is not None and provider_id not in include_ids:
            continue

        expected_paths = _resolve_bootstrap_expected_paths(resolved_paths, provider)
        match_mode = str(provider.get("matchMode") or "all")
        present, expected_path = _match_expected_paths(expected_paths, match_mode)
        if provider_id == "provider-ollama":
            ollama_command_path = _resolve_local_command_path("ollama")
            present = ollama_command_path is not None
            if ollama_command_path is not None:
                expected_path = ollama_command_path
        remediation = provider.get("remediation")
        hook_id = None
        if isinstance(remediation, dict):
            raw_hook_id = remediation.get("id")
            if raw_hook_id:
                hook_id = str(raw_hook_id)

        prerequisites.append(
            BootstrapProviderPrerequisite(
                id=provider_id,
                display_name=str(provider.get("displayName") or provider_id),
                root_key=str(provider.get("rootKey") or ""),
                expected_path=expected_path or resolved_paths.repo_root,
                expected_paths=expected_paths,
                present=present,
                state=_default_prerequisite_state(present),
                required=bool(provider.get("required", True)),
                upstream=str(provider.get("upstream") or ""),
                manual_install=str(provider.get("manualInstall") or ""),
                hook_id=hook_id,
                hook_command=(
                    f'powershell -ExecutionPolicy Bypass -File "{bootstrap_script}" -RunHook {hook_id}'
                    if hook_id
                    else None
                ),
                runtime_config_path=_resolve_bootstrap_artifact_path(
                    resolved_paths,
                    provider,
                    key="runtimeConfig",
                ),
                install_plan_path=_resolve_bootstrap_artifact_path(
                    resolved_paths,
                    provider,
                    key="installPlan",
                ),
                hint_path=_build_bootstrap_hint_path(
                    repo_root=resolved_paths.repo_root,
                    targets=targets,
                    provider_id=provider_id,
                ),
            )
        )

    return _apply_gpt_sovits_prerequisite_state(
        _apply_faster_whisper_prerequisite_state(tuple(prerequisites))
    )


def get_startup_runtime_prerequisites(
    app_paths: AppPaths | None = None,
) -> tuple[BootstrapProviderPrerequisite, ...]:
    return get_bootstrap_provider_prerequisites(
        include_ids=STARTUP_PROVIDER_IDS,
        app_paths=app_paths,
    )
