# Animation DSL Workflow

This note documents the current repository-backed path from tracked Unity `.anim` source clips toward stable semantic animation assets.

It is intentionally honest about the current state: the repository has a defined provenance and staging layer, but it does not yet have a finished Unity-to-DSL converter or a complete runtime-resolution pipeline. The goal here is to describe the intended workflow, the responsibilities at each stage, and the proof required before the DSL path should be treated as stable.

## Current State

Today the animation pipeline has three concrete pieces in place:

1. Raw Unity clip provenance in Git.
   Raw source clips live under `assets/animations/raw/` and remain tracked so the team keeps the original import payload and can rerun export work deterministically.
2. Safe metadata sidecars.
   `scripts/animation_tools/export_unity_anim_metadata.py` extracts a limited, safe subset of Unity text `.anim` metadata into JSON sidecars under `assets/animations/dsl/shared/`.
3. A staged semantic registry.
   `assets/animations/dsl/shared/animations.json` records which semantic ids exist in staged form and whether they are approved for promotion.

The current export step is intentionally narrow. It captures source provenance plus clip metadata such as Unity clip name, sample rate, start time, stop time, and loop flag. It does not convert curve data into a final runtime-ready semantic DSL, does not retarget clips across characters, and does not prove runtime playback.

The repository now also has a first low-interaction Unity batch export path for raw `.anim` clips. That path is intentionally honest about stage boundaries: it emits generated runtime payloads and semantic asset candidates, but it does not mark them as promoted shared-library inventory.

## What Is Missing

The missing middle is the work between a safe provenance sidecar and a runtime-ready semantic asset:

- semantic review of the candidate id and intended behavior
- retargeting or normalization against the shared humanoid contract
- explicit DSL authoring for semantic playback, timing, blends, and fallback behavior
- validation that the authored result is portable across swap-compatible characters
- promotion rules that separate staged source records from approved runtime assets

The missing final step is a stable runtime contract that resolves semantic animation ids into viewer-safe animation events with override resolution and fallback handling already applied. The backend service boundary for this exists only as a stub today, so this document treats that part as planned work rather than implemented behavior.

## Proposed Workflow

The recommended path is:

`raw clip -> metadata export -> semantic review -> retarget/normalization -> DSL authoring -> validation -> promotion`

### 1. Raw Clip Import

- Drop the Unity text `.anim` file into `assets/animations/raw/`.
- Keep the file in Git while the clip is still part of active provenance, review, or re-export work.
- Treat the clip as source material only, not as a runtime asset.

Expected outcome:

- The repository contains the original import payload.
- The team can inspect or re-export the source without relying on local-only tooling state.

### 2. Metadata Export

- Run `scripts/animation_tools/export_unity_anim_metadata.py` against the raw clip.
- Write the output to `assets/animations/dsl/shared/{semantic_id}.json`.
- Add or update the corresponding registry entry in `assets/animations/dsl/shared/animations.json`.

Expected outcome:

- The repo now has a safe, reviewable sidecar that names the candidate semantic id and records raw-source provenance.
- The staged registry can track that this semantic id exists, but is not yet approved for the shared runtime library.

This stage is already supported by the repo.

### 2a. Unity Batch Normalization Export

- Run `scripts/animation_tools/Invoke-UnityRawAnimExport.ps1` with a semantic id and raw `.anim` source path.
- The wrapper detects or accepts a Unity editor path, creates a temporary Unity project, copies in the raw clip, and runs `NikoF.AnimationTools.RawAnimBatchExporter` in batchmode.
- The Unity-side exporter refreshes the staged sidecar and writes two additional generated outputs:
   - `assets/animations/generated/shared/{semantic_id}/{semantic_id}.runtime.json`
   - `assets/animations/dsl/generated/shared/{semantic_id}.json`

Expected outcome:

- The repo keeps the staged provenance sidecar under `assets/animations/dsl/shared/`.
- The repo gains a viewer-safe normalized runtime payload sampled from Unity curves without requiring a permanent Unity project.
- The repo gains a semantic asset candidate that points at the generated runtime payload while remaining explicitly unpromoted.

