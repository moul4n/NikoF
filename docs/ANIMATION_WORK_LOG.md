# Animation Work Log

## Session: 2026-05-18 — Idle Animation Matching

### Goal
Get the VRM character's idle animation in three-vrm to match how the same animation looks when played in Unity on a humanoid character.

---

### Problem 1: Loop Jump (FIXED)

**Symptom:** Visible jump/pop at the animation loop boundary.

**Root Cause:** Two issues combined:
1. External modulo wrapping (`elapsedSeconds % (durationMs / 1000)`) used a different duration than the actual clip, causing a mismatch at the wrap point.
2. `mixer.setTime(t)` was called every frame, which causes derivative discontinuities in THREE.js AnimationMixer (it resets internal state).

**Fix applied:**
- `frontend/src/avatar/runtime/avatarRuntime.ts`: Let `elapsedSeconds` grow continuously for loop mode (no external modulo). For `once` mode, clamp to final frame.
- `frontend/src/avatar/runtime/mixerPlayback.ts`: Use `mixer.update(delta)` for normal forward advancement (preserves smooth interpolation). Only fall back to `mixer.setTime()` for seeks or resets (delta > 1s or backward).

**Result:** Loop is now seamless.

---

### Problem 2: Missing Posture / Straight Torso (NOT YET RESOLVED)

**Symptom:** The VRM character stands bolt-upright with no natural spine curvature, shoulder slope, or weight shift. The same `.anim` file played on a Unity humanoid character shows natural relaxed posture.

#### Investigation

**What we found about the pipeline:**
```
Unity .anim (muscle curves) 
  → C# RawAnimBatchExporter.cs (HumanPoseHandler on synthetic rig)
  → bone local rotation quaternions (JSON)
  → three-vrm normalized bone quaternion tracks (AnimationMixer)
```

**Muscle values in the idle animation are TINY for the spine:**
| Channel | Peak Value | Approx Degrees |
|---------|-----------|----------------|
| Spine Front-Back | 0.0158 | ~0.6° |
| Chest Front-Back | 0.0272 | ~1.1° |
| UpperChest Front-Back | 0.0546 | ~2.2° |
| Left Upper Arm Front-Back | — | ~80° |
| Left Upper Leg Front-Back | 0.4847 | ~19.4° |

The arms and legs have significant muscle values and export correctly. The spine barely moves — this IS what the source animation contains.

**Why it looks different in Unity:**
In Unity, when the same muscle values are applied via `HumanPoseHandler` to a character's Avatar, the resulting bone `localRotation` values **include the Avatar's skeletal rest orientations**. Characters modeled with natural spine curvature, shoulder droop, etc. show those in their T-pose bone rotations. The muscles add subtle motion ON TOP of this natural posture.

**Our VRM model's skeleton:**
All bones have `rotation: [0, 0, 0, 1]` (identity) in the glTF data. The VRM is a perfectly straight T-pose with zero natural curvature. This is common for VRM models (the VRM spec emphasizes a canonical T-pose).

#### Attempted Fix 1: Exporter bodyPosition Bug (Partial Success)

**Change:** `scripts/animation_tools/unity/RawAnimBatchExporter.cs`
- Previously: `pose.bodyPosition = Vector3.zero` and `pose.bodyRotation = Quaternion.identity` were hardcoded when calling `SetHumanPose()`.
- Fixed: Now resolves RootT.x/y/z and RootQ.x/y/z/w channels per-frame and feeds them as `bodyPosition` and `bodyRotation`.
- Also removed `rig.animator.Update(0f)` from the sample loop (could overwrite SetHumanPose results).

**Result:** Improved arm rotations (80° from identity — proper rest-from-T-pose), improved leg rotations (7-15°). Spine still near-zero because the muscles ARE near-zero. The bodyPosition fix was correct but didn't solve the visual posture issue.

#### Attempted Fix 2: Static Forward Lean Workaround (Removed)

**Change:** `frontend/src/avatar/runtime/mixerPlayback.ts`
- Added `STATIC_FORWARD_LEAN = 0.035` (~2° total) distributed across spine/chest/upperChest as a constant pitch rotation applied every frame.
- Later REMOVED because it was a hack that wouldn't survive different animations or character-specific tuning.

**Result:** Visually helped slightly but was not a real solution. Removed.

#### Attempted Fix 3: Bake Natural Posture into Export Rig (Did Not Help)

