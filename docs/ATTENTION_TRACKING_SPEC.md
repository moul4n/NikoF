# Attention Tracking Implementation Spec

Updated: 2026-05-22T00:00:00Z

## Purpose

Define a concrete first implementation for optional camera-driven user attention tracking so the avatar can maintain believable eye and light face or head attention toward the user without turning webcam input into a hard dependency for the voice loop.

This spec intentionally targets attention tracking, not literal eye-to-eye tracking.

Primary outcome:

- the avatar should appear aware of where the user is in frame
- gaze should feel human rather than mechanically locked
- speaking should bias attention more strongly toward the user
- the feature should stay low-cost, optional, and backend-owned at the process level

## Non-Goals

- exact iris or pupil tracking
- full-body pose puppeteering in the first pass
- raw video transport through the backend
- making camera availability a requirement for speech, TTS, or animation
- introducing a second frontend-owned authority for avatar state

## Current Fit In The System

Existing seams already support the core of this feature:

- the frontend avatar runtime already has passive eye drift with gaze lock and release behavior
- the frontend runtime already supports a look-at target concept
- the backend already owns sidecar process lifecycle for STT and TTS
- the control surface already has a backend-owned device-selection pattern for STT
- the architecture already reserves optional camera and vision flows outside the voice critical path

Current gap:

- there is no live webcam capture pipeline
- there is no backend-owned attention-tracking sidecar
- there is no camera control panel or camera device route
- there is no dedicated live attention feed from backend to display runtime

## Product Behavior

### User-Facing Behavior

When enabled and a face is confidently tracked:

- the avatar eyes should bias toward the user position in frame
- the avatar may add small head or neck follow later, but first pass should drive eyes only
- the avatar should retain subtle drift, micro-saccades, and short deviations so it does not look robotic
- during speaking, gaze should feel more engaged and more stable
- during idle or thinking, gaze should relax and wander slightly more

When tracking is unavailable:

- the avatar should immediately fall back to passive eye drift
- the rest of the system should remain unaffected

### Realism Rules

The first pass should follow these behavioral rules:

- never lock 100 percent to the detected face center
- keep a configurable deviation layer even while tracking is active
- smooth target changes aggressively enough to remove jitter
- ignore tiny target changes inside a dead zone
- clamp maximum horizontal and vertical offsets to human-looking limits
- release or soften tracking when confidence drops instead of snapping

## Architectural Decision

The first implementation should use a backend-owned attention sidecar with frontend capture and frontend final gaze blending.

Why this split:

- frontend is the correct place for camera permission and low-latency capture
- backend is the correct place for canonical device selection, feature enablement, lifecycle ownership, and diagnostics
- frontend renderer is the cheapest place to apply per-frame smoothing and naturalized gaze blending
- this keeps raw video out of the backend while still preserving backend authority over the feature

## First-Pass Pipeline

```text
Control surface camera selection
  -> frontend capture worker starts selected camera
  -> frontend attention sampler produces normalized face observations
  -> backend attention sidecar receives bounded observations
  -> backend publishes canonical attention state
  -> display frontend consumes attention state
  -> avatar runtime blends tracked target with passive eye drift
```

## Ownership Model

### Frontend Responsibilities

- request camera permission
- enumerate browser camera devices
- start and stop local capture for the selected camera
- run low-resolution face detection close to the capture path
- send only normalized observations to the backend
- consume canonical attention state from the backend
- apply final smoothing and realism blending in the avatar runtime

### Backend Responsibilities

- own the feature enable flag and canonical session state
- expose camera device and tracking control routes
- own a sidecar-style attention runtime and its shutdown
- accept normalized observations rather than raw frames
- derive stable canonical attention state from the latest observations
- expose diagnostics for availability, selected device, tracking state, confidence, and degraded mode

### Display Runtime Responsibilities

- subscribe to the backend attention state
- map normalized user position to a world-space look target
- blend tracked attention with passive drift according to speaking and idle state
- fall back cleanly when attention becomes unavailable

