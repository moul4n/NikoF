# Backend Animation Contract Draft

## Purpose

This document defines the next-phase backend animation contract for NikoF. It is a backend-owned, engine-neutral model that can be consumed by the current web viewer and by a future Unity viewer without changing the backend event semantics.

This draft is grounded in the current repository state:

- `backend.app.schemas.animation.AnimationCommand` is currently a minimal placeholder with `animation_id`, `character_id`, `state`, `intensity`, and freeform `parameters`.
- `backend.app.services.animation.StubAnimationService` currently echoes that placeholder command and does not yet resolve semantic intent.
- `backend.app.schemas.session` already defines the canonical `SessionEvent`, `SpeechLifecycleEventEnvelope`, and `SpeechLifecycleTransportSnapshot` shapes used for backend-owned ordered delivery.
- `backend.app.services.speech` already treats speech lifecycle state as the reusable backend transport seam and already emits normalized timing metadata for speech.
- `docs/ARCHITECTURE.md` establishes that the backend is the only public service boundary, transport is HTTP plus SSE or WebSocket later, and animation events must be frontend-safe rather than engine-specific.
- `docs/WORKSTREAMS.md` assigns Tank Stage 7 to semantic animation resolution order: shared clip, declared override, safe fallback.
- `assets/animations/README.md` establishes the storage tiers, promotion rules, and the fact that raw Unity `.anim` files are provenance inputs rather than runtime contract values.
- `scripts/animation_tools/export_unity_anim_metadata.py` shows that Unity metadata is staged as safe export data, not as a transport schema the frontend should receive directly.

## Scope

This contract covers:

- animation intent emitted by backend orchestration
- resolved animation commands emitted after backend resolution
- playback lifecycle events and envelope rules
- scheduling hints for speech-aligned and non-speech-aligned motion
- interruption and fallback policy
- invariants required for multiple viewers

This contract does not yet define:

- live transport implementation details beyond reuse of the current backend envelope model
- Unity runtime scripts, Playables graphs, Mecanim state machines, or WebGL scene wiring
- authoring workflow for DSL sidecars beyond the storage and provenance rules already documented

## Design Principles

1. The backend emits semantic animation data, not engine commands.
2. The backend owns intent resolution and fallback decisions; viewers own playback execution.
3. Animation payloads must compose with the existing speech lifecycle seam instead of bypassing it.
4. The same payload must be sufficient for both a browser avatar runtime and a future Unity avatar runtime.
5. Storage provenance may mention Unity as an authoring source, but backend contracts must not depend on Unity-only concepts.

## Canonical Terms

### Animation Intent

An animation intent is the backend's semantic request before final clip resolution. It expresses what the character should do and why, without committing to a viewer-specific clip handle or runtime implementation.

Animation intent exists so orchestration can reason about:

- reply state
- speaking state
- turn transitions
- idle behavior
- emphasis or affect
- gesture timing relative to speech
- fallback when a semantic animation is unavailable for a specific character

### Resolved Animation Command

A resolved animation command is the backend's normalized playback instruction after semantic resolution order has been applied.

Resolution order for the next implementation phase is:

1. approved shared semantic animation
2. active-character declared override
3. safe backend fallback semantic animation

The resolved command remains engine-neutral. It may identify the semantic animation chosen and the asset declaration used, but it must not expose engine-native playback objects or raw storage layout.

### Playback Event

A playback event is a backend-owned status update describing the lifecycle of a resolved animation command. Playback events use the same ordered envelope pattern already used for `speech.lifecycle` delivery.

## Proposed Backend Model

## Current Stage 1 Read Surface

The immediate backend-owned read surface for animation is a deterministic session snapshot route:

- `GET /session/animation`
- `PUT /session/lifecycle-state`

