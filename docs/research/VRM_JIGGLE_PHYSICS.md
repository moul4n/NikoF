# VRM Jiggle Physics (Spring Bones) — Research Report

**Date:** 2026-06-22
**Context:** NikoF renders VRM avatars with three.js + `@pixiv/three-vrm` (v3.5.2). This report covers how "jiggle physics" (secondary motion for hair, chest, skirt, accessories) is added to a VRM *after* the model is authored, the spec mechanics behind it, the tooling, programmatic file-patching, and how to do it without breaking the animation stack.

> **TL;DR for NikoF:** Jiggle in VRM is not a plugin you bolt on at runtime — it is **spring-bone data baked into the `.vrm` file** (a glTF extension) and simulated by a runtime you already ship. **All five of NikoF's `model.vrm` files already contain VRM 0.x `secondaryAnimation` spring data, and your render loop already simulates it** (`vrm.update(deltaSeconds)` at `avatarRuntime.ts:2530`). So you are not adding physics from zero — you are **tuning, extending, or re-authoring** existing spring chains. There are three realistic levers: (A) live-tune parameters at runtime in JS, (B) re-author the chains/colliders in a tool (UniVRM/Blender/VRoid) and re-export, or (C) script a patch of the `.vrm` JSON. Details below.

---

## 0. What's actually in NikoF today (codebase findings)

| Fact | Evidence |
|---|---|
| Runtime is `@pixiv/three-vrm` 3.5.2, which bundles `@pixiv/three-vrm-springbone` 3.5.2 and `three-vrm-materials-v0compat` | `frontend/package-lock.json:978-1099` |
| VRM loaded via `VRMLoaderPlugin` (installs the spring-bone loader plugin automatically) | `avatarRuntime.ts:2711-2712` |
| Render loop already drives the spring sim every frame | `avatarRuntime.ts:2530` `currentAvatar.vrm.update(deltaSeconds)` |
| Delta comes straight from `clock.getDelta()` **with no clamp** | `avatarRuntime.ts:2509` → passed to `vrm.update` |
| Body animation (`updateBaseAnimation`) runs **before** `vrm.update` — correct order | `avatarRuntime.ts:2511` (anim) precedes `:2530` (vrm.update) |
| **All 5 models are VRM 0.x** with `secondaryAnimation` already present (not 1.0 `VRMC_springBone`) | grep of `assets/characters/*/model.vrm` → every file contains `secondaryAnimation` |

**Two immediate implications:**

1. **Your avatars almost certainly already jiggle** to whatever degree the original authors set up. If they don't visibly, the spring chains/parameters in the source models are weak, or the chains are missing on the parts you care about — that's an authoring gap, not a runtime gap.
2. **One concrete latent bug:** the unclamped delta. If a tab backgrounds or a GC stall produces a large `deltaSeconds`, the Verlet integrator can explode (hair flings to infinity / NaN). This is *the* most common three-vrm spring-bone bug. Fix is one line — clamp to ~0.033–0.05 s (see §6).

---

## 1. The mechanism: VRM Spring Bones are the spec-native jiggle system

"Jiggle physics" in VRM is **not** a soft-body/cloth solver and **not** a separate plugin. It is a chain of extra skeleton bones (hair bones, breast bones, skirt bones) simulated with **Verlet integration** and written back as bone rotations each frame. This lives in the VRM spec itself, in two incompatible generations:

| | VRM 0.x | VRM 1.0 |
|---|---|---|
| Where it lives in the file | `extensions.VRM.secondaryAnimation` | `extensions.VRMC_springBone` (standalone glTF extension) |
| Top-level arrays | `boneGroups[]` + `colliderGroups[]` | `springs[]` + `colliders[]` + `colliderGroups[]` |
| Chain definition | **Flat** — list root bone(s) in `bones[]`; runtime auto-walks children | **Explicit** — enumerate every node in `joints[]`, parent→child |
| Parameters | One set **per bone group** | **Per joint** |
| Colliders | **Sphere only** | **Sphere + capsule** (+ plane via extended-collider extension) |
| Coordinates | Left-handed Y-up (Unity) | Right-handed Y-up (glTF) |
| Stiffness field name | `stiffiness` *(sic — typo baked into the 0.x schema)* | `stiffness` |
| `gravityDir`/`offset` shape | `{x,y,z}` **object** | `[x,y,z]` **array** |

