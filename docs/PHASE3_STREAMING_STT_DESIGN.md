# Phase 3 — Streaming STT (NVIDIA Parakeet TDT 0.6B v2)

**Goal:** transcribe *while the user is still speaking* and swap the recognizer to NVIDIA
Parakeet TDT 0.6B v2 (English). Win is largest on long utterances (today they are transcribed in
one pass *after* an ~800 ms end-of-speech silence) and adds live-caption UX. Independent of the
LLM/TTS streaming work (Phases 1/2).

Decision (2026-06-21): **Parakeet TDT 0.6B v2, English-only, swap now.** Faster-Whisper stays a
selectable fallback. Default only switches after a WER A/B gate passes.

## Where it plugs in (current architecture)

```text
HotMicRuntime (sidecar)  →  /events poll  →  STTWorker  →  run_user_text_turn  →  LLM/TTS
faster_whisper_runtime.py     stt_server     stt_worker.py    turns.py
```

- Sidecar (`backend/app/providers/faster_whisper_runtime.py`) owns the mic, RMS endpointing
  (`NIKOF_STT_SPEECH_END_BLOCKS`, ~8×100 ms), and whole-utterance `model.transcribe(...)`. It emits
  `transcript.confirmed` events on `/events`.
- `STTWorker` (`backend/app/services/stt_worker.py`) polls `/events`, filters filler words, builds a
  `SpeechTranscriptionContract`, and calls `run_user_text_turn(...)`.
- The contract enters the `speech.lifecycle` stream as a `transcription.status` event.

The sidecar's HTTP API does **not** change — partials are a new event type on the existing
`/events` channel.

## Runtime choice: ONNX Runtime, not NeMo

Parakeet TDT 0.6B v2 ships as a NeMo checkpoint, but NeMo (`nemo_toolkit[asr]`) is heavy and
fragile on Windows (pins numpy<2, large torch/lightning tree). The box already runs Kokoro through
`onnxruntime`, so the consistent, lighter path is an **ONNX export of Parakeet run via
`onnx-asr` + `onnxruntime-gpu`** (CUDA EP), in-process like Kokoro — no NeMo, no numpy downgrade.

- `onnx-asr` resolves a pre-exported Parakeet TDT 0.6B v2 ONNX from Hugging Face and runs RNN-T/TDT
  greedy decoding on the CUDA execution provider.
- `onnxruntime-gpu` replaces the CPU `onnxruntime` wheel; it still exposes `CPUExecutionProvider`,
  so Kokoro keeps working (it pins no provider). Install swaps the wheel, not the API.
- Fallback: if the ONNX path proves unworkable, the NeMo+torch path (torch 2.8+cu128 is already
  present) is the documented alternative behind the same provider seam.

Model assets live under `<NIKOF_STT_MODELS_ROOT>/parakeet-tdt-0.6b-v2` (same root convention as
Faster-Whisper), never committed.

## Contract change (additive, baseline-safe)

`serialize_dataclass_payload = strip_none(asdict(...))` drops `None`, so optional fields default to
`None` are invisible in existing payloads — no baseline churn.

- `SpeechTranscriptionContract` gains `is_final: bool | None = None`. Absent/None/True ⇒ a confirmed
  final transcript (today's behavior, unchanged serialization). Partials set `is_final=False`.
- New session event type **`transcript.partial`** added to `session-event.schema.json` enum
  (additive) with a new fixture. Existing fixtures/baselines are untouched because no existing
  scenario emits partials. `transcription.status` keeps carrying the final.
- No `SESSION_EVENT_SCHEMA_VERSION` bump required — the change is additive and default-off.

## Increments

1. **Additive contract plumbing (no model, no install).** `is_final` on the transcription contract;
   `transcript.partial` event type + schema + fixture; contract-gate + unit tests. Default behavior
   identical; baselines unchanged. *(De-risks the rest; useful for either recognizer.)*
2. **Parakeet provider.** `providers/parakeet_runtime.py` exposing the same hot-mic interface as
   `faster_whisper_runtime.py`, selectable via `core/settings.py` (env `NIKOF_STT_ENGINE`,
   default `faster-whisper`). Install `onnx-asr` + `onnxruntime-gpu`; acquire the ONNX model.
3. **WER A/B bench.** `scripts/testing/stt_wer_bench.py` transcribes the `.local/stt-tests` clips
   with both engines and reports WER + per-clip latency. Switch the default to Parakeet only if WER
   is within threshold of Faster-Whisper medium.
4. **Streaming partials + live captions.** Sidecar emits throttled `transcript.partial` while
   speaking (Parakeet streaming or periodic re-decode); worker forwards them display-only (LLM still
   fires on confirmed); frontend shows live captions on the avatar surface. Endpointing tightened so
   the final lands ~0.2–0.4 s after speech end.

## Status (2026-06-21)

Increments 1 + 2 (engine seam, deps, wiring) are committed:

- Contract plumbing (`is_final`, `transcript.partial`) — additive, baseline-safe.
- `NIKOF_STT_ENGINE` selection; default `faster-whisper`.
- Deps installed: `onnxruntime-gpu` (replaced the CPU `onnxruntime` wheel; Kokoro still imports and
  keeps `CPUExecutionProvider`) + `onnx-asr`. Captured as the `backend[parakeet]` extra.
- Parakeet wired into the sidecar hot-mic loop and the one-shot path (`faster_whisper_runtime.py`,
  inlined to keep the sidecar free of `app.*` imports) and into the worker's profile-id stamping.

**Remaining (needs the GPU free):**

1. **Model acquisition.** Place the Parakeet TDT 0.6B v2 ONNX export at
   `<NIKOF_STT_MODELS_ROOT>/parakeet-tdt-0.6b-v2` (default `%LOCALAPPDATA%\NikoF\models\stt\…`).
   `onnx-asr` resolves `nemo-parakeet-tdt-0.6b-v2` from that local dir; fetch the pre-exported ONNX
   from Hugging Face (e.g. `huggingface-cli download istupakov/parakeet-tdt-0.6b-v2-onnx --local-dir
   <…>/parakeet-tdt-0.6b-v2`). Never committed.
2. **Smoke + WER A/B** with `NIKOF_STT_ENGINE=parakeet` and `NIKOF_STT_ALLOW_GPU=1`.

## Risk & rollout

- Increments 1 is additive/default-off → near-zero risk.
- Increment 2 swaps the `onnxruntime` wheel (Kokoro dependency) — verify Kokoro TTS still synthesizes
  after the swap before relying on it.
- Faster-Whisper remains the default until increment 3's WER gate passes; the engine is a config
  switch, reversible at any time.
- `latency_bench.py --stt-dir` already measures the STT leg headlessly; reuse it to confirm no
  first-audio regression after the swap.

**Done when:** Parakeet is selectable and passes the WER gate; live partial captions appear while
speaking; the final lands within ~0.5 s of speech end; Faster-Whisper still works as fallback;
contracts/tests updated without refreshing unrelated baselines.
