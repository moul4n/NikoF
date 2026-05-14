# Squad Workstreams

Updated at: 2026-05-14T11:42:00+01:00

This is the active scaffold board for the current stages. It assumes the three test avatar package ids are fixed as `test-vrm-01`, `test-vrm-02`, and `test-vrm-03` until real identity review says otherwise.

## Trinity

### Trinity Stage 0

- [x] Lock the three-package asset contract and animation storage rules.
- [x] Document the minimum manifest and fallback identity metadata.
- [x] Publish squad workstreams and the immediate handoff contract.
- [x] Publish the 2026 local baseline for STT, TTS, LLM, embeddings, and optional vision.
- [x] Own squad model-fit policy review and keep persistent routing on the available GPT-5.4 family labels in this environment: `gpt-5.4-mini` for cheap routine work and `gpt-5.4` for core working roles. Only reopen the mapping when repeated reviewer failures, repeated multi-session quality misses, materially worse cost or latency, or a clearly better latest-family replacement shows it is wrong.
- [ ] Lock the portability rule that heavyweight prerequisites stay out of Git and are recovered through bootstrap plus install documentation.
- [ ] Review the setup and continuity guide whenever storage roots, provider expectations, or onboarding steps change.

### Trinity Stage 1

- [ ] Review backend adapter seams for STT, TTS, LLM, embeddings, memory, and optional vision before Tank deepens the skeleton.
- [ ] Review the session event contract so voice and optional vision telemetry stay normalized before integration work spreads.
- [ ] Review backend character-service schemas before Tank exposes any asset APIs.
- [ ] Review backend configuration contracts for local model-path resolution and machine-specific provider discovery.
- [x] Review the first backend-authored operator command envelope so text-question submission and TTS preview publish only canonical session or `speech.lifecycle` events and do not smuggle in frontend-only state.
- [ ] Review the first real `text_question` LLM execution seam so the existing backend command route stays authoritative, the frontend remains unchanged, and debug or operator-control expansion stays deferred.

### Trinity Stage 2

- [ ] Review the frontend avatar runtime and catalog contract before Switch broadens beyond the default-character shell.
- [x] Review the real `/control` and `/display` entrypoint batch so App stays the only backend-sync and `speech.lifecycle` owner.
- [x] Review the control-surface operator panel wiring so it remains a thin backend command publisher and does not create local-only display state or side channels.
- [ ] Keep camera and microphone UX bounded to the frontend shell without letting provider logic leak into components.

### Trinity Stages 3 Through 7

- [ ] Keep animation event vocabulary small before Phase 4 expands the runtime.
- [ ] Keep the vision pipeline optional and off the critical path for the voice turn.
- [ ] Reject any implementation that branches on raw character file paths or ad hoc skeleton exceptions.

## Switch

### Switch Stage 0

- [ ] Scaffold the React plus TypeScript frontend shell.
- [ ] Add shared frontend types for `character_id`, manifest summaries, and semantic animation ids.
- [ ] Create avatar runtime mount points that assume manifests resolve asset paths.

### Switch Stage 2

- [ ] Build the initial avatar stage and one-character shell around manifest-provided data.
- [ ] Load VRMs from manifest-provided paths only.
- [x] Split the current frontend shell into a control surface and a display surface while keeping App-level loaders and backend envelope consumption unchanged.
- [x] Use simple local surface branching for that split instead of adding a routing dependency in this batch.
- [x] Replace the query-parameter split with real `/control` and `/display` entrypoints that both mount the same App-owned backend-sync shell.
- [x] Keep the display entrypoint minimal-chrome, fullscreen-capable, and presentation-first while the control entrypoint retains configuration and status panels.
- [x] Avoid router-level information architecture in this batch; prefer entrypoint-level bootstraps or multi-page Vite wiring that do not duplicate backend state ownership.
- [x] Add control-surface operator forms for text-question submission and TTS preview, but keep them as thin clients of one backend-authored command route.
- [x] Keep the display surface read-only with respect to operator commands; it should react only to canonical backend session or `speech.lifecycle` envelopes.
- [x] Surface backend-authored assistant status and reply text on the control surface without creating a second reply path or display-side reply state.
- [ ] Reserve UI seams for microphone and camera permissions without coupling to provider runtime code.

