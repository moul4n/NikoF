# Animation DSL Schema

This note defines the target promoted DSL shape for semantic animation assets.

It stays aligned with the current repo state:

- `assets/animations/dsl/shared/*.json` is still a staged provenance layer derived from raw Unity `.anim` clips.
- The staged export is not the final runtime DSL.
- The promoted DSL should be semantic, viewer-safe, and suitable for backend resolution plus frontend playback.
- The schema should leave room for later speech and expression layering without carrying Unity scene details into runtime.

## Goal

The repository should aim at a two-layer model:

1. Staged source metadata: safe sidecars exported from raw Unity `.anim` files for provenance and review.
2. Promoted semantic assets: runtime-facing DSL entries that describe what the animation means and how it should play after offline normalization and review.

The runtime-facing asset is the contract the backend animation service should resolve. It should not require the frontend to understand Unity clip internals, scene bindings, or authoring-time rig details.

## Promotion Path

The intended path remains:

`raw .anim -> staged Unity metadata sidecar -> semantic review -> normalization/retargeting -> promoted semantic DSL asset -> backend resolution -> frontend playback`

Interpretation of each stage:

- `assets/animations/raw/*.anim` remains source material only.
- `assets/animations/dsl/shared/{semantic_id}.json` remains the tracked staged sidecar exported by `export_unity_anim_metadata.py`.
- `assets/animations/dsl/generated/shared/{semantic_id}.json` may hold generated semantic asset candidates that are runtime-facing but not yet promoted.
- `assets/animations/dsl/templates/` may hold examples and authoring templates for the promoted shape.
- `assets/animations/library/shared/` and approved override locations hold the binary or runtime-loadable animation payloads referenced by the promoted DSL.
- The promoted DSL is the bridge between offline asset prep and runtime command emission.

## Target Promoted Asset Shape

The final DSL should be practical and minimal. One promoted semantic animation asset should look like this:

```json
{
  "dsl_version": "1.0.0",
  "kind": "semantic_animation_asset",
  "semantic_id": "idle.default",
  "scope": "shared",
  "base": {
    "clip_ref": {
      "path": "assets/animations/library/shared/idle.default/idle.default.vrma"
    },
    "playback": "loop",
    "body_scope": "full_body",
    "root_motion": "in_place",
    "timing": {
      "duration_ms": 8333,
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
    "semantic_id": "idle.default"
  }
}
```

## Candidate Asset Shape Before Promotion

The first Unity batch export pipeline may emit a close-to-final semantic asset candidate before viewer validation is complete. That file should remain clearly marked as unpromoted and should point at a generated runtime payload instead of approved shared inventory.

Example candidate shape:

```json
{
  "dsl_version": "1.0.0",
  "kind": "semantic_animation_asset_candidate",
  "stage": "generated_candidate",
  "promotion_status": "not_promoted",
  "semantic_id": "idle.default",
  "scope": "shared",
  "base": {
    "clip_ref": {
      "path": "assets/animations/generated/shared/idle.default/idle.default.runtime.json"
    },
    "playback": "loop",
    "body_scope": "full_body",
    "root_motion": "in_place",
    "timing": {
      "duration_ms": 8333,
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
    "semantic_id": "idle.default"
  }
}
```

This candidate shape exists to keep the pipeline useful without pretending the asset is fully promoted. The final promoted DSL should still use `kind: semantic_animation_asset` and should reference approved shared inventory under `assets/animations/library/shared/`.

## Field Definitions

### Top-Level Fields

- `dsl_version`: schema version for the promoted runtime-facing asset.
- `kind`: fixed discriminator for tooling and validation. Use `semantic_animation_asset`.
- `semantic_id`: stable semantic name used by backend intent and frontend commands.
- `scope`: `shared` for library assets or `override` for approved character-specific replacements.

### `base`

The `base` object defines the primary motion used when the asset is resolved.

- `clip_ref.path`: repo-relative path to the approved runtime payload. This should point at promoted inventory, not raw Unity source.
- `playback`: `loop` or `once`, matching the frontend playback contract.
- `body_scope`: minimal classification such as `full_body`, `upper_body`, or `face_only`.
- `root_motion`: whether the runtime should treat the motion as `in_place` or `driven`.
- `timing.duration_ms`: normalized duration used for scheduling and fallback logic.
- `timing.fade_in_ms` and `timing.fade_out_ms`: viewer-safe transition hints.
- `retarget_profile`: named offline normalization contract, not a Unity avatar binding.

