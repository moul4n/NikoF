# Character Override Animations

Store approved character-specific animation assets under `assets/animations/overrides/{character_id}/`.

- Keep one subdirectory per `character_id`.
- Only place assets here that intentionally replace or extend a shared semantic animation id.
- Every override used at runtime must be declared from that character package's `overrides/animations.json`.