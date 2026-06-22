# Animation Stack Refactor — Implementation Plan (items 1 + 2 + 4 + 5 + override removal)

**Date:** 2026-06-22
**Branch:** `claude/vrm-jiggle-physics-ryl07m`
**Source:** `docs/research/ANIMATION_STACK_AUDIT.md`
**Status:** PLAN — awaiting approval before implementation.

This plans four audit items plus an approved cleanup:
- **(1)** Collapse the parallel command contract → `session.animation` is the single canonical animation seam.
- **(2)** Add an additive / upper-body overlay channel so gestures layer over idle instead of crossfading the whole body.
- **(4)** Harden LLM structured-output parsing (no silent failures, no raw-JSON-as-speech).
- **(5)** Clamp the frame delta (stability for animation + spring-bone physics).
- **(Cleanup)** Remove the character-based animation override mechanism entirely (deprecated, never used).

Work is phased so each phase is independently reviewable, lands with its own tests + baselines, and later phases build on a cleaned contract.

---

## Guiding constraints (from CLAUDE.md)

- **One canonical seam.** `POST /session/operator-command` write, `GET /session/speech-lifecycle` read for speech; **`GET /session/animation` (`session.animation`) is the canonical animation read seam.** Do not introduce a second.
- **Contracts first.** Any contract/schema change updates schemas + fixtures + stability baselines **in the same commit**. Baseline refresh here is an explicit, approved behavior change — called out per phase.
- **Backend stays engine-neutral** (no bones/paths/mixer tracks in payloads) so the future Unity client consumes the same contract.
- **Tests:** `unittest` (`.venv\Scripts\python.exe -m unittest discover -s backend/tests -t backend`), contract gate (`validate-contracts.ps1`), stability suite (`Invoke-StabilitySuite.ps1`; `-RefreshBaselines` only after approved change).

---

## Phase 0 — Frame delta clamp (item 5) · trivial, independent

**Goal:** A backgrounded tab / GC stall must not feed a huge delta into the mixer or spring-bone Verlet integrator (NaN hair / animation jumps).

**Change:**
- `frontend/src/avatar/runtime/avatarRuntime.ts:2509`
  `const deltaSeconds = clock.getDelta();` → `const deltaSeconds = Math.min(clock.getDelta(), 0.05);`
  (≈50 ms cap = down to 20 fps before slow-motion; protects both `mixer.update` and `vrm.update`/spring bones.)

**Tests/baselines:** none (pure runtime guard). Manual: `npm run build` typecheck.
**Risk:** negligible.

---

## Phase 1 — LLM structured-output hardening (item 4) · backend-only, isolated

**Goal:** Structured-parse failures must (a) never surface raw JSON as spoken text, (b) be logged, (c) degrade to a safe, intentional fallback. Today (`llm.py:565-579`) a parse failure is swallowed (`except TextGenerationInvocationError: pass`) and the raw `reply_text` (possibly a JSON blob) is spoken, with no animation/feeling and no trace.

