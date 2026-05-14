# Squad Decisions

## Active Decisions

### 2026-05-14T08:57:41.6820932+01:00: User directive

**By:** Jason Fletcher (via Copilot)
**What:** Prefer UniVRM 1.0 as the standard avatar/model system for rigging, compatibility, and sourcing interchangeable character models.
**Why:** User wants the project designed around a standard model pipeline that supports existing community models and new artist-produced assets.

### 2026-05-14T08:57:41.6820932+01:00: Initial architecture planning baseline

**By:** Trinity
**What:** Established UniVRM 1.0 as the baseline character package standard, with manifest-driven swap compatibility, shared animation libraries, and per-character overrides isolated to asset metadata rather than application branching. Also fixed the initial repo split around `frontend/`, `backend/`, `assets/`, `models/`, `scripts/`, `tests/`, and `docs/` so later work can proceed in thin vertical slices.
**Why:** The project's core risk is interface drift between avatar assets, frontend runtime, backend orchestration, and local providers. Locking the character contract and repo boundaries early reduces rework and lets frontend, backend, asset, and test work advance in parallel.

### 2026-05-14T08:57:41.6820932+01:00: 2026 technical blueprint directive

**By:** Jason Fletcher (via Copilot)
**What:** Add the 2026 technical blueprint to the squad context, including the preferred model stack (GPT-SoVITS, Faster-Whisper, LLaMA 3.1 8B Q4, MediaPipe plus CLIP, SQLite plus ChromaDB), the full voice and vision workflows, and the refined development stages.
**Why:** User wants the project blueprint and team context aligned with a more concrete target architecture and model selection baseline.

### 2026-05-14T08:57:41.6820932+01:00: 2026 blueprint baseline and stage reorder

**By:** Trinity
**What:** Adopt GPT-SoVITS latest stable 2026 fork as the default TTS baseline, Faster-Whisper Medium with Small fallback for STT, LLaMA 3.1 8B Q4_K_M as the local LLM baseline, MediaPipe Face Mesh as the realtime tracking baseline, optional CLIP as non-blocking vision enrichment, and SQLite plus ChromaDB or FAISS with `bge-small-en` and `MiniLM-L6-v2` fallback for memory retrieval. Lock the end-to-end workflows as `Mic -> STT -> Memory -> LLM -> TTS -> Avatar` and `Camera -> MediaPipe -> optional CLIP -> backend context -> avatar reactions`, with vision explicitly outside the critical voice path.
**Why:** The older planning docs captured the broad system shape, but they did not pin the refined 2026 local model stack or the explicit delivery sequence needed for the Windows 10/11 and 12 GB NVIDIA target profile.

### 2026-05-14T08:57:41.6820932+01:00: Delivery sequencing clarification

**By:** Trinity
**What:** Re-sequence delivery into Stage 0 contract foundation, then backend skeleton, frontend VRM rendering, STT + TTS integration, local LLM + memory, animation DSL, vision pipeline, character swapping, and optimization + polish. Preserve contract-first review gates even though user-facing character swapping is intentionally hardened later in the build.
**Why:** The explicit stage order reduces integration ambiguity, while the Stage 0 contract gate prevents late-stage character or provider work from reopening frontend-backend seams.

### 2026-05-14T08:57:41.6820932+01:00: Asset intake and generated-animation directive

**By:** Jason Fletcher (via Copilot)
**What:** Support three test VRM character packages with scaffolded manifest metadata when source models lack usable identity fields, and treat AI-authored animation generation plus learned custom animations as a planned capability.
**Why:** User wants immediate asset-drop locations plus a data-driven path to link shared and per-character animations to UniVRM-based models.

### 2026-05-14T08:57:41.6820932+01:00: GitHub publish remote directive

**By:** Jason Fletcher (via Copilot)
**What:** Use `https://github.com/moul4n/NikoF` as the GitHub remote for commits and pushes for this repository.
**Why:** User confirmed the destination repository is empty and ready to receive the current project scaffold.

### 2026-05-14T08:57:41.6820932+01:00: Portable prerequisite acquisition directive

