from __future__ import annotations

from dataclasses import dataclass, field, replace
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import subprocess
import sys
import threading
import time
from typing import Any, Iterator, Protocol

from app.core.settings import AppPaths, get_app_paths
from app.schemas.session import (
    AssistantMessageContract,
    AudioFormatMetadata,
    SessionEvent,
    SessionSnapshot,
    SpeechLifecycleEventEnvelope,
    SpeechLifecycleTransportSnapshot,
    SpeechLipSyncDebug,
    SpeechLipSyncPayload,
    SpeechMouthCueSlot,
    SpeechMouthCueTrack,
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
from app.services.session import InvalidEventCursor, SessionEventStore


SESSION_STREAM = "session"
SPEECH_LIFECYCLE_STREAM = "speech.lifecycle"
RUNTIME_CONFIG_FILE_NAME = "runtime.json"
PUBLIC_SESSION_SPEECH_ARTIFACT_PREFIX = "/api/session/speech-artifacts"
_GPT_SOVITS_SYNTHESIS_SINGLE_FLIGHT = threading.Lock()

_BASIC_MOUTH_TRACK_ID = "basic"
_ADVANCED_MOUTH_TRACK_ID = "advanced"
_BASIC_CUE_NAMESPACE = "vrm-basic-v1"
_ADVANCED_CUE_NAMESPACE = "vrm-advanced-v1"
_TEXT_FALLBACK_TIMING_SOURCE = "text_fallback_visemes"


def _normalize_symbol_token(value: str) -> str:
    return "".join(character for character in value.strip().lower() if character.isalnum())


def _normalize_phoneme_token(value: str) -> str:
    return "".join(character for character in value.strip().upper() if character.isalpha())


def _append_timing_source(existing: str | None, marker: str) -> str:
    normalized_existing = str(existing or "").strip()
    if not normalized_existing:
        return marker

    existing_parts = {part.strip() for part in normalized_existing.split("+") if part.strip()}
    if marker in existing_parts:
        return normalized_existing

    return f"{normalized_existing}+{marker}"


def _resolve_basic_cue_from_viseme(viseme: str) -> str | None:
    normalized = _normalize_symbol_token(viseme)
    if not normalized:
        return None

    aliases = {
        "a": "aa",
        "aa": "aa",
        "i": "ih",
        "ih": "ih",
        "u": "ou",
        "ou": "ou",
        "e": "ee",
        "ee": "ee",
        "o": "oh",
        "oh": "oh",
        "sil": "sil",
        "x": "sil",
        "rest": "sil",
        "idle": "sil",
        "pause": "sil",
        "closed": "sil",
        "neutral": "sil",
        "bmp": "sil",
        "smile": "ee",
        "fv": "ee",
        "th": "ih",
        "l": "ee",
        "wq": "ou",
    }
    return aliases.get(normalized)


def _resolve_advanced_cue_from_viseme(viseme: str) -> str | None:
    normalized = _normalize_symbol_token(viseme)
    if not normalized:
        return None

    aliases = {
        "a": "aa",
        "aa": "aa",
        "i": "ih",
        "ih": "ih",
        "u": "ou",
        "ou": "ou",
        "e": "ee",
        "ee": "ee",
        "o": "oh",
        "oh": "oh",
        "sil": "sil",
        "x": "sil",
        "rest": "sil",
        "idle": "sil",
        "pause": "sil",
        "closed": "sil",
        "neutral": "sil",
        "bmp": "bmp",
        "fv": "fv",
        "th": "th",
        "l": "l",
        "wq": "wq",
        "smile": "ee",
    }
    return aliases.get(normalized)


def _resolve_basic_cue_from_phoneme(phoneme: str) -> str | None:
    token = _normalize_phoneme_token(phoneme)
    if not token:
        return None

    if token in {"SIL", "SP", "PAU", "CL", "BCL", "DCL", "GCL", "KCL", "PCL", "TCL"}:
        return "sil"
    if token in {"M", "B", "P", "EM"}:
        return "sil"
    if token in {"AA", "AE", "AH", "AX", "AY"}:
        return "aa"
    if token in {"AO", "ER", "R", "OH"}:
        return "oh"
    if token in {"UW", "UH", "OW", "AW", "OY", "W"}:
        return "ou"
    if token in {"IY", "EY", "EH", "EL", "L", "F", "V"}:
        return "ee"
    if token in {"IH", "IX", "Y", "TH", "DH", "S", "Z", "SH", "ZH", "CH", "JH", "T", "D", "N", "K", "G", "NG", "HH"}:
        return "ih"
    return None


def _resolve_advanced_cue_from_phoneme(phoneme: str) -> str | None:
    token = _normalize_phoneme_token(phoneme)
    if not token:
        return None

    if token in {"SIL", "SP", "PAU", "CL", "BCL", "DCL", "GCL", "KCL", "PCL", "TCL"}:
        return "sil"
    if token in {"M", "B", "P", "EM"}:
        return "bmp"
    if token in {"F", "V"}:
        return "fv"
    if token in {"L", "EL"}:
        return "l"
    if token in {"TH", "DH"}:
        return "th"
    if token in {"W", "UW", "UH", "OW", "AW", "OY"}:
        return "wq"
    if token in {"AA", "AE", "AH", "AX", "AY"}:
        return "aa"
    if token in {"AO", "ER", "R", "OH"}:
        return "oh"
    if token in {"IY", "EY", "EH"}:
        return "ee"
    if token in {"IH", "IX", "Y", "S", "Z", "SH", "ZH", "CH", "JH", "T", "D", "N", "K", "G", "NG", "HH"}:
        return "ih"
    return None


def _merge_mouth_cue_slots(slots: tuple[SpeechMouthCueSlot, ...]) -> tuple[SpeechMouthCueSlot, ...]:
    if not slots:
        return tuple()

    ordered_slots = sorted(slots, key=lambda slot: (slot.start_ms, slot.end_ms, slot.cue))
    merged_slots: list[SpeechMouthCueSlot] = [ordered_slots[0]]
    for slot in ordered_slots[1:]:
        previous = merged_slots[-1]
        if slot.cue == previous.cue and slot.start_ms <= previous.end_ms:
            merged_slots[-1] = SpeechMouthCueSlot(
                cue=previous.cue,
                start_ms=previous.start_ms,
                end_ms=max(previous.end_ms, slot.end_ms),
                weight=previous.weight if previous.weight is not None else slot.weight,
            )
            continue

        merged_slots.append(slot)

    return tuple(merged_slots)


def _build_mouth_cue_slots_from_phonemes(
    phoneme_slots: tuple[SpeechPhonemeSlot, ...],
    resolver: Any,
) -> tuple[SpeechMouthCueSlot, ...]:
    cues = [
        SpeechMouthCueSlot(
            cue=cue,
            start_ms=max(0, slot.start_ms),
            end_ms=max(max(0, slot.start_ms), slot.end_ms),
        )
        for slot in phoneme_slots
        for cue in [resolver(slot.phoneme)]
        if cue is not None and max(max(0, slot.start_ms), slot.end_ms) > max(0, slot.start_ms)
    ]
    return _merge_mouth_cue_slots(tuple(cues))


def _build_mouth_cue_slots_from_visemes(
    viseme_slots: tuple[SpeechVisemeSlot, ...],
    resolver: Any,
) -> tuple[SpeechMouthCueSlot, ...]:
    cues = [
        SpeechMouthCueSlot(
            cue=cue,
            start_ms=max(0, slot.start_ms),
            end_ms=max(max(0, slot.start_ms), slot.end_ms),
        )
        for slot in viseme_slots
        for cue in [resolver(slot.viseme)]
        if cue is not None and max(max(0, slot.start_ms), slot.end_ms) > max(0, slot.start_ms)
    ]
    return _merge_mouth_cue_slots(tuple(cues))


def _tokenize_text_fallback_visemes(text: str) -> tuple[str, ...]:
    normalized_text = text.lower()
    if not normalized_text.strip():
        return tuple()

    symbols: list[str] = []
    index = 0
    while index < len(normalized_text):
        pair = normalized_text[index:index + 2]
        character = normalized_text[index]

        if not character.isalpha():
            symbol = "sil"
            step = 1
        elif pair == "th":
            symbol = "th"
            step = 2
        elif pair in {"sh", "ch", "zh"}:
            symbol = "ih"
            step = 2
        elif character in {"m", "b", "p"}:
            symbol = "bmp"
            step = 1
        elif character in {"f", "v"}:
            symbol = "fv"
            step = 1
        elif character == "l":
            symbol = "l"
            step = 1
        elif character in {"w", "q"}:
            symbol = "wq"
            step = 1
        elif character == "a":
            symbol = "a"
            step = 1
        elif character == "e":
            symbol = "e"
            step = 1
        elif character in {"i", "y"}:
            symbol = "i"
            step = 1
        elif character == "o":
            symbol = "o"
            step = 1
        elif character == "u":
            symbol = "u"
            step = 1
        else:
            symbol = "ih"
            step = 1

        if not symbols or symbols[-1] != symbol:
            symbols.append(symbol)
        index += step

    return tuple(symbols or ["sil"])


def _build_text_fallback_viseme_slots(text: str, utterance_duration_ms: int) -> tuple[SpeechVisemeSlot, ...]:
    if utterance_duration_ms <= 0:
        return tuple()

    symbols = _tokenize_text_fallback_visemes(text)
    if not symbols:
        return tuple()

    weights = {
        "sil": 0.35,
        "bmp": 0.7,
        "fv": 0.8,
        "th": 0.8,
        "l": 0.8,
        "wq": 0.95,
        "a": 1.35,
        "e": 1.15,
        "i": 1.0,
        "o": 1.3,
        "u": 1.15,
        "ih": 0.85,
    }
    total_weight = sum(weights.get(symbol, 1.0) for symbol in symbols)
    if total_weight <= 0:
        return tuple()

    slots: list[SpeechVisemeSlot] = []
    cursor_ms = 0
    for index, symbol in enumerate(symbols):
        if index == len(symbols) - 1:
            end_ms = utterance_duration_ms
        else:
            slice_ms = max(1, int(round((weights.get(symbol, 1.0) / total_weight) * utterance_duration_ms)))
            end_ms = min(utterance_duration_ms, cursor_ms + slice_ms)

        if end_ms <= cursor_ms:
            continue

        slots.append(
            SpeechVisemeSlot(
                viseme=symbol,
                start_ms=cursor_ms,
                end_ms=end_ms,
            )
        )
        cursor_ms = end_ms

    if not slots:
        return tuple()

    if slots[-1].end_ms < utterance_duration_ms:
        last_slot = slots[-1]
        slots[-1] = SpeechVisemeSlot(
            viseme=last_slot.viseme,
            start_ms=last_slot.start_ms,
            end_ms=utterance_duration_ms,
        )

    return tuple(slot for slot in slots if slot.end_ms > slot.start_ms)


def _normalize_mouth_cue_slots(raw_value: Any) -> tuple[SpeechMouthCueSlot, ...]:
    if not isinstance(raw_value, list):
        return tuple()

    slots = tuple(
        SpeechMouthCueSlot(
            cue=str(item.get("cue") or ""),
            start_ms=_coerce_int(item.get("start_ms"), 0),
            end_ms=_coerce_int(item.get("end_ms"), 0),
            weight=_coerce_float(item.get("weight")),
        )
        for item in raw_value
        if isinstance(item, dict) and str(item.get("cue") or "").strip()
    )
    return _merge_mouth_cue_slots(tuple(slot for slot in slots if slot.end_ms > slot.start_ms))


def _normalize_mouth_cue_tracks(raw_value: Any) -> tuple[SpeechMouthCueTrack, ...]:
    if not isinstance(raw_value, list):
        return tuple()

    return tuple(
        SpeechMouthCueTrack(
            track_id=str(item.get("track_id") or "").strip(),
            cue_namespace=str(item.get("cue_namespace") or "").strip() or _BASIC_CUE_NAMESPACE,
            cues=_normalize_mouth_cue_slots(item.get("cues")),
        )
        for item in raw_value
        if isinstance(item, dict) and str(item.get("track_id") or "").strip()
    )


def _build_default_lip_sync_payload(
    *,
    phoneme_slots: tuple[SpeechPhonemeSlot, ...],
    viseme_slots: tuple[SpeechVisemeSlot, ...],
    preferred_track_id: str | None,
    timing_source: str | None,
) -> SpeechLipSyncPayload | None:
    basic_cues = (
        _build_mouth_cue_slots_from_visemes(viseme_slots, _resolve_basic_cue_from_viseme)
        if viseme_slots
        else _build_mouth_cue_slots_from_phonemes(phoneme_slots, _resolve_basic_cue_from_phoneme)
    )
    advanced_cues = (
        _build_mouth_cue_slots_from_phonemes(phoneme_slots, _resolve_advanced_cue_from_phoneme)
        if phoneme_slots
        else _build_mouth_cue_slots_from_visemes(viseme_slots, _resolve_advanced_cue_from_viseme)
    )

    tracks = tuple(
        track
        for track in (
            SpeechMouthCueTrack(
                track_id=_BASIC_MOUTH_TRACK_ID,
                cue_namespace=_BASIC_CUE_NAMESPACE,
                cues=basic_cues,
            )
            if basic_cues
            else None,
            SpeechMouthCueTrack(
                track_id=_ADVANCED_MOUTH_TRACK_ID,
                cue_namespace=_ADVANCED_CUE_NAMESPACE,
                cues=advanced_cues,
            )
            if advanced_cues
            else None,
        )
        if track is not None
    )

    if not tracks:
        return None

    available_track_ids = tuple(track.track_id for track in tracks)
    default_track_id = (
        preferred_track_id.strip()
        if isinstance(preferred_track_id, str) and preferred_track_id.strip() in available_track_ids
        else (_ADVANCED_MOUTH_TRACK_ID if _ADVANCED_MOUTH_TRACK_ID in available_track_ids else available_track_ids[0])
    )
    source_slot_type = "phoneme_slots" if phoneme_slots else "viseme_slots" if viseme_slots else None
    return SpeechLipSyncPayload(
        default_track_id=default_track_id,
        mouth_cue_tracks=tracks,
        debug=SpeechLipSyncDebug(
            timing_source=timing_source,
            source_slot_type=source_slot_type,
            generated_track_ids=available_track_ids,
            phoneme_slot_count=len(phoneme_slots),
            viseme_slot_count=len(viseme_slots),
        ),
    )


def _normalize_lip_sync_payload(
    raw_value: Any,
    *,
    phoneme_slots: tuple[SpeechPhonemeSlot, ...],
    viseme_slots: tuple[SpeechVisemeSlot, ...],
    preferred_track_id: str | None,
    timing_source: str | None,
) -> SpeechLipSyncPayload | None:
    default_payload = _build_default_lip_sync_payload(
        phoneme_slots=phoneme_slots,
        viseme_slots=viseme_slots,
        preferred_track_id=preferred_track_id,
        timing_source=timing_source,
    )
    if not isinstance(raw_value, dict):
        return default_payload

    tracks = _normalize_mouth_cue_tracks(raw_value.get("mouth_cue_tracks")) or (
        default_payload.mouth_cue_tracks if default_payload is not None else tuple()
    )
    if not tracks:
        return None

    available_track_ids = tuple(track.track_id for track in tracks)
    raw_default_track_id = str(raw_value.get("default_track_id") or "").strip()
    default_track_id = raw_default_track_id if raw_default_track_id in available_track_ids else None
    if default_track_id is None and isinstance(preferred_track_id, str) and preferred_track_id.strip() in available_track_ids:
        default_track_id = preferred_track_id.strip()
    if default_track_id is None:
        default_track_id = (
            default_payload.default_track_id
            if default_payload is not None and default_payload.default_track_id in available_track_ids
            else (_ADVANCED_MOUTH_TRACK_ID if _ADVANCED_MOUTH_TRACK_ID in available_track_ids else available_track_ids[0])
        )

    raw_debug = raw_value.get("debug") if isinstance(raw_value.get("debug"), dict) else {}
    return SpeechLipSyncPayload(
        default_track_id=default_track_id,
        mouth_cue_tracks=tracks,
        debug=SpeechLipSyncDebug(
            timing_source=str(raw_debug.get("timing_source") or timing_source or "").strip() or None,
            source_slot_type=str(raw_debug.get("source_slot_type") or "").strip()
            or (default_payload.debug.source_slot_type if default_payload and default_payload.debug else None),
            generated_track_ids=tuple(raw_debug.get("generated_track_ids") or available_track_ids),
            phoneme_slot_count=_coerce_int(raw_debug.get("phoneme_slot_count"), len(phoneme_slots)),
            viseme_slot_count=_coerce_int(raw_debug.get("viseme_slot_count"), len(viseme_slots)),
        ),
    )


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


class SpeechTranscriptionService(Protocol):
    """Boundary for provider-agnostic speech-to-text adapters."""

    def transcribe(self, request: SpeechTranscriptionRequest) -> SpeechTranscriptionContract:
        raise NotImplementedError


class SpeechSynthesisService(Protocol):
    """Boundary for provider-agnostic text-to-speech adapters."""

    def synthesize(self, request: SpeechSynthesisRequest) -> SpeechSynthesisContract:
        raise NotImplementedError


class SessionEventFactory(Protocol):
    """Boundary for canonical session-event production around speech contracts."""

    def build_event(
        self,
        snapshot: SessionSnapshot,
        *,
        character_id: str,
        event_type: str,
        status: str,
        reason: str | None = None,
        transcription: SpeechTranscriptionContract | None = None,
        assistant: AssistantMessageContract | None = None,
        synthesis: SpeechSynthesisContract | None = None,
    ) -> SessionEvent:
        raise NotImplementedError


class SpeechLifecycleSnapshotService(Protocol):
    """Boundary for a provider-agnostic speech lifecycle polling surface."""

    def get_snapshot(
        self,
        snapshot: SessionSnapshot,
        *,
        character_id: str,
        cursor: str | None = None,
    ) -> SpeechLifecycleTransportSnapshot:
        raise NotImplementedError


class SpeechLifecycleLiveDeliveryService(Protocol):
    """Boundary for streaming speech lifecycle delivery over a canonical cursor seam."""

    def iter_live_events(
        self,
        snapshot: SessionSnapshot,
        *,
        character_id: str,
        cursor: str | None = None,
        poll_interval_seconds: float = 0.25,
    ) -> Iterator[SpeechLifecycleEventEnvelope]:
        raise NotImplementedError


@dataclass(slots=True, frozen=True)
class BackendTurnRequest:
    character_id: str
    transcription: SpeechTranscriptionRequest
    synthesis: SpeechSynthesisRequest


@dataclass(slots=True, frozen=True)
class BackendTurnPublication:
    status: str
    session_events: tuple[SpeechLifecycleEventEnvelope, ...]
    speech_lifecycle_events: tuple[SpeechLifecycleEventEnvelope, ...]
    ordered_events: tuple[SpeechLifecycleEventEnvelope, ...]


class TurnPipelinePublisher(Protocol):
    """Boundary for publishing backend-owned turn events into canonical streams."""

    def publish_turn(
        self,
        snapshot: SessionSnapshot,
        turn_request: BackendTurnRequest,
    ) -> BackendTurnPublication:
        raise NotImplementedError


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


def _normalize_contract_status(raw_status: Any, *, success: bool) -> str:
    normalized = str(raw_status or "").strip().lower()
    if normalized in {"unavailable", "missing", "not_configured"}:
        return "unavailable"

    if normalized in {"degraded"}:
        return "degraded"

    if normalized in {"error", "failed"}:
        return "error"

    if normalized in {"ready", "ok", "success", "completed", "final"}:
        return "ready" if success else "error"

    return "ready" if success else "error"


def _coerce_int(value: Any, default: int) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def _coerce_float(value: Any) -> float | None:
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _normalize_audio_format(
    raw_value: Any,
    *,
    fallback: AudioFormatMetadata | None,
) -> AudioFormatMetadata | None:
    if not isinstance(raw_value, dict):
        return fallback

    if fallback is None:
        fallback = AudioFormatMetadata(
            container="wav",
            encoding="pcm_s16le",
            sample_rate_hz=24000,
            channels=1,
        )

    return AudioFormatMetadata(
        container=str(raw_value.get("container") or fallback.container),
        encoding=str(raw_value.get("encoding") or fallback.encoding),
        sample_rate_hz=_coerce_int(raw_value.get("sample_rate_hz"), fallback.sample_rate_hz),
        channels=_coerce_int(raw_value.get("channels"), fallback.channels),
    )


def _normalize_segment_ranges(raw_value: Any) -> tuple[SpeechSegmentRange, ...]:
    if not isinstance(raw_value, list):
        return tuple()

    return tuple(
        SpeechSegmentRange(
            start_ms=_coerce_int(item.get("start_ms"), 0),
            end_ms=_coerce_int(item.get("end_ms"), 0),
            text=str(item.get("text")) if item.get("text") is not None else None,
        )
        for item in raw_value
        if isinstance(item, dict)
    )


def _normalize_phoneme_slots(raw_value: Any) -> tuple[SpeechPhonemeSlot, ...]:
    if not isinstance(raw_value, list):
        return tuple()

    return tuple(
        SpeechPhonemeSlot(
            phoneme=str(item.get("phoneme") or ""),
            start_ms=_coerce_int(item.get("start_ms"), 0),
            end_ms=_coerce_int(item.get("end_ms"), 0),
        )
        for item in raw_value
        if isinstance(item, dict) and str(item.get("phoneme") or "").strip()
    )


def _normalize_viseme_slots(raw_value: Any) -> tuple[SpeechVisemeSlot, ...]:
    if not isinstance(raw_value, list):
        return tuple()

    return tuple(
        SpeechVisemeSlot(
            viseme=str(item.get("viseme") or ""),
            start_ms=_coerce_int(item.get("start_ms"), 0),
            end_ms=_coerce_int(item.get("end_ms"), 0),
        )
        for item in raw_value
        if isinstance(item, dict) and str(item.get("viseme") or "").strip()
    )


def _normalize_timing(
    raw_value: Any,
    *,
    fallback: SpeechTimingMetadata,
    preferred_lip_sync_track_id: str | None = None,
    source_text: str | None = None,
) -> SpeechTimingMetadata:
    if not isinstance(raw_value, dict):
        return fallback

    segment_ranges = _normalize_segment_ranges(raw_value.get("segment_ranges")) or fallback.segment_ranges
    utterance_duration_ms = _coerce_int(
        raw_value.get("utterance_duration_ms"),
        fallback.utterance_duration_ms,
    )
    if utterance_duration_ms <= 0 and segment_ranges:
        utterance_duration_ms = max(segment.end_ms for segment in segment_ranges)

    phoneme_slots = _normalize_phoneme_slots(raw_value.get("phoneme_slots"))
    viseme_slots = _normalize_viseme_slots(raw_value.get("viseme_slots"))
    timing_source = str(raw_value.get("timing_source") or "").strip() or None

    if not phoneme_slots and not viseme_slots:
        fallback_viseme_slots = _build_text_fallback_viseme_slots(str(source_text or "").strip(), utterance_duration_ms)
        if fallback_viseme_slots:
            viseme_slots = fallback_viseme_slots
            timing_source = _append_timing_source(timing_source, _TEXT_FALLBACK_TIMING_SOURCE)

    return SpeechTimingMetadata(
        utterance_duration_ms=utterance_duration_ms,
        segment_ranges=segment_ranges,
        audio_format=_normalize_audio_format(
            raw_value.get("audio_format"),
            fallback=fallback.audio_format,
        ),
        phoneme_slots=phoneme_slots,
        viseme_slots=viseme_slots,
        lip_sync=_normalize_lip_sync_payload(
            raw_value.get("lip_sync"),
            phoneme_slots=phoneme_slots,
            viseme_slots=viseme_slots,
            preferred_track_id=preferred_lip_sync_track_id,
            timing_source=timing_source,
        ) or fallback.lip_sync,
    )


def _normalize_audio_reference(raw_value: Any, *, provider_root: Path, model_root: Path) -> str | None:
    if not isinstance(raw_value, str) or not raw_value.strip():
        return None

    normalized_value = raw_value.strip()
    if "://" in normalized_value:
        return normalized_value

    raw_path = Path(normalized_value)
    if raw_path.is_absolute():
        return str(raw_path) if raw_path.exists() else None

    for base_root in (provider_root, model_root):
        resolved = (base_root / raw_path).resolve()
        if resolved.exists():
            return str(resolved)

    return None


def _looks_like_machine_local_audio_reference(raw_value: str) -> bool:
    normalized_value = raw_value.strip()
    if not normalized_value or normalized_value.startswith("session://"):
        return False

    if "://" in normalized_value:
        return False

    return Path(normalized_value).is_absolute()


def _is_relative_to(path: Path, root: Path) -> bool:
    try:
        path.relative_to(root)
    except ValueError:
        return False

    return True


def _resolve_public_speech_audio_artifact_path(audio_reference: str) -> Path | None:
    if not _looks_like_machine_local_audio_reference(audio_reference):
        return None

    audio_path = Path(audio_reference).resolve()
    if not audio_path.is_file():
        return None

    app_paths = get_app_paths()
    allowed_roots = (
        app_paths.tts_models_root.resolve(),
        app_paths.cache_root.resolve(),
    )
    if not any(_is_relative_to(audio_path, root) for root in allowed_roots):
        return None

    return audio_path


def build_public_speech_audio_reference(*, event_id: str) -> str:
    return f"{PUBLIC_SESSION_SPEECH_ARTIFACT_PREFIX}/{event_id}/audio"


def project_public_session_event(
    event: SessionEvent,
    *,
    audio_event_id: str | None = None,
) -> SessionEvent:
    synthesis = event.synthesis
    if synthesis is None or synthesis.audio_reference is None or audio_event_id is None:
        return event

    if _resolve_public_speech_audio_artifact_path(synthesis.audio_reference) is None:
        return event

    return replace(
        event,
        synthesis=replace(
            synthesis,
            audio_reference=build_public_speech_audio_reference(event_id=audio_event_id),
        ),
    )


def project_public_speech_lifecycle_envelope(
    envelope: SpeechLifecycleEventEnvelope,
) -> SpeechLifecycleEventEnvelope:
    projected_event = project_public_session_event(
        envelope.event,
        audio_event_id=envelope.event_id,
    )
    if projected_event == envelope.event:
        return envelope

    return replace(envelope, event=projected_event)


def project_public_speech_lifecycle_snapshot(
    snapshot: SpeechLifecycleTransportSnapshot,
) -> SpeechLifecycleTransportSnapshot:
    return replace(
        snapshot,
        events=tuple(project_public_speech_lifecycle_envelope(envelope) for envelope in snapshot.events),
    )


def resolve_session_speech_artifact_path(
    event_store: SessionEventStore,
    *,
    session_id: str,
    event_id: str,
) -> Path | None:
    for envelope in event_store.read(SPEECH_LIFECYCLE_STREAM, session_id=session_id):
        if envelope.event_id != event_id:
            continue

        synthesis = envelope.event.synthesis
        if synthesis is None or synthesis.audio_reference is None:
            return None

        return _resolve_public_speech_audio_artifact_path(synthesis.audio_reference)

    return None


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


@dataclass(slots=True)
class StubSpeechLifecycleSnapshotService:
    """Deterministic read surface that prefers canonical event-store data when present."""

    event_store: SessionEventStore | None = None
    transcription_service: SpeechTranscriptionService | None = None
    synthesis_service: SpeechSynthesisService | None = None
    session_event_factory: SessionEventFactory | None = None
    fallback_on_empty: bool = False

    def get_snapshot(
        self,
        snapshot: SessionSnapshot,
        *,
        character_id: str,
        cursor: str | None = None,
    ) -> SpeechLifecycleTransportSnapshot:
        if self.event_store is not None:
            events = self.event_store.read(
                SPEECH_LIFECYCLE_STREAM,
                session_id=snapshot.session_id,
                after_cursor=cursor,
            )
            if events or not self.fallback_on_empty:
                return project_public_speech_lifecycle_snapshot(
                    SpeechLifecycleTransportSnapshot(
                        schema_version=1,
                        stream=SPEECH_LIFECYCLE_STREAM,
                        delivery="snapshot",
                        session_id=snapshot.session_id,
                        next_cursor=self.event_store.next_cursor(
                            SPEECH_LIFECYCLE_STREAM,
                            session_id=snapshot.session_id,
                        ),
                        events=events,
                    )
                )

        transcription_service = self.transcription_service or StubSpeechTranscriptionService()
        synthesis_service = self.synthesis_service or StubSpeechSynthesisService()
        session_event_factory = self.session_event_factory or DefaultSessionEventFactory()
        after_sequence = _parse_cursor_sequence(
            SPEECH_LIFECYCLE_STREAM,
            session_id=snapshot.session_id,
            cursor=cursor,
        )

        transcription = transcription_service.transcribe(
            SpeechTranscriptionRequest(
                audio_reference="session://speech-sample/transcription.wav",
                locale="en-US",
                transcript_hint="Hey Niko, can you wave after you answer?",
                confidence_hint=0.98,
            )
        )
        synthesis = synthesis_service.synthesize(
            SpeechSynthesisRequest(
                text="Sure. I can wave once I finish speaking.",
                locale="en-US",
            )
        )

        events = (
            session_event_factory.build_event(
                snapshot,
                character_id=character_id,
                event_type="transcription.status",
                status="final",
                transcription=transcription,
            ),
            session_event_factory.build_event(
                snapshot,
                character_id=character_id,
                event_type="speech.synthesis",
                status="ready",
                synthesis=synthesis,
            ),
        )

        envelopes = tuple(
            SpeechLifecycleEventEnvelope(
                event_id=f"speech-lifecycle-{sequence:04d}",
                sequence=sequence,
                cursor=f"{SPEECH_LIFECYCLE_STREAM}:{snapshot.session_id}:{sequence}",
                event=event,
            )
            for sequence, event in enumerate(events, start=1)
            if sequence > after_sequence
        )

        return project_public_speech_lifecycle_snapshot(
            SpeechLifecycleTransportSnapshot(
                schema_version=1,
                stream=SPEECH_LIFECYCLE_STREAM,
                delivery="snapshot",
                session_id=snapshot.session_id,
                next_cursor=f"{SPEECH_LIFECYCLE_STREAM}:{snapshot.session_id}:{len(events) + 1}",
                events=envelopes,
            )
        )


@dataclass(slots=True)
class SpeechServiceRegistry:
    """Minimal profile-family registry for provider shells while contracts stay stable."""

    transcription_services: dict[str, SpeechTranscriptionService] = field(default_factory=dict)
    synthesis_services: dict[str, SpeechSynthesisService] = field(default_factory=dict)
    fallback_transcription_service: SpeechTranscriptionService = field(
        default_factory=StubSpeechTranscriptionService
    )
    fallback_synthesis_service: SpeechSynthesisService = field(
        default_factory=StubSpeechSynthesisService
    )

    def resolve_transcription(self, request: SpeechTranscriptionRequest) -> SpeechTranscriptionService:
        return self.transcription_services.get(
            _resolve_profile_family(request.profile_id),
            self.fallback_transcription_service,
        )

    def resolve_synthesis(self, request: SpeechSynthesisRequest) -> SpeechSynthesisService:
        return self.synthesis_services.get(
            _resolve_profile_family(request.profile_id),
            self.fallback_synthesis_service,
        )


def build_speech_service_registry(app_paths: AppPaths | None = None) -> SpeechServiceRegistry:
    resolved_paths = app_paths or get_app_paths()
    return SpeechServiceRegistry(
        transcription_services={
            "faster-whisper": FasterWhisperTranscriptionAdapter(app_paths=resolved_paths),
        },
        synthesis_services={
            "gpt-sovits": GptSovitsSynthesisAdapter(app_paths=resolved_paths),
        },
    )


@dataclass(slots=True)
class DefaultSessionEventFactory:
    """Builds the current backend session-event envelope without provider coupling."""

    def build_event(
        self,
        snapshot: SessionSnapshot,
        *,
        character_id: str,
        event_type: str,
        status: str,
        reason: str | None = None,
        transcription: SpeechTranscriptionContract | None = None,
        assistant: AssistantMessageContract | None = None,
        synthesis: SpeechSynthesisContract | None = None,
    ) -> SessionEvent:
        return SessionEvent(
            schema_version=1,
            event_type=event_type,
            session_id=snapshot.session_id,
            character_id=character_id,
            status=status,
            timestamp=datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
            reason=reason,
            transcription=transcription,
            assistant=assistant,
            synthesis=synthesis,
        )


def _parse_cursor_sequence(
    stream: str,
    *,
    session_id: str,
    cursor: str | None,
) -> int:
    if cursor is None:
        return 0

    cursor_stream, separator, remainder = cursor.partition(":")
    if not separator:
        raise InvalidEventCursor(f"Invalid cursor format: {cursor}")

    cursor_session_id, separator, sequence_text = remainder.partition(":")
    if not separator:
        raise InvalidEventCursor(f"Invalid cursor format: {cursor}")

    if cursor_stream != stream or cursor_session_id != session_id:
        raise InvalidEventCursor(
            f"Cursor {cursor} does not belong to {stream} for session {session_id}."
        )

    try:
        sequence = int(sequence_text)
    except ValueError as error:
        raise InvalidEventCursor(f"Invalid cursor sequence: {cursor}") from error

    if sequence < 0:
        raise InvalidEventCursor(f"Cursor sequence must be non-negative: {cursor}")

    return sequence


def _derive_publication_status(*statuses: str) -> str:
    if any(status == "error" for status in statuses):
        return "error"

    if any(status in {"degraded", "unavailable"} for status in statuses):
        return "degraded"

    return "ready"


@dataclass(slots=True)
class DefaultTurnPipelinePublisher:
    transcription_service: SpeechTranscriptionService
    synthesis_service: SpeechSynthesisService
    session_event_factory: SessionEventFactory
    event_store: SessionEventStore

    def publish_turn(
        self,
        snapshot: SessionSnapshot,
        turn_request: BackendTurnRequest,
    ) -> BackendTurnPublication:
        session_started = self.event_store.append(
            SESSION_STREAM,
            self.session_event_factory.build_event(
                snapshot,
                character_id=turn_request.character_id,
                event_type="session.turn.started",
                status="started",
            ),
        )
        transcription = self.transcription_service.transcribe(turn_request.transcription)
        transcription_event = self.event_store.append(
            SPEECH_LIFECYCLE_STREAM,
            self.session_event_factory.build_event(
                snapshot,
                character_id=turn_request.character_id,
                event_type="transcription.status",
                status=transcription.status,
                transcription=transcription,
            ),
        )
        synthesis = self.synthesis_service.synthesize(turn_request.synthesis)
        synthesis_event = self.event_store.append(
            SPEECH_LIFECYCLE_STREAM,
            self.session_event_factory.build_event(
                snapshot,
                character_id=turn_request.character_id,
                event_type="speech.synthesis",
                status=synthesis.status,
                synthesis=synthesis,
            ),
        )
        publication_status = _derive_publication_status(transcription.status, synthesis.status)
        session_published = self.event_store.append(
            SESSION_STREAM,
            self.session_event_factory.build_event(
                snapshot,
                character_id=turn_request.character_id,
                event_type="session.turn.published",
                status=publication_status,
            ),
        )

        session_events = (session_started, session_published)
        speech_lifecycle_events = (transcription_event, synthesis_event)
        return BackendTurnPublication(
            status=publication_status,
            session_events=session_events,
            speech_lifecycle_events=speech_lifecycle_events,
            ordered_events=(
                session_started,
                transcription_event,
                synthesis_event,
                session_published,
            ),
        )


@dataclass(slots=True)
class PollingSpeechLifecycleLiveDeliveryService:
    snapshot_service: SpeechLifecycleSnapshotService

    def iter_live_events(
        self,
        snapshot: SessionSnapshot,
        *,
        character_id: str,
        cursor: str | None = None,
        poll_interval_seconds: float = 0.25,
    ) -> Iterator[SpeechLifecycleEventEnvelope]:
        current_cursor = cursor

        while True:
            transport_snapshot = self.snapshot_service.get_snapshot(
                snapshot,
                character_id=character_id,
                cursor=current_cursor,
            )
            if transport_snapshot.events:
                for envelope in transport_snapshot.events:
                    current_cursor = envelope.cursor
                    yield envelope
                continue

            time.sleep(poll_interval_seconds)