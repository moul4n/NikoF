# Animation Viewer Strategy

Updated: 2026-05-21

## Decision

The web viewer in `frontend/` is now the system-of-record runtime for animation playback.

That viewer has already proven the core contract boundary:

- backend-owned semantic animation selection
- frontend-owned playback execution
- multiple frontend playback adapters behind one semantic surface

Unity remains an offline authoring and export tool. It is not the active runtime target.

## Current Stable Runtime Strategy

The current runtime split is:

- backend emits semantic ids only
- frontend resolves approved runtime metadata for those ids
- frontend chooses the playback adapter locally

Current stable routes:

- `idle.neutral` -> official Mixamo FBX playback path
- `idle.default` -> VRMA playback
- `listen.loop` -> VRMA playback
- `speak.loop` -> VRMA playback

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
- playback adapter selection
- local debug instrumentation

That separation is already proving useful: `idle.neutral` moved to the official adapter while the backend contract stayed stable.

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