from __future__ import annotations

import base64
import binascii
import io
import json
from dataclasses import dataclass
from pathlib import Path
import wave

from app.core.settings import AppPaths, get_app_paths


MAX_REFERENCE_WAV_BYTES = 5 * 1024 * 1024
DEFAULT_PROMPT_LANGUAGE = "en-US"
DEFAULT_TEXT_LANGUAGE = "en-US"
DEFAULT_SPEAKER_MANIFEST_RELATIVE_PATH = Path("speakers") / "default.json"
DEFAULT_REFERENCE_AUDIO_ROOT_RELATIVE_PATH = Path("reference-audio")
DEFAULT_REFERENCE_AUDIO_FILE_NAME = "default-reference.wav"
ALLOWED_REFERENCE_AUDIO_EXTENSIONS = (".wav",)


class TTSReferenceSettingsError(ValueError):
    pass


@dataclass(slots=True, frozen=True)
class TTSReferenceSettingsSnapshot:
    schema_version: int
    prompt_text: str
    prompt_language: str
    text_language: str
    configured: bool
    has_reference_audio: bool
    reference_audio_path: str | None
    reference_audio_file_name: str | None
    speaker_manifest_path: str
    reference_audio_root: str
    max_reference_audio_bytes: int
    allowed_extensions: tuple[str, ...]


def _tts_model_root(app_paths: AppPaths) -> Path:
    return app_paths.tts_models_root / "gpt-sovits"


def _read_json_dict(path: Path) -> dict[str, object]:
    if not path.is_file():
        return {}

    try:
        decoded = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}

    return decoded if isinstance(decoded, dict) else {}


def _write_json_dict(path: Path, payload: dict[str, object]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2), encoding="utf-8")


def _resolve_model_local_path(
    model_root: Path,
    raw_value: object,
    *,
    default_relative_path: Path,
    field_name: str,
) -> tuple[Path, str]:
    model_root_resolved = model_root.resolve()
    candidate = Path(str(raw_value).strip()) if str(raw_value or "").strip() else default_relative_path
    resolved = candidate.resolve() if candidate.is_absolute() else (model_root_resolved / candidate).resolve()

    try:
        relative = resolved.relative_to(model_root_resolved)
    except ValueError as exc:
        raise TTSReferenceSettingsError(f"Configured {field_name} must stay inside the managed GPT-SoVITS model root.") from exc

    return resolved, relative.as_posix()


def _resolve_existing_reference_audio_path(model_root: Path, reference_audio_value: object) -> Path | None:
    raw_reference = str(reference_audio_value or "").strip()
    if not raw_reference:
        return None

    candidate = Path(raw_reference)
    resolved = candidate.resolve() if candidate.is_absolute() else (model_root.resolve() / candidate).resolve()
    return resolved if resolved.is_file() else None


def _decode_reference_audio(file_name: str, file_base64: str) -> bytes:
    suffix = Path(file_name).suffix.lower()
    if suffix not in ALLOWED_REFERENCE_AUDIO_EXTENSIONS:
        raise TTSReferenceSettingsError("Reference audio must be a .wav file.")

    try:
        audio_bytes = base64.b64decode(file_base64, validate=True)
    except (binascii.Error, ValueError) as exc:
        raise TTSReferenceSettingsError("Reference audio payload is not valid base64.") from exc

    if len(audio_bytes) > MAX_REFERENCE_WAV_BYTES:
        raise TTSReferenceSettingsError(
            f"Reference audio exceeds the {MAX_REFERENCE_WAV_BYTES // (1024 * 1024)} MB limit."
        )

    try:
        with wave.open(io.BytesIO(audio_bytes), "rb"):
            pass
    except wave.Error as exc:
        raise TTSReferenceSettingsError("Reference audio must be a valid WAV file.") from exc

    return audio_bytes


