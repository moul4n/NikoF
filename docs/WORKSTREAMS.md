# Squad Workstreams

Updated at: 2026-05-14T08:57:41.6820932+01:00

This is the active scaffold board for the current stages. It assumes the three test avatar package ids are fixed as `test-vrm-01`, `test-vrm-02`, and `test-vrm-03` until real identity review says otherwise.

## Trinity

### Trinity Stage 0

- [x] Lock the three-package asset contract and animation storage rules.
- [x] Document the minimum manifest and fallback identity metadata.
- [x] Publish squad workstreams and the immediate handoff contract.
- [x] Publish the 2026 local baseline for STT, TTS, LLM, embeddings, and optional vision.
- [ ] Lock the portability rule that heavyweight prerequisites stay out of Git and are recovered through bootstrap plus install documentation.
- [ ] Review the setup and continuity guide whenever storage roots, provider expectations, or onboarding steps change.

### Trinity Stage 1

- [ ] Review backend adapter seams for STT, TTS, LLM, embeddings, memory, and optional vision before Tank deepens the skeleton.
- [ ] Review the session event contract so voice and optional vision telemetry stay normalized before integration work spreads.
- [ ] Review backend character-service schemas before Tank exposes any asset APIs.
- [ ] Review backend configuration contracts for local model-path resolution and machine-specific provider discovery.

### Trinity Stage 2

- [ ] Review the frontend avatar runtime and catalog contract before Switch broadens beyond the default-character shell.
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

### Tank Stage 3

- [ ] Expose the audio turn lifecycle needed for Faster-Whisper and GPT-SoVITS without leaking provider-specific events.
- [ ] Stream transcription, synthesis, and speaking-state updates to the frontend.

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

- [ ] Wire Faster-Whisper Medium as the default STT path with Small as the fallback profile.
- [ ] Wire GPT-SoVITS latest stable 2026 fork behind the normalized TTS contract.
- [ ] Publish the timing or phoneme metadata shape needed for speech-aligned avatar playback.
- [ ] Define bootstrap download steps, checksum or version expectations, and manual install notes for STT and TTS providers.

### Link Stage 4

- [ ] Integrate the LLaMA 3.1 8B Q4_K_M baseline through llama.cpp or Ollama without leaking runtime choice past the adapter boundary.
- [ ] Define the embedding baseline as `bge-small-en` first and `MiniLM-L6-v2` second.
- [ ] Keep SQLite plus ChromaDB or FAISS retrieval hidden behind a normalized memory contract.
- [ ] Document expected local model placement and provider-specific environment settings so fresh-machine setup stays deterministic.

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
- [ ] Add tests that reject widened provider payloads leaking past normalized backend events.
- [ ] Keep schema gates aligned with the Stage 1 service boundaries.
- [ ] Add checks that missing local providers resolve to actionable bootstrap or manual-install guidance instead of opaque failures.

### Mouse Stages 3 And 4

- [ ] Add tests for STT and TTS event ordering, degraded failure states, and timing metadata presence.
- [ ] Add tests for retrieval provenance and vector-store fallback behavior.

### Mouse Stage 5

- [ ] Add tests for animation resolution order and safe fallback behavior.
- [ ] Add tests that block generated motion from entering the shared library without promotion.

### Mouse Stages 6 And 7

- [ ] Add tests that vision events remain optional and never block the voice turn.
- [ ] Add swap-regression tests across multiple characters using the same semantic animation ids and backend contracts.

## Immediate Handoff

- Tank can deepen the backend skeleton and provider-agnostic adapter seams now.
- Switch can keep the frontend focused on the default-character VRM shell and device permission seams now.
- Link can start STT and TTS adapter contracts now, using the agreed 2026 baseline.
- Mouse owns the stability harness next: add backend session-event snapshots, bootstrap artifact assertions, and staged failure baselines as Stage 1 contracts firm up.
- Trinity owns the portability, bootstrap, and continuity contract until those rules are reflected in implementation docs and setup validation.