**By:** Jason Fletcher (via Copilot)
**What:** Do not commit local model weights or heavyweight runtime dependencies to GitHub; instead provide bootstrap scripts and documented manual fallback instructions to acquire required prerequisites on a fresh machine. Also keep the project plan, notes, and squad context comprehensive enough that a new PC or developer can resume work cleanly.
**Why:** User wants the repository to stay portable and reproducible while preserving full project continuity across machines and contributors.

### 2026-05-14T08:57:41.6820932+01:00: PowerShell-first stability testing directive

**By:** Jason Fletcher (via Copilot)
**What:** Add a PowerShell-first change and stability testing system, similar in spirit to Pester, so the tester can run regression, change-impact, and input-output stability checks as the project evolves.
**Why:** User wants future changes to be measured against predictable baselines, with tracked input and output behavior rather than ad hoc manual verification.

### 2026-05-14T08:57:41.6820932+01:00: Contract validation scaffold

**By:** Link
**What:** Added a dependency-free PowerShell contract validator for scaffold manifests and local event fixtures, and treated `assets/animations/generated/` as staged content rather than approved shared-library inventory during validation.
**Why:** Phase 0 needs a local contract gate that runs before frontend, backend, VRM import, or provider integrations exist, while still preserving a hard boundary between reviewed shared animations and AI-authored/generated motion.

### 2026-05-14T08:57:41.6820932+01:00: Asset intake documentation anchor points

**By:** Mouse
**What:** Standardized package-root README placeholders for each test character and root-level README placeholders inside the shared, generated, and override animation storage directories so real asset drops and promotion rules are explicit before runtime code lands.
**Why:** The asset tree already existed, but the working contract was too easy to infer incorrectly. Putting the policy at the exact drop locations reduces bad imports, undocumented overrides, and premature promotion of generated motion.

### 2026-05-14T08:57:41.6820932+01:00: PowerShell stability harness baseline policy

**By:** Mouse
**What:** Add a PowerShell-first stability harness under `scripts/testing/` with checked-in JSON baselines in `tests/stability/baselines/`, Git-ignored run artifacts in `tests/stability/artifacts/`, and an explicit `-RefreshBaselines` switch as the only supported way to rewrite expected outputs.
**Why:** The repo already has executable contract and bootstrap seams, so snapshot-based regression checks can start now without adding Pester or other external dependencies.

### 2026-05-14T08:57:41.6820932+01:00: Character package VRM normalization

**By:** Mouse
**What:** Keep each character package's runtime contract fixed at `model.vrm` in the package root. Under the current fallback identity schema, preserve the original imported vendor filename in `metadata/identity.json` as explicit intake provenance in `source_vrm.embedded_identifier` while `source_vrm.file_name` stays aligned to the manifest runtime filename.
**Why:** The manifest and validator contract currently require `source_vrm.file_name` to match `model.vrm`, but intake still needs to retain the original vendor filename for traceability.

### 2026-05-14T08:57:41.6820932+01:00: Initial repository publish target

**By:** Scribe
**What:** Treat `origin` at `https://github.com/moul4n/NikoF.git` and the `main` branch as the canonical first-publish remote and default tracked branch for this repository.
**Why:** The initial scaffold is now published to GitHub and future collaboration should build from the same remote and primary branch instead of reintroducing branch or remote ambiguity.

### 2026-05-14T08:57:41.6820932+01:00: Frontend scaffold stays manifest-first

**By:** Switch
**What:** Frontend placeholder catalog data will only declare character ids and manifest URLs. The catalog loader resolves model, metadata, expression, voice, and animation override URLs from each manifest document, and the avatar shell exposes fixed mount point ids through a small runtime bridge.
**Why:** This keeps Phase 0 and early Phase 1 aligned with the asset contract, avoids hardcoded character file branching in the UI, and lets the real viewer runtime replace the scaffold without changing the selection or loading interfaces.

### 2026-05-14T08:57:41.6820932+01:00: Backend scaffold boundary

