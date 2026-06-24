# Backend Scaffold

This backend slice is intentionally minimal. It defines stable boundaries for session,
character, and animation concerns before FastAPI routes or local provider adapters are
implemented.

## Current scope

- `app/main.py` exposes an application shell and an optional FastAPI-compatible entrypoint.
- `app/api/router.py` lists the Stage 1 HTTP surface without binding the project to a web framework yet.
- `app/services/character.py` is the first real service stub and reads character manifests from `assets/characters/`.
- `app/services/session.py` and `app/services/animation.py` define coherent seams for later orchestration work.
- `GET /health`, `GET /characters`, `GET /session/active-character`, `GET /session/animation`, `GET /session/speech-lifecycle`, and `PUT /session/active-character` all stay provider-agnostic and can be inspected without local model installs.
- `GET /characters` returns a normalized catalog envelope with the current active character id plus summary records only.
- `PUT /session/active-character` returns the same normalized active-character envelope on success and on invalid selection, using HTTP 400 with a stable rejection payload when the requested character id is unavailable.
- `GET /session/animation` returns a deterministic session animation snapshot for the active character and currently resolves the backend-owned default base command to the repo-backed `idle.default` semantic the web viewer can play now.
- `GET /session/speech-lifecycle` exposes the ordered speech lifecycle snapshot alongside the session animation snapshot so the frontend can read both backend-owned seams without inventing local session defaults.

## Later integration points

- Real HTTP handlers belong in `app/api/` once FastAPI is introduced.
- Local STT, LLM, TTS, and memory providers should sit behind dedicated services, not route modules.
- Normalized speech adapter contracts live in `app/schemas/session.py`. The Faster-Whisper and GPT-SoVITS adapters now execute behind those schema types instead of widening route payloads or introducing provider-shaped API responses.
- The backend-owned `POST /session/operator-command` seam now pins `text_question` to `llm.ollama.llama3.1-8b-2026` and `tts_preview` to `tts.gpt-sovits.2026-stable`, while keeping the request and response envelopes unchanged.
- `text_question` now shapes the Ollama prompt for spoken-output discipline and only invokes GPT-SoVITS when the assistant reply is actually ready, so degraded LLM states no longer synthesize fallback error text as if the voice lane were healthy.
- Baseline speech profile ids are locked for planning and fixture coverage: `stt.faster-whisper.medium-2026`, `stt.faster-whisper.small-2026`, and `tts.gpt-sovits.2026-stable`.
- Persistent session state can replace the in-memory session stub without changing route contracts.

## Local AI Adapter Expectations

- `app/services/llm.py` resolves the Ollama-backed LLaMA lane only from `NIKOF_LLM_MODELS_ROOT` and `NIKOF_PROVIDERS_ROOT`. The default binding expects `NIKOF_PROVIDERS_ROOT/llm/ollama/` plus `NIKOF_LLM_MODELS_ROOT/ollama-llama3.1-8b/` to exist.
- The Ollama adapter uses `http://127.0.0.1:11434/api/generate` by default and `llama3.1:8b` as the default model tag. If a local machine needs a different tag or endpoint, place a machine-local `runtime.json` under the model root or provider root instead of adding new repo-tracked settings.
- The LLM sidecar manager can now backend-own the Ollama server lifecycle when the local `runtime.json` opts in with `manage_process: true`. The current machine-local fields are `endpoint`, optional `health_url`, optional `serve_command`, plus optional startup and health timeout overrides.
- When `manage_process: true` is enabled, the backend starts the sidecar lazily on the first LLM request, attempts an eager start during app lifespan startup, stops any owned child process during backend shutdown, and reports process health and owned-log paths through `/system/resources`.
- When the local Ollama roots are present but the runtime is unreachable, the adapter returns the existing normalized `unavailable` or `error` assistant contract instead of leaking the raw Ollama payload or transport failure.

- `app/services/speech.py` resolves speech runtimes only from the bootstrap-managed local roots in `NIKOF_STT_MODELS_ROOT`, `NIKOF_TTS_MODELS_ROOT`, and `NIKOF_PROVIDERS_ROOT`.
- Faster-Whisper transcription is still a normalized stub contract in the current repo slice. The backend already resolves the expected `NIKOF_STT_MODELS_ROOT` and `NIKOF_PROVIDERS_ROOT` locations for the future adapter, but real inline or provider-entrypoint execution is not landed yet.
- GPT-SoVITS synthesis now runs through a backend-owned local sidecar started from `NIKOF_PROVIDERS_ROOT/tts/gpt-sovits/api_server.py`. The backend queues requests, keeps one warm model load, and sends normalized synthesis requests over local HTTP instead of spawning per-request model processes.
- GPT-SoVITS request shaping now merges the active character's checked-in `voice/profile.json` defaults with machine-local `runtime.json` overrides under the configured TTS model root or provider root. Keep speaker references, prompt text, reference audio, and other vendor payload details in those local roots rather than in git.
- Provider entrypoints must return normalized JSON fields only: `status`, `locale`, optional `transcript` or `text`, optional `confidence`, optional `audio_reference`, and optional `timing` with `utterance_duration_ms`, `segment_ranges`, `audio_format`, and optional `phoneme_slots` or `viseme_slots`.
- GPT-SoVITS ready-state normalization now requires a real `audio_reference`. Missing local roots or entrypoints produce `unavailable`; invocation failures or malformed payloads produce `error`.
- When the local model payload, runtime, or provider entrypoint is absent, the adapters return deterministic normalized `unavailable` or `error` contracts instead of raising raw provider failures into route payloads.
- The backend will not attach to an unrelated external GPT-SoVITS listener on `127.0.0.1:9880`; it must own the sidecar process so process lifetime, VRAM residency, and failure logging stay deterministic.

## Quick check

From the repo root:

```powershell
Set-Location backend
..\.venv\Scripts\python.exe -m app.dev_server
..\.venv\Scripts\python.exe -m app.main
..\.venv\Scripts\python.exe -m compileall app
```

`..\.venv\Scripts\python.exe -m app.dev_server` is the canonical backend dev start command and binds the API to `http://127.0.0.1:8000`.

For full-stack local work, do not start the backend in isolation by default. The preferred user, developer, and agent workflow is to run `start-all.bat` from the repo root (preflight-gate + backend + control frontend + Tauri stage, each in its own window) and stop everything with `powershell -ExecutionPolicy Bypass -File .\scripts\bootstrap\stop-dev-stack.ps1`. Use `app.dev_server` directly only for backend-only investigation.

If port `8000` is already occupied, `app.dev_server` now fails fast with a specific message that distinguishes an already-healthy backend from a stale listener that is holding the port without answering `/health`.

If required local LLM or TTS prerequisites are still missing, `app.dev_server` stays in degraded mode but now prints the exact expected path, the matching bootstrap resume hook when one exists, and the generated hint-file path for the missing prerequisite.

If GPT-SoVITS sidecar startup fails after the local roots look ready, inspect `%LOCALAPPDATA%\NikoF\logs\tts\tts-server-*.stderr.log` before changing backend code. The current dev-machine-compatible pair is `s1bert25hz-2kh-longer-epoch=68e-step=50232.ckpt` with `s2G488k.pth`.

`..\.venv\Scripts\python.exe -m app.main` prints a normalized contract snapshot for the current scaffold so you can inspect Stage 1 responses without FastAPI or any STT, TTS, LLM, or memory providers installed.
