# Implementation Plan

## Delivery Strategy

Build the system in thin vertical slices that prove the core contracts early. The first priority is not feature breadth; it is establishing stable seams between avatar assets, frontend runtime, backend orchestration, and local AI services so later specialists can work in parallel without reworking the foundation.

The explicit 2026 implementation sequence is now:

1. Backend skeleton
2. Frontend VRM rendering
3. STT + TTS integration
4. Local LLM + memory
5. Animation DSL
6. Vision pipeline
7. Character swapping
8. Optimization + polish

That sequence does not relax the contract-first rule. Character manifests, session events, animation events, and service adapter interfaces are still locked before later stages widen implementation.

## Stage 0: Contracts, Repository Foundation, And Baseline Selection

Goal

Create the project skeleton, Windows-first bootstrap, and the shared contracts that all later stages depend on.

Stage 0 also locks the repo portability rule: heavyweight prerequisites are acquired outside Git, bootstrap scripts own automated setup where possible, and documentation plus squad state must support fresh-machine recovery without tribal knowledge.

Dependencies

- Approved architecture and repo structure
- Selected baseline runtime stack: Python backend, React plus TypeScript frontend, UniVRM 1.0 avatar standard
- Agreed 2026 local model baseline for STT, TTS, LLM, embeddings, memory, and optional vision

Work

- Scaffold `frontend/` and `backend/` projects.
- Define shared API schemas for session events, character manifests, animation events, and optional vision telemetry.
- Add local bootstrap scripts for Windows-first development.
- Define the local model and provider storage policy, including environment-variable or settings-driven path resolution.
- Publish manual fallback install instructions for providers that cannot be redistributed or reliably automated.
- Add placeholder asset folders and validation entry points.
- Scaffold the three test character packages under `assets/characters/test-vrm-01..03/` with placeholder manifests and identity metadata.
- Scaffold the shared, generated, and per-character animation directories under `assets/animations/`.
- Publish the squad execution board in `docs/WORKSTREAMS.md` so each specialist can start from explicit contracts.
- Publish a setup and continuity guide that covers fresh-machine bootstrap, local storage roots, and squad handoff expectations.

Exit Criteria

- Repo boots with separate frontend and backend dev commands.
- Shared schema types exist for character selection, chat events, animation events, and optional vision context.
- Developers can run a local empty shell without provider integrations.
- The bootstrap flow, manual install fallbacks, and local-only storage roots are documented well enough for a second machine to reproduce the environment.

Acceptance Criteria

- A new developer can clone the repo and start both apps from documented commands.
- A new Windows machine can identify which prerequisites are downloaded by script, which require manual install, and where local model payloads belong without asking the original author.
- The repo layout matches the structure defined in the architecture doc.
- CI or local validation can check formatting, type health, and backend startup.
- The repo already contains the three agreed test character drop locations and animation storage roots, even before real asset files are imported.

## Stage 1: Backend Skeleton

Goal

Establish the backend orchestrator, API shell, settings model, and service adapter seams before any provider-specific depth is added.

Dependencies

- Stage 0 contracts and repo scaffold

Work

- Scaffold the FastAPI or Starlette app, routing, settings, and session lifecycle shell.
- Define stable service interfaces for STT, TTS, LLM, memory, embeddings, vision, character, and animation adapters.
- Add backend schemas for manifest summaries, session state, animation events, and optional vision-context events.
- Stand up health, diagnostics, and manifest-summary endpoints that remain provider-agnostic.

Exit Criteria

- The backend boots locally with stub adapters and clear configuration boundaries.
- Route handlers depend on service interfaces rather than provider-specific code.
- Session, character, and animation contracts are available for frontend integration.
- Backend settings can point at documented local model or provider roots without source edits.

Acceptance Criteria

- Developers can run the backend with no local models installed and still inspect contract responses.
- Provider selection lives in settings and service layers, not in route handlers.
- Optional vision support is visible in the API model without forcing camera support to be enabled.
- Missing provider installs fail with actionable guidance that points back to the documented bootstrap or manual fallback path.

## Stage 2: Frontend VRM Rendering

Goal

Render a validated UniVRM 1.0 character in a stable frontend shell that can consume backend session and animation state.

Dependencies

- Stage 0 contracts
- Stage 1 backend manifest-summary and session contracts

Work

- Implement a three.js plus three-vrm avatar viewer.
- Build the avatar stage, frontend catalog loader, and manifest-driven default-character flow.
- Keep microphone and camera permission UX in the frontend shell without coupling UI code to provider logic.
- Establish semantic avatar states such as `idle`, `listen`, `speak`, and `emote`, even when motions are placeholder-level.

Exit Criteria

- The app loads one default character from manifest data without hardcoded path logic.
- The frontend can react to backend session state and animation events.
- The avatar shell is ready for audio and animation integration without reopening the rendering contract.