### Switch Stage 5

- [ ] Implement animation playback against semantic ids rather than file paths.
- [ ] Resolve per-character overrides through manifest data returned by the backend.
- [ ] Add safe fallback handling when a shared or override animation asset is missing.

### Switch Stage 6

- [ ] Wire MediaPipe face-state input into frontend state without leaking raw landmarks into avatar components.
- [ ] Keep camera capture optional and recover cleanly when permissions or devices are unavailable.

### Switch Stage 7

- [ ] Expand the catalog and selection UI from one default character to robust hot-swapping.
- [ ] Preserve camera framing and high-level avatar state when the active character changes.

## Tank

### Tank Stage 1

- [ ] Scaffold the Python backend and the character, animation, and session service boundaries.
- [ ] Define the backend schema for manifest summaries, active character selection, and animation commands.
- [ ] Add service stubs for STT, TTS, LLM, memory, embeddings, vision, character, and animation.
- [ ] Add settings-driven local storage roots for models, provider binaries, and caches instead of hardcoded machine paths.
- [ ] Scaffold bootstrap-facing diagnostics that report missing local prerequisites with actionable remediation text.
- [x] Add one backend-owned operator command route that accepts text-question submission and TTS preview requests, validates them, and publishes canonical session or `speech.lifecycle` envelopes through the existing event store.
- [x] Keep active-character selection as the only in-scope selection control for this batch; do not add provider-profile switching or animation debug commands yet.

### Tank Stage 3

- [x] Add backend live delivery on top of the existing ordered store, streaming canonical `speech.lifecycle` events without leaking provider-specific events or changing the current envelope.
- [x] Keep the transport surface cursor-based and envelope-preserving so SSE or WebSocket delivery reuses the ordered `speech.lifecycle` document rather than transport-specific payload shapes.
- [x] Route `text_question` through a real backend LLM adapter seam that turns accepted operator text into reply text on the existing command path.
- [x] Publish the first LLM reply through the current canonical session and `speech.lifecycle` envelopes instead of inventing a second frontend-facing reply transport.

### Tank Stage 4

- [ ] Add SQLite-backed transcript and summary persistence behind the memory service.
- [ ] Keep vector retrieval and embedding selection behind the backend service boundary.
- [ ] Keep identity scaffolding and override resolution inside the character service, not route handlers.

### Tank Stage 6

- [ ] Accept normalized face-state or sampled-frame input without making the backend a raw camera transport layer.
- [ ] Keep CLIP-style enrichment behind a bounded, optional vision adapter.

### Tank Stage 7

- [ ] Implement semantic animation resolution order: shared clip, declared override, safe fallback.
- [ ] Keep AI-generated motion references behind semantic animation ids and manifest declarations.
- [ ] Expose package summaries and active-character transitions without leaking filesystem quirks to the frontend.

## Link

### Link Stage 3

- [x] Wire Faster-Whisper Medium as the default STT path with Small as the fallback profile.
- [x] Wire GPT-SoVITS latest stable 2026 fork behind the normalized TTS contract.
- [ ] Publish the timing or phoneme metadata shape needed for speech-aligned avatar playback.
- [ ] Define bootstrap download steps, checksum or version expectations, and manual install notes for STT and TTS providers.
- [ ] Stay consult-only for the next live-delivery seam unless Tank needs timing, provider-status, or other speech-envelope normalization changes beyond the current operator-command contract.

### Link Stage 4

- [ ] Integrate the LLaMA 3.1 8B Q4_K_M baseline through llama.cpp or Ollama without leaking runtime choice past the adapter boundary.
- [x] Add the first local text-generation adapter slice for backend-owned `text_question` replies, keeping degraded `unavailable` and `error` outcomes inside one normalized assistant contract.
- [ ] Define the embedding baseline as `bge-small-en` first and `MiniLM-L6-v2` second.
- [ ] Keep SQLite plus ChromaDB or FAISS retrieval hidden behind a normalized memory contract.
- [ ] Document expected local model placement and provider-specific environment settings so fresh-machine setup stays deterministic.
- [x] Narrow the first LLM slice to one local `text_question` reply path with no retrieval or memory enrichment beyond the current operator-command input.

