# Architecture

## Purpose

NikoF is a local-only anime companion stack optimized for low-latency interaction on Windows 10/11 hardware with about 12 GB of NVIDIA-friendly VRAM. The system must support interchangeable characters, a reusable animation library, offline speech and language processing, optional realtime vision cues, and a stable asset pipeline that external artists can target without custom rig negotiation on every character.

## Recommended 2026 Local Baseline

- STT: Faster-Whisper Medium as the default recognition target, with Faster-Whisper Small as the fallback for tighter VRAM budgets.
- TTS: GPT-SoVITS latest stable 2026 fork behind a normalized adapter contract.
- LLM: LLaMA 3.1 8B Q4_K_M as the local default model profile.
- Face tracking: MediaPipe Face Mesh for realtime landmark extraction close to the camera input path.
- Optional visual context: CLIP as a non-blocking enrichment path for coarse object or scene recognition.
- Memory: SQLite as the canonical transactional store plus ChromaDB or FAISS as the vector index layer.
- Embeddings: `bge-small-en` by default, with `MiniLM-L6-v2` available as a lighter fallback.

The baseline above is a planning contract, not a hard lock on one specific runtime implementation. Backend adapters must keep provider choice behind stable internal interfaces so later experiments do not leak into the frontend or asset pipeline.

## Portability, Bootstrap, And Storage Policy

- Git stores source, contracts, manifests, scripts, and documentation. Git does not store LLM weights, speech model payloads, vector indexes generated from local data, vendor runtime installers, or other heavyweight prerequisites.
- Bootstrap scripts are the first-class path for preparing a new Windows machine. They should download or provision prerequisites when licensing, redistribution, and installer behavior make automation viable.
- When a provider cannot be installed safely through automation, the repo must still carry precise manual fallback instructions, expected install locations, validation checks, and the next step needed to rejoin the standard bootstrap flow.
- Cross-machine continuity is a design requirement, not a convenience item. The checked-in docs plus `.squad/` state must be sufficient for Jason or another developer to recover the architecture, current work plan, and local setup expectations on a fresh machine.

Local storage rule:

- Keep local model weights, provider runtimes, caches, and other heavyweight machine-specific prerequisites outside the normal source tree when possible, such as under `%LOCALAPPDATA%\NikoF\models`, `%LOCALAPPDATA%\NikoF\providers`, or another documented local root.
- If a development workflow needs a repo-adjacent cache or pointer directory, it must be explicitly local-only, documented, and ignored by Git.
- Backend configuration should resolve these locations through settings or environment variables instead of hardcoded absolute paths.

## Primary Runtime Workflows

### Voice Workflow

`Mic -> STT -> Memory -> LLM -> TTS -> Avatar`

- The backend orchestrator owns the turn lifecycle and remains the only public service boundary to the frontend.
- Memory retrieval happens before response generation, not as an afterthought layered on top of finished replies.
- TTS returns timing metadata that the frontend avatar runtime can use for lip-sync and speaking-state alignment.

### Vision Workflow

`Camera -> MediaPipe -> optional CLIP -> backend context -> avatar reactions`

- Camera permissions and low-latency frame capture live on the frontend side.
- MediaPipe Face Mesh should run close to the capture path so face landmarks stay responsive and do not depend on round-tripping raw video through the backend.
- The backend receives normalized face or scene observations, optionally enriches sampled frames through CLIP, then merges the result into session context and avatar reaction intent.
- Vision is optional and must remain outside the critical path for the voice workflow.

## Proposed Repository Structure

```text
NikoF/
  README.md
  docs/
    ARCHITECTURE.md
    IMPLEMENTATION_PLAN.md
  frontend/
    package.json
    src/
      app/
      features/devices/
      features/chat/
      features/vision/
      features/settings/
      features/session/
      avatar/
        components/
        runtime/
        loaders/
        manifests/
        animation/
      workers/
        mediapipe/
      shared/
        api/
        state/
        types/
  backend/
    pyproject.toml
    app/
      api/
      core/
      orchestrator/
      schemas/
      services/
        stt/
        llm/
        tts/
        memory/
        embeddings/
        vision/
        character/
        animation/
      storage/
        vector/
      workers/
  assets/
    characters/
      test-vrm-01/
        manifest.json
        metadata/
          identity.json
        model.vrm
        expressions/
          mapping.json
        voice/
          profile.json
        overrides/
          animations.json
      test-vrm-02/
        manifest.json
        metadata/
          identity.json
        model.vrm
        expressions/
          mapping.json
        voice/
          profile.json
        overrides/
          animations.json
      test-vrm-03/
        manifest.json
        metadata/
          identity.json
        model.vrm
        expressions/
          mapping.json
        voice/
          profile.json
        overrides/
          animations.json
    animations/
      library/
        shared/
      dsl/
      generated/
        shared/
        characters/
          {character_id}/
      overrides/
        {character_id}/
      retargeting/
  scripts/
    bootstrap/
    asset_validation/
    benchmarks/
  tests/
    integration/
    contracts/
    latency/
```

