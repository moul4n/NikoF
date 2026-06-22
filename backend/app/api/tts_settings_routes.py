from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from app.services.kokoro_voices import (
    get_kokoro_lang,
    get_selected_kokoro_voice,
    list_female_voices,
    set_selected_kokoro_voice,
)
from app.services.tts_engines import apply_kokoro_voice, resolve_tts_engine_name
from app.services.tts_reference_settings import (
    TTSReferenceSettingsError,
    TTSReferenceSettingsSnapshot,
    get_tts_reference_settings,
    save_tts_reference_settings,
)
from app.services.tts_worker import TTSWorkerStatus, get_tts_worker


@dataclass(slots=True, frozen=True)
class TTSReferenceSettingsRequest:
    prompt_text: str
    file_name: str | None = None
    file_base64: str | None = None
    prompt_language: str | None = None
    text_language: str | None = None


@dataclass(slots=True, frozen=True)
class TTSControlRequest:
    action: str


@dataclass(slots=True, frozen=True)
class KokoroVoiceRequest:
    voice: str


def _serialize_kokoro_voices() -> dict[str, Any]:
    voices = list_female_voices()
    return {
        "schema_version": 1,
        "engine_active": resolve_tts_engine_name() == "kokoro",
        "available": bool(voices),
        "selected_voice": get_selected_kokoro_voice(),
        "lang": get_kokoro_lang(),
        "voices": [
            {
                "voice_id": voice.voice_id,
                "label": voice.label,
                "language": voice.language,
                "english": voice.english,
            }
            for voice in voices
        ],
    }


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


def _serialize_tts_worker_status(status: TTSWorkerStatus) -> dict[str, Any]:
    return {
        "state": status.state.value if hasattr(status.state, "value") else str(status.state),
        "model_name": status.model_name,
        "queue_depth": status.queue_depth,
        "max_queue_depth": status.max_queue_depth,
        "total_processed": status.total_processed,
        "average_latency_ms": status.average_latency_ms,
        "last_error": status.last_error,
        "vram_allocated_mb": status.vram_allocated_mb,
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

    @router.get("/session/tts/kokoro-voices")
    async def get_session_kokoro_voices() -> dict[str, Any]:
        return _serialize_kokoro_voices()

    @router.put("/session/tts/kokoro-voice")
    async def put_session_kokoro_voice(update: KokoroVoiceRequest) -> dict[str, Any]:
        try:
            stored = set_selected_kokoro_voice(update.voice)
        except ValueError as exc:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc

        # Persisted above; also push onto the running adapter so the change takes
        # effect on the next synthesis without a restart.
        apply_kokoro_voice(stored)
        return _serialize_kokoro_voices()

    @router.post("/session/tts/control")
    async def post_session_tts_control(payload: TTSControlRequest) -> dict[str, Any]:
        worker = get_tts_worker()
        action = payload.action.strip().lower()

        if action == "start":
            await worker.start()
            # An explicit operator start is intent to bring TTS up, so eagerly
            # warm the model (background load) instead of staying idle until the
            # first synthesis request. Lifespan auto-start stays lazy.
            worker.request_warmup()
        elif action == "stop":
            await worker.stop()
        elif action == "restart":
            await worker.stop()
            await worker.start()
            worker.request_warmup()
        else:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"Unsupported TTS control action: {payload.action}",
            )

        return {
            "schema_version": 1,
            "action": action,
            "tts": _serialize_tts_worker_status(worker.status()),
        }