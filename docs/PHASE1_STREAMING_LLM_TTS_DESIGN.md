# Phase 1 Design — Streaming LLM + Sentence-Level TTS Dispatch

**Status:** Draft for review · **Branch:** `claude/app-workflow-performance-28izyu` · **Date:** 2026-06-20
**Companion to:** `docs/STREAMING_PERFORMANCE_PLAN.md` (Phase 1)

## 1. Goal & scope

Make the assistant start *speaking the first sentence* while the rest of the reply is still
being generated/synthesized, instead of waiting for the whole reply → whole WAV. Target: cut
perceived latency by ~1.5–3 s on a normal multi-sentence reply, with **no new dependencies**.

**In scope:** LLM streaming, sentence segmentation, per-segment TTS dispatch, an additive
multi-segment synthesis contract, ordered frontend playback over the *existing* SSE + file-fetch
seams.

**Out of scope (Phase 2):** WebSocket transport and chunked audio framing. Phase 1 deliberately
reuses today's `/session/speech-lifecycle` (SSE) + `/session/speech-artifacts/{event_id}/audio`
(one file per segment) so the win lands before the transport rework.

## 2. Current flow (verified, with citations)

- LLM call is non-streaming: `llm.py:537` hardcodes `"stream": False`; the whole completion is
  read by `_read_json_response` (`llm.py:531`). With `expect_structured_output`, `"format":"json"`
  is set (`llm.py:536`) and the completion is a **single JSON planner object**.
- The planner object is parsed: `reply_text = _extract_json_object(reply_text)` (`llm.py:566`)
  then `_assistant_contract_from_structured_payload` (`llm.py:356–428`) builds the
  `AssistantMessageContract` (`text`, `feeling`, `voice_tone`, `animation_cues`,
  `memory_writebacks`). The planner JSON shape is defined in the prompt at `turns.py:353`, with
  `reply_text` as the **first** field.
- Orchestration `run_user_text_turn` (`turns.py:555`) is **serial**: memory → LLM
  (`turns.py:609`) → one synthesis (`turns.py:658` inline, or `turns.py:702`
  `_dispatch_deferred_synthesis` for the STT path) → one `speech.synthesis` event
  (`_append_synthesis_event`, `turns.py:475`).
- Synthesis contract today (`schemas/session.py:117`): `profile_id, status, text, locale,
  audio_reference, timing`. One event = one whole utterance. Audio is one full WAV served by
  `/api/session/speech-artifacts/{event_id}/audio`.

## 3. The `format:"json"` tension and the chosen approach

We cannot naively stream `reply_text` because, under `format:"json"`, the model streams *fragments
of a JSON object*, not clean prose. Two viable options:

- **(A) Change the planner to two channels** (stream prose, append metadata trailer). Cleanest
  streaming, but changes the prompt + parser + every planner-shaped fixture/baseline. High blast
  radius.
- **(B) Keep the planner JSON unchanged; add a streaming extractor for the `reply_text` string
  value.** Because `reply_text` is the first field, we can detect `"reply_text":"…"` and emit its
  characters (honoring `\"` / `\\` escapes) until the closing unescaped quote, segmenting into
  sentences as they arrive. The full object is still parsed at `done` for the authoritative
  contract (feeling/cues/memory). **No planner contract change.**

