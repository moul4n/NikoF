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

### 2026-05-14T08:57:41.6820932+01:00: GPT-5.4 persistent squad model policy

**By:** Trinity
**What:** Set `gpt-5.4-mini` as the persistent squad default for low-cost routine work such as logging, coordination, and other cheap operational tasks, and pin `gpt-5.4` for Trinity, Switch, Tank, Link, and Mouse as the standard core-work model. Keep the broader rule cost-aware and latest-family first, and reserve premium or extreme models for explicit, rare exceptions only. In this environment, the persistent config names exposed to the squad are `gpt-5.4` and `gpt-5.4-mini`, so do not encode literal medium or high SKU labels in squad config.
**Why:** The user wants GPT-5.4 family defaults reflected in persistent squad routing with low routine cost, stronger standard reasoning for the core working roles, and no ambiguity about the actual model identifiers available on this surface.

### 2026-05-14T08:57:41.6820932+01:00: Stage 1 backend contract normalization

**By:** Tank
**What:** Keep the Stage 1 backend surface limited to `GET /health`, `GET /characters`, and `GET` or `PUT /session/active-character`. Character responses expose normalized manifest summaries only, active-character control returns a reusable `session_event` envelope, and scaffold health diagnostics report provider-agnostic storage probes keyed by contract names rather than raw filesystem paths.
**Why:** This keeps raw manifests and machine-local quirks out of route payloads while establishing a transport-ready control contract the frontend and later streaming layer can reuse.

### 2026-05-14T08:57:41.6820932+01:00: Stage 2 default-character VRM bundling

**By:** Switch
**What:** Keep the Stage 2 frontend catalog pinned to the default `test-vrm-01` character for now and satisfy the real-model shell by resolving only the manifest-declared `model.vrm` path through a Vite-imported asset URL.
**Why:** This preserves the manifest-first contract for identity and asset resolution while avoiding premature frontend dependence on backend catalog APIs, repo-root static serving, or multi-character hot-swap behavior before those later slices are unlocked.

### 2026-05-14T08:57:41.6820932+01:00: Stage 1 backend stability normalization

**By:** Mouse
**What:** Stage 1 backend stability snapshots will use the backend-owned `build_api_contract_snapshot()` helper, sandbox `NIKOF_*` local-root environment variables for deterministic health diagnostics, and normalize session-event timestamps to `<generated-at>` before baseline comparison.
**Why:** The locked Stage 1 route payloads now exist in backend code, but raw wall-clock timestamps and machine-local storage roots would cause false diffs unrelated to contract changes.

### 2026-05-14T08:57:41.6820932+01:00: Stage 1 batch contract handoff

**By:** Trinity
**What:** Lock the next Stage 1 batch to four provider-agnostic backend contract surfaces only: `GET /health` expands into a stable diagnostics-lite payload, `GET /characters` stays the manifest-summary list contract, active-character selection remains the only writable session control via `GET` and `PUT /session/active-character`, and normalized session-event payloads are introduced as a backend-owned schema for lifecycle reporting without exposing provider-specific detail. Frontend work remains manifest-first and may load one real default VRM from manifest-derived URLs only, while backend session events, bootstrap/provider remediation detail, live audio streaming, and multi-character UI remain out of scope for this batch. Stability work snapshots only the new health, manifest-summary, and session-selection/session-event contracts and does not baseline animation command behavior, provider diagnostics depth, or any transport intended for later streaming phases.
**Why:** The current scaffold already proves the right seam: the backend router exposes minimal provider-agnostic routes and the frontend catalog resolves runtime asset URLs from manifests only. This batch should deepen that seam without letting Stage 1 broaden into provider integration, transport work, or frontend swap behavior that belongs to later stages.

### 2026-05-14T08:57:41.6820932+01:00: Next batch contract boundary

