"""Pluggable TTS engine adapters (Phase 3/4).

Kokoro and XTTS-v2 alongside GPT-SoVITS, selected by ``NIKOF_TTS_ENGINE`` so we
can benchmark speed/quality. Each adapter implements the
``SpeechSynthesisService`` seam (``synthesize(request) -> SpeechSynthesisContract``):
it renders text to a 24 kHz mono WAV under ``cache_root`` and builds the contract
(with text-fallback lip-sync via ``speech._normalize_timing``), matching the
GPT-SoVITS output shape exactly.

Libraries and model weights are lazy-loaded; a missing dependency or model yields
``status="unavailable"`` instead of crashing the turn, so the adapters can be
wired in before the local install is complete.
"""

from __future__ import annotations

import logging
import threading
import time
import wave
from pathlib import Path
from typing import Any

from app.core.settings import AppPaths, get_app_paths
from app.schemas.session import (
    AudioFormatMetadata,
    SpeechSynthesisContract,
    SpeechTimingMetadata,
)
from app.services.speech import SpeechSynthesisRequest, _normalize_timing


logger = logging.getLogger(__name__)

_SAMPLE_RATE_HZ = 24000
_DEFAULT_TIMING = SpeechTimingMetadata(
    utterance_duration_ms=0,
    audio_format=AudioFormatMetadata(
        container="wav", encoding="pcm_s16le", sample_rate_hz=_SAMPLE_RATE_HZ, channels=1
    ),
)


def _write_wav_int16(path: Path, samples: Any, sample_rate: int) -> float:
    """Write float32 [-1, 1] samples to a mono 16-bit WAV; return duration in ms."""
    import numpy as np

    arr = np.asarray(samples, dtype=np.float32).reshape(-1)
    arr = np.clip(arr, -1.0, 1.0)
    pcm16 = (arr * 32767.0).astype("<i2")
    path.parent.mkdir(parents=True, exist_ok=True)
    with wave.open(str(path), "wb") as writer:
        writer.setnchannels(1)
        writer.setsampwidth(2)
        writer.setframerate(sample_rate)
        writer.writeframes(pcm16.tobytes())
    return (len(arr) / float(sample_rate)) * 1000.0 if sample_rate else 0.0


def _build_contract(
    *, profile_id: str, text: str, locale: str, audio_path: Path, duration_ms: float
) -> SpeechSynthesisContract:
    duration = int(round(duration_ms))
    timing = _normalize_timing(
        {
            "utterance_duration_ms": duration,
            "audio_format": {
                "container": "wav",
                "encoding": "pcm_s16le",
                "sample_rate_hz": _SAMPLE_RATE_HZ,
                "channels": 1,
            },
            "segment_ranges": [{"start_ms": 0, "end_ms": duration, "text": text}],
        },
        fallback=_DEFAULT_TIMING,
        source_text=text,
    )
    return SpeechSynthesisContract(
        profile_id=profile_id,
        status="ready",
        text=text,
        locale=locale,
        audio_reference=str(audio_path),
        timing=timing,
    )


def _unavailable(profile_id: str, request: SpeechSynthesisRequest, detail: str) -> SpeechSynthesisContract:
    logger.warning("TTS engine %s unavailable: %s", profile_id, detail)
    return SpeechSynthesisContract(
        profile_id=profile_id,
        status="unavailable",
        text=request.text,
        locale=request.locale,
    )


class KokoroSynthesisAdapter:
    """Kokoro-82M via kokoro-onnx (CPU-friendly, ~24 kHz native, no cloning)."""

    profile_id = "tts.kokoro.2026"

    def __init__(self, *, app_paths: AppPaths | None = None, voice: str | None = None, lang: str | None = None) -> None:
        from app.services.kokoro_voices import get_kokoro_lang, get_selected_kokoro_voice

        self._app_paths = app_paths or get_app_paths()
        # Voice timbre and phonemizer language are independent: keep ``lang`` at
        # ``en-us`` to render English text intelligibly while picking any of the
        # installed voice embeddings (incl. non-English ones) for the timbre. The
        # selected voice persists across restarts and can be changed live from the
        # control surface (see ``apply_kokoro_voice``).
        self._voice = (voice or get_selected_kokoro_voice(self._app_paths)).strip()
        self._lang = (lang or get_kokoro_lang(self._app_paths)).strip()
        self._engine: Any | None = None
        self._load_error: str | None = None
        self._lock = threading.Lock()

    @property
    def voice(self) -> str:
        return self._voice

    def set_voice(self, voice: str) -> None:
        """Swap the active voice embedding in place. The ONNX model is unchanged
        (voices are just embeddings), so no reload is needed."""
        normalized = voice.strip()
        if normalized:
            self._voice = normalized

    def _model_dir(self) -> Path:
        return self._app_paths.tts_models_root / "kokoro"

    def _ensure_engine(self) -> Any | None:
        if self._engine is not None or self._load_error is not None:
            return self._engine
        with self._lock:
            if self._engine is not None or self._load_error is not None:
                return self._engine
            try:
                from kokoro_onnx import Kokoro  # type: ignore
            except Exception as exc:  # pragma: no cover - import guard
                self._load_error = f"kokoro-onnx not installed: {exc}"
                return None
            model_dir = self._model_dir()
            model_path = model_dir / "kokoro-v1.0.onnx"
            voices_path = model_dir / "voices-v1.0.bin"
            if not model_path.is_file() or not voices_path.is_file():
                self._load_error = f"model files missing under {model_dir}"
                return None
            try:
                self._engine = Kokoro(str(model_path), str(voices_path))
            except Exception as exc:  # pragma: no cover - load guard
                self._load_error = f"failed to load Kokoro: {exc}"
                return None
            return self._engine

    def request_warmup(self) -> None:
        """Load the model in a background thread so the first turn is fast."""
        threading.Thread(target=self._ensure_engine, name="kokoro-warmup", daemon=True).start()

    def synthesize(self, request: SpeechSynthesisRequest) -> SpeechSynthesisContract:
        engine = self._ensure_engine()
        if engine is None:
            return _unavailable(self.profile_id, request, self._load_error or "unavailable")
        try:
            samples, sample_rate = engine.create(
                request.text, voice=self._voice, speed=1.0, lang=self._lang
            )
        except Exception as exc:
            return _unavailable(self.profile_id, request, f"synthesis failed: {exc}")
        audio_path = self._app_paths.cache_root / "kokoro" / f"kokoro-{time.time_ns()}.wav"
        duration_ms = _write_wav_int16(audio_path, samples, int(sample_rate or _SAMPLE_RATE_HZ))
        return _build_contract(
            profile_id=self.profile_id,
            text=request.text,
            locale=request.locale,
            audio_path=audio_path,
            duration_ms=duration_ms,
        )


