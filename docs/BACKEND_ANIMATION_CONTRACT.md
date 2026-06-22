# Backend Animation Contract

## Purpose

This document defines the current backend-owned animation contract for NikoF.

The contract is semantic and engine-neutral:

- the backend chooses semantic animation ids from session state and higher-level intent;
- the frontend chooses how to realize those semantics through approved runtime metadata;
- neither side leaks engine-native state machine details, mixer tracks, or raw asset paths into the public session contract.

## Current Stable State

The repository now uses this split:

- Backend: resolves semantic commands such as `idle.neutral`, `listen.loop`, and `speak.loop`.
- Frontend: realizes those commands through approved runtime metadata.
- Default fallback semantic id: `idle.neutral`.
- Current stable base playback route: `idle.neutral` uses the official Mixamo FBX playback adapter in the frontend.
- Current promoted shared library inventory: `idle.default`, `idle.neutral`, `listen.loop`, and `speak.loop`.
- Compatibility rule: the frontend still aliases legacy `idle1v3` commands to `idle.neutral` so older snapshots do not break playback.

The backend does not need to know whether the viewer uses VRMA, the official Mixamo FBX route, or another future engine-specific adapter.

## Design Rules

1. The backend emits semantic ids, not playback math.
2. The backend owns semantic selection and fallback policy.
3. Viewers own clip loading, retargeting, blending, and transport-specific smoothing.
4. Semantic ids remain stable even when the approved runtime asset or playback adapter changes.
5. Raw provenance remains in repo-owned asset metadata, not in backend transport payloads.

## Current Read Surface

The current backend-owned read surface is session animation snapshot delivery on `GET /session/animation`.

- Plain HTTP returns the current deterministic snapshot.
- `Accept: text/event-stream` reuses the same semantic snapshot shape through ordered live delivery.
- `PUT /session/lifecycle-state` updates the lifecycle state that drives the resolved session base animation.
- Assistant turns may also publish transient cue-driven snapshots into the same live-delivery stream when the LLM returns structured `animation_cues` metadata. These cue snapshots do not mutate the base lifecycle state; they give the frontend animation stack an ordered semantic command to layer on top of the current session state.

Current snapshot shape:

```json
{
  "schema_version": 1,
  "session_id": "session-scaffold-01",
  "lifecycle_state": "idle",
  "active_character_id": "test-vrm-01",
  "command": {
    "schema_version": 1,
    "command_id": "anim-cmd:session-animation:session-scaffold-01:test-vrm-01:idle",
    "intent_id": "session-animation:session-scaffold-01:test-vrm-01:idle",
    "session_id": "session-scaffold-01",
    "character_id": "test-vrm-01",
    "semantic_id": "idle.neutral",
    "resolved_state": "selected",
    "resolution": {
      "selected_source": "shared_library",
      "selected_asset_id": "idle.neutral",
      "fallback_applied": false
    },
    "playback": {
      "mode": "loop",
      "blend_hint": "base_full_body",
      "expected_duration_ms": 16633,
      "loop": true
    },
    "timing": {
      "mode": "immediate",
      "anchor": null,
      "anchor_event_id": null,
      "offset_ms": 0,
      "max_start_delay_ms": null
    },
    "policy": {
      "interruptible": true,
      "fallback_semantic_id": "idle.neutral",
      "drop_if_late": false,
      "on_interruption": "replace",
      "on_missing_resolution": "fallback"
    },
    "intensity": 1.0,
    "parameters": {
      "session_state": "idle"
    }
  }
}
```

## Semantic Resolution Rules

Current backend resolution order:

1. approved shared semantic animation
2. safe fallback semantic animation

Current lifecycle-state mapping:

- `idle` -> `idle.neutral`
- `listen` -> `listen.loop`
- `speak` -> `speak.loop`

The backend-selected `resolution.selected_asset_id` must stay backend-safe. It can be a semantic asset id or alias, but it must not be a raw path.

## Intent And Command Model

The backend distinguishes between semantic intent and resolved command.

Intent fields describe why a motion is needed:

- `intent_id`
- `session_id`
- `character_id`
- `intent_type`
- `semantic_id`
- `source`
- `priority`
- `requested_state`
- `timing`
- `policy`
- `parameters`

