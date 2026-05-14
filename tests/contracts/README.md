# Contract Validation

This slice keeps asset and event-contract checks runnable before frontend, backend, or provider integrations exist.

Run the validator locally from the repo root:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\asset_validation\validate-contracts.ps1
```

What it checks now:

- the scaffold manifest shape for `test-vrm-01`, `test-vrm-02`, and `test-vrm-03`
- fallback identity scaffold presence when source VRM metadata is incomplete
- referenced JSON sidecars such as voice profiles, expression maps, and animation override declarations
- local fixture payloads for character manifest summaries, animation events, and session events

Validation boundary for animation assets:

- `assets/animations/library/shared/` is treated as the approved shared-animation root
- `assets/animations/generated/shared/` and `assets/animations/generated/characters/{character_id}/` stay staged and are never treated as approved shared-library assets during validation
- generated motion only becomes part of the approved contract after review, semantic-id assignment, and promotion into `assets/animations/library/shared/`
- character-specific generated motion must still be referenced through the owning character's override manifest before runtime code can treat it as usable

Current scope intentionally stops short of provider integrations, VRM import/runtime checks, and retargeting validation.