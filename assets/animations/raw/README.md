# Raw Animation Imports

`assets/animations/raw/` is the tracked provenance root for source animation payloads.

Current source types include:

- Unity `.anim` clips
- raw FBX source clips such as Mixamo imports

Rules:

- keep raw sources in git while they are part of the approved provenance chain
- treat raw files as source assets, not backend transport values
- refresh staged sidecars under `assets/animations/dsl/shared/`
- register semantic ids in `assets/animations/dsl/shared/animations.json`
- promote runtime behavior through semantic assets and approved library inventory, not by pointing the backend at raw files

Quick comparison:

- raw files preserve provenance and re-exportability
- staged sidecars preserve reviewable source metadata
- generated runtime payloads are viewer-safe candidates
- promoted semantic assets define stable runtime meaning