### `layers`

`layers` reserves room for later additive behavior without making today’s base assets depend on it.

- `layers.speech.supported`: whether the asset expects an additional speech-driven body or mouth layer.
- `layers.expression.supported`: whether the asset expects an additional expression layer.

If layering becomes active later, those sections can expand with additive clip refs or policy flags. The base shape does not need to change.

### `fallback`

- `fallback.semantic_id`: semantic fallback if the requested asset cannot be resolved after shared-library and override lookup.

This keeps fallback semantic rather than file-path-driven.

## What Does Not Belong In The Final DSL

The promoted runtime-facing asset should not embed:

- Unity scene object names
- Unity curve payloads
- Animator controller state names
- Mecanim state machine details
- per-scene hierarchy bindings
- raw `.anim` file contents
- authoring-only review state such as `approved_for_shared_library`

Those are either offline authoring concerns or source-provenance data. They can exist in staged artifacts or adjacent documentation, but not in the runtime-facing semantic asset.

## Alignment With Current Frontend Contract

The current frontend animation command shape already expects:

- a semantic id
- a source classification
- a playback mode
- optional duration or intensity hints

That means the promoted DSL should remain a backend-owned asset contract that resolves into `SemanticAnimationCommand` values rather than becoming a frontend-only schema. In practical terms:

- `semantic_id` maps directly to command `id`
- `base.playback` maps directly to command `playback`
- resolved library or override origin determines command `source`
- `base.timing.duration_ms` may populate command `durationMs` when useful

## Raw Export To Final DSL Mapping

The current exporter writes staged sidecars shaped like `assets/animations/dsl/shared/idle.default.json`. Those fields map into the promoted DSL as follows.

| Staged export field | Meaning today | Final DSL target | Notes |
| --- | --- | --- | --- |
| `semantic_id` | Candidate semantic name | `semantic_id` | Carries forward unchanged once approved. |
| `stage` | Staging lifecycle marker | Not stored in promoted runtime asset | Promotion state belongs to workflow, not runtime playback. |
| `approved_for_shared_library` | Review flag | Not stored in promoted runtime asset | Approval is implied by promotion into approved inventory. |
| `promotion_status` | Review flag | Not stored in promoted runtime asset | Same reason as above. |
| `source.kind` | Provenance type | Not stored in promoted runtime asset | Keep in staged sidecar or adjacent provenance data only. |
| `source.path` | Raw `.anim` provenance path | Not stored in promoted runtime asset | Useful for audit and re-export, not runtime. |
| `source.provenance` | Provenance label | Not stored in promoted runtime asset | Audit-only metadata. |
| `unity_clip.name` | Unity-authored clip label | Optional authoring note only | Do not make runtime depend on Unity naming. |
| `unity_clip.sample_rate` | Unity timeline sample rate | Used offline during normalization | Not required in the promoted runtime asset. |
| `unity_clip.start_time` | Source clip start | Used to derive `base.timing.duration_ms` | Usually combine with stop time during authoring. |
| `unity_clip.stop_time` | Source clip stop | Used to derive `base.timing.duration_ms` | `duration_ms = (stop_time - start_time) * 1000`. |
| `unity_clip.loop_time` | Unity loop hint | `base.playback` | Treat values greater than `0` as a candidate `loop`; final decision still requires review. |

## Authored Fields That Cannot Come From Raw Export Alone

Several promoted DSL fields must be authored or validated after export instead of inferred automatically:

- `base.clip_ref.path`
- `base.body_scope`
- `base.root_motion`
- `base.timing.fade_in_ms`
- `base.timing.fade_out_ms`
- `base.retarget_profile`
- `layers.*`
- `fallback.semantic_id`

These depend on retargeting, runtime testing, and semantic review. They should not be fabricated from the Unity metadata sidecar.

## Recommended Minimal Authoring Rules

- Promote only after the runtime-loadable clip exists under approved shared or override inventory.
- Keep `semantic_id` stable across characters; use overrides rather than changing semantics.
- Require `base.playback`, `base.clip_ref.path`, and `base.timing.duration_ms` on every promoted asset.
- Keep `layers` explicit, even when unsupported, so future extension stays predictable.
- Keep provenance in the staged sidecar and treat the promoted asset as the runtime contract.

## Example Asset

See `assets/animations/dsl/templates/semantic-animation.asset.example.json` for a concrete promoted asset example that follows this target shape.