# Phase 2 Design — WebSocket Transport (lifecycle + binary audio)

**Status:** Draft for review · **Branch:** `claude/app-workflow-performance-28izyu` · **Date:** 2026-06-21
**Companion to:** `docs/STREAMING_PERFORMANCE_PLAN.md` (Phase 2)

## 1. Why now

Phase 1 streams the LLM and synthesizes per sentence, but audio still reaches the browser as
**whole files fetched after the fact** (`/session/speech-artifacts/{event_id}/audio`). To compare a
**faster, streaming TTS** (Phase 3/4 — Kokoro/XTTS) we need a transport that can **push audio
chunks as they are produced**. That transport is a WebSocket, and per the plan it is chosen so the
**Unity frontend reuses the same contracts** — no web-only assumptions.

Measured motivation (test box, 2026-06-21): first-audio is dominated by LLM generation (~5 s on the
large persona prompt) **and GPT-SoVITS TTS cost** (~0.7–5 s/segment). Streaming a fast TTS over WS
is the lever that moves the second half.

## 2. Decisions (locked)

- **One transport, same contracts.** A single endpoint `GET /session/stream` (WebSocket) carries:
  - **Control frames** (JSON text) = the existing `speech.lifecycle` envelopes — *identical schema*
    to the SSE read seam. Framed as `{"event": "speech.lifecycle", "kind": "snapshot"|"event",
    "cursor": <str|null>, "data": <payload>}` so web and Unity parse one shape.
  - **Audio frames** (binary) = PCM/WAV chunks for a segment, each preceded by a small JSON header
    frame `{"event":"speech.audio","utterance_id","segment_index","is_final","mime":"audio/wav",
    "bytes":N}` then the binary frame. (WS interleaves text + binary frames natively.)
- **Additive, fallback preserved.** SSE (`/session/speech-lifecycle`) and file fetch stay as the
  default; the WS endpoint is opt-in. `audio_reference` browser-safe rules are unchanged.
- **Not in the contract snapshot.** WS routes are registered via `@router.websocket` and are **not**
  added to the hand-maintained `RouteDefinition` list, so `build_api_contract_snapshot` and the
  stability route baselines are unaffected.
- **Binary audio is a second increment.** Increment 1 ships the control-frame transport (lifecycle
  over WS) so the frontend/Unity can consume one stream; increment 2 adds binary audio chunk push
  (which is what a streaming TTS needs).

## 3. Integration gotchas found while scoping (must handle)

1. **Fake routers need `.websocket`.** The stability harness builds the real router under a *fake*
   fastapi (`FakeAPIRouter` in `backend/tests/test_event_store.py` and an inline copy in
   `scripts/testing/Invoke-StabilitySuite.ps1`). They expose `get/put/post` but **not** `websocket`.
   Adding `@router.websocket` will `AttributeError` there (re-crashing `backend-operator-command-
   surface` and `backend-session-animation-live-delivery`). Fix: add a no-op `websocket(path)`
   decorator to both fakes (records the route like `get`).
2. **Real serving needs a WS impl.** uvicorn serves WebSockets only with `websockets` (or `wsproto`)
   installed; it is **not** currently in the env. `fastapi.testclient.TestClient` tests WS
   in-process **without** it, but production serving needs it added to backend requirements.
3. **Idle-disconnect detection.** `iter_live_events` is an infinite blocking generator; a WS client
   that disconnects while idle isn't noticed until the next `send`. Increment 1 detects disconnect on
   send (good enough, endpoint is unused by default); increment 2 should add a concurrent
   `receive()` task to cancel promptly and avoid a lingering worker thread per dead connection.

## 4. Increment 1 — control-frame transport (backend)

`backend/app/api/session_routes.py`, inside `register_session_transport_routes`:

```python
@router.websocket("/session/stream")
async def session_stream(websocket: WebSocket) -> None:
    await websocket.accept()
    cursor = websocket.query_params.get("cursor")
    snapshot = services.session_service.get_snapshot()
    character = services.character_service.get_character_summary(snapshot.active_character_id)
    transport = services.speech_lifecycle_service.get_snapshot(snapshot, character_id=character.character_id, cursor=cursor)
    try:
        await websocket.send_json({"event": SPEECH_LIFECYCLE_STREAM, "kind": "snapshot",
                                   "cursor": None, "data": serialize_dataclass_payload(transport)})
        async for envelope in _iterate_blocking_iterator(
            services.speech_lifecycle_live_delivery.iter_live_events(snapshot, character_id=character.character_id, cursor=cursor)
        ):
            await websocket.send_json({"event": SPEECH_LIFECYCLE_STREAM, "kind": "event",
                                       "cursor": envelope.cursor, "data": serialize_dataclass_payload(envelope)})
    except WebSocketDisconnect:
        return
```

Reuses the exact services + serializer the SSE path uses. Plus: `FakeAPIRouter.websocket` in both
harness copies; add `websockets` to backend requirements. **Test:** a unit test that builds the
router with the fake fastapi and asserts `/session/stream` registered, plus a handler test driving a
fake `WebSocket` (accept/send_json/query_params) against a finite stubbed live-delivery — asserts the
snapshot frame then ordered event frames.

## 5. Increment 2 — binary audio push (the part the fast TTS needs)

- The TTS sink (`_StreamingSegmentSink`, Phase 1b) already produces ordered segments. Extend the
  publish step to also push the segment's audio bytes to any connected WS as a binary frame
  (header + bytes), keyed by `utterance_id`/`segment_index`/`is_final`.
- Needs a small per-session fan-out registry (connected sockets) the sink can publish to. Keep it
  in-process; the lifecycle event remains the source of truth (WS audio is an optimization).
- A streaming TTS engine (Phase 4) can push sub-segment chunks the same way (header `is_final`
  on the last chunk of a segment).

## 6. Increment 3 — frontend Web Audio consumer (and Unity)

- Replace whole-file `<audio>` with a chunk queue feeding `AudioBufferSourceNode`/`MediaSource`,
  driven by the WS audio frames; keep the playlist ordering + symmetric cleanup from Phase 1a.
- Keep the bridge handoff anchored on `canonicalSpeechSynthesisEvent`; the WS control frames carry
  the same envelopes the SSE path delivers today, so `selectCurrentUtteranceSegments` is reused.
- Unity consumes the identical frames: JSON control → state; binary audio → `AudioClip` streaming
  buffer. Document the framing as the shared client contract.

## 7. Rollout & risk

- Increment 1 is additive and unused by default → near-zero risk; gated only by the harness/dep
  fixes in §3.
- Frontend cutover (increment 3) keeps SSE+file as fallback until WS playback is validated.
- This unblocks the **Phase 3/4 TTS swap + streaming comparison**: with WS audio push in place,
  swap GPT-SoVITS → Kokoro/XTTS streaming and re-run `latency_bench.py` to compare first-audio.
