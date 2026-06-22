"""Per-turn speech synthesis dispatch + streaming generation (extracted from turns.py).

Builds the synthesis request/contracts, runs the synthesis service, appends
speech.synthesis lifecycle events (and pushes segment audio over the WebSocket),
and drives Phase 1a/1b segmented + streamed generation into ordered TTS
segments. Depends on turns only via the duck-typed UserTurnServices (typed Any
here to avoid a cycle); re-exported from turns.py for the pipeline.
"""

from __future__ import annotations

import logging
import queue
import threading
import time
from dataclasses import replace
from pathlib import Path
from typing import Any

from app.schemas.session import (
    AssistantMessageContract,
    SpeechLifecycleEventEnvelope,
    SpeechSynthesisContract,
    TTS_BASELINE_PROFILE_IDS,
)
from app.services.llm import TextGenerationRequest
from app.services.speech import SPEECH_LIFECYCLE_STREAM, SpeechSynthesisRequest
from app.services.speech_audio_broadcast import get_speech_audio_broadcaster
from app.services.text_segmentation import StreamingSentenceSegmenter


logger = logging.getLogger(__name__)


def _build_degraded_synthesis_contract(
    assistant: AssistantMessageContract,
    *,
    locale: str,
    voice_profile_id: str | None,
) -> SpeechSynthesisContract:
    synthesis_status = assistant.status if assistant.status in {"error", "unavailable", "degraded"} else "unavailable"
    return SpeechSynthesisContract(
        profile_id=voice_profile_id or TTS_BASELINE_PROFILE_IDS[0],
        status=synthesis_status,
        text=assistant.text,
        locale=locale,
    )


def _build_queued_synthesis_contract(
    assistant: AssistantMessageContract,
    *,
    locale: str,
    voice_profile_id: str | None,
) -> SpeechSynthesisContract:
    return SpeechSynthesisContract(
        profile_id=voice_profile_id or TTS_BASELINE_PROFILE_IDS[0],
        status="queued",
        text=assistant.text,
        locale=locale,
    )


def _build_turn_synthesis_request(
    assistant: AssistantMessageContract,
    *,
    locale: str,
    voice_profile: Any,
    lip_sync_preferences: Any,
    text_override: str | None = None,
) -> SpeechSynthesisRequest:
    voice_profile_payload = {
        "profile_id": voice_profile.profile_id,
        "provider": voice_profile.provider,
        "style": assistant.voice_tone.style if assistant.voice_tone is not None and assistant.voice_tone.style else voice_profile.style,
        "notes": voice_profile.notes,
        **voice_profile.settings,
    }
    if assistant.voice_tone is not None:
        voice_profile_payload["llm_voice_tone"] = {
            "style": assistant.voice_tone.style,
            "pace": assistant.voice_tone.pace,
            "energy": assistant.voice_tone.energy,
        }

    return SpeechSynthesisRequest(
        text=text_override if text_override is not None else assistant.text,
        locale=locale,
        profile_id=TTS_BASELINE_PROFILE_IDS[0],
        voice_profile_id=voice_profile.profile_id or TTS_BASELINE_PROFILE_IDS[0],
        voice_profile=voice_profile_payload,
        preferred_lip_sync_track_id=lip_sync_preferences.preferred_track_id,
    )


def _run_synthesis_request(
    synthesis_request: SpeechSynthesisRequest,
    *,
    services: Any,
) -> SpeechSynthesisContract:
    try:
        return services.synthesis_service.synthesize(synthesis_request)
    except Exception:
        logger.exception("User turn synthesis failed")
        return SpeechSynthesisContract(
            profile_id=synthesis_request.voice_profile_id or synthesis_request.profile_id,
            status="error",
            text=synthesis_request.text,
            locale=synthesis_request.locale,
        )


