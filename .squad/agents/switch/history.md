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
- Stage 2 default-character work can keep the manifest contract authoritative while still bundling one real VRM by overriding only the manifest-declared `model.vrm` path with a Vite-imported asset URL for `test-vrm-01`.
- `getAvatarRuntimeMountPoints()` must return a stable object identity because the stage mount effect depends on it; otherwise React re-renders remount the canvas and reset runtime state.
- Stage 1 frontend-to-backend bridging should overlay backend character summaries and active-character session state onto the local manifest catalog by `character_id`, never replace manifest-derived asset URLs with backend payloads.
- The frontend shell can persist active-character changes over HTTP, but it must degrade cleanly to local-only selection when `/characters` or `/session/active-character` is unavailable.
- In Vite dev, route backend bridge calls through a local `/api` proxy by default so the shell can use FastAPI surfaces without opening CORS work in the frontend slice.