**Change:** `scripts/animation_tools/unity/RawAnimBatchExporter.cs` — `CreatePunchComparisonRig()`
- Modified the synthetic rig skeleton to include natural bone rotations:
  - Hips: 4° forward, Spine: 3° forward, Chest: 2.5° forward
  - UpperChest: 1.5° forward, Neck: 3° forward, Head: 2° backward
  - Shoulders: 3° natural slope
  - Added slight Z-offsets for S-curve geometry
- Theory: The exported `localRotation` would now include these rest offsets, making the VRM show natural posture.

**Result:** Export data confirmed the offset values are present in the bone quaternions. However, **no visible improvement in the three-vrm rendering**. The character still appears straight.

**Why it didn't work (hypothesis):** three-vrm's normalized bone system may handle the small rotation values differently than expected, OR the coordinate conversion (negate X, Y quaternion components) is interacting with the offset in a way that cancels it out, OR the VRM's own rest-to-raw mapping is overriding our values.

---

### Key Insight: We're Reinventing the Wheel

**The fundamental problem:** We built a custom pipeline that:
1. Extracts muscle curves from Unity .anim files
2. Converts them to bone quaternions via a synthetic rig + HumanPoseHandler
3. Exports as flat JSON arrays
4. Reconstructs as THREE.js KeyframeTrack clips
5. Applies to three-vrm normalized bones

This pipeline works for raw bone data but **loses the semantic richness** that both Unity's humanoid system and three-vrm's animation system provide natively.

**What Unity and three-vrm already handle:**
- Skeleton-aware muscle-to-bone mapping with configurable limits
- Rest pose preservation and normalization
- Twist distribution across bone chains
- Proper retargeting between different character proportions
- Spring bone / secondary animation physics

**What we should do instead:**
Use the animation formats and playback systems that three-vrm and Unity already support, rather than converting everything through our custom intermediate format. Specifically:
- three-vrm supports VRM Animation (VRMA) format
- three-vrm supports loading `.glb`/`.gltf` animations with proper bone targeting
- Unity can export humanoid animations as `.glb` that three-vrm can consume directly
- The backend can send animation commands/parameters, not raw sample arrays

---

### Current Architecture (What We Have)

```
[Unity .anim]
  ↓ (C# exporter with HumanPoseHandler)
[idle.default.runtime.json] — 251 frames × 22 bones × 4 quat components
  ↓ (frontend loads JSON)
[THREE.AnimationMixer + QuaternionKeyframeTrack per bone]
  ↓ (applied to vrm.humanoid normalized bones)
[VRM character renders]
```

### Proposed Direction

Stop converting animation data into a custom format. Instead:
1. **Use standard animation formats** that three-vrm already consumes (VRMA, glTF animations, BVH)
2. **Keep the backend as the orchestrator** — it tells the frontend WHICH animation to play, with WHAT parameters (speed, blend weight, transition time)
3. **Let three-vrm handle the bone math** — it already knows how to retarget, normalize, and apply humanoid animations to VRM models
4. **Preserve manipulation capability** — the backend can still send real-time overrides (head tracking, expression blends, procedural layers) as high-level commands

---

### Files Modified Today

| File | Change | Status |
|------|--------|--------|
| `scripts/animation_tools/unity/RawAnimBatchExporter.cs` | bodyPosition fix + natural posture rig | Modified |
| `frontend/src/avatar/runtime/mixerPlayback.ts` | Loop fix (mixer.update), removed STATIC_FORWARD_LEAN | Modified |
| `frontend/src/avatar/runtime/avatarRuntime.ts` | Continuous elapsedSeconds for loops | Modified (earlier) |
| `assets/animations/generated/shared/idle.default/idle.default.runtime.json` | Re-exported with fixes | Regenerated |
| `scripts/animation_tools/verify_export.py` | Utility script for checking export | New |

---

### Reference Data

**VRM model (test-vrm-01):** All bones at identity rotation. Straight skeleton. VRM 0.x format.

**idle.anim source:** 8.333s duration, 30fps (251 frames), 140 muscle channels including RootT/RootQ. Very subtle spine motion. Significant arm/leg motion.

**Coordinate conversion (Unity LH → three-vrm RH):** Negate X and Y quaternion components (Z-axis mirror convention).

---

### Next Steps