### Link Stage 5

- [ ] Translate backend reply and timing data into semantic animation intents rather than clip-path logic.
- [ ] Keep generated motion requests staged behind semantic ids only.

### Link Stage 6

- [ ] Define the optional CLIP handoff shape for sampled frames, object tags, or scene hints.
- [ ] Keep vision-derived context bounded so it enriches reactions without dominating prompt assembly.

## Mouse

### Mouse Stage 0

- [x] Scaffold contract tests for manifest shape, identity scaffolding presence, and animation event schemas.
- [x] Add JSON fixture validation for the placeholder character packages.
- [x] Define a validation command the rest of the squad can run locally.
- [x] Add a PowerShell-first stability harness that snapshots the contract validator and bootstrap prerequisite surface with explicit baseline refresh.
- [ ] Add validation checks for bootstrap prerequisites and documentable failure states once the setup scripts exist.
- [ ] Expand the stability suite with backend contract snapshots, bootstrap artifact assertions, and change-impact checks as Stage 1 surfaces settle.

### Mouse Stage 1

- [ ] Add backend contract tests for session start or stop flows, health payloads, and manifest summaries.
- [ ] Add tests that reject widened provider payloads leaking past normalized backend events; current widened-payload baselines cover the locked Stage 1 response envelopes, including invalid active-character rejection when present, and the bootstrap report surface.
- [ ] Keep schema gates aligned with the Stage 1 service boundaries.
- [ ] Add checks that missing local providers resolve to actionable bootstrap or manual-install guidance instead of opaque failures.
- [x] Add a narrow frontend shell-structure check that proves backend-confirmed active-character and `speech.lifecycle` state still feed the same envelope-owning loader path after the control and display split lands.
- [x] Retarget that shell-structure guard to the real `/control` and `/display` entrypoints so top-level bootstraps must still route through one App-owned backend-sync and `speech.lifecycle` path.
- [x] Add backend and frontend stability coverage for the operator command batch: request or response envelopes, command rejection paths, and proof that the display still updates only from canonical backend state.

### Mouse Stages 3 And 4

- [x] Add regression coverage for the first backend-only `text_question` LLM reply path, including accepted-command publication, canonical reply output, and degraded provider outcomes without changing the command envelope.
- [ ] Add tests for retrieval provenance and vector-store fallback behavior.

### Mouse Stage 5

- [ ] Add tests for animation resolution order and safe fallback behavior.
- [ ] Add tests that block generated motion from entering the shared library without promotion.

### Mouse Stages 6 And 7

- [ ] Add tests that vision events remain optional and never block the voice turn.
- [ ] Add swap-regression tests across multiple characters using the same semantic animation ids and backend contracts.

## Immediate Handoff

- Tank now owns seam stability: keep the backend-owned `text_question` reply path authoritative on `POST /session/operator-command`, preserve the current canonical session plus `speech.lifecycle` envelopes, and only deepen the slice when hardening requires it.
- Link keeps the local text-generation adapter narrow and provider-agnostic: no retrieval, memory enrichment, or provider-profile work while this first backend-owned reply path settles.
- Mouse stays on the critical path for seam hardening: extend backend-first regression coverage for canonical assistant reply publication and degraded local-LLM outcomes without inventing frontend-only assertions.
- Trinity keeps debug and operator-control expansion deferred: preserve active-character selection as the only selection control and keep `wave`, provider switching, and diagnostics growth in the backlog.
- Switch treats the current control-surface assistant reply readout as sufficient until the backend proves a real read-model gap; the display surface remains read-only over canonical backend state.
- Trinity owns queue hygiene alongside portability and continuity: keep `docs/NEXT_STEPS.md`, this handoff section, and the setup docs aligned with `.squad/identity/now.md` after each landed batch.

## Deferred Work

- Additional operator or debug controls beyond the landed `text_question` and `tts_preview` path.
- Provider-profile switching.
- Animation debug actions such as `wave`.
- Extra control-surface or display-side debug toggles, diagnostics panels, or similar operator affordances that do not advance the backend reply path.
- Memory retrieval, prompt enrichment, and other post-baseline LLM orchestration once one local `text_question` reply path works end to end.
