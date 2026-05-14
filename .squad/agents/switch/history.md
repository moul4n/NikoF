# Project Context

- **Owner:** Jason Fletcher
- **Project:** Local-only anime companion with interchangeable VRM characters, local voice pipeline, persistent memory, and AI-authored animation scripts
- **Stack:** Python backend, FastAPI/Starlette, React + TypeScript + Vite, three.js + three-vrm, Faster-Whisper, Ollama/llama.cpp, GPT-SoVITS, SQLite, Chroma/FAISS
- **Created:** 2026-05-14T08:57:41.6820932+01:00

## Learnings

- Frontend must support VRM swapping, shared animation libraries, and optional character-specific overrides.
- Expression, viseme, and idle animation channels need clean APIs so the backend can drive them predictably.
- Placeholder frontend catalog data should stop at manifest entry points; resolve model, metadata, voice, and override URLs relative to each manifest so Phase 1 does not bake filesystem branching into UI code.
- Avatar viewer work should hang off stable mount point ids and a small runtime bridge now, leaving the React shell and selection flow intact when three.js plus three-vrm arrives.