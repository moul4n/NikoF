# Raw FBX Inbox

Drop new animation FBX files here when they still need semantic naming, review, and import processing.

Use this folder for:

- new bulk FBX drops that are not approved provenance yet
- alternate takes that might map to new semantic ids
- source files that still need clipping, staging, or promotion

Do not use this folder for:

- the currently approved default idle source in `assets/animations/raw/IdleNeutral.fbx`
- promoted runtime inventory under `assets/animations/library/shared/`
- generated runtime payloads under `assets/animations/generated/`

Recommended filename pattern:

- `{semantic_id}__{source-or-variant}.fbx`
- examples: `idle.relaxed__mixamo.fbx`, `listen.attentive__take2.fbx`, `emote.wave.once__mixamo.fbx`

Semantic naming guidelines:

- use stable AI-facing semantic ids such as `idle.relaxed`, `idle.excited`, `listen.attentive`, `think.considering`, `speak.explain`, or `emote.wave.once`
- prefer behavior names over source pack names
- keep one semantic id per intended runtime behavior, even if the source filename changes later

Handoff notes for future processing:

- tell the importer which files should become shared semantics and which are character-specific overrides
- note whether a clip should loop or play once
- note whether the clip is intended for idle, listen, speak, think, or emote behavior
- facial expressions are layered separately from body motion, so FBX clips should be treated as body animation unless the pipeline is explicitly extended

Current baseline reference:

- the load-time fallback idle currently resolves to `idle.neutral`
- its raw source asset lives at `assets/animations/raw/IdleNeutral.fbx`

Processing path after drop:

1. choose the final semantic id
2. export the staged sidecar to `assets/animations/dsl/shared/{semantic_id}.json`
3. generate the runtime candidate under `assets/animations/generated/shared/{semantic_id}/`
4. review and promote the approved asset intentionally