**By:** Tank
**What:** Phase 0 backend scaffold uses standard-library dataclasses and service protocols first, with optional FastAPI compatibility in the app shell instead of requiring framework installation up front.
**Why:** This keeps the backend slice dependency-light while preserving stable route, schema, and service seams for later orchestration and provider work.

### 2026-05-14T08:57:41.6820932+01:00: Bootstrap local storage contract

**By:** Tank
**What:** Reserve `NIKOF_LOCAL_ROOT`, `NIKOF_MODELS_ROOT`, `NIKOF_LLM_MODELS_ROOT`, `NIKOF_STT_MODELS_ROOT`, `NIKOF_TTS_MODELS_ROOT`, `NIKOF_EMBEDDINGS_ROOT`, `NIKOF_PROVIDERS_ROOT`, and `NIKOF_CACHE_ROOT` as the canonical local storage contract. Bootstrap may emit machine-local helper files under `.local/bootstrap/`, but heavyweight models and provider payloads still default to `%LOCALAPPDATA%\NikoF`.
**Why:** The docs already require a reproducible fresh-machine flow and Git-ignored local storage roots. Locking one env naming scheme now prevents the backend, bootstrap scripts, and later provider adapters from drifting into incompatible machine setup expectations.

### 2026-05-14T08:57:41.6820932+01:00: Asset packaging and workstream plan

**By:** Trinity
**What:** Fixed the first three avatar intake slots at `assets/characters/test-vrm-01..03/`, with manifest-driven identity scaffolding in `manifest.json` plus `metadata/identity.json`, and separated animation storage into shared library, generated motion, and per-character override roots.
**Why:** The team needs stable asset ids and storage rules before frontend, backend, tests, and asset intake can proceed in parallel without inventing incompatible conventions.

### 2026-05-14T08:57:41.6820932+01:00: Squad execution board

**By:** Trinity
**What:** Added `docs/WORKSTREAMS.md` as the phase-by-phase squad handoff for Trinity, Switch, Tank, Link, and Mouse.
**Why:** The project now has enough contract clarity to start scaffold work immediately, and the board keeps phase ownership explicit.

### 2026-05-14T08:57:41.6820932+01:00: Squad model policy

**By:** Trinity
**What:** Set `claude-haiku-4.5` as the persistent squad default for coordination, logging, and other low-cost routine work, with `claude-sonnet-4.6` pinned for Trinity, Switch, Tank, Link, and Mouse because those roles routinely handle code, test design, integration review, or higher-consequence reasoning. Do not persist Opus-class models in squad config; treat them as explicit, temporary exceptions for rare full-repo review or deep analysis only.
**Why:** This keeps day-to-day work on the best current cost-value mix using latest model families only, while preserving a stronger standard tier for the roles most likely to write code or gate quality. VS Code sessions may not honor per-subagent model overrides, so the intended policy needs to live in squad config and decisions for compatible surfaces and future sessions.

**Reevaluation:** Trinity owns periodic model-fit review and should only change this mapping when repeated reviewer rejections, repeated multi-session quality misses, materially worse latency or cost, or a clearly better latest-family replacement demonstrates a real need.

### 2026-05-14T08:57:41.6820932+01:00: Bootstrap, local storage, and continuity rule

**By:** Trinity
**What:** The repository stores source, contracts, manifests, scripts, and documentation, but not LLM weights, model payloads, provider runtimes, or other heavyweight prerequisites. Bootstrap scripts should acquire prerequisites where licensing and installer behavior allow automation; otherwise the repo must carry explicit manual install fallbacks, expected local storage roots, and validation guidance. Cross-machine continuity is a required deliverable, so checked-in docs plus `.squad/` state must be sufficient for Jason or another developer to resume the project on a fresh Windows machine.
**Why:** The project targets local AI runtimes whose artifacts are too large, machine-specific, or license-constrained to treat as normal source files. Making storage, bootstrap, and continuity explicit now prevents accidental Git bloat and avoids hidden setup knowledge.

## Governance

- All meaningful changes require team consensus
- Document architectural decisions here
- Keep history focused on work, decisions focused on direction