Resolved command fields describe the backend decision after applying resolution order:

- `command_id`
- `intent_id`
- `semantic_id`
- `resolved_state`
- `resolution.selected_source`
- `resolution.selected_asset_id`
- `resolution.fallback_applied`
- `playback.mode`
- `playback.blend_hint`
- `playback.expected_duration_ms`
- `playback.loop`

The command stays semantic. It does not expose whether the viewer will use VRMA, a generated mixer payload, or the official Mixamo FBX path.

## Timing And Policy

Scheduling fields stay advisory and viewer-safe:

- `timing.mode`
- `timing.anchor`
- `timing.anchor_event_id`
- `timing.offset_ms`
- `timing.max_start_delay_ms`

Policy fields stay explicit so viewers do not invent fallback behavior:

- `interruptible`
- `fallback_semantic_id`
- `drop_if_late`
- `on_interruption`
- `on_missing_resolution`

Current rule: idle and recovery behavior must use explicit fallback semantics such as `idle.neutral`, never viewer-local guesses.

## Live Delivery

Animation live delivery reuses the same backend-owned ordering discipline already established for speech:

- stable `event_id`
- increasing `sequence`
- opaque session-scoped `cursor`
- deterministic session ordering

The currently implemented live stream is still the session animation snapshot stream, not a separate engine-native playback feed. That is intentional. It keeps the backend surface semantic while the frontend remains free to improve local playback without changing transport meaning.

Current structured assistant lane:

- The shared turn executor accepts `assistant.animation_cues` from the structured LLM contract.
- The backend normalizes generic cue aliases such as `wave`, `happy`, `small_wave`, `wink`, or `subtle_wink` onto approved shared semantic ids.
- The first normalized cue is published as a transient `session.animation` snapshot through the existing live-delivery channel.
- The frontend remains responsible for deciding how that semantic command is blended with the current idle, listen, or speak state.

## Viewer Responsibilities

The current frontend runtime is responsible for:

- canonicalizing legacy `idle1v3` to `idle.neutral`
- resolving approved runtime metadata from repo-owned assets
- loading the correct playback adapter for a semantic id
- applying the official Mixamo FBX path for `idle.neutral`
- applying VRMA playback for promoted VRMA assets such as `idle.default`, `listen.loop`, and `speak.loop`
- exposing local dev controls without changing backend semantic authority

This split is why the backend contract must remain semantic even though the stable frontend now uses more than one playback adapter.

## What Must Not Leak Into The Backend Contract

The following are out of bounds for backend-facing payloads:

- raw files under `assets/animations/raw/`
- generated runtime payload paths under `assets/animations/generated/`
- promoted library paths under `assets/animations/library/`
- Unity `.anim` or FBX importer details
- Animator Controller state names
- Playables graph ids
- Three.js mixer track names
- VRM node paths
- local filesystem paths
- authoring-only export metadata

Those concerns belong in repo-owned asset metadata and offline tooling, not in backend session transport.

## Multi-Viewer Invariants

These rules must continue to hold for both the current web viewer and any future alternate viewer:

1. `semantic_id` is the primary animation identity.
2. `character_id` only scopes override resolution; it is not a clip-path lookup key.
3. `cursor` remains opaque and ordered.
4. Time values stay in milliseconds, not engine frames.
5. Fallback behavior is backend-declared, not viewer-invented.
6. Unknown optional fields must be safely ignored.
7. A viewer may improve local retargeting or blending, but it must preserve the backend-declared semantic meaning.

## Implementation Notes

Current source-of-truth code lives in:

- `backend/app/schemas/animation.py`
- `backend/app/services/animation.py`

Those modules now define `idle.neutral` as the default fallback semantic id and expose the deterministic session snapshot model that the frontend consumes today.

## Recommended Next Implementation Slice

When code work begins, the first backend slice should:

1. introduce an animation intent schema beside the existing session schemas
2. expand the animation command schema into a resolved-command shape with explicit resolution metadata
3. add an animation event payload to canonical backend events
4. preserve the existing speech envelope semantics for ordered delivery
5. keep viewer adapters responsible only for local playback execution and optional acknowledgement

This gives Tank, Switch, and the future Unity runtime one contract surface to harden before engine-specific playback details expand.