class XttsSynthesisAdapter:
    """XTTS-v2 via coqui-tts (voice cloning from a reference sample)."""

    profile_id = "tts.xtts-v2.2026"

    def __init__(self, *, app_paths: AppPaths | None = None) -> None:
        self._app_paths = app_paths or get_app_paths()
        self._engine: Any | None = None
        self._load_error: str | None = None
        self._lock = threading.Lock()

    def _reference_wav(self) -> Path | None:
        candidates = [
            self._app_paths.tts_models_root / "xtts" / "reference.wav",
            self._app_paths.tts_models_root / "xtts" / "speaker.wav",
        ]
        for candidate in candidates:
            if candidate.is_file():
                return candidate
        return None

    def _ensure_engine(self) -> Any | None:
        if self._engine is not None or self._load_error is not None:
            return self._engine
        with self._lock:
            if self._engine is not None or self._load_error is not None:
                return self._engine
            try:
                from TTS.api import TTS  # type: ignore
            except Exception as exc:  # pragma: no cover - import guard
                self._load_error = f"coqui-tts (TTS) not installed: {exc}"
                return None
            try:
                self._engine = TTS("tts_models/multilingual/multi-dataset/xtts_v2")
                try:
                    import torch

                    if torch.cuda.is_available():
                        self._engine.to("cuda")
                        logger.info("XTTS-v2 running on CUDA")
                except Exception:  # pragma: no cover - GPU move is best-effort
                    pass
            except Exception as exc:  # pragma: no cover - load guard
                self._load_error = f"failed to load XTTS-v2: {exc}"
                return None
            return self._engine

    def request_warmup(self) -> None:
        """Load the model in a background thread (only if a reference exists)."""
        if self._reference_wav() is None:
            return
        threading.Thread(target=self._ensure_engine, name="xtts-warmup", daemon=True).start()

    def synthesize(self, request: SpeechSynthesisRequest) -> SpeechSynthesisContract:
        # Check the reference first so we never load the ~1.8GB model when there
        # is nothing to clone (keeps the unavailable path cheap).
        reference = self._reference_wav()
        if reference is None:
            return _unavailable(self.profile_id, request, "no reference WAV under tts/xtts/")
        engine = self._ensure_engine()
        if engine is None:
            return _unavailable(self.profile_id, request, self._load_error or "unavailable")
        try:
            import numpy as np

            wav = engine.tts(text=request.text, speaker_wav=str(reference), language="en")
            samples = np.asarray(wav, dtype="float32")
        except Exception as exc:
            return _unavailable(self.profile_id, request, f"synthesis failed: {exc}")
        audio_path = self._app_paths.cache_root / "xtts" / f"xtts-{time.time_ns()}.wav"
        # XTTS renders at 24 kHz.
        duration_ms = _write_wav_int16(audio_path, samples, _SAMPLE_RATE_HZ)
        return _build_contract(
            profile_id=self.profile_id,
            text=request.text,
            locale=request.locale,
            audio_path=audio_path,
            duration_ms=duration_ms,
        )


def resolve_tts_engine_name() -> str:
    import os

    return (os.environ.get("NIKOF_TTS_ENGINE") or "gpt-sovits").strip().lower()


_alternate_services: dict[str, Any] = {}
_alternate_lock = threading.Lock()


def apply_kokoro_voice(voice: str) -> bool:
    """Push a new voice onto the live (cached) Kokoro adapter, if one exists.

    Returns True when a live adapter was updated. When no adapter is cached yet,
    the persisted selection (written by ``kokoro_voices.set_selected_kokoro_voice``)
    is picked up the next time the adapter is constructed."""
    with _alternate_lock:
        service = _alternate_services.get("kokoro")
    if service is None or not hasattr(service, "set_voice"):
        return False
    service.set_voice(voice)
    return True


def build_alternate_synthesis_service(
    engine_name: str, *, app_paths: AppPaths | None = None
) -> Any | None:
    """Return a non-GPT-SoVITS synthesis service for the engine, or None to keep
    the default GPT-SoVITS worker path. Cached per engine so the lifespan warmup
    and the request path share the same (warmed) instance."""
    if engine_name not in ("kokoro", "xtts", "xtts-v2"):
        return None
    with _alternate_lock:
        service = _alternate_services.get(engine_name)
        if service is None:
            if engine_name == "kokoro":
                service = KokoroSynthesisAdapter(app_paths=app_paths)
            else:
                service = XttsSynthesisAdapter(app_paths=app_paths)
            _alternate_services[engine_name] = service
        return service
