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
- Baseline speech profile ids are locked for planning and fixture coverage: `stt.faster-whisper.medium-2026`, `stt.faster-whisper.small-2026`, and `tts.gpt-sovits.2026-stable`.
- Persistent session state can replace the in-memory session stub without changing route contracts.

## Local Speech Adapter Expectations

- `app/services/speech.py` resolves speech runtimes only from the bootstrap-managed local roots in `NIKOF_STT_MODELS_ROOT`, `NIKOF_TTS_MODELS_ROOT`, and `NIKOF_PROVIDERS_ROOT`.
- Faster-Whisper transcription first tries inline execution when `faster_whisper` is importable in the backend environment. If that package is unavailable, it falls back to a provider-local Python entrypoint at `NIKOF_PROVIDERS_ROOT/stt/faster-whisper/transcribe.py` or `main.py` and sends one JSON request over stdin.
- GPT-SoVITS synthesis executes through a provider-local Python entrypoint at `NIKOF_PROVIDERS_ROOT/tts/gpt-sovits/synthesize.py` or `api_server.py`, again using one JSON request over stdin and one JSON response over stdout.
- Provider entrypoints must return normalized JSON fields only: `status`, `locale`, optional `transcript` or `text`, optional `confidence`, and optional `timing` with `utterance_duration_ms`, `segment_ranges`, `audio_format`, and optional `phoneme_slots` or `viseme_slots`.
- When the local model payload, audio input, runtime, or provider entrypoint is absent, the adapters return deterministic normalized `unavailable` or `error` contracts instead of raising raw provider failures into route payloads.

## Quick check

From the repo root:

```powershell
Set-Location backend
python -m app.main
python -m compileall app
```

`python -m app.main` prints a normalized contract snapshot for the current scaffold so you can inspect Stage 1 responses without FastAPI or any STT, TTS, LLM, or memory providers installed.
