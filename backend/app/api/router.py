from __future__ import annotations

from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from typing import Any

from app.core.settings import get_app_paths
from app.schemas.character import ActiveCharacterSelection, CharacterCatalogResponse, CharacterSummary
from app.schemas.health import DiagnosticProbe, HealthDiagnostics, HealthPayload
from app.schemas.session import (
    ActiveCharacterResponse,
    ActiveCharacterSelectionResult,
    AudioFormatMetadata,
    SessionEvent,
    SessionSnapshot,
    SpeechPhonemeSlot,
    SpeechSegmentRange,
    SpeechSynthesisContract,
    SpeechTimingMetadata,
    SpeechTranscriptionContract,
    SpeechVisemeSlot,
    build_baseline_speech_adapter_profiles,
)
from app.services.character import CharacterService, FileSystemCharacterManifestSource, UnknownCharacterError
from app.services.session import InMemorySessionService, SessionService


@dataclass(slots=True, frozen=True)
class RouteDefinition:
    method: str
    path: str
    name: str


@dataclass(slots=True)
class RouterShell:
    routes: list[RouteDefinition]


def _strip_none(value: Any) -> Any:
    if isinstance(value, dict):
        return {
            key: _strip_none(item)
            for key, item in value.items()
            if item is not None
        }

    if isinstance(value, list):
        return [_strip_none(item) for item in value]

    return value


def _serialize_dataclass_payload(value: Any) -> dict[str, Any]:
    return _strip_none(asdict(value))


def _route_definitions() -> list[RouteDefinition]:
    return [
        RouteDefinition(method="GET", path="/health", name="healthcheck"),
        RouteDefinition(method="GET", path="/characters", name="list_characters"),
        RouteDefinition(method="GET", path="/session/active-character", name="get_active_character"),
        RouteDefinition(method="PUT", path="/session/active-character", name="set_active_character"),
    ]


def _build_services() -> tuple[SessionService, CharacterService]:
    character_service = CharacterService(FileSystemCharacterManifestSource())
    session_service = InMemorySessionService(default_character_id="test-vrm-01")
    return session_service, character_service


def _timestamp_now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _build_health_payload(character_service: CharacterService) -> HealthPayload:
    app_paths = get_app_paths()
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
        notes=[
            "Scaffold diagnostics are provider-agnostic in Stage 1.",
            "Create the local model and provider roots through bootstrap before Stage 3 integrations.",
        ],
    )
    return HealthPayload(status="ok", mode="scaffold", diagnostics=diagnostics)


def _build_session_event(
    snapshot: SessionSnapshot,
    *,
    character_id: str,
    event_type: str,
    status: str,
    reason: str | None = None,
    transcription: SpeechTranscriptionContract | None = None,
    synthesis: SpeechSynthesisContract | None = None,
) -> SessionEvent:
    return SessionEvent(
        schema_version=1,
        event_type=event_type,
        session_id=snapshot.session_id,
        character_id=character_id,
        status=status,
        timestamp=_timestamp_now(),
        reason=reason,
        transcription=transcription,
        synthesis=synthesis,
    )


def _build_sample_transcription_contract() -> SpeechTranscriptionContract:
    return SpeechTranscriptionContract(
        profile_id="stt.faster-whisper.medium-2026",
        status="final",
        locale="en-US",
        transcript="Hey Niko, can you wave after you answer?",
        confidence=0.98,
        timing=SpeechTimingMetadata(
            utterance_duration_ms=1890,
            segment_ranges=(
                SpeechSegmentRange(start_ms=0, end_ms=640, text="Hey Niko,"),
                SpeechSegmentRange(start_ms=640, end_ms=1890, text="can you wave after you answer?"),
            ),
            audio_format=AudioFormatMetadata(
                container="wav",
                encoding="pcm_s16le",
                sample_rate_hz=16000,
                channels=1,
            ),
        ),
    )


def _build_sample_synthesis_contract() -> SpeechSynthesisContract:
    return SpeechSynthesisContract(
        profile_id="tts.gpt-sovits.2026-stable",
        status="ready",
        text="Sure. I can wave once I finish speaking.",
        locale="en-US",
        timing=SpeechTimingMetadata(
            utterance_duration_ms=2120,
            segment_ranges=(
                SpeechSegmentRange(start_ms=0, end_ms=880, text="Sure."),
                SpeechSegmentRange(
                    start_ms=880,
                    end_ms=2120,
                    text="I can wave once I finish speaking.",
                ),
            ),
            audio_format=AudioFormatMetadata(
                container="wav",
                encoding="pcm_s16le",
                sample_rate_hz=24000,
                channels=1,
            ),
            phoneme_slots=(
                SpeechPhonemeSlot(phoneme="S", start_ms=0, end_ms=110),
                SpeechPhonemeSlot(phoneme="UH", start_ms=110, end_ms=260),
            ),
            viseme_slots=(
                SpeechVisemeSlot(viseme="sil", start_ms=0, end_ms=45),
                SpeechVisemeSlot(viseme="smile", start_ms=45, end_ms=310),
            ),
        ),
    )


def _build_speech_contract_examples(snapshot: SessionSnapshot, character_id: str) -> dict[str, Any]:
    return {
        "speech_adapter_profiles": [
            asdict(profile) for profile in build_baseline_speech_adapter_profiles()
        ],
        "canonical_transcription_event": asdict(
            _build_session_event(
                snapshot,
                character_id=character_id,
                event_type="transcription.status",
                status="final",
                transcription=_build_sample_transcription_contract(),
            )
        ),
        "canonical_speech_synthesis_event": asdict(
            _build_session_event(
                snapshot,
                character_id=character_id,
                event_type="speech.synthesis",
                status="ready",
                synthesis=_build_sample_synthesis_contract(),
            )
        ),
    }