Important constraint:

- These generated outputs are candidate assets, not approved shared-library inventory.
- They remain under `generated/` and `dsl/generated/` until viewer validation and promotion review move them into `assets/animations/library/shared/`.

### 3. Semantic Review

- Review whether the candidate semantic id is correct for the clip's intended meaning, not just its authored filename.
- Confirm whether the motion belongs in the shared semantic vocabulary or should remain character-specific.
- Record obvious notes that downstream DSL authoring will need, such as loop expectations, intensity range, emotional tone, or whether the clip is additive versus full-body.

Expected outcome:

- A stable semantic id such as `idle.base`, `listen.attentive`, or `emote.wave` is accepted for the clip.
- The team decides whether the asset is aiming at shared promotion or character-only override handling.

This stage is currently a human review activity. The repo has naming rules and staging structure, but not a formal review tool yet.

### 4. Retarget And Normalize

- Retarget the source clip, or derive an equivalent normalized motion, against the shared humanoid contract implied by the UniVRM 1.0 character pipeline.
- Normalize timing, looping behavior, root motion expectations, and any rig-specific quirks that would block cross-character playback.
- Keep reusable retargeting mappings or profiles under `assets/animations/retargeting/` when those artifacts become concrete.

Expected outcome:

- The motion is no longer just a Unity-authored source clip. It has been translated into a character-agnostic form that a semantic animation definition can rely on.
- Character-specific fixes are identified explicitly instead of being left to ad hoc viewer code.

This stage remains offline tooling work. No checked-in converter or retargeter currently performs it inside the repo.

### 5. DSL Authoring

- Author the semantic animation definition that should become the runtime-facing asset.
- Keep this DSL focused on semantic playback rules rather than raw Unity implementation details.
- Capture the details the runtime will actually need, such as semantic id, loop mode, timing windows, blend or layering hints, and fallback expectations.

Expected outcome:

- There is a promoted semantic asset under the `assets/animations/dsl/` area that represents runtime intent rather than raw-source provenance.
- The staged provenance sidecar remains useful for traceability, but it is no longer the only record of the animation.

Important constraint:

- The final promoted DSL schema is not locked yet in this repo.
- Until that schema exists, the staged JSON sidecar in `assets/animations/dsl/shared/` should be treated as a precursor artifact, not the final runtime DSL.
- The Unity batch exporter may emit `semantic_animation_asset_candidate` JSON under `assets/animations/dsl/generated/shared/`. That file is a pre-promotion runtime contract candidate, not a promoted shared semantic asset.

### 6. Validation

- Validate that the authored semantic asset behaves correctly across the supported swap-compatible characters.
- Validate that shared semantic ids remain file-path-agnostic and do not require viewer logic to branch on `character_id`.
- Validate that override declarations remain manifest-driven and that missing assets degrade to safe fallback behavior.

Expected outcome:

- The clip is proven portable enough for shared-library promotion, or it is explicitly downgraded to a character-specific override or generated experiment.
- The asset contract stays semantic and normalized, matching the architecture boundary.

Part of this validation can eventually be automated by contract and stability tests, but viewer proof is also required before the pipeline should be considered mature.

### 7. Promotion

- Promote approved shared runtime assets into `assets/animations/library/shared/`.
- Keep staged or exploratory outputs out of the approved library until review and validation are complete.
- If the motion is intentionally character-specific, promote it instead into `assets/animations/overrides/{character_id}/` and declare it from that character package's `overrides/animations.json`.

Expected outcome:

- Shared library assets are approved, semantic, and reusable.
- Character-specific behavior remains explicit and declared.
- The runtime resolution order can stay: shared semantic clip, declared override, then safe fallback.

## Where Generated, Shared, And Override Assets Fit

### `assets/animations/generated/shared/`

This area is for AI-authored or procedural motion that may eventually join the shared library. These assets should enter the workflow after generation, at semantic review, and then pass through the same normalization, DSL authoring, validation, and promotion gates as raw Unity imports. They are staged candidates, not stable runtime inventory.

