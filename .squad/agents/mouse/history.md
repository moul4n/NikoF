# Project Context

- **Owner:** Jason Fletcher
- **Project:** Local-only anime companion with interchangeable VRM characters, local voice pipeline, persistent memory, and AI-authored animation scripts
- **Stack:** Python backend, FastAPI/Starlette, React + TypeScript + Vite, three.js + three-vrm, Faster-Whisper, Ollama/llama.cpp, GPT-SoVITS, SQLite, Chroma/FAISS
- **Created:** 2026-05-14T08:57:41.6820932+01:00

## Learnings

- High-risk paths include end-to-end voice latency, WebSocket payload drift, and character swaps that break rig or animation assumptions.
- The project needs executable checks around shared versus character-specific animation behavior early, not only at polish time.
- Real VRM intake should stay anchored to `model.vrm` at each package root; changing file names or adding extra nesting would break the manifest contract before runtime code exists.
- Animation policy is easier to enforce when each storage root carries its own README describing promotion versus override rules, instead of relying on one top-level note.
- When a vendor VRM arrives with an arbitrary export filename, normalize the package root back to `model.vrm` immediately; under the current scaffold schema, keep the runtime filename in `source_vrm.file_name` and stash the dropped vendor filename as explicit intake provenance in `source_vrm.embedded_identifier` until reviewed identity metadata replaces the scaffold.