def get_tts_reference_settings(app_paths: AppPaths | None = None) -> TTSReferenceSettingsSnapshot:
    paths = app_paths or get_app_paths()
    model_root = _tts_model_root(paths)
    runtime_path = model_root / "runtime.json"
    runtime_payload = _read_json_dict(runtime_path)
    synthesis_payload = runtime_payload.get("synthesis") if isinstance(runtime_payload.get("synthesis"), dict) else {}

    speaker_manifest_path, speaker_manifest_relative = _resolve_model_local_path(
        model_root,
        runtime_payload.get("speaker_manifest"),
        default_relative_path=DEFAULT_SPEAKER_MANIFEST_RELATIVE_PATH,
        field_name="speaker_manifest",
    )
    reference_audio_root_path, reference_audio_root_relative = _resolve_model_local_path(
        model_root,
        runtime_payload.get("reference_audio_root"),
        default_relative_path=DEFAULT_REFERENCE_AUDIO_ROOT_RELATIVE_PATH,
        field_name="reference_audio_root",
    )
    speaker_manifest_payload = _read_json_dict(speaker_manifest_path)

    prompt_text = str(
        speaker_manifest_payload.get("prompt_text")
        or speaker_manifest_payload.get("reference_text")
        or synthesis_payload.get("prompt_text")
        or synthesis_payload.get("reference_text")
        or ""
    ).strip()
    prompt_language = str(
        speaker_manifest_payload.get("prompt_language")
        or speaker_manifest_payload.get("reference_language")
        or synthesis_payload.get("prompt_language")
        or synthesis_payload.get("reference_language")
        or DEFAULT_PROMPT_LANGUAGE
    ).strip() or DEFAULT_PROMPT_LANGUAGE
    text_language = str(
        speaker_manifest_payload.get("text_language")
        or synthesis_payload.get("text_language")
        or DEFAULT_TEXT_LANGUAGE
    ).strip() or DEFAULT_TEXT_LANGUAGE

    reference_audio_path = _resolve_existing_reference_audio_path(
        model_root,
        speaker_manifest_payload.get("reference_audio")
        or speaker_manifest_payload.get("refer_wav_path")
        or synthesis_payload.get("reference_audio"),
    )

    return TTSReferenceSettingsSnapshot(
        schema_version=1,
        prompt_text=prompt_text,
        prompt_language=prompt_language,
        text_language=text_language,
        configured=bool(prompt_text and reference_audio_path),
        has_reference_audio=reference_audio_path is not None,
        reference_audio_path=str(reference_audio_path) if reference_audio_path is not None else None,
        reference_audio_file_name=reference_audio_path.name if reference_audio_path is not None else None,
        speaker_manifest_path=str(speaker_manifest_path),
        reference_audio_root=str(reference_audio_root_path),
        max_reference_audio_bytes=MAX_REFERENCE_WAV_BYTES,
        allowed_extensions=ALLOWED_REFERENCE_AUDIO_EXTENSIONS,
    )