Suggested current response shape:

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
    "semantic_id": "idle.default",
    "resolved_state": "selected",
    "resolution": {
      "selected_source": "shared_library",
      "selected_asset_id": "idle.default",
      "fallback_applied": false,
      "override_character_id": null
    },
    "playback": {
      "mode": "loop",
      "blend_hint": "base_full_body",
      "expected_duration_ms": 8333,
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
      "fallback_semantic_id": "idle.default",
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

Current Stage 1 intent:

- the backend, not the web viewer runtime, chooses the session's default base semantic command;
- the current deterministic base selection is `idle.default` because that semantic is already backed by the generated shared runtime asset in the repository and is playable in the current web viewer;
- the backend may also accept lifecycle-state updates from the current shell through `PUT /session/lifecycle-state` so the backend remains the single semantic authority while playback timing is still scaffolded;
- these surfaces do not introduce viewer-specific playback math, raw asset paths, or a new live animation transport stream.

## Animation Intent Contract

Suggested logical shape:

```json
{
  "schema_version": 1,
  "intent_id": "anim-intent-0001",
  "session_id": "session-123",
  "character_id": "test-vrm-01",
  "intent_type": "gesture",
  "semantic_id": "greet.wave.once",
  "source": "assistant_reply",
  "priority": "normal",
  "requested_state": "enqueue",
  "intensity": 0.75,
  "timing": {
    "mode": "after_speech_segment",
    "anchor": "speech.synthesis",
    "anchor_event_id": "speech-lifecycle-0002",
    "offset_ms": 120,
    "max_start_delay_ms": 1000
  },
  "policy": {
    "interruptible": true,
    "fallback_semantic_id": "idle.default",
    "drop_if_late": true
  },
  "parameters": {
    "handedness": "right"
  },
  "reason": "assistant agreed to wave after speaking"
}
```

Normative fields:

- `schema_version`: Integer contract version.
- `intent_id`: Stable unique id for backend correlation.
- `session_id`: Session scope.
- `character_id`: Character scope.
- `intent_type`: Semantic category such as `idle`, `gesture`, `expression_support`, `reaction`, or `transition`.
- `semantic_id`: Backend semantic animation id. This is the main lookup key.
- `source`: Why the intent exists, such as `assistant_reply`, `speech_state`, `vision_reaction`, `operator_preview`, or `system_idle`.
- `priority`: One of `low`, `normal`, `high`, `critical`.
- `requested_state`: Requested action such as `start`, `enqueue`, `replace`, or `stop`.
- `intensity`: Normalized scalar in the inclusive range `[0.0, 1.0]` unless a future version explicitly widens it.
- `timing`: Scheduling hints described below.
- `policy`: Interruption and fallback rules described below.
- `parameters`: Small semantic modifiers only.
- `reason`: Optional backend explanation for debugging and observability.

### Resolved Animation Command Contract

Suggested logical shape:

```json
{
  "schema_version": 1,
  "command_id": "anim-cmd-0001",
  "intent_id": "anim-intent-0001",
  "session_id": "session-123",
  "character_id": "test-vrm-01",
  "semantic_id": "greet.wave.once",
  "resolved_state": "queued",
  "resolution": {
    "selected_source": "shared_library",
    "selected_asset_id": "greet.wave.once",
    "fallback_applied": false,
    "override_character_id": null
  },
  "playback": {
    "mode": "oneshot",
    "blend_hint": "additive_upper_body_preferred",
    "expected_duration_ms": 1400,
    "loop": false
  },
  "timing": {
    "mode": "after_speech_segment",
    "anchor": "speech.synthesis",
    "anchor_event_id": "speech-lifecycle-0002",
    "offset_ms": 120,
    "max_start_delay_ms": 1000
  },
  "policy": {
    "interruptible": true,
    "fallback_semantic_id": "idle.default",
    "drop_if_late": true
  },
  "parameters": {
    "handedness": "right"
  }
}
```

Normative fields:

- `command_id`: Stable unique id for playback lifecycle correlation.
- `intent_id`: Reference to the originating intent.
- `semantic_id`: Semantic animation chosen after resolution.
- `resolved_state`: Backend command state such as `accepted`, `queued`, `playing`, `completed`, `cancelled`, `dropped`, or `failed`.
- `resolution.selected_source`: One of `shared_library`, `character_override`, or `fallback`.
- `resolution.selected_asset_id`: Stable backend asset identifier or semantic id alias. This must remain viewer-safe and must not be a raw path.
- `resolution.fallback_applied`: Boolean indicating whether semantic downgrade occurred.
- `resolution.override_character_id`: Present only when a declared per-character override was selected.
- `playback.mode`: One of `loop`, `oneshot`, `hold`, or `transition`.
- `playback.blend_hint`: Optional viewer hint describing semantic layering intent rather than engine implementation.
- `playback.expected_duration_ms`: Optional predicted duration for scheduling and UI correlation.
- `playback.loop`: Explicit loop flag.

## Playback Event Envelope And Lifecycle

Animation playback status should reuse the same backend-owned ordered delivery pattern already used by `SpeechLifecycleEventEnvelope` and `SpeechLifecycleTransportSnapshot`.

For the next implementation phase, animation events should use a parallel stream shape rather than a transport-specific special case:

```json
{
  "schema_version": 1,
  "stream": "animation.lifecycle",
  "delivery": "snapshot",
  "session_id": "session-123",
  "next_cursor": "animation.lifecycle:session-123:3",
  "events": [
    {
      "event_id": "animation-lifecycle-0001",
      "sequence": 1,
      "cursor": "animation.lifecycle:session-123:1",
      "event": {
        "schema_version": 1,
        "event_type": "animation.command",
        "session_id": "session-123",
        "character_id": "test-vrm-01",
        "status": "queued",
        "timestamp": "2026-05-15T12:00:00Z",
        "reason": null,
        "animation": {
          "command_id": "anim-cmd-0001",
          "intent_id": "anim-intent-0001",
          "semantic_id": "greet.wave.once"
        }
      }
    }
  ]
}
```

Recommended lifecycle statuses:

- `accepted`: Backend accepted the intent but has not resolved playback.
- `queued`: Backend resolved a command and queued it for playback.
- `playing`: Viewer reports playback has started or backend assumes start for deterministic preview flows.
- `completed`: Playback finished normally.
- `interrupted`: Playback was preempted by a higher-priority command or state change.
- `cancelled`: Backend revoked the command before playback started.
- `dropped`: Backend intentionally skipped playback because the timing window expired or prerequisites failed.
- `failed`: Backend or viewer could not satisfy the command and fallback also failed.

Recommended event types:

- `animation.intent`
- `animation.command`
- `animation.playback`

If the project chooses not to introduce a separate `animation.lifecycle` stream immediately, the backend may temporarily carry animation status inside the existing canonical `SessionEvent` family. Even in that transitional case, the ordering, cursoring, and envelope semantics must match the current speech lifecycle seam.

## Scheduling Hints

Scheduling hints are advisory metadata emitted by the backend so different viewers can align motion without diverging contract behavior.

Required scheduling fields:

- `timing.mode`: One of `immediate`, `after_current_animation`, `after_speech_segment`, `with_speech_segment`, `at_timestamp`, or `idle_window`.
- `timing.anchor`: Semantic anchor domain such as `speech.synthesis`, `speech.segment`, `session.turn`, or `animation.command`.
- `timing.anchor_event_id`: Optional event correlation id when the hint is anchored to a prior backend event.
- `timing.offset_ms`: Signed offset from the anchor.
- `timing.max_start_delay_ms`: If exceeded, the viewer should apply the drop or fallback policy.

Optional scheduling fields:

- `timing.segment_index`: For speech-segment alignment when the TTS timing metadata contains segment ranges.
- `timing.window_end_ms`: Explicit latest-start boundary.
- `timing.coordination_group`: String key for commands that should co-schedule or mutually exclude.

Scheduling guidance relative to the current speech contract:

- When anchoring to TTS output, the backend should prefer normalized speech timing metadata already present in `SpeechSynthesisContract.timing`.
- When anchoring to partial or final STT state, animation should reference speech lifecycle event ids or cursor positions rather than provider-native timestamps.
- Viewers may refine playback start locally for smoothness, but they must not reinterpret the semantic meaning of the timing mode.

## Interruption And Fallback Policy

The backend must define interruption and fallback policy explicitly so viewers do not invent inconsistent behavior.

Policy fields:

- `interruptible`: Whether a command may be preempted once queued or playing.
- `preempted_by`: Optional semantic category or priority threshold that is allowed to interrupt the command.
- `fallback_semantic_id`: Safe semantic animation to use when the requested animation cannot be resolved or should not start late.
- `drop_if_late`: Whether to drop the command rather than start it after the allowed timing window.
- `on_interruption`: One of `stop`, `blend_out`, `replace`, or `return_to_fallback`.
- `on_missing_resolution`: One of `fallback`, `drop`, or `fail`.

Normative behavior:

1. If a semantic animation cannot be resolved for the active character, the backend applies Stage 7 resolution order before emitting a terminal failure.
2. If a command becomes stale relative to its scheduling window and `drop_if_late` is true, the command becomes `dropped` and the backend may emit a fallback command.
3. If a higher-priority command interrupts a lower-priority command and `interruptible` is true, the original command becomes `interrupted` rather than silently disappearing.
4. Idle or recovery motion should use explicit fallback semantic ids such as `idle.default`, not implicit viewer guesses.

## Relation To Current Speech Lifecycle And Transport Seams

This contract is intentionally adjacent to the existing speech seam, not independent from it.

Rules:

1. Speech remains the current canonical ordered event seam in the backend.
2. Animation commands that depend on speaking state must anchor to backend-owned speech lifecycle events, not viewer-local audio callbacks alone.
3. Animation transport must preserve envelope semantics already established by `SpeechLifecycleEventEnvelope` and `SpeechLifecycleTransportSnapshot`: stable `event_id`, increasing `sequence`, opaque `cursor`, and session-scoped ordered delivery.
4. The backend should continue to expose HTTP for control surfaces and SSE or WebSocket later for live delivery, but payload semantics must remain independent from transport choice.
5. A viewer may acknowledge playback progress back to the backend in a future phase, but any acknowledgement contract must still be semantic and engine-neutral.

Concrete coordination examples:

- A reply gesture scheduled after speech completion should reference the `speech.synthesis` event or a specific speech lifecycle event id.
- Lip-sync remains driven by speech timing metadata, not by the animation contract. The animation contract may coordinate gesture timing with those speech timings.
- A transient listening posture may be triggered by transcription state, but the emitted command should remain `idle.listening.loop` or similar semantic ids rather than viewer-native state names.

## Invariants For Multi-Viewer Consumption

The following invariants must hold so both the web viewer and a future Unity viewer can consume the same contract:

1. `semantic_id` is the primary animation identity. Viewers must not require backend-provided filesystem paths.
2. `character_id` identifies override scope, but resolution output must remain valid even if the viewer stores local assets differently.
3. Envelope ordering is authoritative. Viewers must process `sequence` order and treat `cursor` as opaque.
4. All time values are expressed in milliseconds relative to backend-declared anchors or absolute timestamps, never engine frame counts.
5. Intensity and other scalar controls use normalized numeric ranges rather than runtime-specific parameter scales.
6. Unknown optional fields must be safely ignored; unknown required fields must reject the payload as incompatible.
7. Fallback behavior must be backend-declared, not inferred by individual viewers.
8. A viewer may have richer local blending or retargeting behavior, but it must preserve the backend-declared lifecycle states and semantic ids.
9. A viewer must be able to consume a command without parsing Unity text metadata, WebGL scene graph data, or raw storage provenance.

## What Must Not Leak Into Backend Contracts

The following are explicitly out of bounds for backend-facing animation contracts:

- Unity `.anim` file paths
- raw repo storage paths such as anything under `assets/animations/raw/`, `assets/animations/library/shared/`, or override folders
- Unity state machine state names
- Animator Controller layer indices
- Mecanim parameter names, hashes, or transition ids
- Playables graph node ids
- Unity avatar mask references
- Three.js object names, mixer track names, or scene-node paths
- VRM runtime component instance names
- absolute local filesystem paths
- provider-specific export script internals beyond safe provenance data retained in staging sidecars
- authoring-only metadata that exists solely because `export_unity_anim_metadata.py` extracted it from a Unity text clip

Authoring and provenance data may remain in repo-owned files under `assets/animations/dsl/` and related staging roots, but those artifacts are not the transport contract.

## Mapping To Current Backend Placeholders

The current `AnimationCommand` dataclass can be treated as a placeholder predecessor of the resolved animation command.

Current field mapping guidance:

- `animation_id` should evolve toward `semantic_id` or a backend-safe resolved asset identifier.
- `character_id` remains valid as-is.
- `state` should evolve into a clearer lifecycle status or requested action field.
- `intensity` remains valid if kept normalized.
- `parameters` may survive, but only for bounded semantic modifiers.

The current stub animation service is therefore acceptable for Stage 1 scaffolding, but the next implementation phase should split responsibilities into:

- intent construction
- semantic resolution
- fallback application
- lifecycle publication

## Recommended Next Implementation Slice

When code work begins, the first backend slice should:

1. introduce an animation intent schema beside the existing session schemas
2. expand the animation command schema into a resolved-command shape with explicit resolution metadata
3. add an animation event payload to canonical backend events
4. preserve the existing speech envelope semantics for ordered delivery
5. keep viewer adapters responsible only for local playback execution and optional acknowledgement

This gives Tank, Switch, and the future Unity runtime one contract surface to harden before engine-specific playback details expand.