from __future__ import annotations

from dataclasses import asdict
from typing import Any

from app.api.session_routes import _build_sse_frame
from app.core.settings import AppPaths, BootstrapProviderPrerequisite, get_app_paths, get_startup_runtime_prerequisites
from app.schemas.character import CharacterCatalogResponse, CharacterSummary
from app.schemas.health import (
    DiagnosticProbe,
    HealthDiagnostics,
    HealthPayload,
    PrerequisiteBlocker,
    PrerequisiteLane,
    SubsystemReadiness,
)
from app.schemas.session import (
    ActiveCharacterResponse,
    ActiveCharacterSelectionResult,
    SessionSnapshot,
    SpeechLifecycleTransportSnapshot,
    build_baseline_speech_adapter_profiles,
)
from app.services.character import CharacterService
from app.services.speech import SPEECH_LIFECYCLE_STREAM, SessionEventFactory


STARTUP_PREREQUISITE_LANES = (
    ("llm", "LLM", ("llm-model-ollama-llama3.1-8b", "provider-ollama")),
    ("stt", "STT", ("stt-medium", "stt-provider-entrypoint")),
    ("tts", "TTS", ("tts-model-gpt-sovits", "tts-provider-entrypoint")),
)


def strip_none(value: Any) -> Any:
    if isinstance(value, dict):
        return {
            key: strip_none(item)
            for key, item in value.items()
            if item is not None
        }

    if isinstance(value, list):
        return [strip_none(item) for item in value]

    return value


def serialize_dataclass_payload(value: Any) -> dict[str, Any]:
    return strip_none(asdict(value))


def _derive_prerequisite_lane_state(
    prerequisites: list[BootstrapProviderPrerequisite],
) -> str:
    states = {prerequisite.state for prerequisite in prerequisites}
    if states == {"ready"}:
        return "ready"

    if "scaffolded" in states:
        return "scaffolded"

    return "missing"


def _build_fallback_prerequisite_blockers(
    prerequisites: list[BootstrapProviderPrerequisite],
) -> list[PrerequisiteBlocker]:
    blockers: list[PrerequisiteBlocker] = []
    for prerequisite in prerequisites:
        if prerequisite.state == "ready":
            continue

        blockers.append(
            PrerequisiteBlocker(
                id=prerequisite.id,
                status="missing" if prerequisite.state == "missing" else "blocked",
                summary=f"{prerequisite.display_name} is not ready.",
            )
        )

    return blockers


def _build_prerequisite_lane_blockers(
    prerequisites: list[BootstrapProviderPrerequisite],
) -> list[PrerequisiteBlocker]:
    blockers_by_id: dict[str, PrerequisiteBlocker] = {}
    for prerequisite in prerequisites:
        for blocker_detail in prerequisite.blocker_details:
            blockers_by_id.setdefault(
                blocker_detail.id,
                PrerequisiteBlocker(
                    id=blocker_detail.id,
                    status=blocker_detail.status,
                    summary=blocker_detail.summary,
                ),
            )

    if blockers_by_id:
        return list(blockers_by_id.values())

    return _build_fallback_prerequisite_blockers(prerequisites)


def _build_prerequisite_lanes(app_paths: AppPaths) -> list[PrerequisiteLane]:
    prerequisites_by_id = {
        prerequisite.id: prerequisite
        for prerequisite in get_startup_runtime_prerequisites(app_paths=app_paths)
    }
    lanes: list[PrerequisiteLane] = []
    for lane_id, display_name, prerequisite_ids in STARTUP_PREREQUISITE_LANES:
        lane_prerequisites = [
            prerequisites_by_id[prerequisite_id]
            for prerequisite_id in prerequisite_ids
            if prerequisite_id in prerequisites_by_id
        ]
        if not lane_prerequisites:
            continue

        lanes.append(
            PrerequisiteLane(
                id=lane_id,
                display_name=display_name,
                state=_derive_prerequisite_lane_state(lane_prerequisites),
                blockers=_build_prerequisite_lane_blockers(lane_prerequisites),
            )
        )

    return lanes


def build_subsystem_readiness() -> list[SubsystemReadiness]:
    """Snapshot live worker/sidecar readiness for the health surface.

    Reads only in-memory worker state — no HTTP probes — so /health stays
    cheap and can never hang on a wedged sidecar. Each subsystem is isolated:
    a failure to read one is reported as that subsystem's error state instead
    of failing the whole health endpoint.
    """
    readiness: list[SubsystemReadiness] = []

    try:
        from app.services.stt_worker import get_stt_worker

        stt_status = get_stt_worker().status()
        readiness.append(
            SubsystemReadiness(
                id="stt",
                state=str(stt_status.state.value),
                ready=bool(stt_status.available),
                detail=stt_status.last_error,
            )
        )
    except Exception as exc:
        readiness.append(SubsystemReadiness(id="stt", state="error", ready=False, detail=str(exc)))

    try:
        from app.services.tts_worker import TTSWorkerState, get_tts_worker

        tts_worker = get_tts_worker()
        tts_status = tts_worker.status()
        # TTS loads lazily: an idle worker with a running loop is accepting
        # work, so it counts as ready even though the model is not loaded yet.
        loop_running = tts_worker._processing_task is not None
        tts_ready = tts_status.state in (TTSWorkerState.READY, TTSWorkerState.PROCESSING) or (
            tts_status.state == TTSWorkerState.IDLE and loop_running
        )
        readiness.append(
            SubsystemReadiness(
                id="tts",
                state=str(tts_status.state.value),
                ready=tts_ready,
                detail=tts_status.last_error,
            )
        )
    except Exception as exc:
        readiness.append(SubsystemReadiness(id="tts", state="error", ready=False, detail=str(exc)))

    try:
        from app.services.llm import get_text_generation_sidecar_manager

        llm_status = get_text_generation_sidecar_manager().status()
        readiness.append(
            SubsystemReadiness(
                id="llm",
                state=str(llm_status.state.value),
                ready=bool(llm_status.available),
                detail=llm_status.last_error,
            )
        )
    except Exception as exc:
        readiness.append(SubsystemReadiness(id="llm", state="error", ready=False, detail=str(exc)))

    return readiness