**By:** Trinity
**What:** Lock the next batch to three narrow seams. Link may define provider-agnostic STT and TTS adapter contracts, baseline profile identifiers, and speech timing metadata only, without invoking Faster-Whisper or GPT-SoVITS yet and without adding live transport events or provider bootstrapping. Tank and Switch may connect the frontend shell to `GET /characters` and `GET` plus `PUT /session/active-character`, but manifest document loading and asset URL resolution stay frontend-local and derived from `character_id` rather than a new backend asset-serving surface. Mouse may extend stability coverage with normalized failure-path and widened-payload checks for Stage 1 backend and bootstrap payloads only; live streaming, deep provider remediation, and runtime-specific failure matrices stay out of scope.
**Why:** The repo already has the right contract seam. Tightening the batch around normalized schemas, current HTTP control routes, and deterministic stability snapshots lets the team advance integration without reopening provider choice, transport design, or asset-serving boundaries too early.

### 2026-05-14T08:57:41.6820932+01:00: Stage 3 speech contract envelope

**By:** Link
**What:** Carry future STT and TTS adapter output in optional normalized `transcription` and `synthesis` objects on the shared session-event contract, and keep timing metadata limited to utterance duration, segment ranges, audio format, and optional phoneme or viseme slots. Publish the baseline profile catalog separately with `stt.faster-whisper.medium-2026`, `stt.faster-whisper.small-2026`, and `tts.gpt-sovits.2026-stable`.
**Why:** This gives later provider adapters a stable contract target without adding provider-specific transport, API routes, or bootstrap behavior in the current slice.

### 2026-05-14T08:57:41.6820932+01:00: Stage 1 frontend-backend character bridge

**By:** Tank
**What:** `GET /characters` returns a catalog envelope with `schema_version`, `active_character_id`, and normalized character summaries, and `GET` plus `PUT /session/active-character` now share one response shape that always includes the current active summary and a normalized `selection` result. Invalid active-character writes return HTTP 400 with `error_code="unknown_character"` while leaving the current active character unchanged.
**Why:** This gives the frontend one stable provider-agnostic contract for summary inventory and active-character control without widening into manifest serving, live transport, or provider diagnostics.

### 2026-05-14T08:57:41.6820932+01:00: Frontend backend-bridge boundary

**By:** Switch
**What:** Keep the frontend manifest catalog authoritative for asset URL resolution and VRM loading, but overlay backend `GET /characters` summaries and `GET` or `PUT /session/active-character` state onto matching local packages by `character_id`. Frontend characters without a local manifest stay unavailable to the runtime even if the backend knows about them.
**Why:** This lets the shell start reading backend-owned summary and session state now without violating the contract lock that keeps manifest loading and asset path resolution frontend-local in this slice.

### 2026-05-14T08:57:41.6820932+01:00: Stage 1 failure baseline scope lock

**By:** Mouse
**What:** Keep the current stability expansion limited to deterministic widened-payload baselines for the backend-owned Stage 1 response envelopes and the generated bootstrap report surface. Include the invalid active-character rejection payload only when it exists in the current backend slice.
**Why:** The backend and bootstrap JSON surfaces are stable enough for no-widening checks, and the invalid selection payload should be tested only from the real backend contract rather than from a tester-invented stub.

### 2026-05-14T08:57:41.6820932+01:00: Stability comparison normalization

**By:** Mouse
**What:** The stability harness now compares JSON scenarios by canonicalized content instead of raw serializer whitespace, and the `bootstrap-prerequisites` snapshot records the declared tooling contract from `bootstrap.targets.json` rather than live tool availability on the local machine.
**Why:** Compare mode should fail on approved contract drift, not on PowerShell JSON formatting differences or transient PATH state such as whether `node` and `npm` happen to be installed on one workstation.

### 2026-05-14: Squad state continuity repair

**By:** Scribe
**What:** Restore the standard append-only squad directories `.squad/log/` and `.squad/orchestration-log/` when they are missing, keep them empty until real session or orchestration entries exist, restore the `.squad/decisions/inbox/` drop-box required for decision writes, and remove accidental tool or patch paste artifacts from agent history files instead of treating them as valid history.
**Why:** The squad conventions and Scribe workflow depend on these paths existing and on history files remaining trustworthy. Restoring the expected structure without fabricating old logs improves continuity for future sessions and prevents malformed content from being read as project memory.

