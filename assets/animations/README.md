# Animation Storage

Use these roots consistently:

- `assets/animations/library/shared/` for approved semantic animation clips shared across characters.
- `assets/animations/generated/shared/` for AI-authored or procedural motion that may later be promoted into the shared library.
- `assets/animations/generated/characters/{character_id}/` for generated motion that is exploratory or character-specific.
- `assets/animations/overrides/{character_id}/` for approved custom assets that a character manifest explicitly overrides.
- `assets/animations/dsl/` for semantic animation definitions and presets.
- `assets/animations/dsl/shared/` for staged semantic sidecars derived from raw source clips before library promotion.
- `assets/animations/dsl/shared/animations.json` for the tracked registry of shared DSL sidecars keyed by semantic id.
- `assets/animations/raw/` for tracked Unity `.anim` clips and other source payloads kept in git for provenance and repeatable export work, not for runtime resolution.
- `assets/animations/retargeting/` for reusable retargeting profiles or mappings.

Validation rule:

- Contract validation treats only `assets/animations/library/shared/` as approved shared-library inventory.
- Files under `assets/animations/generated/` stay staged until review, semantic-id assignment, and promotion into `assets/animations/library/shared/`.
- Files under `assets/animations/dsl/shared/` may describe raw source provenance and candidate semantic ids, but they are not promoted runtime library assets.

Import, staging, and registration flow:

1. Add or update the raw source clip under `assets/animations/raw/` and keep it in git while the team still needs source provenance.
2. Run `scripts/animation_tools/export_unity_anim_metadata.py` to extract safe Unity metadata into `assets/animations/dsl/shared/{semantic_id}.json`.
3. Register that staged sidecar in `assets/animations/dsl/shared/animations.json` so the semantic id is represented in repo-owned metadata.
4. Promote only reviewed assets into `assets/animations/library/shared/`; staged DSL sidecars remain provenance records, not approved runtime clips.

Comparison of the tracked layers:

- Raw source: `assets/animations/raw/*.anim` remains the import and provenance asset kept in git for now.
- Exported JSON: `assets/animations/dsl/shared/{semantic_id}.json` is the safe, tracked metadata export derived from the raw source.
- Semantic registration: `assets/animations/dsl/shared/animations.json` records which semantic ids exist in the staged shared set.
