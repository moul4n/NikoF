"""Local speech provider adapters and their subprocess-invocation infra.

Extracted from speech.py to isolate the provider layer from the lifecycle/
registry code: the request dataclasses, the JSON-entrypoint invocation layer,
voice-profile / synthesis-option normalization, and the four provider adapters
(stub + Faster-Whisper transcription, stub + GPT-SoVITS synthesis).

Self-contained — imports only leaf helpers (speech_timing, speech_artifacts) +
schema/settings/resource-monitor, never speech.py — so speech.py can re-export
these without an import cycle.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from app.core.settings import AppPaths, get_app_paths
from app.schemas.session import (
    AudioFormatMetadata,
    SpeechPhonemeSlot,
    SpeechSegmentRange,
    SpeechSynthesisContract,
    SpeechTimingMetadata,
    SpeechTranscriptionContract,
    SpeechVisemeSlot,
    STT_BASELINE_PROFILE_IDS,
    TTS_BASELINE_PROFILE_IDS,
)
from app.services.resource_monitor import get_resource_monitor
from app.services.speech_artifacts import _normalize_audio_reference
from app.services.speech_timing import (
    _coerce_float,
    _coerce_int,
    _normalize_contract_status,
    _normalize_timing,
)


RUNTIME_CONFIG_FILE_NAME = "runtime.json"
_GPT_SOVITS_SYNTHESIS_SINGLE_FLIGHT = threading.Lock()
def _read_runtime_config(*roots: Path) -> tuple[dict[str, Any], Path | None]:
    for root in roots:
        config_path = root / RUNTIME_CONFIG_FILE_NAME
        if not config_path.is_file():
            continue

        try:
            decoded = json.loads(config_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue

        if isinstance(decoded, dict):
            return decoded, config_path

    return {}, None


def _resolve_relative_entrypoint(provider_root: Path, raw_value: Any) -> Path | None:
    if not isinstance(raw_value, str) or not raw_value.strip():
        return None

    candidate = (provider_root / raw_value.strip()).resolve()
    provider_root_resolved = provider_root.resolve()
    try:
        candidate.relative_to(provider_root_resolved)
    except ValueError:
        return None

    return candidate


def _normalize_python_executable(raw_value: Any) -> str:
    if isinstance(raw_value, str) and raw_value.strip():
        return raw_value.strip()

    return sys.executable


@dataclass(slots=True, frozen=True)
class SpeechTranscriptionRequest:
    audio_reference: str
    locale: str
    profile_id: str = STT_BASELINE_PROFILE_IDS[0]
    transcript_hint: str | None = None
    confidence_hint: float | None = None
    timing: SpeechTimingMetadata | None = None


@dataclass(slots=True, frozen=True)
class SpeechSynthesisRequest:
    text: str
    locale: str
    profile_id: str = TTS_BASELINE_PROFILE_IDS[0]
    timing: SpeechTimingMetadata | None = None
    voice_profile_id: str | None = None
    voice_profile: dict[str, Any] | None = None
    preferred_lip_sync_track_id: str | None = None

@dataclass(slots=True, frozen=True)
class SpeechAdapterRuntimeBinding:
    """Describes where a future provider-specific adapter will resolve its runtime assets."""

    profile_id: str
    modality: str
    family: str
    provider_root: Path
    model_root: Path
    invocation_entrypoint: Path
    configured: bool
    runtime_config_path: Path | None = None
    python_executable: str = sys.executable
    timeout_seconds: int = 20


class SpeechAdapterInvocationError(RuntimeError):
    """Raised when a local speech adapter cannot complete a request."""


def _resolve_invocation_entrypoint(provider_root: Path, primary_name: str, fallback_name: str) -> Path:
    primary_entrypoint = provider_root / primary_name
    fallback_entrypoint = provider_root / fallback_name
    if primary_entrypoint.exists() or not fallback_entrypoint.exists():
        return primary_entrypoint

    return fallback_entrypoint


def _run_json_entrypoint(
    entrypoint: Path,
    payload: dict[str, Any],
    *,
    python_executable: str = sys.executable,
    timeout_seconds: int = 20,
    environment: dict[str, str] | None = None,
) -> dict[str, Any]:
    try:
        completed = subprocess.run(
            [python_executable, str(entrypoint)],
            input=json.dumps(payload),
            capture_output=True,
            text=True,
            timeout=timeout_seconds,
            check=False,
            cwd=str(entrypoint.parent),
            env=environment,
        )
    except (OSError, subprocess.SubprocessError) as error:
        raise SpeechAdapterInvocationError("execution-failed") from error

    if completed.returncode != 0:
        raise SpeechAdapterInvocationError("execution-failed")

    try:
        decoded = json.loads(completed.stdout)
    except json.JSONDecodeError as error:
        raise SpeechAdapterInvocationError("invalid-json") from error

    if not isinstance(decoded, dict):
        raise SpeechAdapterInvocationError("invalid-payload")

    return decoded
def _normalize_string(value: Any) -> str | None:
    if value is None:
        return None

    normalized = str(value).strip()
    return normalized or None


def _normalize_voice_profile_payload(
    raw_value: Any,
    *,
    provider_root: Path,
    model_root: Path,
) -> dict[str, Any]:
    if not isinstance(raw_value, dict):
        return {}

    normalized: dict[str, Any] = {}
    for key in (
        "profile_id",
        "provider",
        "style",
        "notes",
        "speaker",
        "prompt_text",
        "prompt_language",
        "reference_text",
        "text_language",
    ):
        value = _normalize_string(raw_value.get(key))
        if value is not None:
            normalized[key] = value

    reference_audio = _normalize_audio_reference(
        raw_value.get("reference_audio"),
        provider_root=provider_root,
        model_root=model_root,
    )
    if reference_audio is not None:
        normalized["reference_audio"] = reference_audio

    for key in ("speed", "temperature", "top_p", "repetition_penalty"):
        value = _coerce_float(raw_value.get(key))
        if value is not None:
            normalized[key] = value

    top_k = _coerce_int(raw_value.get("top_k"), -1)
    if top_k >= 0:
        normalized["top_k"] = top_k

    seed = _coerce_int(raw_value.get("seed"), -1)
    if seed >= 0:
        normalized["seed"] = seed

    return normalized


def _normalize_runtime_synthesis_options(
    raw_value: Any,
    *,
    locale: str,
    provider_root: Path,
    model_root: Path,
) -> dict[str, Any]:
    if not isinstance(raw_value, dict):
        return {}

    source = raw_value.get("synthesis") if isinstance(raw_value.get("synthesis"), dict) else raw_value
    normalized = _normalize_voice_profile_payload(
        source,
        provider_root=provider_root,
        model_root=model_root,
    )
    if "text_language" not in normalized:
        normalized["text_language"] = locale
    return normalized


def _merge_synthesis_options(
    runtime_options: dict[str, Any],
    voice_profile: dict[str, Any],
) -> dict[str, Any]:
    if not runtime_options and not voice_profile:
        return {}

    merged = dict(runtime_options)
    for key, value in voice_profile.items():
        if value is None:
            continue

        merged[key] = value

    return merged


def _resolve_profile_family(profile_id: str) -> str:
    _, separator, remainder = profile_id.partition(".")
    if not separator:
        return profile_id

    family, _, _ = remainder.partition(".")
    return family or profile_id


@dataclass(slots=True)
class StubSpeechTranscriptionService:
    """Deterministic scaffold until a real STT adapter is wired in."""

    default_timing: SpeechTimingMetadata = SpeechTimingMetadata(
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
    )

    def transcribe(self, request: SpeechTranscriptionRequest) -> SpeechTranscriptionContract:
        return SpeechTranscriptionContract(
            profile_id=request.profile_id,
            status="final",
            locale=request.locale,
            transcript=request.transcript_hint or "Scaffold transcription unavailable.",
            confidence=request.confidence_hint if request.confidence_hint is not None else 0.98,
            timing=request.timing or self.default_timing,
        )


@dataclass(slots=True)
class FasterWhisperTranscriptionAdapter(StubSpeechTranscriptionService):
    """Configuration-aware Faster-Whisper adapter behind the local provider contract."""

    app_paths: AppPaths = field(default_factory=get_app_paths)
    model_directories: dict[str, str] = field(
        default_factory=lambda: {
            STT_BASELINE_PROFILE_IDS[0]: "faster-whisper-medium",
            STT_BASELINE_PROFILE_IDS[1]: "faster-whisper-small",
        }
    )

    def binding_for(self, request: SpeechTranscriptionRequest) -> SpeechAdapterRuntimeBinding:
        model_directory = self.model_directories.get(request.profile_id, "faster-whisper-medium")
        provider_root = self.app_paths.providers_root / "stt" / "faster-whisper"
        model_root = self.app_paths.stt_models_root / model_directory
        runtime_config, runtime_config_path = _read_runtime_config(model_root, provider_root)
        invocation_entrypoint = _resolve_relative_entrypoint(
            provider_root,
            runtime_config.get("entrypoint"),
        ) or _resolve_invocation_entrypoint(
            provider_root,
            "transcribe.py",
            "main.py",
        )
        return SpeechAdapterRuntimeBinding(
            profile_id=request.profile_id,
            modality="stt",
            family="faster-whisper",
            provider_root=provider_root,
            model_root=model_root,
            invocation_entrypoint=invocation_entrypoint,
            configured=provider_root.exists()
            and model_root.exists()
            and invocation_entrypoint.exists(),
            runtime_config_path=runtime_config_path,
            python_executable=_normalize_python_executable(runtime_config.get("python_executable")),
            timeout_seconds=max(1, _coerce_int(runtime_config.get("timeout_seconds"), 20)),
        )

    def transcribe(self, request: SpeechTranscriptionRequest) -> SpeechTranscriptionContract:
        binding = self.binding_for(request)
        tracker = get_resource_monitor().tracker("stt")
        fallback_timing = request.timing or self.default_timing
        if not binding.configured:
            return SpeechTranscriptionContract(
                profile_id=request.profile_id,
                status="unavailable",
                locale=request.locale,
                transcript=request.transcript_hint or "Local transcription is unavailable.",
                confidence=request.confidence_hint,
                timing=fallback_timing,
            )

        start_time = time.time()
        try:
            response = _run_json_entrypoint(
                binding.invocation_entrypoint,
                {
                    "profile_id": request.profile_id,
                    "audio_reference": request.audio_reference,
                    "locale": request.locale,
                    "transcript_hint": request.transcript_hint,
                    "confidence_hint": request.confidence_hint,
                    "model_root": str(binding.model_root),
                    "provider_root": str(binding.provider_root),
                    "timing": None if request.timing is None else {
                        "utterance_duration_ms": request.timing.utterance_duration_ms,
                        "segment_ranges": [
                            {
                                "start_ms": segment.start_ms,
                                "end_ms": segment.end_ms,
                                "text": segment.text,
                            }
                            for segment in request.timing.segment_ranges
                        ],
                    },
                },
                python_executable=binding.python_executable,
                timeout_seconds=binding.timeout_seconds,
                environment={
                    **os.environ,
                    "NIKOF_BACKEND_ROOT": str(Path(__file__).resolve().parents[2]),
                },
            )
        except SpeechAdapterInvocationError as error:
            status = "unavailable" if str(error) == "execution-failed" else "error"
            return SpeechTranscriptionContract(
                profile_id=request.profile_id,
                status=status,
                locale=request.locale,
                transcript=request.transcript_hint or "Local transcription is unavailable.",
                confidence=request.confidence_hint,
                timing=fallback_timing,
            )

        elapsed_ms = (time.time() - start_time) * 1000

        # Mark STT as loaded on first successful transcription
        if not tracker.loaded:
            # faster-whisper medium uses ~2GB VRAM
            tracker.mark_loaded(f"faster-whisper/{binding.model_root.name}", vram_mb=2000, ram_mb=512)
        tracker.record_request(elapsed_ms)

        transcript = str(
            response.get("transcript")
            or response.get("text")
            or request.transcript_hint
            or ""
        )
        success = bool(transcript.strip())
        status = _normalize_contract_status(response.get("status"), success=success)
        confidence = _coerce_float(response.get("confidence"))
        if confidence is None:
            confidence = request.confidence_hint

        return SpeechTranscriptionContract(
            profile_id=request.profile_id,
            status=status,
            locale=str(response.get("locale") or request.locale),
            transcript=transcript,
            confidence=confidence,
            timing=_normalize_timing(response.get("timing"), fallback=fallback_timing),
        )


@dataclass(slots=True)
class StubSpeechSynthesisService:
    """Deterministic scaffold until a real TTS adapter is wired in."""

    default_timing: SpeechTimingMetadata = SpeechTimingMetadata(
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
    )

    def synthesize(self, request: SpeechSynthesisRequest) -> SpeechSynthesisContract:
        return SpeechSynthesisContract(
            profile_id=request.profile_id,
            status="ready",
            text=request.text,
            locale=request.locale,
            timing=request.timing or self.default_timing,
        )


@dataclass(slots=True)
class GptSovitsSynthesisAdapter(StubSpeechSynthesisService):
    """Configuration-aware shell for future GPT-SoVITS-backed synthesis."""

    app_paths: AppPaths = field(default_factory=get_app_paths)
    model_directories: dict[str, str] = field(
        default_factory=lambda: {
            TTS_BASELINE_PROFILE_IDS[0]: "gpt-sovits",
        }
    )

    def binding_for(self, request: SpeechSynthesisRequest) -> SpeechAdapterRuntimeBinding:
        model_directory = self.model_directories.get(request.profile_id, "gpt-sovits")
        provider_root = self.app_paths.providers_root / "tts" / "gpt-sovits"
        model_root = self.app_paths.tts_models_root / model_directory
        runtime_config, runtime_config_path = _read_runtime_config(model_root, provider_root)
        invocation_entrypoint = _resolve_relative_entrypoint(
            provider_root,
            runtime_config.get("entrypoint"),
        ) or _resolve_invocation_entrypoint(
            provider_root,
            "synthesize.py",
            "api_server.py",
        )
        return SpeechAdapterRuntimeBinding(
            profile_id=request.profile_id,
            modality="tts",
            family="gpt-sovits",
            provider_root=provider_root,
            model_root=model_root,
            invocation_entrypoint=invocation_entrypoint,
            configured=provider_root.exists()
            and model_root.exists()
            and invocation_entrypoint.exists(),
            runtime_config_path=runtime_config_path,
            python_executable=_normalize_python_executable(runtime_config.get("python_executable")),
            timeout_seconds=max(1, _coerce_int(runtime_config.get("timeout_seconds"), 20)),
        )

    def synthesize(self, request: SpeechSynthesisRequest) -> SpeechSynthesisContract:
        binding = self.binding_for(request)
        fallback_timing = request.timing or self.default_timing
        if not binding.configured:
            return SpeechSynthesisContract(
                profile_id=request.profile_id,
                status="unavailable",
                text=request.text,
                locale=request.locale,
                timing=fallback_timing,
            )

        runtime_config, _ = _read_runtime_config(binding.model_root, binding.provider_root)
        voice_profile = _normalize_voice_profile_payload(
            request.voice_profile,
            provider_root=binding.provider_root,
            model_root=binding.model_root,
        )
        synthesis_options = _merge_synthesis_options(
            _normalize_runtime_synthesis_options(
                runtime_config,
                locale=request.locale,
                provider_root=binding.provider_root,
                model_root=binding.model_root,
            ),
            voice_profile,
        )

        try:
            with _GPT_SOVITS_SYNTHESIS_SINGLE_FLIGHT:
                response = _run_json_entrypoint(
                    binding.invocation_entrypoint,
                    {
                        "profile_id": request.profile_id,
                        "voice_profile_id": request.voice_profile_id
                        or _normalize_string(voice_profile.get("profile_id"))
                        or _normalize_string(synthesis_options.get("profile_id")),
                        "text": request.text,
                        "locale": request.locale,
                        "model_root": str(binding.model_root),
                        "provider_root": str(binding.provider_root),
                        "voice_profile": voice_profile or None,
                        "synthesis_options": synthesis_options or None,
                        "timing": None if request.timing is None else {
                            "utterance_duration_ms": request.timing.utterance_duration_ms,
                            "segment_ranges": [
                                {
                                    "start_ms": segment.start_ms,
                                    "end_ms": segment.end_ms,
                                    "text": segment.text,
                                }
                                for segment in request.timing.segment_ranges
                            ],
                        },
                    },
                    python_executable=binding.python_executable,
                    timeout_seconds=binding.timeout_seconds,
                    environment={
                        **os.environ,
                        "NIKOF_BACKEND_ROOT": str(Path(__file__).resolve().parents[2]),
                    },
                )
        except SpeechAdapterInvocationError as error:
            status = "unavailable" if str(error) == "execution-failed" else "error"
            return SpeechSynthesisContract(
                profile_id=request.profile_id,
                status=status,
                text=request.text,
                locale=request.locale,
                timing=fallback_timing,
            )

        audio_reference = _normalize_audio_reference(
            response.get("audio_reference")
            or response.get("audio_path")
            or response.get("output_path")
            or response.get("wav_path"),
            provider_root=binding.provider_root,
            model_root=binding.model_root,
        )
        timing = _normalize_timing(
            response.get("timing"),
            fallback=fallback_timing,
            preferred_lip_sync_track_id=request.preferred_lip_sync_track_id,
            source_text=str(response.get("text") or request.text),
        )
        success = audio_reference is not None
        status = _normalize_contract_status(response.get("status"), success=success)

        return SpeechSynthesisContract(
            profile_id=request.profile_id,
            status=status,
            text=str(response.get("text") or request.text),
            locale=str(response.get("locale") or request.locale),
            audio_reference=audio_reference,
            timing=timing,
        )


