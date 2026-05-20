# Character Packages

Character imports are manifest-backed package folders under `assets/characters/`. Each package keeps the runtime VRM at `model.vrm`, plus the sidecar JSON files the frontend and backend already expect.

The original three test packages still exist as stable fixture slots:

- `assets/characters/test-vrm-01/model.vrm`
- `assets/characters/test-vrm-02/model.vrm`
- `assets/characters/test-vrm-03/model.vrm`

Additional optional characters should follow the same package contract in their own folder, as with `assets/characters/maria/`.

## Package Root Readiness

Each test package root is the direct drop location for one real UniVRM 1.0 file:

- `assets/characters/test-vrm-01/` expects `model.vrm`
- `assets/characters/test-vrm-02/` expects `model.vrm`
- `assets/characters/test-vrm-03/` expects `model.vrm`

Do not add nested `models/` folders or rename the incoming asset file. The manifest contract already points to `model.vrm`, so imports should replace the missing file at that exact relative path.

## Future VRM Import Workflow

Use this workflow for every new VRM import, whether it replaces a scaffolded test slot or adds a new optional character package.

1. Create or choose a package folder under `assets/characters/{character_id}/`.
2. Place the source VRM in that package root as `model.vrm`.
3. Add or update the required sidecars: `manifest.json`, `metadata/identity.json`, `expressions/mapping.json`, `voice/profile.json`, and `overrides/animations.json`.
4. If the character should be selectable in the frontend control surface, register the package in `frontend/src/avatar/loaders/characterCatalog.ts`.
5. Generate Unity `.meta` files in batch mode so the package is editor-ready without opening the Unity UI manually.

### Batch-Mode Unity Metadata Generation

Use the batch importer after creating or updating a character package:

```powershell
Set-Location C:\Users\fletc\Sources\NikoF
.\scripts\asset_validation\Invoke-UnityCharacterMetaImport.ps1 -AssetRelativePath 'assets/characters/{character_id}'
```

Notes:

- The wrapper auto-discovers a local Unity editor under `C:\Program Files\Unity\Hub\Editor\` unless `-UnityEditorPath` is provided.
- The Unity entrypoint lives in `assets/Editor/CharacterMetaGenerator.cs`.
- The script verifies that the expected `.meta` files were generated for the package folder and its contents.
- Logs are written to `.local/unity-meta-import/`.

### Optional Character Checklist

When importing a new optional character rather than replacing an existing scaffolded slot:

1. Use a stable folder name that will become the package `character_id`.
2. Keep the package non-default by appending it after the current default entries in `frontend/src/avatar/loaders/characterCatalog.ts`.
3. Normalize vendor VRM filenames back to `model.vrm` and record the original filename in `metadata/identity.json` when needed.
4. Treat missing embedded identity data as a packaging problem; solve it in the manifest and identity sidecar, not with runtime special cases.

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