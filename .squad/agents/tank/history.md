# Project Context

- **Owner:** Jason Fletcher
- **Project:** Local-only anime companion with interchangeable VRM characters, local voice pipeline, persistent memory, and AI-authored animation scripts
- **Stack:** Python backend, FastAPI/Starlette, React + TypeScript + Vite, three.js + three-vrm, Faster-Whisper, Ollama/llama.cpp, GPT-SoVITS, SQLite, Chroma/FAISS
- **Created:** 2026-05-14T08:57:41.6820932+01:00

## Learnings

- The backend is the central orchestrator for LLM, STT, TTS, memory, character config, and animation messaging.
- Character and animation behavior should be loaded from config files, not baked into service logic.
- Phase 0 backend work should stay framework-light: keep route shape coherent for FastAPI, but let service contracts and filesystem-backed character loading land before provider integrations.
- Character package access belongs behind a manifest source boundary so route handlers never need to know about `assets/characters/{character_id}/manifest.json` layout details.
- Bootstrap and backend settings should share one local-path contract: `NIKOF_LOCAL_ROOT`, `NIKOF_MODELS_ROOT`, `NIKOF_LLM_MODELS_ROOT`, `NIKOF_STT_MODELS_ROOT`, `NIKOF_TTS_MODELS_ROOT`, `NIKOF_EMBEDDINGS_ROOT`, `NIKOF_PROVIDERS_ROOT`, and `NIKOF_CACHE_ROOT`.
- Machine-local bootstrap reports and session env helpers belong under `.local/bootstrap/` so they stay disposable and Git-ignored, while heavyweight provider payloads still default to `%LOCALAPPDATA%\NikoF`.
- Stage 1 route payloads should normalize manifest data down to stable summaries only: include `schema_version`, `character_id`, `display_name`, `identity_source`, `vrm_spec_version`, `supported_states`, and `shared_animation_set`, but do not surface asset-version bookkeeping or raw manifest paths.
- Active-character control is the Stage 1 session boundary: `GET` and `PUT /session/active-character` should return a dedicated response envelope with the selected character summary plus a normalized `session_event`, so later SSE or WebSocket transport can reuse the same payload shape.
- For frontend-facing Stage 1 reads, `GET /characters` should use a catalog envelope with `schema_version`, `active_character_id`, and normalized character summaries instead of a bare array.
- Invalid active-character writes should keep the existing active summary, return the same normalized response envelope as successful reads and writes, and fail through a stable `selection` object plus HTTP 400 rather than a leaked manifest lookup error.
- Scaffold `/health` should stay provider-agnostic and report diagnostics-lite through named storage probes and remediation notes, not absolute filesystem paths or provider-specific payloads.
- The first backend-owned event store should stay provider-agnostic and deterministic: persist canonical `session` and `speech.lifecycle` events in per-session, per-stream order and reuse the existing envelope fields (`event_id`, `sequence`, `cursor`, `event`) rather than inventing a second transport shape.
- The `GET /session/speech-lifecycle` read surface can add cursor-based reads without changing its snapshot envelope by reading ordered events from the backend-owned store and keeping `next_cursor` as the stream-local append position.
