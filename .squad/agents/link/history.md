# Project Context

- **Owner:** Jason Fletcher
- **Project:** Local-only anime companion with interchangeable VRM characters, local voice pipeline, persistent memory, and AI-authored animation scripts
- **Stack:** Python backend, FastAPI/Starlette, React + TypeScript + Vite, three.js + three-vrm, Faster-Whisper, Ollama/llama.cpp, GPT-SoVITS, SQLite, Chroma/FAISS
- **Created:** 2026-05-14T08:57:41.6820932+01:00

## Learnings

- The core interaction loop is mic input to STT to memory retrieval to LLM to TTS to avatar playback.
- Animation hints and emotion tags should come out of model generation in structured form so the runtime can validate them.
- 2026-05-14T08:57:41.6820932+01:00: Phase 0 contract validation can stay dependency-free by treating scaffold character packages and local fixture payloads as the source of truth before any provider or runtime integrations exist.
- 2026-05-14T08:57:41.6820932+01:00: Generated animation roots must stay validation-distinct from `assets/animations/library/shared/`; promotion into the approved shared library is a separate reviewed step.
- 2026-05-14T08:57:41.6820932+01:00: Keep Stage 3 speech contracts provider-agnostic by carrying STT and TTS payloads as optional normalized session-event subobjects, with timing metadata limited to utterance duration, segment ranges, audio format, and optional phoneme or viseme slots.
- 2026-05-14T08:57:41.6820932+01:00: Lock baseline speech profile ids in the contract snapshot and docs as `stt.faster-whisper.medium-2026`, `stt.faster-whisper.small-2026`, and `tts.gpt-sovits.2026-stable`, while leaving schema `profile_id` fields open for later adapter additions.
- 2026-05-14T08:57:41.6820932+01:00: Real STT execution can prefer an inline `faster_whisper` import when the backend environment already has it, but the local storage contract still needs a provider-local fallback entrypoint under `NIKOF_PROVIDERS_ROOT/stt/faster-whisper/` so fresh machines degrade predictably.
- 2026-05-14T08:57:41.6820932+01:00: Keep speech-adapter failure semantics normalized at the service boundary: missing audio, model roots, runtimes, or provider entrypoints return deterministic `unavailable` or `error` contracts instead of leaking provider stack details into session payloads.