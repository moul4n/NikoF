# Raw Animation Imports

`assets/animations/raw/` is the tracked import and provenance location for Unity `.anim` clips and other source payloads.

- Keep raw source files in git for now so the team retains the original import payloads and export provenance.
- Treat these files as source assets, not runtime-resolved assets.
- Export safe metadata into tracked JSON sidecars under `assets/animations/dsl/shared/`.
- Register staged semantic ids in `assets/animations/dsl/shared/animations.json`.
- Promote only reviewed shared-library assets into `assets/animations/library/shared/`.

Quick comparison:

- Raw source files capture the original Unity clip payload.
- Exported JSON sidecars capture safe metadata derived from that payload.
- The shared animations registry records semantic ids and sidecar locations, not runtime clip approval.