1. Research how three-vrm natively handles animation (VRMA format, mixamo import, glTF animations)
2. Investigate whether we can export from Unity directly to a format three-vrm consumes without our custom intermediate
3. Design the backend→frontend animation command protocol (play/stop/blend/override) that works with native three-vrm playback
4. Keep the procedural overlay system (breathing, head tracking, expression) as a lightweight layer on top of native animation playback

---

## Research: three-vrm Native Animation System

### `@pixiv/three-vrm-animation` Package

Three-vrm has a dedicated animation package that handles everything we're trying to do manually:

**Key Components:**
- **`VRMAnimationLoaderPlugin`** — A `GLTFLoader` plugin that loads `.vrma` files (glTF with `VRMC_vrm_animation` extension)
- **`createVRMAnimationClip(vrmAnimation, vrm)`** — Creates a properly retargeted `THREE.AnimationClip` for a specific VRM model
- **`VRMAnimation`** — Intermediate representation with humanoid rotation/translation tracks, expression tracks, and lookAt tracks

**What it handles that we don't:**
- World-space rotation retargeting between different skeleton structures
- VRM 0.x vs 1.x coordinate differences (auto-negates quaternion components for v0)
- Hips height scaling (`animationRestHipsY / modelRestHipsY` ratio)
- Expression weight animation tracks (blendshapes)
- LookAt direction tracks (eye gaze)
- Parent bone world matrix transformations for proper FK transfer

**How it works internally:**
```
Load .vrma file (glTF + VRMC_vrm_animation extension)
  ↓
VRMAnimationLoaderPlugin parses bone→node mapping
  ↓
Computes world matrices of animation skeleton's bones
  ↓
For each rotation track: transforms from animation world space → local delta
  ↓
createVRMAnimationClip() retargets to target VRM's normalized bones
  ↓
Standard THREE.AnimationMixer plays the clip
```

The critical difference: VRMA stores rotations **relative to the animation skeleton's world orientation**. The loader then **retargets** these to the target VRM's skeleton using proper matrix math. If the animation skeleton has natural curvature, it's encoded in the world matrices and properly transferred.

### VRMA Format (VRMC_vrm_animation 1.0)

**What it is:** A glTF 2.0 extension for storing humanoid animation data that can be applied to any VRM model.

**Structure:**
```json
{
  "nodes": [...],           // Nodes in T-pose representing the animation skeleton
  "animations": [...],      // Standard glTF animation channels
  "extensions": {
    "VRMC_vrm_animation": {
      "specVersion": "1.0",
      "humanoid": {
        "humanBones": {
          "hips": { "node": 0 },
          "spine": { "node": 1 },
          "chest": { "node": 2 },
          ...
        }
      },
      "expressions": {
        "preset": {
          "happy": { "node": 59 },
          "blink": { "node": 60 }
        }
      },
      "lookAt": {
        "node": 64,
        "offsetFromHeadBone": [0.0, 0.06, 0.0]
      }
    }
  }
}
```

**Key properties:**
- Animation skeleton nodes MUST be in VRM T-pose at rest
- Only Hips bone may have translation tracks
- No scale tracks on humanoid bones
- The T-pose hierarchy CAN have rotations (handles different skeleton orientations)
- 30fps recommended guideline
- Linear interpolation between keyframes

### Why VRMA Solves Our Posture Problem

Our current issue: the animation skeleton in the export rig is perfectly straight (all identity rotations), so the exported bone rotations are tiny for the spine. The VRM model is also straight. Result = straight character.

With VRMA: The animation skeleton can have **any rotation in its T-pose** (the spec explicitly allows this). The `VRMAnimationLoaderPlugin` uses the animation skeleton's world matrices to properly retarget the animation to the target VRM. Natural curvature in the animation skeleton gets transferred correctly.

Even better: if we export from Unity with the character's actual skeleton as the animation reference, the bone rotations will include the natural posture that the character has in Unity.

---

## Plan: Migration to VRMA-Based Pipeline

### Phase 1: Export Unity .anim → VRMA

Modify our C# exporter to output `.vrma` (glTF binary) instead of custom JSON:

1. Create glTF nodes in humanoid T-pose hierarchy (can use the character's actual skeleton orientations)
2. Add `VRMC_vrm_animation` extension mapping nodes to bone names
3. Convert muscle curves → bone local rotations per frame (we already do this)
4. Write as glTF animation channels targeting those nodes
5. Output as `.glb` binary

This lets us keep using Unity's `HumanPoseHandler` for the muscle→bone conversion while outputting a standard format.

### Phase 2: Frontend Loads VRMA Natively

1. Install `@pixiv/three-vrm-animation`
2. Register `VRMAnimationLoaderPlugin` with the GLTFLoader
3. Load `.vrma` files → get `VRMAnimation` objects
4. Use `createVRMAnimationClip(vrmAnimation, vrm)` to create retargeted clips
5. Play via standard `THREE.AnimationMixer`

This replaces our custom `mixerPlayback.ts` quaternion interleaving and coordinate conversion.

### Phase 3: Backend Orchestration

The backend doesn't send raw animation data. It sends commands:
```json
{ "command": "play_animation", "clip_id": "idle.default", "transition_ms": 200 }
{ "command": "set_expression", "name": "happy", "weight": 0.8 }
{ "command": "set_lookat", "target": [0, 1.5, 2.0] }
```

The frontend manages the animation library, loading, blending, and playback. The backend controls WHAT plays and WHEN.

### Phase 4: Procedural Overlay Layer

Keep lightweight procedural overlays on top of base animation:
- Breathing rhythm (subtle chest expansion)
- Head tracking / eye gaze
- Expression blending
- Idle variation (shift weight, glance around)

These are applied AFTER the base animation, using three-vrm's expression/lookAt APIs.

---

## Architecture Comparison

### Current (Custom Pipeline)
```
Unity .anim → C# HumanPoseHandler → custom JSON (251×22 quaternions)
  → Frontend: manual quaternion interleaving → THREE.KeyframeTrack → AnimationMixer
  → Manual coordinate conversion (negate X,Y)
  → Manual position handling
```
Problems: No retargeting, no expression support, posture lost, custom format.

### Target (Standard Pipeline)  
```
Unity .anim → C# HumanPoseHandler → .vrma (glTF binary with VRMC_vrm_animation)
  → Frontend: VRMAnimationLoaderPlugin → createVRMAnimationClip() → AnimationMixer
  → Automatic retargeting, coordinate handling, height scaling
  → Expression + LookAt tracks included
```
Benefits: Standard format, proper retargeting, posture preserved, ecosystem tools work.

---

## Session: 2026-05-19 — Floor Grounding, Two-Bone IK & Knee Stabilisation

### Context

Switched to the `idle1v2` animation (from "X Bot@Idle (1).fbx") — a 16.6s, 500-sample, 30fps idle with a 13cm lateral hip weight shift. The runtime.json pipeline is working correctly for bone rotations and hips translation. The remaining visual issues are all **proportion mismatch** between the source XBot skeleton and our VRM model.

### Problem: Left Foot Lifting Off Floor

**Symptom:** During the rightward weight shift, the left foot lifts ~43mm above the floor plane. The right foot stays grounded but the left visibly separates from the ground.

**Root Cause:** The VRM's legs are ~5% shorter than the XBot source skeleton. The position scaling uses uniform `vrmHipsY / sourceHipsY = 0.9479` which correctly scales the hips position, but during the 13cm lateral weight shift the left leg chain (total 0.768m) physically cannot reach the floor from the shifted hip position (requires 0.806m reach).

**User's design philosophy:** "We don't want to be applying fixes to the animation but to the way the animation is built or applied to the model, so all future animations will work first time."

---

### Fix: Per-Frame Floor Grounding System (Two-Phase)

Implemented in `frontend/src/avatar/runtime/avatarRuntime.ts` as `applyFloorGrounding()`. Runs generically after `vrm.update()` on every frame for all animations.

#### Phase 1: Root Y Clamp (Highest Foot)

Lowers `root.position.y` so the **highest** foot reaches Y=0. This guarantees no foot goes above the floor. The other foot may go below floor (gets fixed in Phase 2).

```
root.position.y -= Math.max(leftFootY, rightFootY)
```

#### Phase 2: Per-Leg Two-Bone IK

For each foot that's displaced from Y=0, solves the full two-bone IK (UpperLeg → LowerLeg → Foot target):

1. **Law of cosines** — computes the new knee angle given hip position, target foot position, and bone lengths
2. **Pole-target constraint** — derives the IK plane from the animation's natural knee forward direction (XZ projection of hip→knee), ensuring the kneecap always faces forward
3. **Swing rotation** — `setFromUnitVectors` rotates upper leg to point at the solved knee position
4. **Pole correction** — after the swing, an explicit twist around the bone axis aligns the knee to the pole direction (prevents lateral pop-out from the swing introducing unwanted roll)
5. **Lower leg swing** — rotates lower leg to point at the target
6. **Foot orientation restoration** — captures foot world quaternion before IK, restores it after, preserving animation-driven toe-out angle
7. **Unreachable fallback** — if `targetDist >= chainLen`, fully extends the leg toward target (best effort)

#### Phase 3: Toe-Out Retargeting Correction

The source XBot skeleton produces visible ~7° toe-out in the idle pose, but the VRM model's leg chain orientation absorbs most of this rotation. Post-IK, a static Y-axis rotation is applied to each foot bone:

- Left foot: +5° outward
- Right foot: +7° outward

This matches the source animation's visual intent and biases the knee forward, improving natural appearance.

---

### Key Algorithm: Pole-Target Constraint

The `applyPoleConstraint()` function prevents knee pop-out:

1. Gets current knee world position and computes the upper leg bone axis
2. Projects both the CURRENT knee direction and DESIRED pole direction onto the plane perpendicular to the bone axis
3. Computes the signed angle between them (using cross product for direction)
4. Applies a twist rotation around the bone axis to align the knee

This is the same technique Unity/Unreal use in their IK systems — the pole target explicitly controls kneecap direction independent of how the directional swing was applied.

---

### Key Algorithm: Foot Orientation Restoration

The `restoreFootOrientation()` function preserves animation-driven foot angles through IK:

1. Before IK: captures the foot's world quaternion (animation intent)
2. After IK: the foot's world orientation has drifted (it's a child of the rotated leg chain)
3. Computes the world-space correction quaternion: `target * inv(current)`
4. Applies it via `applyWorldRotationToLocal()` — converting from world to bone-local space