**three-vrm handles both:** the bundled `three-vrm-materials-v0compat` + the spring-bone loader import VRM 0.x `secondaryAnimation` *and* 1.0 `VRMC_springBone` into the same internal `VRMSpringBoneManager`. So NikoF's 0.x models work today without conversion.

### The physics (per simulated joint, each frame)

```
inertia   = (currentTail - prevTail) * (1 - dragForce)          // momentum, damped
stiffness = worldSpaceBoneAxis * (stiffness * delta)            // pull back toward rest pose
external  = gravityDir * (gravityPower * delta)                 // gravity / wind
nextTail  = currentTail + inertia + stiffness + external
nextTail  = boneWorldPos + normalize(nextTail - boneWorldPos) * boneLength   // length constraint
nextTail  = resolveCollisions(nextTail)                         // push out of colliders
// bone rotation derived from boneAxis -> nextTail
```

| Parameter | Default | Meaning | Tuning direction |
|---|---|---|---|
| `stiffness` (`stiffnessForce` in 0.x runtime) | `1.0` | Restoring force toward rest pose | ↑ = stiffer/less jiggle; ↓ = floppy |
| `dragForce` | `0.4` (three-vrm) | Damping, 0–1; inertia × `(1 - dragForce)` | ↑ = settles fast; ↓ = floaty/oscillates |
| `gravityPower` | `0.0` | Magnitude of external pull | ↑ = hangs/droops |
| `gravityDir` | `(0,-1,0)` | Direction of pull (can be wind) | — |
| `hitRadius` | `0.0`–`0.02` | The joint's own collision sphere radius (m) | pair with collider radius |
| `center` | `null` | Reference frame for the sim (see §5) | set to hips/root for moving avatars |

---

## 2. How three-vrm runs it (NikoF's runtime) — and the runtime tuning lever