def _append_synthesis_event(
    synthesis: SpeechSynthesisContract,
    *,
    services: Any,
    snapshot: Any,
    character_id: str,
) -> SpeechLifecycleEventEnvelope:
    envelope = services.session_service.event_store.append(
        SPEECH_LIFECYCLE_STREAM,
        services.session_event_factory.build_event(
            snapshot,
            character_id=character_id,
            event_type="speech.synthesis",
            status=synthesis.status,
            synthesis=synthesis,
        ),
    )
    _publish_segment_audio(snapshot, synthesis)
    return envelope


def _publish_segment_audio(snapshot: Any, synthesis: SpeechSynthesisContract) -> None:
    """Phase 2: push the segment's WAV bytes to any connected WebSocket clients
    (no-op when none are listening). The lifecycle event + artifact fetch remain
    the source of truth; this just lets a client start audio without a fetch."""
    broadcaster = get_speech_audio_broadcaster()
    if not broadcaster.has_subscribers:
        return
    reference = synthesis.audio_reference
    if not reference:
        return
    path = Path(reference)
    if not path.is_file():  # session:// or non-file references aren't pushed
        return
    try:
        audio = path.read_bytes()
    except OSError:
        return
    broadcaster.publish(
        snapshot.session_id,
        {
            "event": "speech.audio",
            "utterance_id": synthesis.utterance_id,
            "segment_index": synthesis.segment_index,
            "is_final": synthesis.is_final,
            "mime": "audio/wav",
            "bytes": len(audio),
        },
        audio,
    )


def _dispatch_deferred_synthesis(
    synthesis_request: SpeechSynthesisRequest,
    *,
    services: Any,
    snapshot: Any,
    character_id: str,
) -> None:
    def _worker() -> None:
        synthesis = _run_synthesis_request(synthesis_request, services=services)
        _append_synthesis_event(
            synthesis,
            services=services,
            snapshot=snapshot,
            character_id=character_id,
        )

    threading.Thread(
        target=_worker,
        name=f"user-turn-synthesis:{snapshot.session_id}:{character_id}",
        daemon=True,
    ).start()


def _stamp_segment_fields(
    synthesis: SpeechSynthesisContract,
    *,
    utterance_id: str,
    segment_index: int,
    segment_count: int | None,
    is_final: bool | None = None,
) -> SpeechSynthesisContract:
    """Attach multi-segment metadata to a synthesized contract.

    ``is_final`` may be given explicitly (Phase 1b streaming, where the total
    count is unknown until generation ends) or derived from ``segment_count``
    (Phase 1a, where the count is known up front)."""
    resolved_final = is_final if is_final is not None else (segment_index == (segment_count or 1) - 1)
    return replace(
        synthesis,
        utterance_id=utterance_id,
        segment_index=segment_index,
        segment_count=segment_count,
        is_final=resolved_final,
    )


def _dispatch_segmented_synthesis(
    segment_requests: list[SpeechSynthesisRequest],
    *,
    services: Any,
    snapshot: Any,
    character_id: str,
    utterance_id: str,
    segment_count: int,
    start_index: int,
) -> None:
    """Synthesize the given segments in a single background thread, preserving
    order so speech-lifecycle events are appended by ascending segment_index."""

    def _worker() -> None:
        for offset, segment_request in enumerate(segment_requests):
            segment_index = start_index + offset
            synthesis = _stamp_segment_fields(
                _run_synthesis_request(segment_request, services=services),
                utterance_id=utterance_id,
                segment_index=segment_index,
                segment_count=segment_count,
            )
            _append_synthesis_event(
                synthesis,
                services=services,
                snapshot=snapshot,
                character_id=character_id,
            )

    threading.Thread(
        target=_worker,
        name=f"user-turn-synthesis:{snapshot.session_id}:{character_id}:{utterance_id}",
        daemon=True,
    ).start()


