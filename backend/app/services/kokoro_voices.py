"""Kokoro voice catalog + selection persistence.

Kokoro ships a fixed library of named voice embeddings (the ``voices-v1.0.bin``
file). The embedding controls timbre/pitch; the phonemizer language is separate
(see ``NIKOF_KOKORO_LANG`` in :mod:`app.services.tts_engines`), so a non-English
voice can still render English text — with an accent.

This module enumerates the *installed* voices, exposes the female ones for the
control surface dropdown, and persists the operator's selection so it survives a
restart. The live :class:`KokoroSynthesisAdapter` reads
:func:`get_selected_kokoro_voice` on construction and is updated in place when the
selection changes (see ``tts_engines.apply_kokoro_voice``).
"""

from __future__ import annotations

import json
import os
import threading
from dataclasses import dataclass
from pathlib import Path

from app.core.settings import AppPaths, get_app_paths


DEFAULT_KOKORO_VOICE = "af_heart"
VOICES_FILE_NAME = "voices-v1.0.bin"

# First letter of a Kokoro voice id encodes its training language; the second
# letter encodes gender ("f" female / "m" male).
_LANGUAGE_LABELS: dict[str, str] = {
    "a": "American English",
    "b": "British English",
    "e": "Spanish",
    "f": "French",
    "h": "Hindi",
    "i": "Italian",
    "j": "Japanese",
    "p": "Brazilian Portuguese",
    "z": "Mandarin Chinese",
}
# English-language voices render English text most naturally, so surface them
# first in the picker.
_ENGLISH_LANGUAGE_KEYS = ("a", "b")

_voices_cache: tuple[str, ...] | None = None
_voices_cache_lock = threading.Lock()


@dataclass(slots=True, frozen=True)
class KokoroVoice:
    voice_id: str
    label: str
    language: str
    female: bool
    english: bool


def _kokoro_dir(app_paths: AppPaths) -> Path:
    return app_paths.tts_models_root / "kokoro"


def _runtime_path(app_paths: AppPaths) -> Path:
    return _kokoro_dir(app_paths) / "runtime.json"


def _read_runtime(app_paths: AppPaths) -> dict[str, object]:
    path = _runtime_path(app_paths)
    if not path.is_file():
        return {}
    try:
        decoded = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    return decoded if isinstance(decoded, dict) else {}


def describe_voice(voice_id: str) -> KokoroVoice:
    """Build display metadata for a voice id using Kokoro's naming convention."""
    language_key = voice_id[:1].lower()
    gender_key = voice_id[1:2].lower()
    language = _LANGUAGE_LABELS.get(language_key, "Other")
    female = gender_key == "f"
    english = language_key in _ENGLISH_LANGUAGE_KEYS
    raw_name = voice_id.split("_", 1)[1] if "_" in voice_id else voice_id
    pretty_name = raw_name.replace("_", " ").title()
    gender_word = "female" if female else "male" if gender_key == "m" else ""
    label = f"{pretty_name} · {language}{f' {gender_word}' if gender_word else ''}"
    return KokoroVoice(voice_id=voice_id, label=label, language=language, female=female, english=english)


def list_installed_voice_ids(app_paths: AppPaths | None = None) -> tuple[str, ...]:
    """Voice ids present in the installed ``voices-v1.0.bin`` (cached)."""
    global _voices_cache
    if _voices_cache is not None:
        return _voices_cache
    with _voices_cache_lock:
        if _voices_cache is not None:
            return _voices_cache
        paths = app_paths or get_app_paths()
        voices_path = _kokoro_dir(paths) / VOICES_FILE_NAME
        if not voices_path.is_file():
            return ()
        try:
            import numpy as np

            data = np.load(str(voices_path))
            _voices_cache = tuple(sorted(data.keys()))
        except Exception:
            return ()
        return _voices_cache


def _sort_key(voice: KokoroVoice) -> tuple[int, str, str]:
    # English first, then by language label, then by id.
    return (0 if voice.english else 1, voice.language, voice.voice_id)


def list_female_voices(app_paths: AppPaths | None = None) -> list[KokoroVoice]:
    voices = [describe_voice(voice_id) for voice_id in list_installed_voice_ids(app_paths)]
    female = [voice for voice in voices if voice.female]
    return sorted(female, key=_sort_key)


def get_selected_kokoro_voice(app_paths: AppPaths | None = None) -> str:
    """Persisted operator choice, else the ``NIKOF_KOKORO_VOICE`` env default."""
    paths = app_paths or get_app_paths()
    persisted = str(_read_runtime(paths).get("voice") or "").strip()
    if persisted:
        return persisted
    return (os.environ.get("NIKOF_KOKORO_VOICE") or DEFAULT_KOKORO_VOICE).strip()


def get_kokoro_lang(app_paths: AppPaths | None = None) -> str:
    paths = app_paths or get_app_paths()
    persisted = str(_read_runtime(paths).get("lang") or "").strip()
    if persisted:
        return persisted
    return (os.environ.get("NIKOF_KOKORO_LANG") or "en-us").strip()


def set_selected_kokoro_voice(voice_id: str, app_paths: AppPaths | None = None) -> str:
    """Validate against installed voices and persist the selection.

    Returns the stored voice id. Raises ``ValueError`` if the voice is not in the
    installed catalog (when the catalog is known).
    """
    paths = app_paths or get_app_paths()
    normalized = voice_id.strip()
    if not normalized:
        raise ValueError("Voice id must not be blank.")

    installed = list_installed_voice_ids(paths)
    if installed and normalized not in installed:
        raise ValueError(f"Voice '{normalized}' is not installed in the Kokoro voices file.")

    runtime = _read_runtime(paths)
    runtime["voice"] = normalized
    runtime.setdefault("lang", get_kokoro_lang(paths))
    runtime_path = _runtime_path(paths)
    runtime_path.parent.mkdir(parents=True, exist_ok=True)
    runtime_path.write_text(json.dumps(runtime, indent=2), encoding="utf-8")
    return normalized