Acceptance Criteria

- UniVRM 1.0 validation still gates bad character packages before runtime.
- No frontend code branches on character-specific skeleton logic outside declared overrides.
- The viewer shell exposes a clean seam for later character swapping work instead of baking it into first-pass rendering.

## Stage 3: STT + TTS Integration

Goal

Ship the first local audio loop by wiring microphone input to transcription and a synthesized response path before full LLM reasoning is added.

Dependencies

- Stage 1 backend adapter boundaries
- Stage 2 frontend device and avatar shell

Work

- Integrate Faster-Whisper Medium as the default STT adapter and Faster-Whisper Small as the fallback profile.
- Integrate GPT-SoVITS latest stable 2026 fork behind a normalized TTS contract.
- Stream transcription, speaking-state, synthesis status, and timing metadata to the frontend.
- Use a bounded backend reply path, such as canned responses or a test echo mode, to validate the full audio loop before LLM coupling.

Exit Criteria

- A user can speak into the app, see transcription state, and hear a synthesized response locally.
- The avatar enters listening and speaking states from backend-owned lifecycle events.
- Provider failures surface as controlled degraded states instead of hard crashes.

Acceptance Criteria

- Audio turn flow succeeds on the target Windows hardware profile.
- Timing metadata exists for later speech-aligned motion and lip-sync work.
- The backend still exposes a single coherent session API instead of provider-specific routes.

## Stage 4: Local LLM + Memory

Goal

Replace the temporary reply path with a stateful local reasoning loop that incorporates persistent memory without collapsing subsystem boundaries.

Dependencies

- Stable Stage 3 audio loop
- SQLite and vector-store foundations from Stages 0 and 1

Work

- Integrate the LLaMA 3.1 8B Q4_K_M baseline through llama.cpp, Ollama, or another local adapter.
- Add persistent transcript, summary, and relationship storage.
- Implement semantic retrieval through SQLite plus ChromaDB or FAISS.
- Resolve embeddings through a dedicated adapter, targeting `bge-small-en` by default and `MiniLM-L6-v2` as a fallback.
- Bind character-specific prompt and voice profiles through the character service.

Exit Criteria

- The assistant can complete a local voice turn with retrieval-augmented response generation.
- Restarting the app does not erase canonical session memory.
- Retrieval and summarization stay behind a dedicated memory service boundary.

Acceptance Criteria

- Memory results are inspectable and attributable for debugging.
- Character-specific tone and voice settings resolve through manifests and backend profiles, not frontend conditionals.
- The local LLM runtime remains swappable behind the adapter contract.

## Stage 5: Animation DSL

Goal

Move from static avatar state changes to reusable semantic animation playback driven by conversation and system intent.

Dependencies

- Stage 2 avatar shell
- Stage 3 speech timing events
- Stage 4 structured reply and memory context

Work

- Define the animation DSL or event schema with semantic actions.
- Implement backend intent-to-animation translation.
- Build frontend runtime playback with shared animation library support.
- Add per-character override resolution for expressions, gestures, and emphasis.
- Stage generated motion under `assets/animations/generated/` and promote it into the shared library only after validation.

Exit Criteria

- Conversation events trigger consistent avatar motion states.
- Shared animation events run across the current sample characters.
- Overrides remain declarative and asset-driven rather than hardcoded in viewer logic.

Acceptance Criteria

- At least one shared idle set, one listening state, one speaking state, and one emote class are working.
- Speech timing metadata can be used for lip-sync or speech-aligned motion.
- The runtime degrades gracefully when a clip or override is missing.

## Stage 6: Vision Pipeline

Goal

Add the optional camera path so face state and light scene understanding can enrich session context and avatar reactions without destabilizing the core voice loop.

Dependencies

- Stage 2 frontend capture shell
- Stage 4 memory and orchestration context handling
- Stage 5 animation intent output

Work

- Add frontend camera capture and MediaPipe Face Mesh processing close to the device path.
- Define normalized face-state and optional sampled-frame contracts for the backend.
- Add optional CLIP-based enrichment through a bounded backend vision adapter.
- Merge relevant visual cues into session context and avatar reaction intent.

Exit Criteria

- Vision can be enabled as an optional feature flag without blocking the voice loop.
- Face or scene cues can drive bounded avatar reactions or context hints.
- Vision failures degrade to a no-camera state rather than breaking the session.

Acceptance Criteria

- MediaPipe output is normalized before it crosses the frontend-backend boundary.
- CLIP or similar visual enrichment only runs on bounded samples, not on every raw frame by default.
- Vision remains clearly outside the critical path for a standard voice turn.

## Stage 7: Character Swapping

Goal

Harden multi-character interchange so the fully integrated voice, memory, animation, and vision stack can swap characters through manifest data instead of special-case code.

Dependencies

- Stages 2 through 6
- Stable UniVRM 1.0 manifest and override contract from Stage 0

