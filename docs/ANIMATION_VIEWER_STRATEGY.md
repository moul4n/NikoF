# Animation Viewer Strategy

Updated: 2026-06-10

## Decision

The web viewer in `frontend/` is now the system-of-record runtime for animation playback.

That viewer has already proven the core contract boundary:

- backend-owned semantic animation selection
- frontend-owned playback execution
- one official playback core behind the semantic surface

Unity remains an offline authoring and export tool. It is not the active runtime target.

## Current Stable Runtime Strategy

The current runtime split is:

- backend emits semantic ids only
- frontend resolves approved runtime metadata for those ids
- frontend plays everything through one official playback core (`frontend/src/avatar/runtime/animationPlayback.ts`)

The single core feeds one `THREE.AnimationMixer` from two official loaders:

1. `.vrma` assets via `@pixiv/three-vrm-animation` (`createVRMAnimationClip`) — preferred whenever a
   character-specific or shared `.vrma` exists for the semantic id under `assets/animations/library/`.
2. Mixamo `.fbx` sources via the official three-vrm retarget path (hips position scaled to the VRM
   rest pose; only humanoid bone rotations plus the hips track animate, so the avatar root stays
   anchored in world space and the character does not drift).

Resolution order per semantic id: character `.vrma` → shared `.vrma` → payload `.fbx` source →
declared source fallback (`idle.default`, `listen.loop`, `speak.loop` resolve through `idle.neutral`
until dedicated `.vrma` exports exist). There is no legacy mixer/quaternion-keyframe path anymore;
an unplayable semantic surfaces an error instead of silently degrading.

This is the correct shape for the project because it lets the playback core change without widening the backend contract.

## Why This Strategy Holds

The viewer now needs to support more than one realization path without fragmenting semantics.

That means the backend should keep owning:

- semantic ids
- session-state selection
- fallback behavior
- live snapshot ordering

And the frontend should keep owning:

- asset lookup
- retargeting
- playback execution
- local debug instrumentation

That separation is already proving useful: the playback core consolidated from three adapters down to one official VRMA/Mixamo bridge while the backend contract stayed stable.

## What Unity Is For Now

Unity is still valuable, but in the offline pipeline only:

- batch export
- normalization
- provenance refresh
- candidate runtime payload generation

It is not the viewer that operators or end users should depend on.

## Conditions For A Future Second Viewer

A second runtime client only makes sense if all of the following become true:

1. the current semantic contract is stable enough that another viewer can consume it unchanged
2. live delivery and playback acknowledgement semantics are mature enough to justify another client surface
3. there is a concrete runtime need the web viewer cannot satisfy well enough

Until then, runtime work should stay concentrated in the current frontend viewer.