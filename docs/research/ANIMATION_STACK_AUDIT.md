# Animation Stack — End-to-End Audit & Stabilization Plan

**Date:** 2026-06-22
**Scope:** Full pass on how NikoF stores, selects, activates, transitions, and renders avatar animation — LLM trigger → backend resolution → SSE → frontend three-vrm runtime — plus optimisations and a plan to "bake" a stable animation stack for future features. Includes a VRM spring-bone (jiggle) inventory of the bundled characters.

> **Headline:** The stack is more mature than expected. The frontend already **crossfades** (no hard cuts), with adaptive timing, async-load guards, and stale-command guards. The backend is a clean **semantic, engine-neutral** contract (good for the future Unity client). The real weaknesses are **architectural, not cosmetic**: (1) a **parallel, unused command contract** the web client ignores; (2) **no additive/upper-body layering** — gesture cues crossfade the whole body instead of overlaying on idle; (3) **character overrides are declared but never loaded**; (4) **brittle LLM JSON parsing that fails silently**; (5) an **unclamped frame delta** that risks physics/animation instability. Fixing 1–3 is what "bakes" the stack so future features stay stable.

---

## 1. The end-to-end flow (as it actually runs today)

```
LLM (Ollama, format=json)
  └─ returns { reply_text, feeling{name,intensity}, animation_cues[], voice_tone, ... }
        │  llm.py: _extract_json_object() (regex+bracket)  → _normalize_structured_contract()
        ▼
turns.py  (backend turn pipeline)
  ├─ _resolve_assistant_animation_choice():  explicit semantic_id  → keyword-priority rules → alias table → none
  ├─ animation.py resolve_intent():  shared library → character override [DEAD] → fallback idle.neutral
  │     + playback metadata (loop/oneshot, blend_hint, duration_ms)
  └─ publish SessionAnimationSnapshot → InMemory live delivery
        ▼
SSE  GET /session/animation   (session_routes.py)
  ├─ emits  event: session.animation   (semantic snapshot)        ◀── consumed by web
  └─ emits  event: animation.command   (thin Play/Crossfade)      ◀── NOT consumed by web (dead on web)
        ▼
frontend  sessionAnimation.ts  (listens to session.animation only)
  └─ consumeSessionAnimationSnapshot → semanticCommand{ id, source, playback, intensity, durationMs }   ⟵ drops layer/requested_state
        ▼
avatarRuntime.ts  runtime.play(command) → activateBaseAnimation()   (SINGLE base channel)
  ├─ adaptive transitionMs (260–520ms oneshot / 320ms loop / 500–760ms return-to-idle)
  ├─ async load (VRMA or Mixamo-FBX retarget) with stale-command guard (expectedCommandId)
  └─ animationPlayback bridge:  action.fadeIn / fadeOut / crossFadeTo  +  stopAllExcept
        ▼
render loop (renderFrame):  updateBaseAnimation → passive blink/mouth/eye/emotion → speech viseme reaction → vrm.update(delta)
  └─ vrm.update applies humanoid pose + expressions + SPRING BONES (jiggle)
```

Key file anchors (verified):
- Backend dual emit: `backend/app/api/session_routes.py:128` (`session.animation`), `:149` (`animation.command`).
- Frontend subscribes to semantic only: `frontend/src/avatar/loaders/sessionAnimation.ts:100`, parse `:130-143`, projection `:219-238` (no `layer`).
- Single base channel + speech-only overlay: `avatarRuntime.ts:482` (`overlayChannels:[createSpeechOverlayChannel()]`), activate `:2287-2423`, `stopAllExcept` `:2384`.
- Crossfade primitives: `animationPlayback.ts:279` (`fadeIn`), `:294` (`fadeOut`), `:312` (`crossFadeTo`).
- Render loop order: `avatarRuntime.ts:2505-2541`; `vrm.update` `:2530`; unclamped delta `:2509`.

---

## 2. What's already good — do NOT regress these

These are earned wins; treat them as load-bearing:

1. **Crossfade everywhere, no hard cuts.** Base transitions use `crossFadeTo`/`fadeIn`/`fadeOut` with adaptive durations; the previous clip keeps playing until the new clip finishes loading, then blends. (`avatarRuntime.ts:2327-2386`, `animationPlayback.ts:257-313`.)
2. **Stale-command guard.** Async loads check `activeBaseAnimation.command.id === expectedCommandId` and abandon superseded loads — close-together commands don't double-activate. (`avatarRuntime.ts:2339,2356`.)
3. **`stopAllExcept`** prevents orphaned clips blending in after overlapping async activations. (`avatarRuntime.ts:2384`.)
4. **Semantic, engine-neutral backend contract.** Backend never ships bones/paths/mixer tracks — only semantic IDs + playback hints. This is exactly right for the future Unity client (a second consumer of the same contract).
5. **Layered passive expression system** (blink, mouth idle, eye micro-saccades, emotion) with **speech-priority** (speech visemes written last, passive mouth suppressed during speech). Smooth envelopes, not steps. (`avatarRuntime.ts:2516-2530`, `passive*.ts`.)
6. **SSE with snapshot-polling fallback** and clean reconnect. (`sessionAnimation.ts:84-118`.)

---

## 3. Findings & optimisations (prioritised)

### P0 — bake these to stabilise the stack for all future features

**P0-1 · Collapse the parallel command contract (one canonical seam).**
The backend computes and emits `animation.command` (`PlayAnimationCommand`/`CrossfadeCommand` via `AnimationCommandTranslator`) on every frame of the SSE stream, but the web client **only** reads `session.animation`. So:
- The server-side crossfade/transition decision (`animation_commands.py:66-103`) is **dead on the web** and **duplicates** the client-side decision in `activateBaseAnimation`. Two places now own "how do we transition," which will drift.
- This is precisely the "don't invent parallel contracts for playback" rule in CLAUDE.md.
- **Decision needed (pick one and document it):**
  - **(A) Semantic-only seam (recommended).** Make `session.animation` the single canonical animation seam; the client owns transition mechanics (as it already does well). Stop emitting `animation.command`, delete/retire `AnimationCommandTranslator`, or demote it to an internal detail. Simplest, removes drift, matches how the web client already works.
  - **(B) Thin-command seam.** Make the client consume `animation.command` and move transition authority to the backend. Heavier; throws away the good adaptive client logic; only worth it if you want Unity + web to share identical server-driven transitions.
- Either way: **one** contract, documented as canonical, with stability baselines updated. This is the single most important "bake it at the highest level" item because every future animation feature will otherwise have to choose between two seams.

**P0-2 · Implement additive / upper-body layering (the real anti-jank fix).**
Today every cue — including `upper_body_additive` gestures like `greet.wave.once` — is funneled through the single base channel and **crossfades the whole body to the gesture and back to idle**. That whole-body swap *is* the "janky override" you're describing. The backend already models this correctly (`blend_hint` / `layer` = base vs additive, `requested_state` = replace vs enqueue), but the frontend **drops `layer`** (`sessionAnimation.ts:229-238`) and has no additive channel for body motion (only speech overlays).
- **Fix shape:** add a second `AnimationMixer`-backed body overlay channel that plays upper-body/additive clips on top of the maintained base idle, using three.js additive blending (`THREE.AnimationUtils.makeClipAdditive` + `action.blendMode = THREE.AdditiveAnimationBlendMode`) or a masked upper-body action. Carry `layer` (and `requested_state`) through `semanticCommand` so `layer:"upper"` routes to the overlay channel instead of `activateBaseAnimation`.
- Result: idle body keeps running; the wave layers on the arms; no full-body crossfade. This is the highest-value visual-quality change and the foundation every future gesture relies on.

**P0-3 · Load character animation overrides from disk.**
`assets/characters/*/overrides/animations.json` exist and `_resolve_semantic()` has the override branch, but `DefaultAnimationService.character_overrides` is **never populated** (`router_composition.py` build path), so the override tier is dead code. Wire manifest → overrides into the service at composition time. Without this, per-character animation customisation silently no-ops — a trap for every future character.

### P1 — robustness & correctness

