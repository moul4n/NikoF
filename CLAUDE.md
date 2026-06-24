# CLAUDE.md — NikoF

NikoF is a Windows-first, local-only anime companion: web UI + rendered VRM avatar + low-latency speech I/O + local LLM + persistent memory + reusable animation runtime. Everything runs on one machine (~12 GB VRAM NVIDIA box). No cloud services in the core loop.

## Stack

| Layer | Tech | Where |
|---|---|---|
| Backend | Python 3.10+, FastAPI/uvicorn | `backend/app/` |
| Frontend | React 18 + TypeScript + Vite, three.js + @pixiv/three-vrm | `frontend/src/` |
| STT | **Parakeet** TDT 0.6B v2 in-process (onnx-asr, canonical) · Faster-Whisper sidecar (port 8767, fallback) | `backend/app/providers/stt_engines.py` · `backend/app/services/stt_server.py` |
| TTS | **Kokoro** in-process (kokoro-onnx, canonical) · GPT-SoVITS sidecar (port 9880, fallback) | `backend/app/services/tts_engines.py` · `backend/app/services/tts_server.py` |
| LLM | Ollama (**qwen3:4b** canonical · llama3.1:8b fallback, port 11434) | `backend/app/services/llm.py` |
| Unity (next phase) | Unity 6 LTS (6000.4.7f1) skeleton at repo root | `Packages/`, `ProjectSettings/`, `assets/` |

Canonical runtime = the performance stack (Kokoro / Parakeet / qwen3:4b), selected via `NIKOF_TTS_ENGINE` / `NIKOF_STT_ENGINE` / `NIKOF_LLM_MODEL` (set by `start-all`), benchmarked in `docs/TTS_ENGINE_BENCHMARK.md`. Kokoro and Parakeet run **in-process** (no sidecar/port); the sidecar engines (GPT-SoVITS:9880, Faster-Whisper:8767) are the legacy fallback that `start-all` does not enable by default.

Ports: frontend 5173, backend 8000, Ollama 11434, STT sidecar 8767 (fallback), TTS sidecar 9880 (fallback).

**The backend owns the STT/TTS/LLM sidecar lifecycles.** The frontend never starts sidecars; nothing else should kill them directly. The legacy ops dashboard / watchdog scripts were retired in favour of the single `start-all` front door.

## Core flow

Voice turn: Mic → STT worker (polls STT sidecar) → `turns.py` → Ollama → TTS worker (async queue) → audio artifact on disk → frontend fetches via `/api/session/speech-artifacts/{event_id}/audio` → HTML5 audio + viseme lip-sync on the avatar.

Session events flow through an event store (`services/session.py`) and reach the frontend via SSE (`GET /session/speech-lifecycle`) with polling fallback.

## Running things

```powershell
# Local startup — the single front door: preflight-gate + full bring-up
start-all.bat   # → start-all.ps1 (backend + frontend + Tauri stage)
# Stop everything (one-shot port cleanup: 8000 / 5173 / 11434)
powershell -ExecutionPolicy Bypass -File .\scripts\bootstrap\stop-dev-stack.ps1
# Verify a machine before launch
powershell -ExecutionPolicy Bypass -File .\scripts\bootstrap\Invoke-Preflight.ps1

# Backend tests (unittest, not pytest)
.venv\Scripts\python.exe -m unittest discover -s backend/tests -t backend

# Contract gate (no models/services needed)
powershell -ExecutionPolicy Bypass -File .\scripts\asset_validation\validate-contracts.ps1

# Stability regression harness (snapshot baselines in tests/stability/baselines/)
powershell -ExecutionPolicy Bypass -File .\scripts\testing\Invoke-StabilitySuite.ps1
# Refresh baselines ONLY after an approved behavior change:
#   Invoke-StabilitySuite.ps1 -RefreshBaselines

# Frontend
cd frontend; npm run dev      # vite, strict port 5173
cd frontend; npm run build    # tsc --noEmit && vite build
```

Backend-only session (no frontend, no dashboard): `.venv\Scripts\python.exe -m app.dev_server` from `backend/`.

## Repo layout

