# Animation Storage

Use these roots consistently:

- `assets/animations/raw/` for tracked provenance inputs such as Unity `.anim` clips and raw Mixamo FBX files.
- `assets/animations/dsl/shared/` for staged provenance sidecars and promoted semantic asset declarations.
- `assets/animations/dsl/shared/animations.json` for the tracked registry of staged shared semantic ids.
- `assets/animations/dsl/generated/shared/` for generated semantic asset candidates before promotion.
- `assets/animations/generated/shared/` for generated runtime payloads used for review and dev-surface discovery.
- `assets/animations/library/shared/` for approved shared runtime inventory.
- `assets/animations/overrides/{character_id}/` for approved character-specific runtime inventory.
- `assets/animations/retargeting/` for reusable retargeting profiles and mappings.

Current stable inventory pattern:

- `idle.neutral` is the default fallback semantic id and currently uses the official Mixamo FBX playback route.
- `idle.default`, `listen.loop`, and `speak.loop` are promoted shared VRMA assets.
- generated runtime payloads remain review and validation surfaces until they are promoted intentionally.

Validation rule:

- only `assets/animations/library/shared/` counts as approved shared runtime inventory
- `generated/` and `dsl/generated/` remain candidate surfaces
- staged sidecars under `dsl/shared/` remain provenance and semantic registration surfaces unless they are the promoted `*.asset.json` files

Practical flow:

1. add or update the raw source asset under `assets/animations/raw/`
2. refresh the staged sidecar under `assets/animations/dsl/shared/{semantic_id}.json`
3. generate `assets/animations/generated/shared/{semantic_id}/{semantic_id}.runtime.json`
4. review the generated semantic candidate under `assets/animations/dsl/generated/shared/{semantic_id}.json`
5. promote approved runtime inventory and semantic asset declarations intentionally

The display dev tools discover generated shared runtime payloads automatically, so new generated shared clips appear in the local animation dropdown without a hardcoded import list.
