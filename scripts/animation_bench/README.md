# Animation Bench — adding VRM animations to NikoF

A small, dependency-free bench for **adding base animations** (idles, emotes,
conversational gestures) to the shared library and wiring them into the runtime.
Standardises on **VRM Animation (`.vrma`)** as the runtime format.

## How the runtime resolves an animation

For a semantic id (e.g. `greet.wave.once`) the frontend resolves a clip in this order
(`frontend/src/avatar/runtime/vrmaAssetResolution.ts` → `avatarRuntime.ts`):

1. **Native `.vrma`** at `assets/animations/library/shared/<semantic-id>.vrma` (preferred).
2. **Mixamo FBX retarget** — the generated payload under
   `assets/animations/generated/shared/<semantic-id>/`, retargeted at runtime
   from a `raw/*.fbx` (rotation-only; `animationPlayback.ts`).

So **dropping `<semantic-id>.vrma` into `library/shared/` upgrades that clip to a
native VRMA** with no other code change — it's preferred over the FBX path.

Run `python scripts/animation_bench/animation-bench-status.py` to see, per id,
whether a native `.vrma` or only the FBX/generated path is present, plus orphans.

## Bench tools (stdlib only, no install)

| Tool | What it does |
|---|---|
| `validate-vrma.py <path\|dir>` | Confirms a file is a well-formed `.vrma` (GLB **or** JSON glTF) with `VRMC_vrm_animation`; reports humanoid bones mapped, duration, expression/lookAt tracks. Run this on every clip before adding it. |
| `animation-bench-status.py` | Coverage dashboard: registered ids × (native vrma / generated FBX), orphan `.vrma`, and suggested gap-fill clips. |

```bash
.venv/Scripts/python.exe scripts/animation_bench/validate-vrma.py path/to/clip.vrma
.venv/Scripts/python.exe scripts/animation_bench/animation-bench-status.py
```

## Where to get animations (and licensing)

| Source | Format | Cost | Notes |
|---|---|---|---|
| [pixiv/VRoid official VRMA set](https://vroid.booth.pm/items/5512385) | `.vrma` ×7 | Free | Authored for VRM → zero retarget artifacts. Commercial OK **with credit** "pixiv Inc. VRoid Project"; don't redistribute raw files. Best clean starting set. |
| [Mixamo](https://www.mixamo.com) | `.fbx` | Free (Adobe login) | The workhorse for gestures/idles. Royalty-free, no credit; no standalone redistribution. **Needs your Adobe login — can't be fetched headlessly.** |
| [CMU Mocap (cgspeed BVH)](https://sites.google.com/a/cgspeed.com/cgspeed/motion-capture/the-daz-friendly-bvh-release-of-cmus-motion-capture-database) | `.bvh` | Free | Large; may need cleanup. Free for any use, can't resell the data. |
| [BOOTH `.vrma` packs](https://booth.pm/en) (search "vrma") | `.vrma` | Mostly paid | Per-pack license — read each. |

For a **local-only personal companion** all of the above are fine; just don't
publish raw pixiv/Mixamo files or resell CMU data.

## Converting to `.vrma`

Pick a **vetted** converter (none are bundled here — they pull native binaries):

- **FBX → VRMA (recommended): [VRM Add-on for Blender](https://vrm-addon-for-blender.info/en-us/ui/export_scene.vrma/)** —
  import the Mixamo FBX onto a VRM armature, `File → Export → VRM Animation (.vrma)`.
  Also the place to **hand-fix** any clip before export.
- **BVH → VRMA: [vrm-c/bvh2vrma](https://vrm-c.github.io/bvh2vrma/)** — official browser tool.
- **FBX → VRMA (CLI, optional): [tk256ailab/fbx2vrma-converter](https://github.com/tk256ailab/fbx2vrma-converter)** (MIT).
  > ⚠️ Installing this runs npm lifecycle scripts and auto-downloads FBX2glTF (a
  > native binary). It is **not** installed by this repo — approve it explicitly
  > before adding it as a bench dependency.

Name the output exactly `<semantic-id>.vrma`.

## Registering a new clip

1. Put `<semantic-id>.vrma` in `assets/animations/library/shared/` and run
   `validate-vrma.py` on it (must PASS).
2. **Frontend** — add the id to `semanticAnimationIds` in
   `frontend/src/shared/types/animation.ts`.
3. **Backend** — add it to `DEFAULT_SHARED_ANIMATION_IDS` and a
   `DEFAULT_PLAYBACK_LIBRARY[<id>]` entry (mode/loop/blend_hint/duration) in
   `backend/app/services/animation.py`.
4. **DSL registry** — add a `sidecars[<id>]` entry in
   `assets/animations/dsl/shared/animations.json`.
5. *(Optional, for LLM-driven triggering)* — add a cue alias/keyword rule in
   `backend/app/services/turns_animation.py` and mention the id in
   `backend/app/services/turns_prompts.py`.
6. Re-run `animation-bench-status.py` (should show `vrma: yes`), then
   `cd frontend && npm run build` and the backend unittest.

> Contracts/baselines: shared-animation lists are sampled, not exhaustively
> snapshotted, so adding an id usually needs no baseline refresh — confirm with
> `validate-contracts.ps1` and the stability suite.

## Caveats (earned)

- **Rotation-only retarget can't guarantee contact.** Avoid clips whose look
  depends on two hands meeting or hand-to-body contact (clap, prayer, arms
  crossed) — they interpenetrate and differ per character. `gesture.clap.once`
  was removed for exactly this reason.
- **Gestures play full-body.** We do not layer upper-body overlays (the additive
  approach didn't fit these holistic clips); a gesture crossfades the whole body
  and returns to idle. Prefer self-contained clips that start and end near a
  neutral standing pose.
- **For a chat companion, prefer** emotes, idles, and conversational gestures
  (nod, shake, shrug, bow, think, laugh, listening/talking idles). Skip action
  moves (kick, shoot, jump) — they don't fit the use case.