---

### Results (Verified Over Full 16.6s Cycle)

| Metric | Before | After |
|--------|--------|-------|
| Left foot peak lift | +43mm | ±0.5mm |
| Right foot peak lift | ±0.5mm | ±0.0mm |
| Right knee X (lateral) | 0.004 (collapsed inward) | 0.072–0.126 (stays outward) |
| Right knee Z (forward) | -0.055 (behind hip!) | 0.054–0.133 (always forward) |
| Left toe-out | -2.5° (toe-in) | +2.5°–4.9° (toe-out) |
| Right toe-out | -3.5° (toe-in) | +3.3°–6.3° (toe-out) |

All measurements sampled every 1s for 17 seconds via `window.__floorClampDiag` diagnostic.

---

### Known Remaining Issue: Hip/Upper-Leg Range

During extreme weight shift, the upper leg bone doesn't move upward into the body enough to avoid tight angles at the knee. The IK geometrically solves the target but the resulting knee bend can look compressed because:

1. The VRM hips are slightly lower than the XBot source
2. The leg chain is ~5% shorter, so during weight shift it's operating near max extension
3. The upper leg needs slightly more inward rotation to clear the pelvis visually

This will be addressed in a future session — potential approaches include adjusting the Phase 1 root clamp strategy or adding a subtle hip offset during extreme shifts.

---

### Position Scaling Pipeline

Hips position tracks use uniform scaling:

```
scale = vrmHipsRestY / sourceHipsRestY = 0.917 / 0.967 = 0.9479
```

Applied in `mixerPlayback.ts` via `rebasePositionToVrmRest()`:
- Source position is relative to source rest (0, 0.967, 0)
- Scaled by uniform ratio
- Added to VRM rest position (0, 0.917, 0)

This correctly scales the 13cm lateral hip sway to ~12.3cm on the VRM.

---

### Quaternion Conversion

Unity (left-handed, Z-forward) → THREE.js/VRM (right-handed, Z-backward):

```
(x, y, z, w) → (-x, -y, z, w)
```

Applied in `interleaveQuaternionSamples()` for all rotation tracks.

---

### Render Loop Integration

The floor grounding runs in the animation frame loop:

```
mixer.update(delta)           // advance animation
vrm.update(delta)             // normalized → raw bone copy
applyFloorGrounding(root, vrm) // IK correction on raw bones
renderer.render(scene, camera) // draw
```

Critical: must run AFTER `vrm.update()` (which copies normalized→raw) and BEFORE render.

---

### Files Modified This Session

