# Streaming Performance Plan — NikoF Speech Pipeline

**Status:** Proposed · **Branch:** `claude/app-workflow-performance-28izyu` · **Date:** 2026-06-20

## Goal

Cut mouth-to-ear latency on a short voice turn from **~5–7 s** down to **~1–1.5 s to first
audio** by moving the pipeline from "fully serial, whole-unit buffered" to "streaming and
overlapped." The transport changes (WebSocket) are chosen so the **Unity frontend (next
phase) reuses the same contracts** — no web-only assumptions.

This plan is ordered by **biggest win for least change first**. Each phase is independently
shippable and independently reversible.

---

## Where the time goes today (baseline)

Measured from when the user *stops speaking* to *first audio out*, for a short turn
(~3 s of speech, ~1 sentence reply):

| Segment | Time | Cause (file) |
|---|---|---|
| Silence detection before STT starts | ~0.8 s | 8-block RMS window — `providers/faster_whisper_runtime.py` |
| Transcription (medium, beam=1, non-streaming) | ~1.0–1.5 s | whole-utterance — `faster_whisper_runtime.py` |
| STT worker poll + memory + orchestration | ~0.5 s | 350 ms poll — `services/stt_worker.py`; sync memory fetch — `services/turns.py` |
| LLM (full non-streamed JSON) | ~1.5–2.0 s | `"stream": False` — `services/llm.py` |
| TTS (whole utterance) | ~1.0–2.0 s | whole-reply synth — `services/tts_worker.py` / `speech.py` |
| File write + download + SSE lag | ~0.3–0.5 s | FileResponse + 250 ms SSE poll — `api/session_routes.py` |
| **Total (first audio)** | **≈ 5–7 s** | |

The dominant cost is **waiting**, not raw model speed. Overlap recovers most of it.

### VRAM budget (12 GB box)

| Subsystem | Now | After plan |
|---|---|---|
| LLM — Llama 3.1 8B Q4 | ~5.5 GB | ~5.5 GB (or 0 if Claude backend, Phase 5) |
| TTS — GPT-SoVITS | ~3.5 GB | ~3.5 GB (or ~3.0 GB if Kokoro, Phase 4) |
| STT — Faster-Whisper medium fp16 | ~2.0–2.5 GB | ~2.1 GB (Parakeet TDT 0.6B, Phase 3) |
| **Total** | **~11–11.5 GB** | **~11 GB → headroom opens as phases land** |

---

## Cross-cutting rules (do not regress)

These come from `CLAUDE.md` and the earned speech seams. Every phase must honor them:

1. **One canonical write seam** (`POST /session/operator-command`) and **one canonical read
   seam** (`GET /session/speech-lifecycle`). WebSocket is a *transport*, not a new contract —
   it carries the **same `speech.lifecycle` envelopes**, plus binary audio frames. Do not
   invent a parallel preview/playback contract.
2. **Contracts first.** Any new event field/type updates `tests/contracts/schemas/` +
   fixtures + stability baselines (`tests/stability/baselines/`) **in the same commit**.
   Never run `Invoke-StabilitySuite.ps1 -RefreshBaselines` to make red green — only after an
   approved behavior change.
3. **`audio_reference` stays browser-safe** (`http:`/`https:`/`blob:`/`data:`/`/api/...`).
   Never rewrite `session://`, `file:`, or `C:\...` into playback URLs.
4. **Unity is a second client** of these contracts. No web-only assumptions in backend
   payloads.
5. **Backend owns sidecar lifecycles.** The dashboard controls sidecars only via backend HTTP
   APIs.
6. Keep the App→bridge handoff anchored on
   `speechLifecycleState.snapshot?.canonicalSpeechSynthesisEvent ?? null`.

---

## Phase 0 — Instrumentation + warmups + interval tightening
**Win: ~1–2 s · Change: tiny · Risk: very low · Dependencies: none**

The cheapest, safest gains. Do this first so later phases are measurable.