### 2026-05-14: Support-role charter alignment

**By:** Scribe
**What:** Align the support-role charter metadata to the active squad roster by documenting Scribe as the Session Logger and continuity maintainer, and Ralph as the Work Monitor.
**Why:** The roster in `.squad/team.md` already reflects these support roles. Keeping the agent charters consistent with that roster reduces identity drift and prevents future sessions from inheriting inaccurate support-role behavior.

### 2026-05-14: Frontend Stage 1 bridge surface rejection guard

**By:** Mouse
**What:** Add a `frontend-stage1-bridge-surface` scenario to the PowerShell stability suite that snapshots the frontend bridge's declared `/characters` envelope keys, active-character response keys, and rejection-path handoff against the locked backend Stage 1 payload-surface baseline.
**Why:** The backend payload baselines already guard the owned Stage 1 envelope, but the frontend bridge also needs a deterministic seam so catalog-envelope drift or loss of rejection-path alignment fails before UI wiring is treated as done.

### 2026-05-14: Stage 1 frontend rejection rollback uses backend envelope

**By:** Switch
**What:** Keep the Stage 1 active-character `PUT` contract unchanged, but preserve the normalized backend response on rejection so the frontend shell can roll local selection back to `response.active_character.character_id` and surface `selection.message` when the backend rejects a requested character.

### 2026-05-14T10:14:00+01:00: Real control and display entrypoints for the next frontend batch

**By:** Trinity
**What:** Re-scope the next frontend batch to replace the current query-parameter surface split with real `/control` and `/display` entrypoints. Keep `App.tsx` as the only owner of backend sync, active-character confirmation, and live `speech.lifecycle` state, and keep operator or debug affordances out of this batch unless they fit without backend contract changes.
**Why:** The user clarified that the display surface should behave like a directly launchable immersive window with minimal chrome, fullscreen capability, and normal resize behavior. The current local surface toggle proves the ownership boundary, but it does not satisfy that entrypoint requirement.

### 2026-05-14T10:17:00+01:00: Frontend entrypoint split guard prep

**By:** Mouse
**What:** Retarget `frontend-shell-split-surface` to snapshot top-level React entrypoints under `frontend/src/*.tsx` separately from `App.tsx`, and require entrypoints to route through `App` without owning backend sync or `speech.lifecycle` themselves.
**Why:** The real `/control` and `/display` split has not landed yet, so the narrow prep guard should baseline the current blocked one-entrypoint state now and fail future duplicate bridge ownership when Switch adds the new surfaces.
**Why:** The shell was updating local selection optimistically and could drift from backend-confirmed active state after a rejected selection, which breaks the current bridge contract even without widening the API surface.

### 2026-05-14: Frontend Stage 1 rollback assertion matches structured catch path

**By:** Mouse
**What:** Detect rejection rollback in the `frontend-stage1-bridge-surface` stability scenario by matching the structured `ActiveCharacterSyncError` catch path in `App.tsx`, including the intermediate reconciled-character variable and the subsequent `setSelectedCharacterId(...)` call, instead of requiring one inline nested call shape.
**Why:** The frontend still performs the intended rollback to the backend-confirmed active character on rejection, but the earlier assertion only recognized one exact syntax form and produced a false negative baseline.

### 2026-05-14T10:30:00+01:00: Operator command batch scope lock

**By:** Trinity
**What:** Re-scope the next implementation batch around one backend-authoritative operator command seam. The first command batch should stay limited to text-authored flows that fit the current canonical event model: text-question submission that bypasses STT and TTS preview text. Keep active-character selection as the only selection control in scope, and defer model-profile switching plus animation debug triggers such as `wave` until the backend owns dedicated configuration and animation-command envelopes.
**Why:** The current backend already owns canonical session and `speech.lifecycle` envelopes plus a turn-publication seam, but it does not yet own a writable operator-command route. Starting with one backend command path lets the control surface drive the immersive display immediately through canonical state without adding frontend-only wiring or widening unrelated contracts.