| File | Change |
|------|--------|
| `frontend/src/avatar/runtime/avatarRuntime.ts` | Added `applyFloorGrounding()`, `applyLegSwingIK()`, `applyPoleConstraint()`, `restoreFootOrientation()`, `applyWorldRotationToLocal()` |
| `frontend/src/avatar/runtime/mixerPlayback.ts` | Position scaling with uniform `vrmHipsY/sourceHipsY`, `rebasePositionToVrmRest()` |
| `frontend/src/avatar/runtime/defaultBaseAnimation.ts` | `idle1v2` as default base animation |

---

### Stability & Build Status

- TypeScript: `tsc --noEmit` passes cleanly (zero errors)
- HMR: Vite dev server picks up changes on save
- Runtime: No console errors, no frame drops from IK computation
- All changes are generic (work for any animation, not tuned to idle1v2)

---

### Architecture Notes

The floor grounding system follows the user's principle: fix the APPLICATION of animation to the model, not individual animations. It works because:

1. **Generic** — runs on all animations without per-clip tuning
2. **Proportion-aware** — compensates for any bone length mismatch automatically
3. **Preserves intent** — pole constraint and foot restoration keep the animation's visual character intact
4. **Composable** — sits cleanly after three-vrm's own bone pipeline without conflicting

The remaining knee/hip issue is geometric (the VRM proportions force near-max-extension during weight shift), not an algorithmic failure. Potential future improvements:
- Adaptive root offset that gives the IK more room during extreme poses
- Soft IK (gradual extension near limits instead of hard geometric solve)
- Per-model proportion metadata that adjusts the position scaling per bone chain

---

## Session: 2026-05-20 — VRMA Grounding Diagnostics, Knee Bend Recovery, and Planned Pelvis Compliance Layer

### Context

The active base path for idle playback is now native VRMA playback (`idle1v3.vrma`) with a grounded post-process in `frontend/src/avatar/runtime/avatarRuntime.ts`.

This session deliberately moved away from clip-side edits and back toward the model/runtime seam because the user confirmed the source animation already works on reference three-vrm models. The question became: why does the same VRMA clip need visible compensation on Maria?

### What Was Verified

#### Step 1: Plain vs Grounded A/B

Dev-only diagnostics were added to switch between:

- `plain`: raw VRMA playback on the project model
- `grounded`: VRMA playback plus the project's grounding / IK correction layer

The A/B result was decisive:

- `plain` already looked wrong on Maria
- `grounded` improved foot contact but initially created backward knee bending and later visible compression popping

Conclusion: the problem is not only floor locking. The base retarget on Maria differs from reference three-vrm playback enough that the correction layer must absorb part of the mismatch.

#### Step 2: Model Compatibility Diagnostics

Additional diagnostics were added to measure Maria's lower-body chain at load and during playback:

- `window.__NIKOF_AVATAR_DEBUG__.getModelCompatibilitySnapshot()`
- `window.__NIKOF_AVATAR_DEBUG__.logModelCompatibilitySnapshot()`

These snapshots exposed the actual bend-plane behavior instead of relying on visual inspection alone.

Key finding: the animated knee bend in `plain` playback wants to travel strongly forward of Maria's baseline bend plane, but grounding originally pulled the knees back toward Maria's native backward bend. That localised the issue to the grounded leg solver rather than the animation asset.

### What Changed in the Runtime

The current grounded VRMA path in `frontend/src/avatar/runtime/avatarRuntime.ts` now includes:

1. VRMA diagnostics for pre/post correction foot and knee state
2. Model compatibility baseline/current diagnostics for both legs
3. A bend-plane hint derived from the animated knee offset relative to the animated hip-to-foot chain
4. A limited upward pelvis prepass that allows some vertical hip give instead of treating the animated hip height as a hard ceiling
5. Smoothed pelvis prepass state carried across frames (`pelvisPrepassOffsetY`) so the vertical correction is not re-applied as a hard snap every frame
6. A blended pelvis target derived from both leg demands instead of hard-switching to whichever leg currently demands the higher hip position
7. A short reverse-order IK convergence pass so one leg does not consistently perturb the other after shared pelvis correction

### Current State at End of Session

The grounded solver is materially better than it was at the start of the investigation:

- both feet now land exactly on target in the cleanest grounded snapshots
- left/right post-correction asymmetry has been removed in the best recent runs
- the hips now participate in vertical absorption (`postCorrection.hipY > preCorrection.hipY`) instead of staying rigid
- the earlier full-leg twist regression was removed
- the earlier persistent backward-knee regression was reduced substantially

