"""Pure timing / lip-sync normalization helpers for the speech pipeline.

Extracted from speech.py (which had grown past ~1,700 lines) to isolate the
stateless "raw provider payload -> timing + lip-sync contract" logic from the
stateful adapters, registries, and lifecycle services that remain there. These
functions depend only on the session schema types — no settings, runtime
tuning, subprocess, or I/O — so they are cheap to import and unit-test.

speech.py re-exports every name here, so existing `app.services.speech.X`
references (e.g. tts_engines importing `speech._normalize_timing`) keep working.
"""

from __future__ import annotations

from typing import Any

from app.schemas.session import (
    AudioFormatMetadata,
    SpeechLipSyncDebug,
    SpeechLipSyncPayload,
    SpeechMouthCueSlot,
    SpeechMouthCueTrack,
    SpeechPhonemeSlot,
    SpeechSegmentRange,
    SpeechTimingMetadata,
    SpeechVisemeSlot,
)


# Single mouth-cue track. (A redundant lower-detail "basic" track was removed:
# the avatar rig only exposes the 5 VRM visemes aa/ih/ou/ee/oh, onto which the
# richer cues already alias, so a second track rendered identically.)
_MOUTH_TRACK_ID = "advanced"
_MOUTH_CUE_NAMESPACE = "vrm-advanced-v1"
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


def _resolve_mouth_cue_from_viseme(viseme: str) -> str | None:
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


def _resolve_mouth_cue_from_phoneme(phoneme: str) -> str | None:
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
            cue_namespace=str(item.get("cue_namespace") or "").strip() or _MOUTH_CUE_NAMESPACE,
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
    mouth_cues = (
        _build_mouth_cue_slots_from_phonemes(phoneme_slots, _resolve_mouth_cue_from_phoneme)
        if phoneme_slots
        else _build_mouth_cue_slots_from_visemes(viseme_slots, _resolve_mouth_cue_from_viseme)
    )

    if not mouth_cues:
        return None

    tracks = (
        SpeechMouthCueTrack(
            track_id=_MOUTH_TRACK_ID,
            cue_namespace=_MOUTH_CUE_NAMESPACE,
            cues=mouth_cues,
        ),
    )

    available_track_ids = tuple(track.track_id for track in tracks)
    default_track_id = (
        preferred_track_id.strip()
        if isinstance(preferred_track_id, str) and preferred_track_id.strip() in available_track_ids
        else _MOUTH_TRACK_ID
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
            else (_MOUTH_TRACK_ID if _MOUTH_TRACK_ID in available_track_ids else available_track_ids[0])
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
