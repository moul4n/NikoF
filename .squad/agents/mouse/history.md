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
- 2026-05-14: When a JSON value contract is not locked yet, snapshot the stable key surface separately instead of inventing provisional error payloads; once the backend owns a rejection contract on the branch, fold that exact response into the widened-payload baseline instead of stubbing it in the harness.
- 2026-05-14T08:57:41.6820932+01:00: Stability compare mode should canonicalize JSON before diffing; otherwise PowerShell serializer whitespace changes create false failures even when the underlying object graph is unchanged.
- 2026-05-14T08:57:41.6820932+01:00: `bootstrap-prerequisites` should snapshot declared tool requirements from `bootstrap.targets.json`, not live command availability, because PATH state is machine-local noise while tool ids and commands are the contract worth guarding.