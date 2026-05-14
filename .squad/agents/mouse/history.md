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
- 2026-05-14: The low-friction regression seam is a PowerShell harness that snapshots existing repo scripts into checked-in JSON baselines and leaves run artifacts untracked under `tests/stability/artifacts/`.
- 2026-05-14: Baseline refresh must stay explicit; the harness should default to diff mode and only rewrite checked-in expectations behind `-RefreshBaselines`.
- 2026-05-14: The Stage 1 backend stability seam should call the backend-owned `build_api_contract_snapshot()` helper instead of reconstructing route behavior in the harness; that keeps route registration and normalized response payloads aligned with the app module even when FastAPI is absent.
- 2026-05-14: Stabilize backend snapshots by sandboxing `NIKOF_*` local-root environment variables and normalizing dynamic session-event timestamps to `<generated-at>`; otherwise `GET /health` and active-character event payloads drift per machine and per run.

*** Add File: c:\Users\fletc\Sources\NikoF\.squad\decisions\inbox\mouse-stage1-backend-stability.md
### 2026-05-14T08:57:41.6820932+01:00: Stage 1 backend stability normalization

**By:** Mouse
**What:** Stage 1 backend stability snapshots will use the backend-owned `build_api_contract_snapshot()` helper, sandbox `NIKOF_*` local-root environment variables for deterministic health diagnostics, and normalize session-event timestamps to `<generated-at>` before baseline comparison.
**Why:** The locked Stage 1 route payloads now exist in backend code, but raw wall-clock timestamps and machine-local storage roots would cause false diffs unrelated to contract changes.