def _build_segment_request(
    text: str,
    *,
    locale: str,
    voice_profile: Any,
    lip_sync_preferences: Any,
) -> SpeechSynthesisRequest:
    """Per-segment synthesis request for the streaming path (Phase 1b).

    Unlike the batch path this omits the LLM voice-tone hint, which is only known
    once the full reply has been parsed — segments are dispatched before then."""
    voice_profile_payload = {
        "profile_id": voice_profile.profile_id,
        "provider": voice_profile.provider,
        "style": voice_profile.style,
        "notes": voice_profile.notes,
        **voice_profile.settings,
    }
    return SpeechSynthesisRequest(
        text=text,
        locale=locale,
        profile_id=TTS_BASELINE_PROFILE_IDS[0],
        voice_profile_id=voice_profile.profile_id or TTS_BASELINE_PROFILE_IDS[0],
        voice_profile=voice_profile_payload,
        preferred_lip_sync_track_id=lip_sync_preferences.preferred_track_id,
    )


def _new_utterance_id(snapshot: Any, character_id: str) -> str:
    return f"utterance:{snapshot.session_id}:{character_id}:{time.time_ns()}"


class _StreamingSegmentSink:
    """Synthesizes streamed segments in order on a single background thread, so
    audio for sentence N is produced while the LLM is still generating N+1."""

    def __init__(
        self,
        *,
        services: Any,
        snapshot: Any,
        character_id: str,
        utterance_id: str,
        build_request: Any,
    ) -> None:
        self._services = services
        self._snapshot = snapshot
        self._character_id = character_id
        self._utterance_id = utterance_id
        self._build_request = build_request
        self._queue: queue.Queue = queue.Queue()
        self._thread = threading.Thread(
            target=self._worker,
            name=f"user-turn-stream-synth:{snapshot.session_id}:{character_id}",
            daemon=True,
        )
        self._started = False
        self._index = 0

    @property
    def dispatched(self) -> bool:
        return self._started

    def push(self, text: str, *, is_final: bool) -> None:
        if not self._started:
            self._started = True
            self._thread.start()
        self._queue.put((self._index, text, is_final))
        self._index += 1

    def finish(self) -> None:
        if self._started:
            self._queue.put(None)

    def _worker(self) -> None:
        while True:
            item = self._queue.get()
            if item is None:
                break
            index, text, is_final = item
            try:
                synthesis = _stamp_segment_fields(
                    _run_synthesis_request(self._build_request(text), services=self._services),
                    utterance_id=self._utterance_id,
                    segment_index=index,
                    segment_count=None,
                    is_final=is_final,
                )
                _append_synthesis_event(
                    synthesis,
                    services=self._services,
                    snapshot=self._snapshot,
                    character_id=self._character_id,
                )
            except Exception:
                logger.exception("Streamed segment synthesis failed")


def _run_streamed_generation(
    request: TextGenerationRequest,
    *,
    services: Any,
    snapshot: Any,
    character_id: str,
    voice_profile: Any,
    lip_sync_preferences: Any,
    utterance_id: str,
    tuning: Any,
) -> tuple[AssistantMessageContract, bool]:
    """Consume the streamed reply, dispatching sentence segments to TTS as they
    complete. Returns the final contract and whether any segment was dispatched."""
    segmenter = StreamingSentenceSegmenter(
        min_chars=tuning.tts_segment_min_chars,
        max_chars=tuning.tts_segment_max_chars,
    )
    sink = _StreamingSegmentSink(
        services=services,
        snapshot=snapshot,
        character_id=character_id,
        utterance_id=utterance_id,
        build_request=lambda text: _build_segment_request(
            text,
            locale=request.locale,
            voice_profile=voice_profile,
            lip_sync_preferences=lip_sync_preferences,
        ),
    )

    final_contract: AssistantMessageContract | None = None
    for event in services.text_generation_service.generate_stream(request):
        if event.text_delta:
            for segment_text in segmenter.feed(event.text_delta):
                sink.push(segment_text, is_final=False)
        if event.contract is not None:
            final_contract = event.contract

    tail = segmenter.flush()
    for offset, segment_text in enumerate(tail):
        sink.push(segment_text, is_final=offset == len(tail) - 1)
    sink.finish()

    if final_contract is None:
        final_contract = AssistantMessageContract(
            profile_id=request.profile_id,
            status="error",
            text="Local text generation returned no reply.",
            locale=request.locale,
        )
    return final_contract, sink.dispatched