def save_tts_reference_settings(
    *,
    prompt_text: str,
    file_name: str | None = None,
    file_base64: str | None = None,
    prompt_language: str | None = None,
    text_language: str | None = None,
    app_paths: AppPaths | None = None,
) -> TTSReferenceSettingsSnapshot:
    normalized_prompt_text = prompt_text.strip()
    if not normalized_prompt_text:
        raise TTSReferenceSettingsError("Reference prompt text must not be blank.")

    if bool(file_name) != bool(file_base64):
        raise TTSReferenceSettingsError("Reference audio updates must include both file_name and file_base64.")

    paths = app_paths or get_app_paths()
    model_root = _tts_model_root(paths)
    model_root.mkdir(parents=True, exist_ok=True)
    runtime_path = model_root / "runtime.json"
    runtime_payload = _read_json_dict(runtime_path)
    synthesis_payload = dict(runtime_payload.get("synthesis") if isinstance(runtime_payload.get("synthesis"), dict) else {})

    speaker_manifest_path, speaker_manifest_relative = _resolve_model_local_path(
        model_root,
        runtime_payload.get("speaker_manifest"),
        default_relative_path=DEFAULT_SPEAKER_MANIFEST_RELATIVE_PATH,
        field_name="speaker_manifest",
    )
    reference_audio_root_path, reference_audio_root_relative = _resolve_model_local_path(
        model_root,
        runtime_payload.get("reference_audio_root"),
        default_relative_path=DEFAULT_REFERENCE_AUDIO_ROOT_RELATIVE_PATH,
        field_name="reference_audio_root",
    )
    speaker_manifest_payload = _read_json_dict(speaker_manifest_path)

    reference_audio_root_path.mkdir(parents=True, exist_ok=True)
    speaker_manifest_path.parent.mkdir(parents=True, exist_ok=True)

    reference_audio_relative: str | None = None
    if file_name and file_base64:
        audio_bytes = _decode_reference_audio(file_name, file_base64)
        reference_audio_path = reference_audio_root_path / DEFAULT_REFERENCE_AUDIO_FILE_NAME
        reference_audio_path.write_bytes(audio_bytes)
        reference_audio_relative = reference_audio_path.resolve().relative_to(model_root.resolve()).as_posix()
    else:
        existing_reference_audio_path = _resolve_existing_reference_audio_path(
            model_root,
            speaker_manifest_payload.get("reference_audio")
            or speaker_manifest_payload.get("refer_wav_path")
            or synthesis_payload.get("reference_audio"),
        )
        if existing_reference_audio_path is not None:
            reference_audio_relative = existing_reference_audio_path.resolve().relative_to(model_root.resolve()).as_posix()

    resolved_prompt_language = (prompt_language or str(
        speaker_manifest_payload.get("prompt_language")
        or speaker_manifest_payload.get("reference_language")
        or synthesis_payload.get("prompt_language")
        or synthesis_payload.get("reference_language")
        or DEFAULT_PROMPT_LANGUAGE
    )).strip() or DEFAULT_PROMPT_LANGUAGE
    resolved_text_language = (text_language or str(
        speaker_manifest_payload.get("text_language")
        or synthesis_payload.get("text_language")
        or DEFAULT_TEXT_LANGUAGE
    )).strip() or DEFAULT_TEXT_LANGUAGE

    updated_speaker_manifest = dict(speaker_manifest_payload)
    updated_speaker_manifest["profile_id"] = str(updated_speaker_manifest.get("profile_id") or "default")
    updated_speaker_manifest["speaker"] = str(updated_speaker_manifest.get("speaker") or "default")
    updated_speaker_manifest["prompt_text"] = normalized_prompt_text
    updated_speaker_manifest["reference_text"] = normalized_prompt_text
    updated_speaker_manifest["prompt_language"] = resolved_prompt_language
    updated_speaker_manifest["reference_language"] = resolved_prompt_language
    updated_speaker_manifest["text_language"] = resolved_text_language
    if reference_audio_relative is not None:
        updated_speaker_manifest["reference_audio"] = reference_audio_relative
        updated_speaker_manifest["refer_wav_path"] = reference_audio_relative

    updated_runtime = dict(runtime_payload)
    updated_runtime["speaker_manifest"] = speaker_manifest_relative
    updated_runtime["reference_audio_root"] = reference_audio_root_relative
    synthesis_payload["prompt_text"] = normalized_prompt_text
    synthesis_payload["reference_text"] = normalized_prompt_text
    synthesis_payload["prompt_language"] = resolved_prompt_language
    synthesis_payload["reference_language"] = resolved_prompt_language
    synthesis_payload["text_language"] = resolved_text_language
    if reference_audio_relative is not None:
        synthesis_payload["reference_audio"] = reference_audio_relative
    updated_runtime["synthesis"] = synthesis_payload

    _write_json_dict(speaker_manifest_path, updated_speaker_manifest)
    _write_json_dict(runtime_path, updated_runtime)

    return get_tts_reference_settings(app_paths=paths)