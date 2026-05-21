# Animation DSL Workflow

This document describes the current repository-backed workflow from raw source assets to stable semantic playback.

The pipeline is no longer just a design sketch. The current repo already supports:

- tracked raw source provenance under `assets/animations/raw/`
- staged source sidecars under `assets/animations/dsl/shared/`
- generated runtime payloads under `assets/animations/generated/shared/`
- generated semantic asset candidates under `assets/animations/dsl/generated/shared/`
- promoted semantic assets under `assets/animations/dsl/shared/*.asset.json`
- backend semantic resolution plus frontend playback

## Current Stable Behavior

Today the runtime behaves like this:

1. The backend resolves a semantic id from session state.
2. The frontend canonicalizes any legacy alias still seen in snapshots.
3. The frontend looks up approved runtime metadata for that semantic id.
4. The frontend chooses the playback route from that metadata.
5. The display dev tools auto-populate their animation dropdown from generated shared runtime payloads.

Current stable examples:

- `idle.neutral` is the default fallback semantic id and uses the official Mixamo FBX playback route.
- `idle.default`, `listen.loop`, and `speak.loop` currently play through promoted VRMA inventory.
- `gesture.punch.once` remains a useful generated/runtime validation slice.

## Workflow

The practical workflow is:

`raw source -> staged sidecar -> generated runtime candidate -> semantic review -> promoted asset -> viewer proof -> stable runtime use`

### 1. Add Raw Source Provenance

- Place the source asset under `assets/animations/raw/`.
- Raw inputs may be Unity `.anim` files or raw FBX imports such as Mixamo source clips.
- Keep the source tracked while it remains part of the approved provenance chain.

Expected result:

- the original source is reproducible
- the export path can be rerun deterministically

### 2. Refresh The Staged Sidecar

- Export or refresh `assets/animations/dsl/shared/{semantic_id}.json`.
- Update `assets/animations/dsl/shared/animations.json` so the semantic id remains registered.

The staged sidecar records provenance and source timing. It is not the final runtime contract.

### 3. Generate Runtime Candidates

- Run the Unity batch export path for the source asset.
- Write generated runtime output to `assets/animations/generated/shared/{semantic_id}/{semantic_id}.runtime.json`.
- Write the paired semantic candidate to `assets/animations/dsl/generated/shared/{semantic_id}.json`.

Expected result:

- the repo gains a viewer-safe generated payload
- the repo gains a reviewable semantic candidate
- nothing is promoted yet

### 4. Review Semantics

- Confirm the semantic id reflects intent, not source filename.
- Confirm whether the animation belongs in the shared set or should stay character-specific.
- Record any runtime requirements such as loop mode, duration, body scope, root motion expectations, and fallback behavior.

### 5. Promote The Semantic Asset

- Write or update `assets/animations/dsl/shared/{semantic_id}.asset.json`.
- Point it at approved inventory under `assets/animations/library/shared/` when applicable.
- Declare `base.source_asset` when the playback contract depends on a raw source asset, as `idle.neutral` does today.

Promotion means the semantic contract is approved. It does not mean every playback route must use the same runtime adapter.

### 6. Prove Playback In The Viewer

Use the web viewer as the runtime proof surface.

Current dev display controls:

- `Switch to default backend`: return to backend-driven semantic playback.
- `Hold neutral stance`: clear base playback and hold the normalized standing pose.
- Generated animation dropdown: populated from every discovered file under `assets/animations/generated/shared/*/*.runtime.json`.

Viewer proof should confirm:

- the semantic id resolves correctly
- the chosen playback route is correct
- loop or once behavior matches the asset contract
- missing or offline conditions return to safe fallback behavior

### 7. Keep Generated And Promoted Surfaces Separate

- `generated/` and `dsl/generated/` are candidate surfaces
- `library/shared/` and `dsl/shared/*.asset.json` are approved surfaces

Do not leave production behavior depending on a generated artifact that was never promoted intentionally.

## Current Repo Layout By Responsibility

### `assets/animations/raw/`

Tracked provenance inputs. Not a backend contract surface.

### `assets/animations/dsl/shared/`

Staged source sidecars plus promoted semantic assets.

### `assets/animations/dsl/generated/shared/`

Generated semantic candidates before promotion.

### `assets/animations/generated/shared/`

Generated runtime payloads used for review, validation, and dev-surface discovery.

### `assets/animations/library/shared/`

Approved shared runtime inventory.

### `assets/animations/overrides/{character_id}/`

Approved character-specific runtime inventory when a shared semantic requires a declared replacement.

## Offline Tooling Versus Runtime Responsibilities

Offline tooling owns:

- source import and provenance
- Unity batch export
- normalization and review artifacts
- promotion-ready semantic asset authoring

Backend runtime owns:

- semantic resolution order
- fallback policy
- session animation snapshots and live delivery

Frontend runtime owns:

- semantic alias canonicalization
- runtime asset lookup
- playback adapter selection
- local playback execution and debug inspection

## Practical Validation Loop

For new or changed assets, the normal loop is:

1. regenerate or refresh the runtime candidate
2. verify the generated payload appears in the display dropdown
3. confirm playback route and pose in `/display`
4. update the promoted semantic asset only after that proof passes

That keeps the semantic contract stable while still allowing the frontend playback route to evolve.