## Detection Strategy

### First Implementation Choice

Use one low-cost face detection pass on the frontend at low resolution and low frame rate.

Recommended operating point:

- resolution: 320 x 240 or equivalent
- sample rate: 5 to 10 fps
- tracked subjects: 1 dominant face only
- selection rule: prefer the most central stable face, otherwise the largest face

### Why Not Full Pose First

Whole-body tracking is heavier, more failure-prone indoors, and not required to make gaze feel believable.

For the first release, face position in frame is enough to drive convincing eye attention.

Future extension:

- optional coarse upper-body or shoulders signal for lean direction
- optional head pose enrichment
- optional scene sampling for attention context

## Observation Contract

The frontend should not send raw landmarks as the canonical cross-layer contract.

First-pass observation payload:

```json
{
  "schema_version": 1,
  "device_id": "camera-default",
  "captured_at": 1779400000.0,
  "frame_size": { "width": 320, "height": 240 },
  "subject": {
    "tracked": true,
    "normalized_x": 0.58,
    "normalized_y": 0.42,
    "face_width": 0.21,
    "face_height": 0.28,
    "confidence": 0.91
  }
}
```

Contract rules:

- `normalized_x` and `normalized_y` are in camera frame space from 0 to 1
- only the dominant subject is sent in v1
- no raw image bytes in the standard path
- no raw landmark arrays in the standard path
- missing or low-confidence subject data is valid and should degrade to `tracked = false`

## Canonical Backend Attention State

The backend should maintain a latest-state snapshot instead of storing every sample as a first-class session event.

First-pass backend state document:

```json
{
  "schema_version": 1,
  "available": true,
  "enabled": true,
  "tracking": true,
  "selected_device_id": "camera-default",
  "selected_device_label": "Integrated Camera",
  "state": "tracking",
  "confidence": 0.91,
  "subject": {
    "normalized_x": 0.58,
    "normalized_y": 0.42,
    "face_width": 0.21,
    "face_height": 0.28
  },
  "last_observed_at": 1779400000.0,
  "last_error": null,
  "fps_target": 8,
  "frame_width": 320,
  "frame_height": 240,
  "next_sequence": 14
}
```

State values:

- `disabled`: feature is turned off
- `idle`: feature is enabled but not receiving usable observations
- `tracking`: face is currently tracked with usable confidence
- `degraded`: camera or processing path exists but is currently unhealthy

## Transport Design

Do not overload `session.animation` with continuous gaze telemetry.

Reason:

- `session.animation` is intentionally semantic and low-frequency
- attention tracking is continuous state, not a semantic animation decision
- separating them keeps the animation contract clean and prevents noisy high-rate updates from polluting it

Use a dedicated backend attention surface.

### Proposed Backend Routes

Control routes:

- `GET /session/attention`
- `GET /session/attention/devices`
- `PUT /session/attention/device`
- `PUT /session/attention/enabled`
- `PUT /session/attention/tracking`
- `POST /session/attention/observations`

Live delivery:

- `GET /session/attention` with `Accept: text/event-stream`

Live events:

- `session.attention`

This mirrors the existing STT route shape and existing SSE usage, which keeps control-surface and display-surface integration consistent with the current system.

## Sidecar Design

The attention sidecar should follow the same ownership rules as STT and TTS.

Required behavior:

- backend starts it during app lifespan when the feature is enabled
- sidecar shuts down when backend shuts down
- sidecar self-terminates if the owning backend pid disappears
- backend never depends on a stray external attention process
- logs go to a dedicated local log root under `%LOCALAPPDATA%\NikoF\logs\attention`

The sidecar in v1 can remain lightweight.

Recommended v1 role:

- receive normalized observations
- validate schema and freshness
- keep the latest stable state only
- expose `health`, `state`, `devices`, `shutdown`