1. **Per-stage latency telemetry.** Stamp each turn with `stt_ms`, `llm_ms`, `tts_ms`,
   `delivery_ms`, `total_ms` and surface in the ops dashboard / `ResourceMonitor`. This is the
   measurement harness for the whole plan — without it we can't prove the savings.
2. **Warm up all three models at startup.** First-turn-after-boot pays a multi-second
   lazy-load tax today (Ollama loads on first generation — `services/llm.py`; TTS loads on
   first synth — `services/tts_worker.py`; `request_warmup()` and `warmup()` already exist,
   they're just not called eagerly). Call them on backend startup once the sidecars are
   healthy.
3. **Tighten the poll/wait intervals:**
   - STT silence window 800 ms → ~400 ms (`faster_whisper_runtime.py`). Watch for clipped
     ends of utterances; make it a setting.
   - STT worker poll 350 ms → ~100 ms (`services/stt_worker.py`).
   - Speech-lifecycle SSE poll 250 ms → ~75–100 ms (`api/session_routes.py` /
     `PollingSpeechLifecycleLiveDeliveryService` in `speech.py`).

**Done when:** dashboard shows per-stage timings; first post-boot turn has no load spike;
intervals are settings-driven with safe defaults.

---

## Phase 1 — Streaming LLM + sentence-level TTS dispatch
**Win: ~1.5–3 s perceived · Change: medium · Risk: medium · Dependencies: Phase 0 telemetry**

This is the **single biggest perceived win** and needs **no new models or dependencies** —
it's pure architecture. Today TTS can't start until the *entire* JSON reply exists.

1. **Stream the Ollama call.** Flip `"stream": False` → `True` in `services/llm.py` and expose
   a token iterator from `_read_json_response` (switch to a line-delimited JSON reader over
   the streamed body). Keep the non-streaming path as a fallback behind a setting.
2. **Resolve the `format:"json"` tension.** The planner currently returns one JSON object
   (`reply_text`, `thinking_summary`, `feeling`, `voice_tone`, `animation_cues`,
   `memory_writebacks` — `services/turns.py:_build_spoken_reply_prompt`). You cannot
   sentence-chunk a field buried mid-JSON cleanly. Pick one:
   - **(Recommended) Two-channel reply.** Generate `reply_text` first as plain streamed prose,
     then emit a compact JSON metadata trailer for the non-spoken fields. Lowest parsing risk,
     best streaming.
   - **Stream-parse `reply_text` first.** Constrain field order so `reply_text` streams first
     and incrementally extract it. Keeps a single object but is more brittle.
3. **Sentence-boundary chunker in `turns.py`.** As prose tokens arrive, accumulate to sentence
   boundaries (`. ! ? …`, newline, or a max-char flush) and dispatch each completed sentence
   to the TTS worker queue (`services/tts_worker.py` is already a FIFO queue — feed it
   per-sentence jobs instead of one whole-reply job).
4. **Ordered multi-segment utterance.** Extend the synthesis lifecycle event to carry
   `utterance_id`, `segment_index`, and `is_final` so the frontend plays segments gaplessly in
   order. **This touches contracts** → update schema + fixtures + stability baselines in the
   same commit.
5. **Interim delivery without WebSocket yet.** Deliver each sentence as its own audio artifact
   over the existing `/speech-artifacts/{event_id}/audio` + SSE path. This captures most of the
   win *before* Phase 2 lands, keeping changes incremental.

**Done when:** first audio plays at first-sentence-ready time, not full-reply time; segments
play in order; metadata (feeling/animation/memory) still lands correctly; contracts/tests
updated.

---

## Phase 2 — WebSocket streaming transport (lifecycle + audio) — Unity-ready
**Win: ~0.5–1 s + enables true overlap & Unity · Change: medium-large · Risk: medium · Dependencies: Phase 1**

WebSocket is explicitly required because **Unity will reuse it**. It replaces "write full WAV →
download full file" with chunked push, and unifies the read path for both clients.

1. **New WS endpoint, same contract.** Add e.g. `GET /session/stream` (WebSocket) in
   `api/session_routes.py`. It carries:
   - **Control frames** = the existing `speech.lifecycle` envelopes (JSON) — *identical schema*
     to the SSE read seam, so Unity/web share one contract.
   - **Binary audio frames** keyed by `utterance_id` + `segment_index` + `is_final`, streamed
     as PCM/WAV chunks (keep 24 kHz mono PCM s16le from `speech.py`) so playback starts on the
     first chunk.
2. **Keep SSE + file fetch as fallback.** Don't delete the existing seams; the WS path is an
   additive transport. `audio_reference` rules still apply for any URL-form references.
3. **Frontend playback over Web Audio API.** Replace whole-file HTML5 `<audio>` with a chunk
   queue feeding an `AudioBufferSourceNode`/`MediaSource` for gapless playback, driving the
   existing viseme/lip-sync timing (`speech.py` mouth-cue tracks) from segment timing metadata.
   Keep the bridge handoff anchored on `canonicalSpeechSynthesisEvent`.
4. **Unity note (next phase):** Unity consumes the same WS — JSON lifecycle frames + binary PCM
   into an `AudioClip` streaming buffer. Document the framing format alongside the schema so the
   Unity client is a drop-in second consumer.

**Done when:** web client plays audio chunk-by-chunk over WS with correct lip-sync; SSE/file
fallback still works; WS framing documented for Unity; contracts/tests updated.

---

## Phase 3 — Swap STT to NVIDIA Parakeet TDT (streaming, transcribe-while-speaking)
**Win: ~1.5–2 s · Change: medium-large · Risk: medium · Dependencies: Phase 0 (independent of 1/2)**

Transcribe **while the user is still talking** instead of after an 800 ms silence + whole-clip
pass. This is independent of the LLM/TTS streaming work and can proceed in parallel.

### Why Parakeet TDT 0.6B
- **Memory: fits the same slot.** ~2.1 GB vs the current ~2.0–2.5 GB for Whisper medium fp16 —
  a like-for-like swap, no extra VRAM pressure on the 12 GB budget.
- **Accuracy: neutral-to-better offline.** v2 reaches ~1.69 % WER on LibriSpeech-clean
  (~38 % better than Whisper large-v3, and ahead of medium). Streaming/low-latency mode gives
  back ~0–2 WER points vs its own offline numbers due to limited right-context — still in the
  Whisper-medium ballpark.
- **Speed: ~10× faster** (RNN-T/TDT is built for streaming, ~80 ms latency, RTFx > 2000).

### Decision gate: language coverage
- **English-only → Parakeet TDT 0.6B v2** (best accuracy, essentially zero loss vs today).
- **Multilingual needed → v3** (~25 languages, slightly less sharp per-language). If broad
  multilingual is critical, Whisper retains an edge — choose before implementing.

### Implementation
1. **New provider alongside the existing one.** Add `providers/parakeet_runtime.py` exposing the
   same hot-mic interface as `faster_whisper_runtime.py` (the provider abstraction already
   exists). Keep Faster-Whisper selectable via `core/settings.py` for fallback/A-B.
2. **Streaming transcription + partial events.** Emit interim `transcript.partial` events while
   speaking and a final `transcript.confirmed` on endpoint. **`transcript.partial` is a new
   event type** → schema + fixtures + stability baselines in the same commit. The frontend can
   show live captions; `turns.py` triggers the LLM on `confirmed`.
3. **Endpointing.** Use the model's streaming endpointing (or a light VAD) instead of the 8-block
   RMS heuristic so the final transcript lands ~200–400 ms after speech ends.
4. **Bench gate.** Before switching the default, run a WER A/B (Parakeet streaming vs
   Faster-Whisper medium) on representative clips and confirm it meets a chosen WER threshold.

**Done when:** live partial captions appear while speaking; final transcript lands within
~0.5 s of speech end; WER A/B passes threshold; Faster-Whisper remains a config fallback;
contracts/tests updated.

---

## Phase 4 — TTS engine decision (optional, gated on voice identity)
**Win: ~1–2 s first-audio · Change: medium · Risk: medium · Dependencies: Phase 1/2 for streaming framing**

GPT-SoVITS whole-utterance synth is the heaviest realtime cost. After Phase 1 it's already
sentence-chunked; this phase decides whether to also change the engine. **Gate on whether NikoF
needs her specific cloned voice:**

| If voice need is… | Choose | Notes |
|---|---|---|
| Preset voice acceptable | **Kokoro-82M** | ~45 ms time-to-first-audio, ~3 GB (frees ~0.5 GB VRAM), 5× throughput. No cloning. |
| Cloned voice required | **XTTS-v2 streaming** or **GPT-SoVITS streaming mode** | Keeps cloning; XTTS ~320 ms first chunk; GPT-SoVITS chunked keeps your exact voice. |

Implement behind the existing synthesis service seam in `speech.py` so it's a config swap, not a
contract change. Reuse the Phase 2 chunked framing.

**Done when:** chosen engine streams first audio in <~300 ms behind the same seam; voice quality
signed off; VRAM budget re-confirmed.

---

## Phase 5 — Optional pluggable LLM backend (Claude Haiku) 
**Win: ~2–2.5× faster generation + better JSON-plan reliability + frees ~5.5 GB VRAM · Change: medium · Risk: low technical / high policy · Dependencies: Phase 1 streaming**

Technically attractive (Haiku 4.5 ≈ 90–110 tok/s vs ~42 local; better instruction-following →
fewer malformed plans; frees the GPU for STT/TTS). **The blocker is policy, not code:** it
breaks the "local-only, no cloud in the core loop" charter.

Recommended shape: a **pluggable backend behind the existing `text_generation_service` seam** —
local Llama as the offline default, Haiku as an optional "fast/accurate online mode," A/B'd
behind the same interface. Use streaming so Phase 1 sentence-chunking still applies. Decide as a
product/privacy call, not a perf call.

---

## Ordering summary & target budget

| Phase | Win | Change | Run order |
|---|---|---|---|
| 0 — warmups, intervals, telemetry | ~1–2 s | tiny | **1st** |
| 1 — streaming LLM + sentence TTS | ~1.5–3 s | medium | **2nd** |
| 2 — WebSocket transport (Unity-ready) | ~0.5–1 s + Unity | med-large | **3rd** |
| 3 — Parakeet TDT streaming STT | ~1.5–2 s | med-large | parallel w/ 1–2 |
| 4 — TTS engine (Kokoro/XTTS) | ~1–2 s | medium | optional, after 1–2 |
| 5 — Claude Haiku backend | gen speed/accuracy/VRAM | medium | optional, policy gate |

**Target after Phases 0–3:** first audio ~**1–1.5 s** after the user stops speaking (down from
~5–7 s).

| | Current | After 0–3 |
|---|---|---|
| End-of-speech → final transcript | ~2.5 s | ~0.3–0.5 s |
| Transcript → first reply token | ~1.5–2 s | ~0.4–0.8 s |
| First sentence → first audio | ~1–2 s + download | ~0.05–0.3 s |
| **Mouth-to-ear (first audio)** | **~5–7 s** | **~1–1.5 s** |

## Risk & rollback

- Every phase is behind a setting with the old path retained (non-streaming LLM, Faster-Whisper,
  SSE+file delivery, GPT-SoVITS). Roll back by flipping the flag.
- Contract changes (Phase 1 multi-segment, Phase 3 partial transcripts) are the highest-risk
  items — they must ship schema + fixtures + stability baselines together, and the stability
  suite must pass *without* a baseline refresh except where the behavior change is explicitly
  approved.
- Phase 0 telemetry is the gate: don't merge a later phase that doesn't show its expected
  per-stage improvement.
