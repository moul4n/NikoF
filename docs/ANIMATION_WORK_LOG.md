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