This keeps the sidecar pattern consistent without putting heavy CV inside the backend process.

## Camera Device Selection

The control surface should expose a camera section that mirrors the current STT device panel.

Required UX:

- selected camera dropdown
- tracking enable or disable button
- status line
- latest confidence and tracked state
- degraded or permission error message

Selection rules:

- the browser still owns permission prompts and local device enumeration details
- the backend owns the canonical selected device id for the session
- on startup, the control surface should try to match the backend-selected device to a browser device
- if the canonical device is absent, the control surface should surface a warning and allow operator reselection
- a browser-default pseudo-device should be supported when exact hardware ids are unstable across sessions

## Frontend Runtime Integration

### Existing Controller Reuse

The existing passive eye drift controller should remain the base layer.

Add a tracked-attention layer on top of it rather than replacing it.

Runtime behavior:

- if no tracked subject is available, use passive drift only
- if tracked subject is available, compute a desired look target from normalized subject position
- blend that desired target with passive drift according to current attention mode
- keep passive micro-saccades active even during tracking

### Proposed Attention Modes

- `idle`: low pull toward user, more drift
- `listening`: medium pull, moderate drift
- `speaking`: high pull, minimal drift
- `thinking`: medium-low pull, brief look-away behavior allowed

Suggested starting weights:

- idle: `target_weight = 0.72`
- listening: `target_weight = 0.82`
- speaking: `target_weight = 0.90`
- thinking: `target_weight = 0.68`

These should remain data-tunable rather than hardcoded as product truth.

## Gaze Mapping

Convert normalized subject position into a world-space target relative to the avatar head rather than moving the eyes directly.

Mapping rules:

- horizontal screen offset maps to lateral gaze target displacement
- vertical screen offset maps to vertical gaze target displacement
- face size can weakly bias depth so a closer face slightly reduces wandering
- final target must be clamped to a human-looking cone

Suggested first-pass limits:

- horizontal normalized clamp after dead zone: about plus or minus 0.35 equivalent offset
- vertical normalized clamp after dead zone: about plus or minus 0.22 equivalent offset
- optional small depth bias from face size only after the base version feels stable

## Smoothing And Naturalization

This is the critical realism layer.

### Required Filters

- dead zone around the current target to suppress tiny jitter
- exponential smoothing or spring-damper smoothing on target position
- confidence-weighted easing when entering or leaving tracking
- short hold time before dropping tracking on one bad sample

### Suggested Defaults

- observation sample rate: `8 fps`
- tracking loss grace period: `0.35 s`
- enter-tracking confidence threshold: `0.65`
- hold-tracking confidence threshold: `0.45`
- dead zone radius: `0.03` normalized frame units
- smoothing half-life: `120 ms` to `180 ms`
- deviation amplitude while tracking: `10 percent` to `25 percent` of passive drift

### Humanization Rules

- preserve micro-saccades while locked
- add small random overshoot or undershoot on larger target moves
- occasionally glance near, not exactly at, the target center
- reduce but do not eliminate drift during speaking

## Speaking-State Bias

When the character is speaking, attention should tighten but not hard-lock.

Speaking adjustments:

- higher target weight
- lower drift amplitude
- faster reacquire speed after target movement
- lower tolerance for prolonged look-away behavior

The speech lifecycle that already exists in the frontend should drive this mode change instead of introducing a second speech-state source.

## Performance Budget

The feature must stay cheap enough that it does not materially affect the current backend and frontend loop.

Budget targets:

- capture and face detection at 5 to 10 fps only
- low-resolution camera sampling only
- at most one tracked subject in v1
- do not queue old observations; latest sample wins
- backend state publication should be snapshot-based, not event-history-heavy
- no GPU requirement for the attention path

## Failure Modes And Degradation

The system must degrade to passive drift with clear operator diagnostics.

Expected failures:

- no camera permission
- no camera available
- selected device missing
- intermittent observation loss
- backend sidecar unavailable
- stale observation timestamps