The Unity batch exporter also writes normalized raw-import payloads here when they are runtime-facing but not yet approved. That keeps generated or normalized clips viewer-safe without implying shared-library promotion.

### `assets/animations/dsl/generated/shared/`

This area is for generated semantic asset candidates that already speak the runtime-facing DSL shape closely enough to review, but are not yet approved for the shared library.

- Use this root for Unity batch-exported semantic asset candidates that point at generated normalized payloads.
- Keep `stage` and `promotion_status` explicit so these files cannot be mistaken for approved shared inventory.
- Promote from here into the final shared DSL or library contract only after viewer validation.

### `assets/animations/generated/characters/{character_id}/`

This area is for exploratory or character-specific generated motion. These assets are not approved overrides yet. If they prove useful, they should move through review and validation, then promote into `assets/animations/overrides/{character_id}/` rather than silently remaining as production dependencies in `generated/`.

### `assets/animations/library/shared/`

This is the approved shared runtime inventory. Promotion into this folder should mean the semantic motion has passed normalization and viewer proof and is safe to resolve by semantic id across swap-compatible characters.

### `assets/animations/overrides/{character_id}/`

This is the approved character-specific runtime inventory. It exists only when a shared semantic animation already exists and a specific character needs a declared replacement, timing patch, additive layer, or similar custom behavior.

### `assets/animations/dsl/shared/`

Today this folder is the staging area for provenance sidecars and the semantic registry. It should not be treated as proof that the final DSL pipeline already exists. As the DSL schema matures, the team should keep a clean distinction between staged provenance artifacts and promoted runtime-facing semantic definitions, whether that is expressed by schema version, stage flags, or a more explicit folder split.

## Offline Tooling Versus Backend Runtime Responsibility

### Offline Tooling Owns

- importing and preserving raw Unity source clips
- extracting safe metadata sidecars
- retargeting or normalization work
- generation pipelines that create candidate motion assets
- authoring or compiling the eventual runtime-facing DSL asset
- pre-promotion validation and review workflows

These are asset-production responsibilities. They should remain inspectable, repeatable, and largely filesystem-driven so the team can review artifacts before they become runtime dependencies.

### Backend Runtime Owns

- accepting semantic animation intent from conversation or system state
- resolving semantic ids through the approved shared library and declared character overrides
- applying resolution order and safe fallback behavior
- emitting frontend-safe animation events instead of raw file-path or engine-specific scene logic

The backend should not be responsible for parsing raw Unity `.anim` files, inventing semantics from source payloads on the fly, or performing ad hoc retargeting during a live session. Those concerns belong upstream in the offline asset pipeline.

## What The Web Viewer Must Prove Before This Pipeline Is Stable

Before the DSL pipeline should be treated as stable, the web viewer must prove more than basic file loading.

Required proof points:

- The same shared semantic id can be requested across the current swap-compatible test characters without viewer-side branching on file paths.
- Approved overrides are applied only through declared manifest data, not implicit folder conventions or hardcoded `character_id` checks.
- Missing shared or override assets degrade to a safe fallback pose or expression path instead of causing runtime breakage.
- Looping, timing, and blend expectations from the authored semantic asset behave consistently in the viewer.
- The viewer can consume backend-authored semantic animation events without needing raw Unity clip structure.
- Character swaps preserve high-level animation meaning such as `idle`, `listen`, `speak`, and `emote` even when underlying assets differ.
- Generated or staged assets do not bypass promotion gates and become invisible runtime dependencies.

Until those proofs exist, the repository should treat the current animation DSL path as an asset-staging and design workflow, not a finished runtime pipeline.

## Recommended Near-Term Follow-Up

- keep using raw `.anim` files plus safe sidecars as the provenance front half of the pipeline
- lock a promoted DSL schema that is distinct from staged provenance metadata
- define the offline retargeting and normalization tool contract
- add validation coverage for promotion gates and safe fallback behavior
- prove semantic playback in the web viewer across the existing test characters before expanding the animation vocabulary