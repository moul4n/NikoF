"""Pluggable STT recognizer engines (Phase 3).

The sidecar's hot-mic loop and the one-shot transcribe path both need to turn a
16 kHz mono float32 utterance into the same transcription payload shape
(status/transcript/locale/confidence/timing) regardless of which model produced
it. This module defines that shared result shape plus the engine selection seam:

  - "faster-whisper" (default): the existing Faster-Whisper path in
    faster_whisper_runtime.py — kept as the fallback.
  - "parakeet": NVIDIA Parakeet TDT 0.6B v2 via onnx-asr + onnxruntime
    (CUDA execution provider), in-process like Kokoro — no NeMo/torch.

The engine is selected with NIKOF_STT_ENGINE; Faster-Whisper stays the default
until the WER A/B gate passes (docs/PHASE3_STREAMING_STT_DESIGN.md). onnx_asr is
imported lazily so importing this module never requires the dependency.
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any


SERVER_SAMPLE_RATE_HZ = 16000

# Engine name -> locked transcription profile id. Both are accepted by the
# contract gate's STT baseline allow-list.
STT_ENGINE_PROFILE_IDS = {
    "faster-whisper": "stt.faster-whisper.medium-2026",
    "parakeet": "stt.parakeet-tdt.0.6b-v2-2026",
}

# onnx-asr model identifier for Parakeet TDT 0.6B v2 (English).
PARAKEET_ONNX_MODEL_ID = "nemo-parakeet-tdt-0.6b-v2"
PARAKEET_MODEL_DIRNAME = "parakeet-tdt-0.6b-v2"


@dataclass(slots=True)
class TranscriptionResult:
    """Engine-neutral transcription output, shaped to the sidecar payload."""

    transcript: str
    confidence: float | None = None
    duration_ms: int = 0
    segment_ranges: list[dict[str, Any]] = field(default_factory=list)

    @property
    def has_text(self) -> bool:
        return bool(self.transcript.strip())


def build_transcription_payload(result: TranscriptionResult, *, locale: str) -> dict[str, Any]:
    """Shape an engine result into the dict the sidecar emits / the worker reads.

    Identical to the legacy faster_whisper path so swapping engines never
    changes payload structure (only the transcript content + profile id)."""
    success = result.has_text
    return {
        "status": "final" if success else "unavailable",
        "transcript": result.transcript.strip() if success else "Local transcription is unavailable.",
        "locale": locale,
        "confidence": result.confidence,
        "timing": {
            "utterance_duration_ms": result.duration_ms,
            "segment_ranges": result.segment_ranges,
            "audio_format": {
                "container": "wav",
                "encoding": "pcm_f32le",
                "sample_rate_hz": SERVER_SAMPLE_RATE_HZ,
                "channels": 1,
            },
        },
    }


def resolve_stt_engine_name() -> str:
    """Resolve the selected engine from the environment (lazy; not cached here
    so a sidecar subprocess reads its own NIKOF_STT_ENGINE)."""
    raw = os.environ.get("NIKOF_STT_ENGINE", "").strip().lower()
    return raw if raw in STT_ENGINE_PROFILE_IDS else "faster-whisper"


def stt_profile_id_for(engine_name: str) -> str:
    return STT_ENGINE_PROFILE_IDS.get(engine_name, STT_ENGINE_PROFILE_IDS["faster-whisper"])


def _prefer_gpu() -> bool:
    if os.environ.get("NIKOF_STT_DEVICE_POLICY", "auto").strip().lower() == "cpu":
        return False
    return os.environ.get("NIKOF_STT_ALLOW_GPU", "0").strip().lower() in {"1", "true", "yes", "on"}


def _onnx_providers() -> list[str]:
    if _prefer_gpu():
        return ["CUDAExecutionProvider", "CPUExecutionProvider"]
    return ["CPUExecutionProvider"]


class ParakeetTranscriptionEngine:
    """Parakeet TDT 0.6B v2 via onnx-asr. The model loads lazily on first use
    and is reused for every utterance (RNN-T/TDT greedy decode)."""

    name = "parakeet"

    def __init__(self, model_root: Path) -> None:
        self._model_root = Path(model_root)
        self._model: Any = None

    def _load_model(self) -> Any:
        try:
            import onnx_asr  # noqa: PLC0415 - optional heavy dependency, imported lazily
        except ImportError as error:
            raise RuntimeError(
                "onnx-asr is not installed; install the [parakeet] extra to use the Parakeet engine."
            ) from error

        if not self._model_root.exists():
            raise RuntimeError(f"Parakeet model directory not found: {self._model_root}")

        return onnx_asr.load_model(
            PARAKEET_ONNX_MODEL_ID,
            str(self._model_root),
            providers=_onnx_providers(),
        )

    def ensure_ready(self) -> None:
        if self._model is None:
            self._model = self._load_model()

    def transcribe(self, audio: Any, *, locale: str) -> TranscriptionResult:
        self.ensure_ready()
        recognized = self._model.recognize(audio)
        transcript = _coerce_recognized_text(recognized)
        duration_ms = _duration_ms_from_audio(audio)
        return TranscriptionResult(transcript=transcript, duration_ms=duration_ms)


def _coerce_recognized_text(recognized: Any) -> str:
    """onnx-asr recognize() returns a str (single) or list[str] (batch); some
    versions return a result object exposing `.text`."""
    if isinstance(recognized, str):
        return recognized.strip()
    if isinstance(recognized, (list, tuple)):
        return " ".join(str(part) for part in recognized).strip()
    text = getattr(recognized, "text", None)
    return str(text).strip() if text is not None else str(recognized).strip()


def _duration_ms_from_audio(audio: Any) -> int:
    shape = getattr(audio, "shape", None)
    if not shape:
        return 0
    return int(round(shape[0] * 1000 / SERVER_SAMPLE_RATE_HZ))


def resolve_parakeet_model_root() -> Path:
    """Default Parakeet model dir under the shared STT models root."""
    from app.core.settings import get_app_paths  # noqa: PLC0415 - avoid import cycle at module load

    return get_app_paths().stt_models_root / PARAKEET_MODEL_DIRNAME