def build_health_payload(
    character_service: CharacterService,
    *,
    app_paths: AppPaths | None = None,
    include_subsystems: bool = True,
) -> HealthPayload:
    app_paths = app_paths or get_app_paths()
    character_count = len(character_service.list_character_summaries())

    diagnostics = HealthDiagnostics(
        character_packages_available=character_count,
        storage_probes=[
            DiagnosticProbe(
                name="character-assets",
                configured_by="repo-layout",
                required_for_stage="stage-1",
                available=app_paths.character_assets_root.exists() and character_count > 0,
            ),
            DiagnosticProbe(
                name="models-root",
                configured_by="NIKOF_MODELS_ROOT",
                required_for_stage="stage-3",
                available=app_paths.models_root.exists(),
            ),
            DiagnosticProbe(
                name="providers-root",
                configured_by="NIKOF_PROVIDERS_ROOT",
                required_for_stage="stage-3",
                available=app_paths.providers_root.exists(),
            ),
            DiagnosticProbe(
                name="cache-root",
                configured_by="NIKOF_CACHE_ROOT",
                required_for_stage="stage-3",
                available=app_paths.cache_root.exists(),
            ),
        ],
        prerequisite_lanes=_build_prerequisite_lanes(app_paths),
        notes=[
            "Scaffold diagnostics are provider-agnostic in Stage 1.",
            "Create the local model and provider roots through bootstrap before Stage 3 integrations.",
        ],
    )
    subsystems = build_subsystem_readiness() if include_subsystems else []
    return HealthPayload(
        status="ok",
        mode="scaffold",
        diagnostics=diagnostics,
        subsystems=subsystems,
    )


def build_speech_contract_examples(
    speech_lifecycle_snapshot: SpeechLifecycleTransportSnapshot,
) -> dict[str, Any]:
    return {
        "speech_adapter_profiles": [
            asdict(profile) for profile in build_baseline_speech_adapter_profiles()
        ],
        "canonical_transcription_event": serialize_dataclass_payload(
            speech_lifecycle_snapshot.events[0].event
        ),
        "canonical_speech_synthesis_event": serialize_dataclass_payload(
            speech_lifecycle_snapshot.events[1].event
        ),
        "speech_lifecycle_transport_snapshot": serialize_dataclass_payload(speech_lifecycle_snapshot),
    }


def build_character_catalog_response(
    snapshot: SessionSnapshot,
    characters: list[CharacterSummary],
) -> CharacterCatalogResponse:
    return CharacterCatalogResponse(
        schema_version=1,
        active_character_id=snapshot.active_character_id,
        characters=characters,
    )


def build_active_character_response(
    snapshot: SessionSnapshot,
    active_character: CharacterSummary,
    session_event_factory: SessionEventFactory,
    *,
    requested_character_id: str,
    selection_applied: bool,
    event_type: str,
    status: str,
    error_code: str | None = None,
    message: str | None = None,
    event_character_id: str | None = None,
    reason: str | None = None,
) -> ActiveCharacterResponse:
    return ActiveCharacterResponse(
        schema_version=1,
        session_id=snapshot.session_id,
        lifecycle_state=snapshot.lifecycle_state,
        active_character=active_character,
        selection=ActiveCharacterSelectionResult(
            requested_character_id=requested_character_id,
            applied=selection_applied,
            error_code=error_code,
            message=message,
        ),
        session_event=session_event_factory.build_event(
            snapshot,
            character_id=event_character_id or active_character.character_id,
            event_type=event_type,
            status=status,
            reason=reason,
        ),
    )


def build_speech_lifecycle_sse_frame(envelope: Any) -> str:
    return _build_sse_frame(
        event_name=SPEECH_LIFECYCLE_STREAM,
        payload=envelope,
        cursor=envelope.cursor,
        serialize_dataclass_payload=serialize_dataclass_payload,
    )


def derive_operator_command_status(*statuses: str) -> str:
    if any(status == "error" for status in statuses):
        return "error"

    if any(status in {"degraded", "unavailable"} for status in statuses):
        return next(status for status in statuses if status in {"degraded", "unavailable"})

    return "ready"