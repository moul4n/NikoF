# Animation Viewer Strategy

Updated: 2026-05-15

## Decision

The current implementation path stays on the existing web viewer stack in `frontend/`: React + TypeScript for the shell, with the current three.js + three-vrm avatar viewer path as the first renderer to prove out.

Unity is a valid later alternate renderer, but it is not current implementation work. The repo should not split active viewer development across web and Unity until one renderer proves the core animation contract end to end.

## What We Need To Prove First

The next proof target is narrow and practical:

1. Load the current VRM character through the existing web viewer path.
2. Play base animation from backend-confirmed, semantic animation ids rather than clip paths.
3. Layer speech-driven mouth or expression state on top of that base animation in the web viewer.
4. Keep character overrides, safe fallback behavior, and runtime state owned by the existing manifest and backend contract boundaries.

This aligns with the current architecture and workstreams:

- `docs/ARCHITECTURE.md` already defines the frontend avatar runtime as the host for viewer playback and keeps backend animation output engine-neutral.
- `docs/WORKSTREAMS.md` already places animation playback, override resolution, and fallback handling in the frontend and backend stages that have not landed yet.
- `docs/PROGRESS_REPORT.md` explicitly says the current speech seam is a contract and runtime-proof slice, not a full live pipeline.
- `docs/NEXT_STEPS.md` still prioritizes real adapter execution, event persistence, and live delivery before broader avatar integration.

## Why Web First

The repo already has an active frontend shell, control and display entrypoints, backend-owned session envelopes, and a planned live delivery path. The missing work is not "pick a renderer" in the abstract; it is proving that one renderer can consume the intended backend semantics without engine-specific leakage.

Doing that first in the current web viewer is the lowest-risk path because it:

- extends the stack already under active implementation instead of opening a second client runtime;
- exercises the actual contract we need anyway: semantic animation ids, speech timing or expression signals, override resolution, and fallback behavior;
- keeps current work aligned with Switch, Tank, Link, and Mouse stage sequencing instead of creating a parallel Unity branch before the shared semantics settle.

## Backend Contract Rule

Backend animation semantics and transport must stay engine-neutral.

That means the backend should emit canonical animation intent and speech lifecycle data such as:

- semantic animation ids;
- ordered session or `speech.lifecycle` events;
- timing or expression metadata needed for speech-aligned playback;
- backend-confirmed character and fallback outcomes.

That also means the backend should not emit Unity scene commands, animator-controller assumptions, GameObject names, or three.js-specific scene instructions. `assets/animations/raw/` may continue to hold Unity `.anim` source assets for provenance, but the approved runtime contract remains semantic and renderer-agnostic. The approved shared runtime inventory still lives under `assets/animations/library/shared/`, with staged provenance in the DSL and raw import roots.

## Why Unity Over WebSockets Is Valid Later

A future Unity viewer over WebSockets is a valid later option because the architecture already expects live delivery on top of canonical backend-owned envelopes. If the backend keeps animation and speech payloads engine-neutral, a Unity client can later subscribe to the same ordered event stream and map those semantics into a Unity-side renderer.

That future split is valid only after the semantics are proven. WebSockets are a transport choice, not a reason to fork renderer work early. Right now the repo still needs to prove the payload meaning, layering rules, and fallback behavior more than it needs a second rendering client.

## Why Unity Is Not The Current Work

Starting Unity now would multiply moving parts before the core viewer contract is stable:

- the repo does not yet have the full live speech and animation pipeline implemented;
- timing metadata for speech-aligned avatar playback is still an explicit work item;
- semantic animation resolution and fallback behavior are still staged work, not completed behavior;
- a Unity client now would force duplicate viewer integration, duplicate validation, and duplicate debugging while the shared contract is still settling.

That is the wrong sequence for this repo. First prove one renderer. Then consider a second renderer if it solves a real problem the web viewer cannot.

## Gating Criteria For A Unity Split

A separate Unity viewer becomes justified only when most or all of the following are true:

1. The web viewer has already proven base animation plus layered speech or expression playback against the canonical backend contract.
2. Semantic animation ids, override resolution, and safe fallback behavior are implemented and covered by regression tests.
3. Live delivery is in place using the existing backend-owned envelope shape, with no engine-specific payload fork.
4. Speech timing or equivalent metadata for avatar alignment is published and stable enough that a second renderer would consume it rather than redefine it.
5. There is a concrete renderer-driven requirement the web viewer cannot meet well enough, such as a measured performance limit, a platform-specific integration need, or a Unity-only rendering capability that matters to the product.
6. The team is willing to pay for a second client surface in tests, diagnostics, release flow, and contract validation.

If those gates are not met, Unity remains backlog or spike work, not the implementation path.

## Immediate Direction

Stay on the current web viewer first. Prove base animation and layered speech or expression behavior there. Keep backend animation semantics and transport renderer-neutral so Unity can be added later as an alternate client without rewriting the backend contract.