**P1-1 · Harden LLM structured-output parsing.** `_extract_json_object` is regex+bracket and `_normalize_structured_contract` exceptions are **swallowed silently** (`llm.py` ~:570), so a single malformed reply drops *all* animation + feeling with no signal. Add: schema validation, a logged warning on fallback, and a deterministic default cue (e.g., keep current base / `idle.neutral`) so the avatar never goes inert without trace. Consider Ollama JSON-schema/structured-output mode to reduce malformed payloads.

**P1-2 · Clamp the frame delta.** `avatarRuntime.ts:2509` passes raw `clock.getDelta()` to `vrm.update()` and the mixer. A backgrounded tab / GC stall yields a huge delta → spring-bone Verlet can explode (NaN hair) and animation can jump. One line: `const deltaSeconds = Math.min(clock.getDelta(), 0.05);`. Helps both jiggle and animation stability. (Also the #1 fix from the jiggle research.)

**P1-3 · `speak` lifecycle maps to `idle.neutral`, not `speak.loop`.** `SESSION_LIFECYCLE_TO_SEMANTIC_ID` maps `speak → idle.neutral` while `speak.loop` is defined but unused (`animation.py`). Decide whether speaking should have a talking body loop; if intentional, add a comment so it isn't "fixed" later by accident.

**P1-4 · Animation feedback loop.** Backend has no signal for "clip failed to load / finished / is playing." It can't observe playback state, so it can't make smart enqueue/replace decisions. Add a lightweight client→backend animation-state event (started/looping/ended/failed) to close the loop — needed before any server-side queueing is trustworthy.

### P2 — quality / future-proofing

- **P2-1 · Make alias/keyword mapping data-driven.** The alias table and keyword-priority rules are hard-coded in `turns.py`. Move to a config/contract so new animations don't require pipeline edits and so the Unity client can share them.
- **P2-2 · Feeling-state continuity.** `feeling` is recomputed per turn with no persistence; idle is lifecycle-driven only. A decaying mood state would let idle reflect emotional context between turns (ties into `passiveEmotion`).
- **P2-3 · Durable live delivery.** `InMemorySessionAnimationLiveDeliveryService` loses cursor/state on restart. Fine for now; revisit if sessions must survive backend bounce.
- **P2-4 · Transition curve metadata.** DSL has `fade_in_ms`/`fade_out_ms` (durations) but no easing/curve. If you want per-animation feel (snappy emote vs slow settle), add an easing hint to the contract and honour it in the bridge.
- **P2-5 · Expression-weight arbitration.** Passive layers + speech are "last-writer-wins" on expression weights. It works because speech writes last, but an explicit priority/owner model would prevent future layers (e.g., LLM-driven facial emotion) from fighting passives.

---

## 4. "Bake it at the highest level" — recommended target architecture

A stable, future-proof animation stack rests on three guarantees:

1. **One canonical animation seam** (P0-1). All animation intent flows through `session.animation` (semantic). Transition mechanics live in exactly one place (the client runtime). Document it in `docs/BACKEND_ANIMATION_CONTRACT.md` and lock it with a stability baseline.

2. **A small, explicit channel/layer model** shared by backend contract and frontend runtime:
   - `base` (full-body, looping idle/locomotion/dance) — single channel, crossfaded.
   - `overlay.body` (upper-body/additive one-shots: wave, clap, point) — additive, layered over base (P0-2).
   - `overlay.face` (expressions/emotion) — the existing passive+speech expression layers.
   - `physics` (spring bones) — runs last in `vrm.update`, never animated directly (the jiggle rule).
   Every cue declares which channel it targets; `replace` vs `enqueue` only ever applies *within* a channel. This is the structural fix that makes "no janky clash" a property of the system rather than per-feature tuning.

3. **A feedback loop** (P1-4): client reports channel state so the backend can resolve intents against what's actually playing.

With those three in place, future features (new gestures, emotion-driven idle, lip-sync upgrades, the Unity client) plug into named channels with one contract — no new seams, no whole-body clashes.

---

## 5. Jiggle physics — spring-bone inventory of bundled characters

You asked whether a VRM can be analysed for hair/breast/"skin" spring bones. **Yes** — a `.vrm` is a glTF GLB whose spring data lives in the JSON chunk, readable without touching geometry. I built a reusable analyzer (`scripts/asset_validation/analyze-springbones.py`) and ran it on all five characters.

**Result: every bundled model already has extensive spring bones (VRM 0.x `secondaryAnimation`).** None lack jiggle:

| Model | Spec | Chains | Hair | Breast/bust | Skirt | Other |
|---|---|---|---|---|---|---|
| maria | 0.x | 22 | 14 | ✅ bust01_l/r (stiff 0.4 / drag 0.7) | 4 | cat ears ×2 |
| test-vrm-01 | 0.x | 22 | 16 | ✅ J_Sec_*_Bust1 (drag 0.05) | 5 | coat skirt |
| test-vrm-02 | 0.x | 23 | 14 | ✅ (drag 0.05) | 4 | cat ears, cat tail ×2, sleeves |
| test-vrm-03 | 0.x | 14 | 11 | ✅ | 1 | cat ears |
| test-vrm-04 | 0.x | 13 | 10 | ✅ | 1 | sleeves |

Notes:
- There is no literal "skin" soft-body in VRM; flesh/jiggle is carried by **bust** bones (present everywhere) plus cloth chains (skirt/sleeve). So "hair / breast / skin-based" jiggle is all present.
- **Feel already varies per model:** maria's bust is gently damped (stiffness 0.4 / drag 0.7 = subtle), while test-vrm-01/02 use drag 0.05 (looser, bouncier). This is a tuning surface, not a missing-capability problem.
- These spring bones are **already simulated** at runtime — `vrm.update(deltaSeconds)` drives them every frame (`avatarRuntime.ts:2530`). So "adding jiggle" for NikoF is really **tuning** existing chains (cheap, runtime-only) — see `docs/research/VRM_JIGGLE_PHYSICS.md`.

Run it yourself anytime:
```bash
python3 scripts/asset_validation/analyze-springbones.py            # all characters
python3 scripts/asset_validation/analyze-springbones.py --json     # machine-readable
```

---

## 6. Suggested sequencing

1. **P1-2 delta clamp** — 1 line, removes a latent explosion class (helps animation + jiggle). Do first.
2. **P0-3 character overrides loader** — unblocks per-character animation; small, contained backend change.
3. **P0-1 canonical seam decision** — pick semantic-only (A) and retire the dead `animation.command` path; update the contract doc + baselines. Mostly deletion + documentation.
4. **P0-2 additive overlay channel** — the big visual win; needs frontend channel work + carrying `layer` through `semanticCommand`. Land after the seam is canonical so it's built once, on the right contract.
5. **P1-1 LLM parse hardening** + **P1-4 feedback loop** — robustness once the structure is right.
6. P2 items as polish.

---

## Appendix — key files

**Backend:** `services/turns.py` (cue resolution `:38-272`, turn integration `:596-720`), `services/animation.py` (resolution + library + live delivery), `services/animation_commands.py` (translator — candidate for retirement), `schemas/animation.py`, `schemas/animation_commands.py`, `api/session_routes.py` (`:41-171`), `api/router_composition.py` (override-load gap), `services/llm.py` (`:291-429` parse, `:518-579` generate).

**Frontend:** `avatar/loaders/sessionAnimation.ts` (consume + projection), `avatar/runtime/avatarRuntime.ts` (`activateBaseAnimation :2287-2423`, render loop `:2505-2541`), `avatar/runtime/animationPlayback.ts` (mixer + crossfade), `avatar/runtime/passive*.ts`, `app/App.tsx` (`:167-184` play wiring), `shared/types/animation.ts`.

**Assets/contracts:** `assets/animations/` (DSL tree), `assets/characters/*/overrides/animations.json`, `tests/contracts/schemas/`, `docs/ANIMATION_DSL_SCHEMA.md`, `docs/BACKEND_ANIMATION_CONTRACT.md`.

**Tools:** `scripts/asset_validation/analyze-springbones.py` (spring-bone inventory), `docs/research/VRM_JIGGLE_PHYSICS.md` (jiggle research).