**Decision: (B).** It isolates the change to the LLM adapter + a small parser, keeps the planner
contract and all its fixtures/baselines untouched, and degrades cleanly (if extraction fails we
fall back to today's parse-at-end behavior).

## 4. Staged delivery (de-risks the contract change)

### Phase 1a — Multi-segment synthesis from the *final* reply (no LLM streaming yet)
Split the finished `reply_text` into sentences and dispatch each as its own synthesis segment.
This exercises the new contract, ordered events, and gapless frontend playback end-to-end while
the LLM is still non-streaming. Win: audio starts after sentence 1 synthesizes instead of after
the whole reply synthesizes (TTS↔TTS overlap).

### Phase 1b — Stream the LLM `reply_text` (option B) to also overlap generation
Add streaming generation + the incremental `reply_text` extractor so sentence 1 can be dispatched
to TTS *before generation finishes* (LLM↔TTS overlap). Win: the larger latency cut.

Both stages share the same contract and frontend changes; 1b only adds the streaming source.

## 5. Contract changes (additive) — the one place baselines move

Extend `SpeechSynthesisContract` (`schemas/session.py:117`) with four additive fields:

| Field | Type | Default | Meaning |
|---|---|---|---|
| `utterance_id` | `str \| None` | `None` | Groups all segments of one assistant reply |
| `segment_index` | `int` | `0` | 0-based order within the utterance |
| `segment_count` | `int \| None` | `None` | Total segments when known (may be unknown mid-stream) |
| `is_final` | `bool` | `True` | Last segment of the utterance |

Defaults are chosen so a single-segment reply is semantically identical to today (index 0, final).
Adding fields still changes serialized JSON, so the following must be updated **in the same
commit** (contracts-first):

- **Schema:** `tests/contracts/schemas/session-event.schema.json` — add the four properties to
  `synthesisContract.properties`. Note: `audio_reference` is currently absent from this schema
  even though it exists on the dataclass; add it here too while we're in this file (cleanup) so the
  schema matches reality. Keep `additionalProperties:false`; only `profile_id/status/text/locale`
  stay in `required`.
- **Fixtures:** `tests/contracts/fixtures/session-event.synthesis.valid.json` — add the new fields
  (single-segment example: `segment_index:0, segment_count:1, is_final:true, utterance_id:"…"`).
- **Stability baselines (explicit, approved refresh):** `backend-speech-contracts.json`,
  `backend-speech-event-store.json`, `backend-speech-real-adapter-degraded.json`,
  `backend-turn-publication.json`, `backend-operator-command-surface.json`,
  `frontend-speech-lifecycle-runtime.json`. Refresh via
  `Invoke-StabilitySuite.ps1 -RefreshBaselines` **only after** confirming the diffs are exactly
  the four additive fields (this is the approved behavior change the rule allows).

No new fields on the planner/`AssistantMessageContract`. **Decision (approved): bump the
session-event contract to `schema_version: 2`.** This is a global session-event version change
(all event types), implemented via the `SESSION_EVENT_SCHEMA_VERSION` constant in
`schemas/session.py`, the `build_event` factory, the schema `const`, all session-event fixtures,
and the 9 session-event-bearing stability baselines.

## 6. Backend changes — file by file

### 6.1 LLM streaming source (`backend/app/services/llm.py`)
- Add a streaming read helper `_read_ndjson_stream(endpoint, payload, timeout)` that POSTs with
  `"stream": True` and yields each line's `response` delta until `done` (Ollama NDJSON).
- Add `generate_stream(request) -> Iterator[TextDelta] ` to the service seam, where the final item
  carries the fully-parsed `AssistantMessageContract` (reuse existing `_extract_json_object` +
  `_assistant_contract_from_structured_payload` on the accumulated buffer). Shape:
  `TextDelta(text: str = "", final_contract: AssistantMessageContract | None = None)`.
- Add the incremental extractor `iter_reply_text_deltas(raw_chunks)` implementing option B
  (locate `"reply_text":"`, emit unescaped chars to the closing quote). Pure function → unit-test
  heavily with adversarial inputs (escaped quotes, unicode, key appearing in prose, split across
  chunks).
- **Capability + fallback:** base/default `generate_stream` calls `generate()` and yields the whole
  reply once (so non-Ollama adapters and the degraded path keep working). Only the Ollama adapter
  implements true streaming. Wrap registry/sidecar manager to expose `generate_stream`.
- Keep `generate()` exactly as-is (used by 1a, fallbacks, and when streaming is disabled).

### 6.2 Sentence segmentation (`backend/app/services/turns.py`, new helper)
- `iter_sentence_segments(text_stream, *, min_chars, max_chars)` — accumulate deltas, flush on
  sentence-final punctuation (`. ! ? …`, newline) or when `max_chars` is exceeded; emit a final
  flush at end. Returns `(segment_index, text, is_final)`.
- For 1a, feed it the final `reply_text`; for 1b, feed it the live delta iterator. Same downstream
  code path.

### 6.3 Per-segment synthesis dispatch (`backend/app/services/turns.py`)
- Generate one `utterance_id` per turn (reuse the assistant event id or a uuid).
- Replace the single-synthesis block (`turns.py:644–678`) with a loop over segments:
  - Build a `SpeechSynthesisRequest` per segment (same `_build_turn_synthesis_request`, but with
    `text=segment_text`, plus the new `utterance_id/segment_index/segment_count/is_final`).
  - **Inline path (operator-command):** synthesize **segment 0 inline** so the command response
    still carries first-audio (preserves the “operator-command response is the temporary fallback
    until lifecycle catches up” rule), then dispatch segments 1..n via the existing deferred
    background mechanism.
  - **Deferred path (STT):** dispatch *all* segments to background synthesis, preserving order by
    `segment_index`. Extend `_dispatch_deferred_synthesis` to take a segment and to serialize a
    turn’s segments (a small per-utterance ordered queue) so events append in index order.
  - Each completed segment → one `speech.synthesis` lifecycle event via `_append_synthesis_event`
    (unchanged seam), now carrying the segment fields.
- `timing.segment_ranges` already exists on the contract; populate per-segment timing so lip-sync
  stays correct per chunk (reuse existing phoneme/viseme → mouth-cue logic in `speech.py`).
- Animation + memory persistence stay where they are (after the final contract is known) — they key
  off the full `AssistantMessageContract`, not the segments.

### 6.4 Telemetry (extends Phase 0)
- Record `tts_ms` as time-to-first-segment-audio (the number that now matters), and add
  `segment_count` + `first_audio_ms` to `TurnTimingSample` (`turn_telemetry.py`) so we can prove
  the win on `/system/resources`.

### 6.5 Config (`backend/app/core/runtime_tuning.py`)
Add knobs (env-driven, safe defaults), all reversible:
- `llm_streaming_enabled` (`NIKOF_LLM_STREAMING`, default **false** initially → flip to true after
  validation): selects 1b vs 1a/non-streaming.
- `tts_segment_min_chars` / `tts_segment_max_chars` (defaults ~12 / ~240): segmentation bounds.
- `tts_segmentation_enabled` (`NIKOF_TTS_SEGMENTATION`, default **true** for 1a): allows full
  rollback to single-utterance synthesis.

## 7. Frontend changes (`frontend/src/`)
- **Playback queue:** consume `speech.synthesis` lifecycle events, group by `utterance_id`, and play
  segments in `segment_index` order. While still on today’s `<audio>` + file-fetch path, preload the
  next segment’s artifact during the current segment so playback is gapless (true chunked streaming
  arrives in Phase 2).
- **Bridge handoff:** keep the anchor on
  `speechLifecycleState.snapshot?.canonicalSpeechSynthesisEvent ?? null`, but treat the canonical
  utterance as the *playlist* of its segments. Run speech-reaction cleanup on the **`is_final`
  segment’s** audio completion (and on the timing-window completion of the final segment) — this
  preserves the “symmetric cleanup” invariant rather than firing per segment.
- **Viseme/lip-sync:** drive per-segment from each event’s `timing` (already per-event).
- Unity (Phase 2) consumes the same fields → no web-only assumptions added.

## 8. Tests
- **Unit (pure, no models):** `iter_reply_text_deltas` (escapes/unicode/split-chunks/key-in-prose);
  `iter_sentence_segments` (punctuation, max_chars overflow, single-sentence, empty); per-segment
  request builder sets the new fields and order.
- **Contract gate:** updated fixture validates against updated schema
  (`validate-contracts.ps1`).
- **Turn flow:** extend `test_structured_turn_flow.py` with a fake streaming text service to assert
  N synthesis events with correct `utterance_id/segment_index/is_final`, in order, for both inline
  and deferred paths; assert single-segment behavior is unchanged when segmentation is disabled.
- **Stability:** refresh the 6 baselines as the explicit approved step; the suite must otherwise
  pass with only the four additive-field diffs.

## 9. Risks & rollback
- **Risk: partial-JSON extraction bugs (1b).** Mitigated by option B’s isolation + the parse-at-end
  authoritative contract + heavy unit tests + `llm_streaming_enabled` default false. If extraction
  ever disagrees with the final parse, the final contract wins.
- **Risk: segment ordering / interleaving.** Mitigated by per-utterance ordered dispatch keyed on
  `segment_index`; frontend also sorts by index within `utterance_id`.
- **Risk: more, smaller TTS calls** raise per-call overhead. Mitigated by `min_chars` (don’t
  synthesize tiny fragments) and `max_chars` (cap latency of the first segment).
- **Risk: baseline churn.** Bounded to 6 named files and four additive fields; reviewed before
  refresh.
- **Full rollback:** set `NIKOF_TTS_SEGMENTATION=false` (→ today’s single-utterance synthesis) and
  `NIKOF_LLM_STREAMING=false` (→ today’s non-streaming generate). The contract fields remain but are
  populated as a single final segment, identical in behavior to pre-Phase-1.

## 9a. Build status & Windows verification (read before merging)

> **Step 1 of the commit sequence (the contract change) has landed on this branch.** It is
> behavior-neutral: every synthesis event is still a single, final segment until Phase 1a/1b wire
> up segmentation.

**Landed (verified at unit-test level on Linux):**
- `schemas/session.py`: `SpeechSynthesisContract` gained `utterance_id` / `segment_index` /
  `segment_count` / `is_final`; added `SESSION_EVENT_SCHEMA_VERSION = 2`.
- `services/speech.py`: `build_event` now stamps `schema_version = SESSION_EVENT_SCHEMA_VERSION`.
  (The two `SpeechLifecycleTransportSnapshot` builders and the operator/active-character/catalog
  responses are **separate** contracts and intentionally stay at `schema_version: 1`.)
- `tests/contracts/schemas/session-event.schema.json`: `const` 1→2; `synthesisContract` gained
  `audio_reference`, `utterance_id`, `segment_index`, `segment_count`, `is_final`
  (`additionalProperties:false` kept; `required` unchanged).
- `tests/contracts/fixtures/`: all three session-event fixtures bumped to `schema_version: 2`;
  synthesis fixture shows a single-final-segment example.
- New `backend/tests/test_session_event_contract.py` (3 tests, green). Full backend `unittest`
  failing set is **identical to baseline** (16 pre-existing sandbox-only failures).

**NOT runnable in this sandbox (no PowerShell, no `jsonschema`) — run on the Windows box:**

```powershell
# 1. Contract gate — fixtures must validate against the updated schema
powershell -ExecutionPolicy Bypass -File .\scripts\asset_validation\validate-contracts.ps1

# 2. Backend unit tests
.venv\Scripts\python.exe -m unittest discover -s backend/tests -t backend

# 3. Stability suite — EXPECT diffs, then refresh ONLY if the diff is exactly the
#    schema_version 1->2 bump plus the four additive synthesis fields.
powershell -ExecutionPolicy Bypass -File .\scripts\testing\Invoke-StabilitySuite.ps1
#    Review the diff, confirm it is only the expected additive change, then:
powershell -ExecutionPolicy Bypass -File .\scripts\testing\Invoke-StabilitySuite.ps1 -RefreshBaselines
```

**Likely-affected baselines (verify against the suite's actual diff output — let
`-RefreshBaselines` regenerate exactly what changed).** These are the files that embed a serialized
session event and/or synthesis contract:
`animation-contract-boundaries.json`, `backend-operator-command-surface.json`,
`backend-speech-contracts.json`, `backend-speech-event-store.json`,
`backend-speech-real-adapter-degraded.json`, `backend-stage1-contracts.json`,
`backend-stage1-payload-surface.json`, `backend-turn-publication.json`,
`frontend-speech-lifecycle-runtime.json`.

Expected diff per file: embedded session events change `schema_version` 1→2, and synthesis
payloads gain the four fields (`segment_index:0`, `is_final:true`, and `utterance_id`/
`segment_count` null unless populated). **If any other field moves, stop and investigate before
refreshing.**

## 10. Suggested commit sequence
1. Contract: schema + fixture + dataclass fields + baseline refresh (additive, behavior-neutral —
   single final segment).
2. Phase 1a: segmentation helper + per-segment dispatch (inline + deferred) + frontend playlist +
   tests, behind `NIKOF_TTS_SEGMENTATION`.
3. Phase 1b: streaming `generate_stream` + `iter_reply_text_deltas` + wire into dispatch, behind
   `NIKOF_LLM_STREAMING`.
4. Telemetry: `first_audio_ms` / `segment_count`.