- The spring system is `@pixiv/three-vrm-springbone`: `VRMSpringBoneManager` owns a `Set` of `VRMSpringBoneJoint`s; colliders are `VRMSpringBoneColliderShapeSphere` / `...Capsule`.
- **`vrm.update(delta)` already calls `springBoneManager.update(delta)` internally**, *after* the humanoid pose, look-at, expressions, and node constraints. So secondary motion always reacts to the final posed skeleton. **Do not** also call `vrm.springBoneManager.update()` yourself — that double-steps the physics.
- **Update order rule:** advance skeletal animation (`mixer.update()` / your `updateBaseAnimation`) **before** `vrm.update()`. NikoF already does this (`:2511` before `:2530`). Getting this backwards (or calling `vrm.update` inside an IK branch) is the documented cause of "spring bones stop reacting during animation" (three-vrm issue #1502).

### Live runtime tuning (no re-export needed)

`joint.settings` is a **public, mutable object read fresh every frame**. You can retune jiggle live from JS:

```ts
for (const joint of vrm.springBoneManager.joints) {
  // e.g. make everything bouncier
  joint.settings.dragForce = 0.2;
  joint.settings.stiffness = 0.8;
  joint.settings.gravityPower = 0.3;
  // joint.settings.gravityDir.set(0, -1, 0);
}
```

- To target specific parts, filter by `joint.bone.name` (hair/bust/skirt naming) and apply per-part values from §4.
- You can also **add new chains at runtime**: `new VRMSpringBoneJoint(bone, child, settings, colliderGroups)` → `manager.addJoint(joint)` → **then `manager.setInitState()`** (otherwise the first frame uses uninitialized tail state). Colliders are added by appending to `joint.colliderGroups` — there is no `manager.addCollider`.
- After teleporting/repositioning the avatar, call `manager.reset()` to avoid a violent settle.

> **This is the cheapest path for NikoF to *improve* feel** without touching the model files: a small "physics profile" applied to existing joints by name after load. It cannot, however, *add jiggle where there are no bones* — if a model has no breast/skirt bones, no runtime tuning will create them; that needs re-authoring (§3) or file patching (§4).

---

## 3. Authoring tools — adding/editing chains post-creation, then re-export

All three preserve existing geometry/blendshapes/animation **if used correctly**; the round-trip caveats are noted.

### A. UniVRM in Unity (the reference path)
1. Import: menu **`VRM0 > Import from VRM 0.x`** (or `VRM1` for 1.0). Keep the original separate.
2. Find the auto-created **`secondary`** GameObject (it already has the `VRMSpringBone` component) under the prefab in the Hierarchy.
3. **Root Bones:** drag each chain's start bone (e.g. `hair1_L`) into an `Element` slot. Children swing automatically in 0.x.
4. Set **Stiffness Force / Gravity Power / Gravity Dir / Drag Force / Hit Radius** in the Inspector.
5. **Colliders:** add `VRM Spring Bone Collider Group` to body bones (head, chest, arms, thighs); each holds spheres (offset+radius). Reference those groups back in the spring's `Collider Groups`.
6. Re-export: select the model root → **`VRM0 > Export to VRM 0.*`** (or `VRM1 > Export VRM-1.0`).
- **Round-trip caveats:** blendshapes are exported **only if referenced by a `BlendShapeClip`**; clips in `Preset.Unknown` are dropped. There are known UniVRM bugs where blendshape **normals corrupt** on re-import (#415, #2236) — pin a known-good UniVRM version and visually verify expressions after export. Mecanim animation clips are **not** stored in `.vrm` (they stay as project assets) — fine for NikoF since animations are separate VRMA/FBX.

### B. VRM-Addon-for-Blender (Saturday06)
- Works on an imported VRM. The **Spring Bone** panel lives in **Object Properties → VRM** (and is mirrored in the 3D-view N-panel "VRM" tab) when the armature is selected. You add Colliders (sphere/capsule/plane/inside), Collider Groups, and Springs with ordered Joints, then **File → Export → VRM (.vrm)**. The exported spec version (0.x vs 1.0) follows the armature's stored spec version, not an export-dialog toggle.
- Has built-in **auto/migration operators** in the Spring Bone menu: `assign_spring_bone1_automatically` (auto-setup), **`assign_spring_bone1_from_vrm0`** (convert existing 0.x secondary-animation into 1.0 springs — a sanctioned alternative to the UniVRM round-trip in §4), and `assign_spring_bone1_from_mmd`.
- Enforces good hygiene and is also the best reference for the *programmatic* approach (§4) — it parses the exported GLB and injects the VRM/`VRMC_springBone` dicts into `extensions`, then re-packs.
- **Caveat:** spring-bone export reliability (esp. VRM 1.0) is a known soft spot in recent addon versions (open issues #1191, #543, #336), and there is **no in-Blender physics preview** — always validate exported spring behavior in three-vrm / a downstream viewer, not in the Blender panel alone.

### C. VRoid Studio (where most creators author)
- Hair/skirt bone groups are generated with built-in spring params; exposes "more bones = wider sway", **"Move Axis to Group Center"** (fixes hair flying after edits), and **"Prevent excessive shaking during movement"** (the center-node feature, on by default). Good for hair/skirt; less control over custom breast/accessory chains than Unity/Blender.

### D. VTuber runtimes (for comparison)
- VSeeFace / VNyan / Warudo consume native VRM spring bones directly. Warudo additionally supports **Dynamic Bone** and **Magica Cloth** (higher-fidelity Unity cloth, *not* part of the VRM file). NikoF is web/three-vrm, so the portable, in-file VRM spring-bone path is the right target — anything engine-specific (Magica/Dynamic Bone) doesn't travel in the `.vrm`.

---

## 4. Programmatic / "passive" patching of the `.vrm` file

A `.vrm` is a glTF 2.0 **GLB** binary: a 12-byte header + a **JSON chunk** + a **BIN chunk**. Spring bones live entirely in the JSON chunk under `extensions` — **no geometry/binary edits needed**. You read the GLB, mutate one dict, re-pack (recompute chunk lengths + 4-byte padding).

### VRM 1.0 shape (`extensions.VRMC_springBone`)
```jsonc
{
  "extensionsUsed": ["VRMC_vrm", "VRMC_springBone"],
  "extensions": {
    "VRMC_springBone": {
      "specVersion": "1.0",
      "colliders": [
        { "node": 7, "shape": { "capsule": { "offset": [0,0,0], "radius": 0.05, "tail": [0,-0.2,0] } } }
      ],
      "colliderGroups": [ { "name": "torso", "colliders": [0] } ],
      "springs": [
        { "name": "hair_back", "center": -1, "colliderGroups": [0],
          "joints": [
            { "node": 12, "hitRadius": 0.02, "stiffness": 1.0, "gravityPower": 0.2, "gravityDir": [0,-1,0], "dragForce": 0.4 },
            { "node": 13, "stiffness": 0.8 },
            { "node": 14 }                      // terminal tail node — params unused, but REQUIRED
          ] }
      ]
    }
  }
}
```

### VRM 0.x shape (`extensions.VRM.secondaryAnimation`) — what NikoF's models use
```jsonc
{
  "extensions": { "VRM": { "secondaryAnimation": {
    "boneGroups": [
      { "comment": "hair_back",
        "stiffiness": 1.0,                       // NOTE the misspelling — required in 0.x
        "gravityPower": 0.2, "gravityDir": { "x":0, "y":-1, "z":0 },
        "dragForce": 0.4, "hitRadius": 0.02, "center": -1,
        "bones": [ 12 ],                          // ROOT(s) only — runtime walks children
        "colliderGroups": [ 0 ] }
    ],
    "colliderGroups": [
      { "node": 7, "colliders": [ { "offset": { "x":0,"y":0,"z":0 }, "radius": 0.05 } ] }
    ]
  } } }
}
```

**Mapping bones → indices:** both versions reference bones by **integer index into glTF `nodes[]`**. Build a `name → index` map from `nodes[]`, find the root by name, walk `children` to collect the ordered chain.

### Tooling for the patch
- **`pygltflib` (Python) — recommended.** Loads extensions as plain dicts and round-trips unknown extensions automatically; recomputes GLB chunk lengths/padding on save. ~50 lines: `g = GLTF2().load(...)` → build name→index map → construct the dict → `g.extensions[...] = dict` → ensure `extensionsUsed` → `g.save(...)`.
- **`gltf-transform` (JS)** is powerful but **strips any extension not explicitly registered** — naive read/write will *delete* the VRM data unless you write a VRM Extension class. More friction than pygltflib for pure injection.
- **three.js `GLTFExporter`** round-trips through scene objects (lossy for VRM data) — not recommended for faithful JSON patching.
- **No off-the-shelf "inject VRM spring bones" CLI exists** — the realistic path is a small pygltflib script modeled on the Blender addon's inject pattern.

**0.x → 1.0 migration:** no official standalone JSON converter; the sanctioned route is round-tripping through UniVRM (which also swaps to the 1.0 "FastSpringBone" solver, so motion differs and params need retuning). Hand-migration is mechanical: `boneGroups`→`springs` (expand each root into explicit `joints` by walking children), `stiffiness`→`stiffness`, object→array for `gravityDir`/`offset`, emit `specVersion:"1.0"`.

> **For NikoF specifically:** since the models and runtime already speak 0.x, the lowest-risk patch is to **edit/extend the existing `secondaryAnimation`** in place with pygltflib (match the 0.x field shapes exactly — the `stiffiness` typo and `{x,y,z}` objects are the two classic mistakes). Converting to 1.0 buys capsule colliders and per-joint params but adds a migration + retune step.

---

## 5. Not breaking the animation stack — the rules

1. **One owner per bone.** A bone driven by spring physics must **never** also be keyframed/animated. The simulator stores each joint's rest rotation and writes a new rotation every frame; if the animation mixer also writes that bone, they fight and the jiggle cancels or snaps.
   - **Animation-driven (carriers):** all humanoid bones — hips, spine, chest/upperChest, neck, head, arms, legs, fingers.
   - **Physics-driven:** only **non-humanoid secondary bones** parented under carriers — hair, **breast bones** (extra bones *under* the chest, never the humanoid chest itself), skirt panels, sleeves, tails, ears, accessories.
   - Breast jiggle works precisely because the bust bones are *children* of the animated chest: the chest carries them, physics adds bounce on top.
2. **Every chain needs an explicit end/tail bone.** The last joint in a chain is used only as a tail position — its own params are ignored. Without a trailing (often empty/zero-length) leaf node, the last *visible* bone never moves. (0.x adds an implicit ~7 cm tail; 1.0 requires you to add the node.)
3. **Keep chains short.** Hair 2–4 joints (+end), bust 1 joint/side (+end), skirt one chain per panel (8–16 panels) × 2–3 joints. Keep L/R symmetric and identically parameterized.
4. **Watch `VRMUtils.removeUnnecessaryJoints`** (if ever introduced into the load path): it can strip the empty tail nodes spring chains rely on. NikoF currently does **not** call it — keep it that way for spring-boned models, or run it carefully.

---

## 6. Colliders, tuning values, pitfalls, performance

### Colliders (stop hair/skirt clipping through the body)
- Shapes: sphere (offset+radius), capsule (offset+radius+tail; 1.0 only). Grouped; each chain references only the relevant groups.
- Placement: **head** (sphere) for hair; **chest/torso + hips** (capsules) for hair-down-the-back and skirt; **upper arms/forearms** for long hair/skirt during arm motion; **thighs** for skirts when walking/sitting.
- Assignment: hair → head+torso+arms; skirt → hips+thighs (not head). Don't assign every collider to every chain.
- **Most-cited pitfall: VRM models ship with oversized colliders** → hair floats / sticks in mid-air. Fix: **shrink collider radii ~50%** first. Tune `hitRadius` with it.

### Starting parameter values (then tune per model)
| Part | stiffness | gravityPower | dragForce | Notes |
|---|---|---|---|---|
| Hair | ~2.0 (front/short higher) | 0.3–0.5 | ~0.4 | long ponytails: lower stiffness, higher drag |
| Breast/chest | ~2.0 | **0** | ~0.5 | gravity 0 so it bounces not droops; keep subtle |
| Skirt/cloth | ~0.35 | ~0.2 | ~0.5 | soft; rely on thigh colliders |
| Ears/antennae/small accessories | ~4 | 0 | ~1.0 | stiff + damped = small twitch |

"Uncanny over-jiggle" = oscillates long after the body stops (drag too low) or amplitude too big (stiffness too low) → raise drag/stiffness for a realistic (vs exaggerated-anime) look.

### Pitfalls & fixes (most relevant to NikoF in **bold**)
- **Physics explodes / NaN / hair flies to infinity → unclamped/oversized delta.** `vrm.update()` wants **seconds** (~0.016 @60fps). **Clamp `deltaSeconds` to ≤ ~0.05 s** before passing it (NikoF's `avatarRuntime.ts:2509` does not clamp — recommended fix).
- **Jitter at variable framerate** → same clamp + deterministic order (anim before `vrm.update`, which NikoF already does).
- **Hair whips when the avatar moves/teleports → set a `center` node** (hips/root, unrelated to the chains) so the sim runs in relative space. In three-vrm, `joint.center = someObject3D`. If NikoF ever adds locomotion/repositioning, this matters; for a mostly-stationary companion it's lower priority but cheap insurance.
- **Clipping during poses** → missing arm/thigh colliders or wrong group assignment.
- **No motion on last bone** → missing end/tail node.
- **Jiggle cancelled/snapping** → a humanoid or animated bone was put in a chain, or a spring joint is also keyframed (§5).

### Performance (single ~12 GB box, fine — but keep it tidy)
- Cost ≈ O(joints × colliders-per-joint). **Collider groups are the expensive part** — keep to ~1–2 per chain, don't over-assign.
- Minimize joints per chain; one VRM's worth of hair/skirt/bust is trivial on this hardware. The risk here is *instability/jitter*, not GPU/VRAM (spring bones are CPU/JS, tiny).
- Optional: skip/throttle the spring update when the avatar is off-screen or for idle frames.

---

## 7. Recommended path for NikoF (decision order)

1. **Verify current state first.** Load each character, watch hair/skirt while idle and during an animation. Since 0.x spring data already exists and already simulates, you may just need tuning, not authoring.
2. **Land the delta clamp** (`Math.min(clock.getDelta(), 0.05)` at `avatarRuntime.ts:2509`). One line, removes the explosion failure mode, no behavior change otherwise. This touches the runtime loop — fits the "passive runtime adjustment" the user asked about and is the single highest-value change.
3. **Add a runtime "physics profile"** that, after load, walks `vrm.springBoneManager.joints` and applies per-part values (by `bone.name`) from §6. Pure JS, no model edits, instantly tunable, and reversible. Best ratio of effort to "more realistic."
4. **If parts lack bones entirely** (e.g. no bust/skirt chains in the source model), then either (a) re-author in **UniVRM or the Blender addon** and re-export, or (b) script a **pygltflib** patch of the 0.x `secondaryAnimation` (matching field shapes exactly). Re-authoring in a tool is safer for collider setup; the script is better for batch/repeatable application across all characters.
5. **Keep contracts in mind (CLAUDE.md):** the `.vrm` is a character-package asset; if NikoF ever surfaces physics params in the animation DSL or manifest, normalize the three spellings (`stiffness` / `stiffnessForce` / `stiffiness`) to one and keep it client-neutral for the future Unity frontend.

---

## Sources

**Spec / authoritative**
- VRMC_springBone 1.0 spec: https://github.com/vrm-c/vrm-specification/blob/master/specification/VRMC_springBone-1.0/README.md
- 1.0 schema dir (joint/spring/collider/colliderGroup/shape): https://github.com/vrm-c/vrm-specification/tree/master/specification/VRMC_springBone-1.0/schema
- Extended colliders (inside-sphere/capsule, plane): https://github.com/vrm-c/vrm-specification/blob/master/specification/VRMC_springBone_extended_collider-1.0/README.md
- VRM 0.x spec + schema: https://github.com/vrm-c/vrm-specification/blob/master/specification/0.0/README.md , `/specification/0.0/schema/vrm.secondaryanimation.*.schema.json`
- GLB binary format: https://github.com/KhronosGroup/glTF/blob/main/specification/2.0/specification/2.0/GLB_FORMAT.md

**Runtime (three-vrm)**
- three-vrm spring-bone source (dev): https://github.com/pixiv/three-vrm/tree/dev/packages/three-vrm-springbone
- `VRMSpringBoneManager` docs: https://pixiv.github.io/three-vrm/docs/classes/three-vrm-springbone.VRMSpringBoneManager.html
- Spring bones on scaled models: https://pixiv.github.io/three-vrm/docs/documents/spring-bones-on-scaled-models.html
- Animation/spring update-order issue: https://github.com/pixiv/three-vrm/issues/1502
- npm: https://www.npmjs.com/package/@pixiv/three-vrm-springbone

**Tooling**
- UniVRM source: https://github.com/vrm-c/UniVRM (`Assets/VRM/Runtime/SpringBone/VRMSpringBone.cs`)
- vrm.dev spring bone: https://vrm.dev/en/univrm/springbone/univrm_secondary/ ; 1.0: https://vrm.dev/en/vrm1/springbone/
- Mona UniVRM spring-bone guide: https://docs.monaverse.com/create/creating-avatars/creating-your-avatar-using-univrm/adding-spring-bones-in-univrm-optional
- VirtualCast wiki: https://wiki.virtualcast.jp/wiki/en/vrm/setting/spring
- Blender VRM addon: https://github.com/saturday06/VRM-Addon-for-Blender ; https://vrm-addon-for-blender.info
- VRoid FAQ: https://vroid.pixiv.help/hc/en-us/articles/900001027903 , https://vroid.pixiv.help/hc/en-us/articles/900006910023

**Programmatic patching**
- pygltflib: https://pypi.org/project/pygltflib/
- gltf-transform: https://gltf-transform.dev/extensions (custom-extension Discussion #573; GLB-detection issue #1390)

**Best practices / community**
- Warudo character mod (Dynamic Bone / Magica Cloth): https://docs.warudo.app/docs/modding/character-mod
- vroid-sdk locomotion/center discussion: https://github.com/pixiv/vroid-sdk-developers/discussions/157

> Note: several docs sites (vrm.dev, vroid.pixiv.help, virtualcast wiki, pixiv.github.io, deepwiki) return HTTP 403 to automated fetchers; their technical content was cross-verified against the directly-fetchable spec README, JSON schemas, and three-vrm/UniVRM source, so the claims above are corroborated rather than single-sourced.