**Changes (`backend/app/services/llm.py`):**
1. **No raw-JSON-as-speech.** In `generate()` `:565-579`, distinguish:
   - extraction returned `None` (model didn't emit JSON) → current plain-text fallback is acceptable *only if* `reply_text` isn't itself a JSON object; add a guard that, when `expect_structured_output` and the reply looks like a JSON object, returns `status="error"` with a safe spoken message instead of reading braces aloud.
   - extraction succeeded but `_normalize_structured_contract` raised (e.g., missing `reply_text`) → return `status="error"` + safe text; do **not** fall through to dumping the JSON blob.
2. **Log on every structured fallback** (`:570-571`): replace bare `pass` with a `logger.warning` including the failure reason and a truncated payload (no secrets). Use the existing logging setup in the module/app.
3. **Validate + clamp fields** in `_normalize_structured_contract` `:352-429`: clamp `feeling.intensity` and cue `intensity` to `[0,1]`; bound `duration_ms` to a sane range; ignore non-finite floats. (`_coerce_optional_float` `:345-349` returns NaN-able floats today.)
4. **Optional (recommended):** switch Ollama structured output from `"format": "json"` to a **JSON schema** (`format` accepts a schema object in current Ollama) to cut malformed payloads at the source. `:536`.

**Tests:** extend `backend/tests/` (the structured-turn flow test, `test_structured_turn_flow.py`) with: malformed JSON, valid JSON missing `reply_text`, out-of-range intensity, and a "reply is raw JSON" case → assert no braces in spoken text, `status="error"`, and a logged warning.
**Baselines:** none (no contract shape change).
**Risk:** low; behavior change only on the failure path.

---

## Phase 2 — Canonical seam + override removal (item 1 + cleanup) · contract change

**Goal:** Delete the parallel `animation.command` seam and the character-override resolution tier so the animation contract is **one semantic snapshot**, two-tier resolution (shared → fallback). This is the "bake it" phase.

### 2A · Remove the parallel `animation.command` seam (item 1)
Delete (verified unused by any frontend; web listens only to `session.animation` at `sessionAnimation.ts:100`):
- **Delete files:** `backend/app/schemas/animation_commands.py`, `backend/app/services/animation_commands.py`, and the dead frontend `frontend/src/avatar/runtime/animationCommandHandler.ts` (157 lines, imported nowhere).
- **Edit `backend/app/api/session_routes.py`:** drop imports (`:8`, `:16`), the `animation_command_translator` field on `SessionTransportRouteServices` (`~:30-38`), and the two `event_name="animation.command"` emit blocks (`:124-130`, `:145-151`) — keep only the `session.animation` frames.
- **Edit `backend/app/api/router_composition.py`:** drop import (`:15`), the dataclass field, and the `animation_command_translator=AnimationCommandTranslator()` wiring (`:513`).

### 2B · Remove the character-override tier (cleanup)
Keep `shared_library` + `fallback`; delete the middle tier and its plumbing:
- **`backend/app/services/animation.py`:** remove `character_overrides` field (`:229`) and the override branch in `_resolve_semantic()` (`:280-290`) → 2-tier resolve.
- **`backend/app/schemas/animation.py`:** remove `AnimationResolution.override_character_id` (`:51`); drop `"character_override"` from the conceptual `selected_source` values (now `"shared_library"` | `"fallback"`).
- **`backend/app/schemas/character.py`:** remove `animation_overrides` field (`:24`).
- **`backend/app/services/character.py`:** stop reading `animation_overrides` from manifest (`:81` + constructor `:69-84`).
- **`backend/app/services/turns.py`:** simplify `requested_state` "replace vs enqueue" logic that was override/idle-coupled (`:231-272`) — `replace` for base, `enqueue`/overlay for gestures (feeds Phase 3). Keep alias/keyword resolution.
- **Assets:** delete `assets/characters/*/overrides/animations.json` (+ `.meta`) — 5 files; remove `"animation_overrides"` from all 5 `manifest.json`.
- **Frontend:** in `sessionAnimation.ts:231`, `source: selected_source === "character_override" ? "override" : "shared"` becomes dead → simplify to always `"shared"` (or drop `source` from `SemanticAnimationCommand` in `shared/types/animation.ts` and `App.tsx`/`useSessionAnimationState.ts` usages).

### 2C · Contracts, fixtures, baselines (same commit)
- **`tests/contracts/schemas/character-manifest.schema.json`:** remove `animation_overrides` from `required` (`:20`) and its property (`:91-94`).
- **`tests/contracts/schemas/animation-event.schema.json`:** remove `"character-override"` from the `source_category` enum (`:42`).
- **Fixtures:** confirm none use `character-override`/`animation_overrides`; update if so.
- **Backend tests:** delete the two override tests in `backend/tests/test_animation_service.py` (`:68-93`, `:121-146`); keep shared/fallback tests.
- **Stability baselines (intentional refresh, approved change):**
  - `tests/stability/baselines/animation-contract-boundaries.json` — drop `override_character_id` from `AnimationResolution`.
  - `tests/stability/baselines/backend-session-animation-live-delivery.json` — drop `animation.command` from the SSE event surface.
  - Re-run the suite to catch `backend-stage1-contracts.json` / `bootstrap-prerequisites.json` if they reference removed surface; refresh those that legitimately changed.
- **Docs:** `docs/BACKEND_ANIMATION_CONTRACT.md` (resolution order 3-tier→2-tier `:96-99`; remove `animation.command`), and sweep `docs/ANIMATION_DSL_SCHEMA.md` / `docs/ANIMATION_DSL_WORKFLOW.md` for override mentions.

**Validation:** unittest suite green; `validate-contracts.ps1` green; stability suite green after intentional baseline refresh; `npm run build` typecheck.
**Risk:** medium (contract + baseline churn) but mechanical; shared/fallback path untouched. Land before Phase 3 so layering is built on the final contract.

---

## Phase 3 — Additive upper-body overlay channel (item 2) · the visual win

**Goal:** A gesture tagged additive/upper-body (e.g. `greet.wave.once`) plays **on top of** the maintained base idle via a second additive `AnimationMixer`, instead of crossfading the whole body. Idle keeps running; the wave layers on the arms.

### 3A · Routing signal (no new backend contract field)
Route on data already in the semantic snapshot: `playback.blend_hint` (e.g. `"upper_body_additive"`) is the canonical signal; fallback to semantic-id prefix (`gesture.` / `emote.` / `greet.` → overlay). Thread it through:
- `frontend/src/shared/types/animation.ts` — add `layer?: "base" | "upper-additive"` to `SemanticAnimationCommand` (`:28-34`).
- `frontend/src/avatar/loaders/sessionAnimation.ts:219-238` — derive `layer` from `blend_hint`/prefix in the projection (today it drops it).

### 3B · Playback bridge: second mixer + additive clips (`animationPlayback.ts`)
- Add `overlayMixer = new THREE.AnimationMixer(root)` alongside the base mixer (`:140-141`).
- `update(delta)` advances **both** mixers (`:329-331`).
- `loadClip(url, clipId, channel)` (`:234-255`): for `channel="overlay"`, run additive prep then bind on `overlayMixer` with `action.blendMode = THREE.AdditiveAnimationBlendMode`.
- **Additive clip prep — important correctness detail:** the overlay clip must be (a) made additive via `THREE.AnimationUtils.makeClipAdditive(clip)` AND (b) **masked to upper-body bones** — filter tracks to an allowlist (spine/chest/upperChest/neck/head/shoulders/arms/hands) and drop hips + legs + root position. `makeClipAdditive` alone still adds leg/hip deltas, which would make a "wave" also move the legs. Build the allowlist from `VRMHumanBoneName`.
- Channel-aware stop: `stopAllExcept(keepId, { preserveChannel })` so a base change doesn't kill overlays (`:52`, `:321-327`), and add `stopAllOverlay(fadeOutMs)`. Update the base call site `avatarRuntime.ts:2384` to `preserveChannel: "overlay"`.
- Extend `AnimationClipHandle` with `channel` (`:15-20`) and the bridge interface with overlay methods (`:46-57`).

### 3C · Runtime channel state + routing (`avatarRuntime.ts`)
- Extend `AvatarOverlayChannelId` to `"speech" | "body-gesture"` (`:43`) and add a `createBodyGestureOverlayChannel()` mirroring the speech overlay (`:440-484`, `:1662-1682`) so the control surface can show gesture state.
- Add `activateBodyGestureOverlay(command)` paralleling `activateBaseAnimation` (`:2287-2423`) — async load on the overlay channel with its own stale-guard; auto-stop/fade the overlay when its (non-loop) duration elapses or when a new base/overlay arrives.
- `play(command)` routes by `layer`: `"upper-additive"` → `activateBodyGestureOverlay`, else → `activateBaseAnimation` (`:~2990`).
- Render-loop order is already correct (single `clock.getDelta()` feeds both mixers via `playbackBridge.update`, then passives, then `vrm.update`).

### 3D · Control/debug surface
- `frontend/src/app/devDisplayTools.tsx` — tag gesture options with `layer:"upper-additive"` so the display tools exercise the overlay path; `AvatarStage.tsx` play button needs no change (routing is in `play`).

**Tests/validation:** `npm run build` typecheck; manual via display tools — trigger `greet.wave.once` while idle loops and confirm the body keeps idling while the arm waves (no whole-body swap), and that returning to idle is clean. Backend may need a tiny check that gesture commands carry an additive `blend_hint` (they do in the playback library) — add/confirm a unit assertion.
**Risk:** medium-high (most new code). Mitigations baked in: upper-body track mask (not just hips strip), channel-preserving stop, per-overlay stale-guard, delta clamp from Phase 0.

---

## Sequencing & commits

1. **Phase 0** (delta clamp) — 1 line. Commit.
2. **Phase 1** (LLM hardening) — backend + tests. Commit.
3. **Phase 2** (seam + override removal) — backend deletions, frontend dead-code + projection, contracts/fixtures/tests/baselines/docs **in one commit** (or 2A then 2B if you prefer smaller diffs).
4. **Phase 3** (additive overlay) — frontend feature + small backend assertion. Commit.

Each phase: run unittest + contract gate + stability suite (+ `npm run build`) before committing; push to the feature branch.

---

## Decisions (LOCKED 2026-06-22)

1. **Removal scope: animation-override scaffolding only.** Remove `overrides/animations.json`, `manifest.animation_overrides`, the override resolution tier, `shared_set`/`custom_only`. **Keep** all core per-character identity (`model.vrm`, `expressions/mapping.json`, `voice/profile.json`, `metadata/identity.json`).
2. **Drop the `source` field** from `SemanticAnimationCommand` and its usages (it would always be `"shared"` after removal).
3. **Defer** the Ollama JSON-schema format change. Phase 1 hardens parsing/logging/clamping only; schema-constrained output is a later follow-up.
4. **Implement phase by phase**, committing each.

## Environment note (validation gates available here)

This Linux container has **no installed deps** and the contract gate / stability suite are **PowerShell (Windows-only)**, so they cannot run here. Achievable validation: backend `unittest` (after a venv install) and the frontend `npm run build` typecheck (after `npm ci`). **Stability-baseline regeneration in Phase 2 requires the Windows harness** — baselines touched by Phase 2 are listed explicitly so they can be refreshed on the user's machine (or via the Windows CI) with `Invoke-StabilitySuite.ps1 -RefreshBaselines`.