The repository structure above intentionally omits committed model payload directories. Model assets belong in documented local storage roots, while the repo carries adapters, manifests, bootstrap scripts, and validation logic only.

## Subsystem Responsibilities

### Frontend

- Owns chat presentation, settings, device permissions, and responsive session UX.
- Hosts microphone and optional camera permission flows plus the low-latency client path for face-tracking capture.
- Hosts the avatar viewer, character selection UI, and playback of animation directives received from the backend.
- Maintains client-side session state that is presentation-specific, not canonical system memory.
- Treats backend responses as authoritative for conversation events, speech lifecycle state, memory summaries intentionally surfaced to the UI, and animation intent.

### Avatar Runtime

- Loads UniVRM 1.0 avatars and validates that each character satisfies the required humanoid and expression contract.
- Plays shared animation assets against a normalized rig mapping.
- Applies per-character overrides only where a manifest explicitly declares them.
- Exposes a narrow runtime API to the React app: load character, swap character, play idle set, play scripted animation event, update gaze or expression state.
- Accepts semantic face or scene reactions from the frontend state layer, not raw MediaPipe or CLIP payloads.

### Backend Orchestrator

- Owns the speech turn lifecycle: capture user input, transcribe, retrieve memory, generate reply, synthesize speech, emit animation cues.
- Owns the optional vision-context lifecycle: ingest normalized observations, enrich when enabled, fold relevant cues into memory and animation decisions, and keep the feature off the critical voice path.
- Provides the only public service boundary to the frontend.
- Normalizes provider-specific behavior from STT, LLM, and TTS adapters into stable internal contracts.
- Manages latency budgets and fallbacks, including partial results and degraded local-only modes.
- Resolves local provider and model paths through configuration so a new machine can reproduce the environment without editing source.

### STT Service

- Wraps Faster-Whisper Medium or Small through a stable local recognition contract.
- Accepts raw or preprocessed audio chunks and produces incremental or final transcription events.
- Does not know about personas, memory, UI state, or animation.

### LLM Service

- Wraps local model execution for the LLaMA 3.1 8B Q4_K_M baseline through Ollama, llama.cpp, or another offline adapter.
- Accepts prompt context assembled by the orchestrator.
- Returns structured response payloads that can include text reply, tool-safe metadata, and animation intent hints.
- Does not directly call TTS, memory storage, or frontend APIs.

### TTS Service

- Wraps GPT-SoVITS latest stable 2026 fork or a compatible offline TTS engine.
- Accepts normalized speech text plus voice profile settings from the character service.
- Returns audio artifacts and timing metadata suitable for frontend lip-sync and animation alignment.

### Memory Service

- Owns canonical persistence for session history, character affinity, summaries, and retrieval indexes.
- Uses SQLite for transactional state and ChromaDB or FAISS for semantic recall.
- Resolves embeddings through a dedicated adapter so `bge-small-en` and `MiniLM-L6-v2` remain swappable implementation details.
- Exposes retrieval and write APIs to the orchestrator only.
- Avoids leaking database concerns into speech, avatar, or UI layers.

### Vision Service

- Accepts normalized face landmarks, head pose summaries, attention hints, or sampled image frames from the frontend capture path.
- Runs optional CLIP or equivalent enrichment only when enabled and only on bounded samples.
- Returns backend-safe context objects such as attention state, coarse scene tags, and avatar reaction hints.
- Never becomes a prerequisite for the core voice turn or avatar idle loop.

### Character Asset Service

- Validates character manifests, file layout, and required UniVRM 1.0 metadata.
- Resolves the active character's model path, expression presets, voice profile, prompt profile, and animation override map.
- Shields the rest of the backend from raw filesystem conventions.

## Bootstrap And Continuity Responsibilities

- `scripts/bootstrap/` owns machine preparation steps, prerequisite detection, download orchestration where allowed, and post-install validation entry points.
- Documentation must describe the supported bootstrap flow for a fresh Windows machine, including which prerequisites are automated, which remain manual, and how to validate the finished environment before starting frontend or backend services.
- Squad continuity files under `.squad/` are part of the operational architecture. They preserve active decisions, work ownership, and durable project knowledge so another machine or developer can resume with minimal rediscovery.
- Architecture changes that affect local storage, install flow, or provider expectations must update both the implementation docs and the setup-and-continuity guide in the same change.

### Animation Runtime Service