### 2026-05-14T10:46:00+01:00: Frontend operator command client ownership guard

**By:** Mouse
**What:** Extract the frontend operator command client from `frontend/src/app/App.tsx` into a control-only component and extend `frontend-shell-split-surface` so it requires one non-`App.tsx` operator-command owner, the backend seam path `/session/operator-command`, and the narrowed `text_question` plus `tts_preview` command types.
**Why:** The shared App shell was still allocating command draft and submit mutation state before the display-mode early return, which let the display surface own write state even though it is supposed to stay read-only.

### 2026-05-14T11:04:00+01:00: User directive

**By:** Jason Fletcher (via Copilot)
**What:** Skip debug controls for now and move them to the todo list instead of the active implementation seam.
**Why:** User wants the immediate queue focused on non-debug product seams first.

### 2026-05-14T11:12:00+01:00: Next implementation batch scope lock

**By:** Trinity
**What:** Re-scope the next implementation batch to real `text_question` execution into a local LLM reply path on the existing backend-owned operator-command seam. Keep the first LLM slice backend-only, preserve the current canonical session plus `speech.lifecycle` envelopes and cursor handoff, and defer frontend expansion, provider-profile switching, animation debug actions, and other operator-control growth.
**Why:** The current code already has backend live `speech.lifecycle` delivery and frontend consumption in place, but `text_question` still only publishes a canonical transcription-style event and a session acceptance event. The narrowest coherent slice that matches the user's chosen product seam is to add one real backend reply path without reopening frontend ownership or debug scope.

### 2026-05-14T08:57:41.6820932+01:00: Local speech adapter execution contract

**By:** Link
**What:** Faster-Whisper and GPT-SoVITS execution stays behind the existing normalized speech service interfaces and resolves only from the bootstrap-managed local roots. Faster-Whisper may run inline when `faster_whisper` is installed in the backend environment, otherwise it falls back to a provider-local Python entrypoint under `NIKOF_PROVIDERS_ROOT/stt/faster-whisper/`. GPT-SoVITS runs through a provider-local Python entrypoint under `NIKOF_PROVIDERS_ROOT/tts/gpt-sovits/`. Provider entrypoints accept one JSON request on stdin and emit one normalized JSON response on stdout.
**Why:** The backend needs real local execution paths without widening API payloads, mutating bootstrap state, or forcing one machine-specific runtime layout beyond the documented local storage contract.

### 2026-05-14T08:57:41.6820932+01:00: Speech degraded-mode baseline policy

**By:** Mouse
**What:** Keep speech stability coverage centered on the backend-owned canonical envelope, but let the degraded real-adapter scenario baseline the actual adapter-shell result for the current branch, including selected provider entrypoints and `unavailable` statuses when local provider payloads are missing.
**Why:** The real adapter shells now express degraded mode through the same envelope shape with different contract values. Forcing stub-ready values in the harness would hide legitimate backend behavior changes and make the baseline less trustworthy.

### 2026-05-14T08:57:41.6820932+01:00: Frontend bridge stability follows the actual bridge owner

**By:** Mouse
**What:** Keep `frontend-stage1-bridge-surface` anchored to the file that actually owns Stage 1 bridge behavior. In the current slice that means source-inspecting `frontend/src/avatar/loaders/backendCharacterFlow.ts` for catalog-envelope consumption and helper-backed rejection rollback, while `App.tsx` only needs to prove it routes structured rejection handling through that helper path.
**Why:** The Stage 1 frontend bridge contract did not change, but the implementation moved out of inline loader and component code into helper functions. The stability seam should fail on contract drift, not on harmless internal extraction.

### 2026-05-14T08:57:41.6820932+01:00: Frontend speech lifecycle snapshot bridge

**By:** Switch
**What:** Bridge the frontend shell to `GET /session/speech-lifecycle` as a read-only snapshot surface only, fetching once after catalog readiness and refreshing after backend-confirmed active-character responses, while keeping manifest loading and VRM asset resolution frontend-local.
**Why:** This surfaces canonical transcription and synthesis lifecycle state in the current shell and keeps it aligned with backend-confirmed session flow without widening into polling, SSE, WebSocket transport, or backend asset serving.