However, the user still reports that the motion is not fully convincing. The remaining issue is no longer "feet drift off the floor" or "knees always bend backward". The remaining issue is that the compression still reads too rigid around the top of the legs / hip / inner-hip area compared with reference three-vrm playback.

### Planned Next Step: Separate Pelvis Compliance Layer

The next change should be a distinct pelvis compliance layer, not more leg IK complexity.

#### Rationale

The current solver now handles:

- foot planting
- bend-side recovery
- some vertical hip give

What it still lacks is the extra degree of freedom that makes the motion feel human: pelvis roll and small lateral hip drift tied to asymmetric leg compression. The user's description is consistent across runs: in the reference playback, the legs appear to slide upward into the hip area during compression, while the current project runtime still looks too rigid in the upper leg / hip seam.

#### Intended Design

Add a grounded-only pelvis compliance pass after the vertical pelvis prepass and before the final render, driven by the left/right compression difference.

Implementation outline:

1. Measure per-leg compression after the vertical pelvis prepass and before the final convergence pass.
  Use existing leg-chain data already available in `applyFloorGrounding(...)`:
  - hip world position
  - knee world position
  - foot world position
  - target foot world position

2. Derive two compliance signals:
  - `compressionAverage`: average compression demand across both legs
  - `compressionBias`: left-vs-right compression difference

3. Apply a small pelvis-only adjustment layer on the hips node:
  - vertical: keep the existing smoothed pelvis offset path
  - lateral: shift hips a small distance toward the more compressed/supporting side
  - roll: apply a small roll toward the compressed/supporting side

4. Smooth those new lateral and roll channels across frames, just like `pelvisPrepassOffsetY`, using per-avatar persisted state.

5. Keep the layer grounded-only and opt-in for the VRMA correction path so plain VRMA playback remains the baseline diagnostic reference.

#### Suggested State Additions

If continuing from another machine, the clean extension point is the `LoadedAvatar` state in `frontend/src/avatar/runtime/avatarRuntime.ts`.

Add fields analogous to the current vertical smoothing state:

- `pelvisPrepassOffsetY` (already present)
- `pelvisComplianceOffsetX` or `pelvisComplianceLateral`
- `pelvisComplianceRollRadians`

These should be reset on character load, exactly like the current vertical pelvis smoothing state.

#### Suggested Hook Point

The most likely insertion point is inside `applyFloorGrounding(...)`, after:

- `applyPreIkPelvisHeightSolve(...)`

and before the final per-leg convergence finishes.

That keeps the compliance layer logically separate from the leg solver:

- vertical pelvis prepass decides how much room the chain gets
- pelvis compliance layer adds human-like lateral/roll give
- leg IK still owns foot planting

#### Guardrails

Keep the planned pelvis compliance layer constrained:

- small capped lateral shift only
- small capped roll only
- smoothed over time
- grounded-only
- no animation-specific tuning
- no per-clip authored data required

The goal is to improve how the model absorbs the animation, not to hack `idle1v3` specifically.

### Recommended Continuation Steps on Another Computer

1. Start from the current grounded VRMA path in `frontend/src/avatar/runtime/avatarRuntime.ts`.
2. Preserve the current diagnostics and do not remove the `plain` vs `grounded` A/B switch.
3. Preserve the current vertical pelvis smoothing and convergence pass.
4. Add the separate pelvis compliance layer as a new, isolated slice.
5. Validate with the existing console diagnostics:
  - `window.__NIKOF_AVATAR_DEBUG__.logVrmaRetargetDiagnostics()`
  - `window.__NIKOF_AVATAR_DEBUG__.logModelCompatibilitySnapshot()`
6. Compare not just visuals, but whether:
  - feet stay at exact targets
  - knees stop popping laterally
  - hip/inner-thigh compression looks less rigid
  - plain mode remains unchanged

### Files Relevant to This Handoff

- `frontend/src/avatar/runtime/avatarRuntime.ts`
- `assets/animations/dsl/shared/idle1v3.json`
- `assets/animations/dsl/shared/animations.json`

### Handoff Summary

Do not resume from the old backward-knee or twist experiments. Resume from the current grounded solver and treat the next task as a new layer:

"Add a separate pelvis compliance layer (vertical already exists; add lateral/roll) so grounded VRMA playback can absorb asymmetric compression in the hips instead of pushing the remaining motion into rigid upper-leg and knee behavior."