- Converts conversation state and backend intent into animation DSL events.
- Resolves shared animation library references and optional per-character overrides.
- Emits frontend-safe animation commands, not engine-specific scene code.

## Interface Boundaries And Contracts

### Frontend To Backend

Transport: HTTP for control and setup, WebSocket or SSE for live conversation events.

The frontend sends:

- session start or stop commands
- selected character id
- microphone state and audio stream metadata
- optional camera state and normalized vision telemetry
- user text input when text mode is used

The backend returns or streams:

- transcription status events
- assistant message chunks or final reply
- speech synthesis status and audio metadata
- animation events with normalized names and parameters
- optional vision-state acknowledgements or bounded context summaries when intentionally surfaced
- memory or context summaries only when intentionally surfaced to the UI

Frontend contract rule: the frontend never talks directly to STT, TTS, LLM, or memory providers.

### Orchestrator To STT

Input contract:

- audio frames or buffered audio payload
- sample rate, channel configuration, and session id

Output contract:

- incremental transcript events
- final transcript with confidence and timing ranges
- error states suitable for retry or user-visible diagnostics

### Orchestrator To LLM

Input contract:

- system prompt assembled from character profile and global policies
- user utterance
- retrieved memory slices
- optional scene or animation context

Output contract:

- assistant reply text
- optional structured intent fields for mood, expression, gesture class, and follow-up actions
- token and timing metrics for latency diagnostics

### Orchestrator To TTS

Input contract:

- final assistant text
- character voice profile id and synthesis settings
- optional emotion or delivery hints

Output contract:

- generated audio path or stream handle
- phoneme or timing metadata when available
- synthesis timing and error metadata

### Orchestrator To Memory

Input contract:

- retrieval query keyed by session, character, and user context
- event writes such as transcript records, summaries, tags, and relationship signals

Output contract:

- ranked memory results with provenance
- persisted record ids and summary artifacts

### Orchestrator To Vision Service

Input contract:

- session id and active character id
- normalized face landmarks, head pose summaries, or bounded image samples
- runtime flags that indicate whether CLIP enrichment is enabled

Output contract:

- face or scene context summaries safe to merge into session state
- optional attention, gaze, or emotion hints for the animation runtime
- processing metrics and degraded-mode flags for diagnostics

### Orchestrator To Character Service

Input contract:

- character id

Output contract:

- manifest details including model path, voice profile reference, prompt profile reference, supported expressions, and override definitions

### Orchestrator To Animation Runtime

Input contract:

- normalized intent such as `idle`, `speak`, `listen`, `acknowledge`, `think`, or `emote`
- optional intensity, duration, emphasis, gaze target, and expression hints
- active character id

Output contract:

- frontend-safe animation event object with clip ids, blend hints, and override resolution already applied

## UniVRM 1.0 Character Pipeline Implications

UniVRM 1.0 should be treated as a hard standard for the character layer rather than a loose preference.

### Why It Matters

- It gives purchased, downloaded, or commissioned avatars a single import target.
- It reduces rig ambiguity by centering humanoid compatibility and expected avatar semantics.
- It lets the animation layer assume a common baseline for retargeting instead of per-character bespoke glue.
- It makes character swapping operationally simple: a new model becomes a new manifest package, not a new code path.

### Required Character Package Contract

Each character package should include:

- `manifest.json`: canonical metadata and capabilities
- `metadata/identity.json`: fallback identity record when the source VRM does not expose a stable name or identifier
- `model.vrm`: the UniVRM 1.0 avatar file
- `voice/`: voice profile config and optional synthesis presets
- `expressions/`: named expression mappings and optional blend presets
- `overrides/`: optional animation or expression overrides for specific shared animation ids

### Initial Test Character Placement

The first three imported test avatars should live here and nowhere else:

| Character slot | Folder | Expected dropped VRM |
| --- | --- | --- |
| Test character 01 | `assets/characters/test-vrm-01/` | `assets/characters/test-vrm-01/model.vrm` |
| Test character 02 | `assets/characters/test-vrm-02/` | `assets/characters/test-vrm-02/model.vrm` |
| Test character 03 | `assets/characters/test-vrm-03/` | `assets/characters/test-vrm-03/model.vrm` |

The folder name is the canonical `character_id` until the asset is intentionally renamed. Frontend and backend code should bind to the manifest `character_id`, not the original vendor filename.

### Minimum Manifest Metadata When Source VRMs Lack Identity Data

When a VRM arrives without a usable embedded name, identifier, or consistent catalog metadata, the package must still ship with a valid manifest and scaffolded identity record.

Required minimum fields in `manifest.json`:

