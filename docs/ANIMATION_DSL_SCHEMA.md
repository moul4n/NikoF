# Animation DSL Schema

This document defines the current runtime-facing DSL shape for semantic animation assets.

The stable model is now:

1. staged provenance sidecars under `assets/animations/dsl/shared/`
2. generated runtime candidates under `assets/animations/generated/shared/` and `assets/animations/dsl/generated/shared/`
3. promoted semantic assets under `assets/animations/dsl/shared/*.asset.json`
4. approved runtime inventory under `assets/animations/library/shared/`

The backend resolves semantic ids. The frontend realizes those semantic ids through the promoted asset metadata and generated runtime payloads.

## Current Promotion Path

The practical path is now:

`raw source (.anim or .fbx) -> staged sidecar -> generated runtime candidate -> semantic review -> promoted semantic asset -> backend semantic resolution -> frontend playback`

Interpretation of each stage:

- `assets/animations/raw/` holds tracked provenance inputs, including Unity `.anim` clips and raw Mixamo FBX files.
- `assets/animations/dsl/shared/{semantic_id}.json` holds staged source metadata and semantic registration.
- `assets/animations/generated/shared/{semantic_id}/{semantic_id}.runtime.json` holds viewer-safe generated runtime payloads.
- `assets/animations/dsl/generated/shared/{semantic_id}.json` holds generated semantic asset candidates before promotion.
- `assets/animations/dsl/shared/{semantic_id}.asset.json` holds promoted semantic asset declarations.
- `assets/animations/library/shared/` holds approved shared runtime inventory such as promoted VRMA clips.

## Approved Playback Patterns

The promoted DSL supports more than one runtime realization pattern.

### Pattern 1: Promoted VRMA playback

Used for promoted library assets such as `idle.default`, `listen.loop`, and `speak.loop`.

- `base.clip_ref.path` points at the approved library VRMA.
- `base.runtime_adapter` is `vrma`.

### Pattern 2: Official Mixamo FBX playback

Used for `idle.neutral`.

- `base.runtime_adapter` is `official_mixamo_fbx`.
- `base.source_asset.path` points at the approved raw Mixamo FBX source.
- `base.clip_ref.path` may still point at the promoted library inventory entry so the asset stays normalized and promotion-aware.

That split is deliberate. The backend keeps resolving the same semantic id even though the frontend playback route differs.

## Target Promoted Asset Shape

Current promoted example for `idle.neutral`:

```json
{
  "dsl_version": "1.0.0",
  "kind": "semantic_animation_asset",
  "semantic_id": "idle.neutral",
  "scope": "shared",
  "base": {
    "clip_ref": {
      "path": "assets/animations/library/shared/idle.neutral.vrma"
    },
    "runtime_adapter": "official_mixamo_fbx",
    "source_asset": {
      "kind": "mixamo_fbx",
      "path": "assets/animations/raw/IdleNeutral.fbx"
    },
    "playback": "loop",
    "body_scope": "full_body",
    "root_motion": "in_place",
    "timing": {
      "duration_ms": 16633,
      "fade_in_ms": 200,
      "fade_out_ms": 200
    },
    "retarget_profile": "shared_humanoid_v1"
  },
  "layers": {
    "speech": {
      "supported": false
    },
    "expression": {
      "supported": false
    }
  },
  "fallback": {
    "semantic_id": "idle.neutral"
  }
}
```

## Generated Candidate Shape

Generated candidates remain explicitly unpromoted and point at generated runtime payloads.

Example current candidate for `idle.neutral`:

```json
{
  "dsl_version": "1.0.0",
  "kind": "semantic_animation_asset_candidate",
  "stage": "generated_candidate",
  "promotion_status": "not_promoted",
  "semantic_id": "idle.neutral",
  "scope": "shared",
  "base": {
    "clip_ref": {
      "path": "assets/animations/generated/shared/idle.neutral/idle.neutral.runtime.json"
    },
    "playback": "loop",
    "body_scope": "full_body",
    "root_motion": "in_place",
    "timing": {
      "duration_ms": 16633,
      "fade_in_ms": 200,
      "fade_out_ms": 200
    },
    "retarget_profile": "shared_humanoid_muscle_v1"
  },
  "layers": {
    "speech": {
      "supported": false
    },
    "expression": {
      "supported": false
    }
  },
  "fallback": {
    "semantic_id": "idle.neutral"
  }
}
```

Generated candidates are review artifacts. They are not the promoted library contract.

## Field Definitions

### Top-level fields

- `dsl_version`: version of the runtime-facing semantic asset.
- `kind`: `semantic_animation_asset` for promoted assets, `semantic_animation_asset_candidate` for generated candidates.
- `semantic_id`: stable semantic identity used by backend and frontend.
- `scope`: `shared` or `override`.

### `base`

`base` describes the primary playback contract.

- `clip_ref.path`: repo-relative reference to approved inventory or generated candidate payloads.
- `runtime_adapter`: playback path expected by the frontend runtime. Current approved values are `vrma`, `mixer`, and `official_mixamo_fbx`.
- `source_asset`: optional runtime-loadable source asset required by the playback adapter.
- `playback`: `loop` or `once`.
- `body_scope`: `full_body`, `upper_body`, or another approved semantic scope.
- `root_motion`: `in_place` or `driven`.
- `timing.duration_ms`: normalized duration.
- `timing.fade_in_ms` and `timing.fade_out_ms`: viewer-safe transition hints.
- `retarget_profile`: named offline normalization contract.

### `layers`

`layers` reserves space for future speech or expression stacking without changing the base contract.

- `layers.speech.supported`
- `layers.expression.supported`

### `fallback`

- `fallback.semantic_id`: semantic fallback if the requested asset cannot be resolved.

## What Does Not Belong In The Promoted DSL

The promoted semantic asset should not carry:

- Unity curve payloads
- raw `.anim` contents
- authoring-only review flags such as `promotion_status`
- scene hierarchy names
- Animator Controller or Playables details
- viewer-native mixer track names

Those remain staging or tooling concerns.

## Mapping From Staged Sidecars

The staged sidecar stays the provenance layer. It can originate from a raw `.anim` clip or a raw FBX import that Unity sampled during batch export.

Key mapping rules:

- staged `semantic_id` carries forward directly
- staged `source.path` stays provenance unless the promoted asset explicitly adopts it as `base.source_asset.path`
- staged clip timing informs `base.timing.duration_ms`
- staged loop hints inform `base.playback`, but promotion review still makes the final decision

## Frontend Alignment

The frontend runtime currently consumes this DSL through two linked mechanisms:

- promoted semantic assets define the approved playback contract
- generated runtime payloads under `assets/animations/generated/shared/*/*.runtime.json` are auto-discovered for the dev display catalog

That auto-discovery is why newly generated shared runtime payloads appear in the display dropdown without maintaining a hardcoded import list.

## Minimal Authoring Rules

- Keep `semantic_id` stable across playback-route changes.
- Promote only after the runtime payload and fallback behavior are viewer-proven.
- Require explicit `playback`, `timing.duration_ms`, and `fallback.semantic_id`.
- Use `source_asset` only when the playback contract truly depends on a runtime-loadable source asset, as `idle.neutral` does today.