def _build_character_catalog_response(
    snapshot: SessionSnapshot,
    characters: list[CharacterSummary],
) -> CharacterCatalogResponse:
    return CharacterCatalogResponse(
        schema_version=1,
        active_character_id=snapshot.active_character_id,
        characters=characters,
    )


def _build_active_character_response(
    snapshot: SessionSnapshot,
    active_character: CharacterSummary,
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
        session_event=_build_session_event(
            snapshot,
            character_id=event_character_id or active_character.character_id,
            event_type=event_type,
            status=status,
            reason=reason,
        ),
    )


def build_api_contract_snapshot() -> dict[str, Any]:
    session_service, character_service = _build_services()
    characters = character_service.list_character_summaries()
    current_snapshot = session_service.get_snapshot()
    current_character = character_service.get_character_summary(current_snapshot.active_character_id)
    invalid_selection = ActiveCharacterSelection(
        character_id="missing-character",
        reason="user_selected",
    )
    selected_character = characters[-1] if characters else current_character
    selection = ActiveCharacterSelection(
        character_id=selected_character.character_id,
        reason="user_selected",
    )
    updated_snapshot = session_service.set_active_character(selection)

    return {
        "routes": [asdict(route) for route in _route_definitions()],
        "contracts": _build_speech_contract_examples(
            current_snapshot,
            current_character.character_id,
        ),
        "responses": {
            "health": asdict(_build_health_payload(character_service)),
            "characters": asdict(_build_character_catalog_response(current_snapshot, characters)),
            "get_active_character": _serialize_dataclass_payload(
                _build_active_character_response(
                    current_snapshot,
                    current_character,
                    requested_character_id=current_character.character_id,
                    selection_applied=True,
                    event_type="session.state",
                    status=current_snapshot.lifecycle_state,
                    message="Active character resolved.",
                )
            ),
            "put_active_character": {
                "request": asdict(selection),
                "response": _serialize_dataclass_payload(
                    _build_active_character_response(
                        updated_snapshot,
                        selected_character,
                        requested_character_id=selection.character_id,
                        selection_applied=True,
                        event_type="session.character.selected",
                        status="applied",
                        message="Active character updated.",
                        reason=selection.reason,
                    )
                ),
            },
            "put_active_character_invalid": {
                "request": asdict(invalid_selection),
                "http_status": 400,
                "response": _serialize_dataclass_payload(
                    _build_active_character_response(
                        current_snapshot,
                        current_character,
                        requested_character_id=invalid_selection.character_id,
                        selection_applied=False,
                        event_type="session.character.rejected",
                        status="rejected",
                        error_code="unknown_character",
                        message="Requested character is unavailable.",
                        event_character_id=invalid_selection.character_id,
                        reason=invalid_selection.reason,
                    )
                ),
            },
        },
    }


def build_api_router() -> Any:
    session_service, character_service = _build_services()
    route_definitions = _route_definitions()

    try:
        from fastapi import APIRouter
    except ImportError:
        return RouterShell(routes=route_definitions)

    router = APIRouter()
    from fastapi import Response, status

    @router.get("/health", response_model=HealthPayload)
    def healthcheck() -> HealthPayload:
        return _build_health_payload(character_service)

    @router.get("/characters", response_model=CharacterCatalogResponse)
    def list_characters() -> CharacterCatalogResponse:
        snapshot = session_service.get_snapshot()
        return _build_character_catalog_response(snapshot, character_service.list_character_summaries())

    @router.get(
        "/session/active-character",
        response_model=ActiveCharacterResponse,
        response_model_exclude_none=True,
    )
    def get_active_character() -> ActiveCharacterResponse:
        snapshot = session_service.get_snapshot()
        active_character = character_service.get_character_summary(snapshot.active_character_id)
        return _build_active_character_response(
            snapshot,
            active_character,
            requested_character_id=active_character.character_id,
            selection_applied=True,
            event_type="session.state",
            status=snapshot.lifecycle_state,
            message="Active character resolved.",
        )

    @router.put(
        "/session/active-character",
        response_model=ActiveCharacterResponse,
        response_model_exclude_none=True,
    )
    def set_active_character(selection: ActiveCharacterSelection, response: Response) -> ActiveCharacterResponse:
        current_snapshot = session_service.get_snapshot()

        try:
            active_character = character_service.get_character_summary(selection.character_id)
        except UnknownCharacterError:
            response.status_code = status.HTTP_400_BAD_REQUEST
            current_character = character_service.get_character_summary(current_snapshot.active_character_id)
            return _build_active_character_response(
                current_snapshot,
                current_character,
                requested_character_id=selection.character_id,
                selection_applied=False,
                event_type="session.character.rejected",
                status="rejected",
                error_code="unknown_character",
                message="Requested character is unavailable.",
                event_character_id=selection.character_id,
                reason=selection.reason,
            )

        snapshot = session_service.set_active_character(selection)
        return _build_active_character_response(
            snapshot,
            active_character,
            requested_character_id=selection.character_id,
            selection_applied=True,
            event_type="session.character.selected",
            status="applied",
            message="Active character updated.",
            reason=selection.reason,
        )

    return router