### 2026-05-14T08:57:41.6820932+01:00: Backend event-store shape

**By:** Tank
**What:** Persist canonical `session` and `speech.lifecycle` events in a backend-owned, per-session, per-stream ordered store that reuses the existing envelope fields (`event_id`, `sequence`, `cursor`, `event`). The current `GET /session/speech-lifecycle` surface may accept an optional cursor for incremental reads, but it keeps the same snapshot payload shape and does not introduce transport-specific event bodies.
**Why:** This gives the backend one canonical ordering and cursor source before SSE or WebSocket delivery exists, while preserving the current provider-agnostic contract and avoiding a second event schema.

### 2026-05-14T08:57:41.6820932+01:00: Post-batch queue alignment

**By:** Trinity
**What:** Treat the backend-owned event store, the real Faster-Whisper and GPT-SoVITS execution paths, the frontend speech-lifecycle snapshot bridge, and the current stability slice as landed. Sequence the next queue as backend turn-pipeline publication into the existing ordered event envelope, then live delivery on that same envelope, then frontend live consumption and transport-aware runtime stability expansion without widening payload shapes.
**Why:** `docs/NEXT_STEPS.md` and `docs/WORKSTREAMS.md` had drifted behind the landed batch and were still advertising finished work as upcoming scope.

### 2026-05-14T09:05:00+01:00: Next implementation block boundary

**By:** Trinity
**What:** Lock the next implementation block to backend turn-pipeline publication into the existing canonical `session` and `speech.lifecycle` event store plus publication-scoped stability coverage only. Keep the current `speech.lifecycle` envelope unchanged, queue live delivery as the following batch, and keep Switch's frontend transport work behind that transport slice.
**Why:** The current backend still synthesizes `speech.lifecycle` events from the snapshot read path and does not yet expose an explicit turn orchestration or publication seam. Bundling publication, transport, and frontend live consumption now would cross two unfinished abstraction boundaries at once and make it harder to preserve the canonical envelope.

### 2026-05-14T09:08:00+01:00: Backend turn publication owns canonical speech event creation

**By:** Tank
**What:** Add an explicit backend turn-pipeline publisher that executes the normalized STT and TTS services and appends canonical `session` plus `speech.lifecycle` events in fixed order. Keep `GET /session/speech-lifecycle` as a read-only projection over the existing event store instead of letting the snapshot read path seed events itself.
**Why:** The next batch needs a backend-owned publication seam that can be reused by later delivery work without changing the current speech lifecycle envelope or inventing transport-specific payloads.

### 2026-05-14T09:28:00+01:00: Team decision

**By:** Trinity
**What:** Treat backend turn publication as already landed through the backend-owned ordered store and lock the next batch to backend live delivery plus transport-scoped stability only. Keep frontend live consumption queued for the following slice, and preserve the canonical `speech.lifecycle` event body as the single transport-agnostic envelope reused by snapshot and live delivery.
**Why:** The repo already contains the publication seam in backend services and tests, while the router and frontend still stop at snapshot-only delivery. Splitting live delivery from frontend live consumption keeps the next batch narrow, lets the team stabilize cursor and transport behavior first, and avoids coupling frontend runtime work to a transport surface that is not yet proven.

### 2026-05-14T10:00:00+01:00: Frontend shell split batch

**By:** Trinity
**What:** Lock the next frontend batch to splitting the current `App.tsx` shell into explicit control and display surfaces while keeping character catalog loading, active-character synchronization, and `speech.lifecycle` consumption on the existing App-owned loader path and backend-owned envelope. Use simple in-app surface branching in this batch and do not add a routing dependency yet.
**Why:** The current shell already has one coherent state owner and only two tightly coupled surfaces. Adding router infrastructure now would widen the batch without solving a real navigation problem, while extracting control and display surfaces now will reduce App-level coupling and preserve the current transport and contract boundary.

## Governance

- All meaningful changes require team consensus
- Document architectural decisions here
- Keep history focused on work, decisions focused on direction
