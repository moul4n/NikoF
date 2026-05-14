# Character Packages

Drop the three current test VRMs into these exact package roots:

- `assets/characters/test-vrm-01/model.vrm`
- `assets/characters/test-vrm-02/model.vrm`
- `assets/characters/test-vrm-03/model.vrm`

Each package already has scaffold metadata so frontend, backend, and test work can proceed even if the source VRM does not expose a usable name or identifier yet.

## Package Root Readiness

Each test package root is the direct drop location for one real UniVRM 1.0 file:

- `assets/characters/test-vrm-01/` expects `model.vrm`
- `assets/characters/test-vrm-02/` expects `model.vrm`
- `assets/characters/test-vrm-03/` expects `model.vrm`

Do not add nested `models/` folders or rename the incoming asset file. The manifest contract already points to `model.vrm`, so imports should replace the missing file at that exact relative path.

## Asset Intake Checklist

Use this checklist each time a real character package is imported:

1. Review the source VRM identity metadata before changing any scaffolded names or ids.
2. Drop the source file into the package root as `model.vrm`.
3. Update `manifest.json` only if the reviewed asset metadata changes `display_name`, versioning, or other declared package facts.
4. Confirm `metadata/identity.json` matches the reviewed asset identity and keep `identity_source` truthful.
5. Review `expressions/mapping.json` for coverage of the required semantic states and revise mappings where the source avatar differs.
6. Confirm `voice/profile.json` still matches the intended character voice defaults.
7. Declare character-specific animation behavior in `overrides/animations.json`; do not rely on undocumented custom clips.
8. Keep overrides declarative: shared animation ids stay shared unless the package explicitly opts into a replacement.

## Related Animation Roots

- Approved shared clips live under `assets/animations/library/shared/`.
- Generated or experimental motion lives under `assets/animations/generated/` until promotion.
- Character-specific approved clips live under `assets/animations/overrides/{character_id}/` and must be declared from that character package's `overrides/animations.json`.