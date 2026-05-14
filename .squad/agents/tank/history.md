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
