from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from app.services.tts_reference_settings import (
    TTSReferenceSettingsError,
    TTSReferenceSettingsSnapshot,
    get_tts_reference_settings,
    save_tts_reference_settings,
)


@dataclass(slots=True, frozen=True)
class TTSReferenceSettingsRequest:
    prompt_text: str
    file_name: str | None = None
    file_base64: str | None = None
    prompt_language: str | None = None
    text_language: str | None = None


def _serialize_snapshot(snapshot: TTSReferenceSettingsSnapshot) -> dict[str, Any]:
    return {
        "schema_version": snapshot.schema_version,
        "prompt_text": snapshot.prompt_text,
        "prompt_language": snapshot.prompt_language,
        "text_language": snapshot.text_language,
        "configured": snapshot.configured,
        "has_reference_audio": snapshot.has_reference_audio,
        "reference_audio_path": snapshot.reference_audio_path,
        "reference_audio_file_name": snapshot.reference_audio_file_name,
        "speaker_manifest_path": snapshot.speaker_manifest_path,
        "reference_audio_root": snapshot.reference_audio_root,
        "max_reference_audio_bytes": snapshot.max_reference_audio_bytes,
        "allowed_extensions": list(snapshot.allowed_extensions),
    }


def register_tts_settings_routes(router: Any) -> None:
    from fastapi import HTTPException, status

    @router.get("/session/tts/settings")
    async def get_session_tts_settings() -> dict[str, Any]:
        return _serialize_snapshot(get_tts_reference_settings())

    @router.put("/session/tts/settings")
    async def put_session_tts_settings(update: TTSReferenceSettingsRequest) -> dict[str, Any]:
        try:
            snapshot = save_tts_reference_settings(
                prompt_text=update.prompt_text,
                file_name=update.file_name,
                file_base64=update.file_base64,
                prompt_language=update.prompt_language,
                text_language=update.text_language,
            )
        except TTSReferenceSettingsError as exc:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=str(exc),
            ) from exc

        return _serialize_snapshot(snapshot)