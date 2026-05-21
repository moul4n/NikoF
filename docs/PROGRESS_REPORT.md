# Progress Report

Updated: 2026-05-21

## Implemented

- Stage 1 frontend bridge repairs are in place, including the backend envelope alignment and the invalid active-character rejection rollback path.
- The frontend production build is repaired and currently passes from `frontend/`.
- The backend now exposes provider-agnostic speech service interfaces and configuration-aware adapter shells for the planned Faster-Whisper and GPT-SoVITS providers.
- The backend now exposes `GET /session/speech-lifecycle` as a read surface for ordered `speech.lifecycle` snapshot envelopes around canonical session events.
- Runtime proof coverage now includes the frontend Stage 1 character-flow path and the frontend speech-lifecycle snapshot consumer.
- The backend-owned GPT-SoVITS lane is now re-enabled through the existing `tts_preview` and `text_question` seams with a queue-backed worker, one owned sidecar process, lazy model load, and backend-owned degradation when the local runtime is unavailable.
- The backend resource monitor now exposes GPU-process and backend-owned-process snapshots, and the frontend control surface renders those process tables for live operator visibility.
- Stage-aware GPU baseline capture helpers now exist for idle, backend-plus-frontend without TTS, and backend-plus-frontend with a warmed TTS sidecar.

## Validated

- `npm run build` passes in `frontend/`.
- `frontend-stage1-bridge-surface` is green for the repaired bridge envelope and selection handling.
- `frontend-stage1-character-flow-runtime` proves the frontend bridge consumes the backend catalog envelope and reconciles selection outcomes against backend-confirmed state.
- `backend-speech-contracts` baselines the speech adapter profiles, canonical `transcription.status` and `speech.synthesis` session events, and the ordered `speech.lifecycle` snapshot envelope.
- `frontend-speech-lifecycle-runtime` proves the frontend consumer preserves cursor order and the canonical transcription and synthesis events from the backend snapshot surface.
- `POST /session/operator-command` with `command_type = tts_preview` now returns a live `audio_reference` and timing payload from the backend-owned GPT-SoVITS sidecar when the local runtime is aligned.
- The current staged captures exist for `idle-before-services`, `backend-frontend-no-tts`, and `backend-frontend-with-tts` under `.local/monitoring/`.
- The current machine-local GPT-SoVITS runtime was validated with `s1bert25hz-2kh-longer-epoch=68e-step=50232.ckpt` paired with `s2G488k.pth`; the attempted `v2Pro/s2Gv2Pro.pth` override failed against the current provider runtime with a state-dict mismatch and is not the active local selection.
- The backend-owned process monitor works when the backend environment is synced from `backend/pyproject.toml`; `psutil` was missing from the active `.venv` until the environment was refreshed.
- A sequential 8-prompt TTS soak against `POST /session/operator-command` returned `ready` for all 8 requests, kept the sidecar loaded, and advanced the TTS request counter from 12 to 20 with no hidden extra work.
- During that soak, sampled request latency was 290.6 ms minimum, 881.0 ms average, and 1593.2 ms maximum, while returned utterance timing averaged 4620 ms across the 8 prompts.
- During active synthesis, sampled GPU usage landed between 31% and 56% with a 49.5% average, power ranged from 30.81 W to 75.79 W, and reported VRAM stayed between 4996 MiB and 5113 MiB. These are `nvidia-smi` spot samples taken after each request, not profiler-grade peaks.
- After the soak, 10 reads of `GET /session/speech-lifecycle` held the TTS request counter flat at 20 and left `last_request` unchanged, confirming that snapshot polling stays inert while the sidecar remains warm.
- The post-soak warm-idle GPU sample was 37%, 31.29 W, and 5016 MiB, with the active engines attributed to VS Code and Edge rather than the backend-owned GPT-SoVITS Python PID.
- A longer 30-prompt sequential soak also returned `ready` for all 30 requests and kept the sidecar loaded throughout the run.
- Across that 30-prompt soak, sampled request latency was 478.7 ms minimum, 923.1 ms average, 1480.9 ms at the 95th percentile, and 4515.8 ms maximum, while returned utterance timing averaged 4491.3 ms.
- During the longer soak, sampled GPU usage landed between 8% and 79% depending on when the post-request sample was taken, with a 40.5% average during the active request loop; sampled power averaged 71.39 W and peaked at 86.29 W, while reported VRAM ranged from 5038 MiB to 5659 MiB.
- The first post-soak request-counter read lagged one request at 49, but a follow-up `GET /system/resources` sample caught up to the expected total of 50 and then stayed flat through 10 more `GET /session/speech-lifecycle` reads, so the discrepancy was sampling lag rather than a dropped synthesis event.
- The longer-run warm-idle tail sample settled at 8%, 30.64 W, and 5888 MiB with no GPU engine above the 5% reporting threshold, which is the cleanest warm-idle reading captured so far after repeated prompt traffic.

## Current Boundary

- Real GPT-SoVITS execution is wired and working on the backend-owned sidecar path, but Faster-Whisper is still scaffolded and not yet executable on this machine.
- Live speech delivery over SSE or WebSocket is not implemented yet.
- The speech seam is now a partial live pipeline: backend-owned TTS preview and reply synthesis are real, while STT ingest, broader session orchestration, and live transport remain staged work.