Required degradation behavior:

- avatar falls back to passive drift only
- control surface shows degraded state and reason
- backend remains healthy for all non-camera features
- no voice-turn delays and no TTS delays

## State Persistence

Persist only lightweight operator preferences.

Persistable settings:

- feature enabled flag
- preferred camera device id or default-device policy
- target fps
- target frame size preset

Do not persist:

- raw frames
- raw landmarks
- continuous attention history by default

## Security And Privacy Boundaries

- camera use remains explicit and operator-controlled
- raw video remains local to the browser capture path in v1
- backend stores only bounded normalized observations and latest state
- no cloud dependency is introduced for this feature

## Rollout Plan

### Phase 1: Wiring Spike

- add backend attention routes and state types
- add control-surface camera panel
- add display-side attention consumer
- drive avatar gaze from a fake or manual normalized target source

Success criteria:

- attention state flows end to end
- avatar blends tracked target with passive drift
- enabling and disabling tracking does not affect other subsystems

### Phase 2: Real Camera Input

- add browser device enumeration and permission handling
- add low-resolution face detection
- send normalized observations to backend
- support default camera selection and reselection from control surface

Success criteria:

- one user face can be followed at low fps without obvious jitter
- loss of camera or permission falls back cleanly

### Phase 3: Realism Tuning

- tune smoothing and thresholds
- tune mode weights for idle, listening, speaking, thinking
- optionally add light head follow if eye-only tracking reads too subtle

Success criteria:

- behavior reads human and present rather than robotic
- speaking feels more engaged than idle

## Testing Requirements

### Backend Tests

- state route returns disabled, idle, tracking, and degraded states correctly
- selected device updates survive invalid-device attempts safely
- sidecar start and shutdown follow backend lifetime rules
- stale observations do not keep tracking active forever

### Frontend Tests

- control surface renders device and tracking controls from backend state
- missing permission or missing devices produce the expected degraded UI
- tracked subject updates are smoothed before reaching the avatar runtime target
- passive drift remains active when tracking is disabled or unavailable

### Manual Validation

- user moves left and right in frame and avatar gaze follows with smooth lag
- user stops moving and avatar gaze settles without twitching
- user leaves frame and avatar returns to natural drift
- speaking state visibly tightens attention without hard lock

## Proposed File And Module Additions

Backend:

- `backend/app/api/attention_routes.py`
- `backend/app/services/attention_worker.py`
- `backend/app/services/attention_server.py`
- `backend/app/providers/attention_runtime.py`
- `backend/tests/test_attention_routes.py`
- `backend/tests/test_attention_sidecar_runtime.py`

Frontend:

- `frontend/src/app/useAttentionState.ts`
- `frontend/src/app/ControlSurfaceAttentionPanel.tsx`
- `frontend/src/features/vision/attentionCapture.ts`
- `frontend/src/features/vision/cameraDevices.ts`
- `frontend/src/avatar/loaders/sessionAttention.ts`
- `frontend/src/avatar/runtime/trackedAttentionController.ts`

Shared types:

- extend the shared frontend type surface with backend attention state and device documents

## Open Decisions

- whether frontend detection should use MediaPipe Face Mesh directly in v1 or a lighter face-detection-only path first
- whether the attention sidecar should be a true separate runtime in phase 1 or a worker service inside the backend with sidecar promotion in phase 2
- whether light head follow should ship in the first user-visible version or remain phase 3 tuning

## Recommendation

Recommended first implementation:

1. ship a dedicated backend attention state surface and control panel
2. reuse the existing passive eye drift controller as the realism base layer
3. run one low-resolution face-detection pass on the frontend at about `8 fps`
4. send only normalized subject observations to the backend
5. let the display runtime perform final smoothing and humanized blending
6. keep the entire feature optional and outside the voice critical path

This path is the lowest-risk way to make the avatar feel more present without materially increasing backend load or destabilizing the current speech stack.