- `backend/app/api/` — FastAPI routes (session, operator commands, stt/tts/llm control, resources).
- `backend/app/services/` — sidecar managers (`stt_server.py`, `tts_server.py`, `llm.py`), async workers (`stt_worker.py`, `tts_worker.py`), turn pipeline (`turns.py`), speech adapters/contracts (`speech.py`), session event store, animation, memory.
- `backend/app/core/process_supervision.py` — port probing + process-tree termination shared by all sidecar managers.
- `frontend/src/` — single shared source tree; three Vite entry points: main app, `control/` (operator UI), `display/` (read-only avatar viewport), differentiated by `data-surface-mode`. `avatarRuntime.ts` is the three.js/VRM runtime.
- `scripts/bootstrap/` — `Invoke-Preflight.ps1` (readiness doctor), `stop-dev-stack.ps1` (one-shot cleanup), `bootstrap.ps1`, `install-prerequisites.ps1`. (Launch from `start-all.bat` at the repo root.)
- `scripts/testing/` — stability suite, TTS soak capture.
- `assets/characters/` — UniVRM 1.0 character packages (model.vrm + manifest + expressions + voice profile + animation overrides). `assets/animations/` — animation DSL JSON (tracked in git as the semantic staging path).
- `tests/contracts/` — JSON schemas + fixtures for animation/session/character contracts. `tests/stability/` — snapshot baselines.
- `docs/` — architecture, implementation plan, turn state machine, animation DSL. `docs/STABILIZATION_TODO.md` is the active stabilization worklist.
- `.squad/`, `.copilot/` — legacy multi-agent orchestration state from earlier Copilot-driven development. Historical context only; do not extend.

## Conventions and earned knowledge

### Contracts first
Manifest schemas, session events, animation events, and service boundaries are locked contracts (`tests/contracts/schemas/`). Changing a contract means updating schemas + fixtures + stability baselines in the same change. The Unity frontend (next phase) will be a second client of these same contracts — don't add web-only assumptions to backend payloads.

### Speech playback seams (earned — do not regress)
- One canonical speech write seam: `POST /session/operator-command`. One canonical read seam: `GET /session/speech-lifecycle`. Do not invent parallel contracts for preview/playback features.
- The operator-command response is only a temporary fallback until the `speech.lifecycle` cursor catches up; after catch-up, the lifecycle snapshot is authoritative for assistant text, synthesis text, playback status, and character reconciliation.
- Browser-safe `audio_reference` values: `http:`, `https:`, `blob:`, `data:`, backend-relative `/api/...` paths. **Never** rewrite `session://`, `file:`, or `C:\...` machine-local paths into `file:///` playback URLs — surface the raw reference and fall back to canonical timing metadata.
- Speech-reaction cleanup must be symmetric: clear on audio completion AND on timing-window completion. If audio fails after a canonical synthesis event was accepted, reuse canonical timing metadata rather than dropping the utterance.
- Keep the App→bridge handoff anchored on `speechLifecycleState.snapshot?.canonicalSpeechSynthesisEvent ?? null`.

### Models and heavy payloads
Never commit model weights, provider runtimes, or heavyweight prerequisites. They live in managed local roots outside the source tree (see `docs/SETUP_AND_CONTINUITY.md`). Bootstrap scripts acquire them; GPT-SoVITS is a manual local-source handoff.

### Secrets
Never read `.env`/`.env.local`/`.env.*` (use `.env.example` if present, or ask). Never write credentials, tokens, or connection strings into committed files.

### Test discipline
API/contract changes update tests and stability baselines in the same commit. Baseline refresh (`-RefreshBaselines`) is an explicit, intentional act after an approved behavior change — never run it to make a red suite green.

### Windows-first
Primary platform is Windows 11 + PowerShell. Use `path.join`-style portable path handling where code is cross-platform, but scripts may be PowerShell-only by design. Process management uses `taskkill /T /F` semantics and netstat/psutil port probing — be careful with TIME_WAIT and process-identity assumptions when touching lifecycle code.

## Known weak points (see docs/STABILIZATION_TODO.md for the full worklist)

- Start/stop/restart reliability: two control layers (dashboard vs backend sidecar managers) can desync; restarts historically lacked stop→dead→start barriers; service identity is port-based.
- Latency: pipeline is serial and fully buffered (non-streaming LLM, whole-utterance TTS, full-file audio download) and models lazy-load on first use.
- Monoliths queued for splitting: `backend/app/services/speech.py` (~1,700 lines) and `frontend/src/avatarRuntime.ts` (~3,300 lines).