Work

- Expand the frontend and backend catalog flow from one default character to robust multi-character selection and active swapping.
- Bind prompt, voice, expression, and animation-override profiles to the selected character.
- Add warm-load or state-handoff logic so swaps feel controlled rather than destructive.
- Validate that the same semantic animation ids and service contracts hold across all supported characters.

Exit Criteria

- The app can swap between validated characters without code changes.
- Persona, voice, animation overrides, and optional vision reactions resolve from the active character package.
- Character-specific exceptions remain asset-driven, not hardcoded in the application.

Acceptance Criteria

- All supported character packages conform to the same manifest contract.
- Character swapping preserves session continuity and stable high-level avatar states.
- Frontend and backend still bind to manifest `character_id`, not vendor file names or ad hoc path logic.

## Stage 8: Optimization + Polish

Goal

Turn the integrated prototype into a stable local product candidate for the Windows 10/11 target hardware profile.

Dependencies

- Stages 0 through 7

Work

- Add diagnostics, latency tracing, and benchmark reporting.
- Improve packaging and local install flow for Windows.
- Tune model, embeddings, synthesis, and memory defaults for the 12 GB VRAM target.
- Harden startup, recovery, and degraded-mode behavior for optional components such as camera or CLIP.

Exit Criteria

- The app is operable by a non-developer on a target machine.
- Latency and failure diagnostics are visible enough to tune locally.
- Optional features stay isolated from the critical companion loop.

Acceptance Criteria

- Packaging or scripted setup covers the core local dependencies.
- Resource usage stays within a documented target envelope.
- Vision and other optional sensing features remain off by default unless intentionally enabled.

## Milestone Summary

### Milestone 0

Contracts, repo layout, and validation scaffolding are locked.

### Milestone 1

The backend skeleton boots with stable adapter seams.

### Milestone 2

The frontend renders a manifest-driven UniVRM 1.0 avatar shell.

### Milestone 3

The first local STT + TTS loop works end to end.

### Milestone 4

The local LLM and persistent memory loop are stable.

### Milestone 5

Animation DSL playback is functioning through semantic events.

### Milestone 6

Optional vision cues can enrich context and avatar reactions.

### Milestone 7

Validated characters swap cleanly across the full stack.

### Milestone 8

The system is packaged, profiled, and ready for broader iteration.

## Dependency Graph

1. Stage 0 unblocks every later stage.
2. Stage 1 must land before provider-specific integration work deepens.
3. Stage 2 depends on the Stage 1 contract surface, but it should stay rendering-focused and avoid pulling in provider logic.
4. Stage 3 depends on Stage 1 backend seams and the Stage 2 device plus avatar shell.
5. Stage 4 depends on a stable Stage 3 audio loop plus the memory and vector boundaries established earlier.
6. Stage 5 depends on Stage 2 avatar rendering plus Stage 3 and 4 lifecycle outputs.
7. Stage 6 depends on Stage 2 capture seams and Stage 4 and 5 context plus reaction boundaries.
8. Stage 7 depends on the stability of Stages 2 through 6 and should harden character interchange rather than invent new contracts.
9. Stage 8 hardens the integrated stack after the core loop is proven.

Detailed squad-level execution checklists live in `docs/WORKSTREAMS.md` and should be treated as the current scaffold handoff for Trinity, Switch, Tank, Link, and Mouse.

## Risks And Deferrals

### Risks

- Latency on 12 GB VRAM hardware may force tighter defaults than the ideal 2026 model stack suggests.
- UniVRM 1.0 compatibility alone does not guarantee identical expression fidelity, so validation and override discipline still matter.
- GPT-SoVITS operational complexity may require a fallback local TTS profile if maintenance cost is too high early on.
- MediaPipe plus optional CLIP can blur ownership unless the frontend capture boundary and backend enrichment boundary stay explicit.
- Character swapping late in the stage order can tempt shortcut code unless manifest and semantic animation contracts stay enforced from Stage 0 onward.

### Deferrals

- Advanced tool-calling or autonomous task systems beyond core companion interaction
- Cloud sync and remote inference
- Broad avatar format support outside UniVRM 1.0
- Always-on vision processing as a default dependency

## Recommended First Build Order For The Squad

1. Trinity: lock the updated 2026 baseline, session contracts, animation events, and vision telemetry boundaries.
2. Tank: deepen the backend skeleton, adapter interfaces, and provider-agnostic session API.
3. Switch: keep the frontend shell focused on VRM rendering, device permissions, and backend-owned session state.
4. Link: prepare the STT, TTS, local LLM, embeddings, and optional vision adapter contracts against the Stage 1 backend seams.
5. Mouse: extend contract validation to cover the staged voice and vision event model without widening the runtime surface prematurely.
6. Rejoin on Stage 1 and 2 review before any deep provider-specific integration work.