- `schema_version`
- `character_id`
- `display_name`
- `identity_source`
- `asset_version`
- `vrm_spec_version`
- `model_file`
- `metadata_file`
- `supported_states`
- `shared_animation_set`
- `voice_profile`
- `expression_map`
- `animation_overrides`

Required minimum fields in `metadata/identity.json`:

- `character_id`
- `display_name`
- `identity_status`
- `source_vrm.file_name`
- `source_vrm.embedded_name`
- `source_vrm.embedded_identifier`
- `review_required`

Rules:

- If the source VRM has no stable identity, `character_id` is assigned from the package folder name.
- `display_name` may start as a human-readable placeholder such as `Test Character 01`, but it must remain unique in the manifest catalog.
- `identity_source` must be `scaffolded` until a human updates the package with trusted source identity data.
- Asset validation should reject packages that omit the scaffold files even if the VRM itself loads.

Suggested manifest fields:

- `character_id`
- `display_name`
- `vrm_version`
- `humanoid_profile`
- `supported_expressions`
- `voice_profile`
- `prompt_profile`
- `animation_overrides`
- `camera_defaults`

Minimal scaffold example:

```json
{
  "schema_version": 1,
  "character_id": "test-vrm-01",
  "display_name": "Test Character 01",
  "identity_source": "scaffolded",
  "asset_version": "0.1.0",
  "vrm_spec_version": "1.0",
  "model_file": "model.vrm",
  "metadata_file": "metadata/identity.json",
  "supported_states": ["idle", "listen", "speak", "emote"],
  "shared_animation_set": "core-v1",
  "voice_profile": {
    "profile_id": "test-vrm-01-default",
    "path": "voice/profile.json"
  },
  "expression_map": "expressions/mapping.json",
  "animation_overrides": "overrides/animations.json"
}
```

### Rig Mapping And Swap Compatibility

- Shared animations target a normalized humanoid rig contract, not a character-specific skeleton.
- Any character-specific differences must be resolved in asset validation or override manifests, not in frontend runtime branching.
- A character is considered swap-compatible only if it passes validation for required bones, expression mappings, scale expectations, and baseline idle behavior.
- Character swap should preserve higher-level runtime concepts such as `idle`, `listen`, `speak`, and `emote` even if the underlying clips or expression curves differ per character.

### Artist Pipeline Rules

- Artists should receive a manifest template plus a published validation checklist.
- New character delivery should be accepted only if the model passes import validation and required expression coverage.
- Custom flair belongs in optional overrides, not in the shared contract.
- Non-compliant models can be admitted later through a conversion workflow, but that should be a separate pipeline, not the baseline path.

## Animation Asset Ownership Rules

Animation assets are organized by semantic ownership, not by whichever system authored them.

### Shared Animation Library

- Shared reusable clips live under `assets/animations/library/shared/`.
- Shared assets are addressed by semantic ids such as `idle.base`, `listen.attentive`, or `emote.wave`, never by raw file path in application code.
- Shared assets must be retargetable across every swap-compatible character package.

### Per-Character Overrides

- Character-specific override payloads live in two places: `assets/characters/{character_id}/overrides/animations.json` for manifest declarations, and `assets/animations/overrides/{character_id}/` for the override assets themselves.
- Overrides are allowed only when a shared semantic animation exists first and the character needs a different clip, timing patch, expression blend, or additive motion layer.
- Runtime resolution order is: shared semantic clip, declared character override, then safe fallback pose or expression if neither exists.
- Frontend code must request semantic animation ids only. It may not branch on `character_id` to pick files.

### AI-Authored Animation Generation

- AI-authored or procedurally generated motion is staged under `assets/animations/generated/shared/` when intended for future library promotion, or `assets/animations/generated/characters/{character_id}/` when it is exploratory or character-specific.
- Generated motion is not part of the stable shared library until it is reviewed, validated, assigned a semantic id, and promoted into `assets/animations/library/shared/`.
- Generated character-specific motion can become an override only after the owning character manifest references it explicitly.
- Backend animation services may emit semantic requests for generated motion, but the storage contract remains filesystem-based so later tools and review scripts can inspect the outputs.

## System Contracts That Must Stay Thin

- The frontend renders and reacts; it does not own inference logic.
- The orchestrator coordinates providers; it does not embed provider-specific file conventions in route handlers.
- Character packages declare overrides; they do not alter core animation runtime semantics.
- Memory stores canonical history; temporary UI state stays client-side.
- Animation events are semantic and normalized; the viewer decides how to play them without leaking three.js scene details back into the backend.

## Initial Non-Goals And Deferrals

- Cloud sync or online model hosting
- Multi-user accounts
- Complex tool-use agents beyond conversation orchestration
- Full-body camera-driven animation as a day-one dependency
- Arbitrary avatar standards beyond UniVRM 1.0 in the initial character pipeline
