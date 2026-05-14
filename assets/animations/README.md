# Animation Storage

Use these roots consistently:

- `assets/animations/library/shared/` for approved semantic animation clips shared across characters.
- `assets/animations/generated/shared/` for AI-authored or procedural motion that may later be promoted into the shared library.
- `assets/animations/generated/characters/{character_id}/` for generated motion that is exploratory or character-specific.
- `assets/animations/overrides/{character_id}/` for approved custom assets that a character manifest explicitly overrides.
- `assets/animations/dsl/` for semantic animation definitions and presets.
- `assets/animations/retargeting/` for reusable retargeting profiles or mappings.

Validation rule:

- Contract validation treats only `assets/animations/library/shared/` as approved shared-library inventory.
- Files under `assets/animations/generated/` stay staged until review, semantic-id assignment, and promotion into `assets/animations/library/shared/`.