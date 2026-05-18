---
name: official-idle-finger-proof
description: Keep idle.default finger review on the existing official idle runtime seam, then use the current dev display root-finger proof before adding any broader live-browser system
domain: testing
confidence: high
source: earned
updated_at: 2026-05-18T11:22:18.2082733Z
---

## Context

Use this when `idle.default` finger motion is the next requested slice after grounding, elbow, and wrist or hand retunes were approved on the existing official idle runtime seam, or when someone asks whether finger hardening now needs a true browser hook.

## Pattern

- Start with `frontend-avatar-idle-default-runtime`; it is still the cheapest nearby executable seam.
- The current scenario already samples loop start, one proof timestamp, and final frame on `official_idle_stability`, and it records root-finger rendered articulation in hand space on that same seam.
- For browser-adjacent hardening at a few timestamps, reuse that existing scenario before adding a new browser system.
- When the local playback route is `frontend/src/avatar/runtime/officialPunchClipPlayback.ts`, prefer a root-finger pass first: `leftThumbMetacarpal`, `leftIndexProximal`, `leftMiddleProximal`, `leftRingProximal`, `leftLittleProximal`, `rightThumbMetacarpal`, `rightIndexProximal`, `rightMiddleProximal`, `rightRingProximal`, and `rightLittleProximal`.
- Preserve the existing `official_idle_stability` route, hand proof, settle proof, and grounding proof while adding finger coverage.
- Do not treat generated runtime payload finger-channel presence as proof of rendered finger motion; the baseline already records `*.stretched` and `*.spread` channels without proving runtime delivery.
- If the checked-in `idle.default` sidecar does not export root-finger comparison quaternions, keep the fix local to `frontend/src/avatar/runtime/officialPunchClipPlayback.ts` by binding only the approved root fingers from the existing `*.stretched` and `*_spread` humanoid muscle channels on the official idle path instead of reopening exporter or backend transport work.
- The existing proof is explicit because it samples a rendered finger-articulation proxy on the fake rig, using a tip marker measured in hand space, so the seam fails when the route renders no finger motion even if authored channel data is present.
- Approval should continue to require explicit rendered finger proof on the same seam, asserting:
  - the intended finger slice is actually targeted or bound during official idle playback
  - sampled rendered finger excursion clears a small threshold
  - rendered motion keeps the intended authored dominant-axis sign or equivalent directional agreement
  - the added finger slice still returns near loop start
- If the remaining risk is specifically real-VRM or live-display morphology coverage that the fake-rig seam cannot answer, stay on the current dev display surface first instead of adding a new browser system.
- Start from `frontend/src/avatar/runtime/avatarRuntime.ts`: add a sibling `window.__NIKOF_AVATAR_DEBUG__.getIdleFingerSnapshot()` beside the existing punch comparison hook, and sample the loaded VRM root-finger bones at loop start, quarter, mid, three-quarter, and loop return on `official_idle_stability`.
- Surface that snapshot through `frontend/src/app/devDisplayTools.tsx`, `frontend/src/app/App.tsx`, and `frontend/src/app/surfaceShellPresentation.tsx` so the existing display rail can show peak excursion, loop return, and dominant channel sign without widening the runner stack.

## Residual Risk

- Even with the focused extension, the fake-rig sampled runtime seam can still miss morphology-specific finger silhouette drift or transient defects between sampled times.
- The dev display snapshot closes the nearest real-VRM gap for root-finger local rotations, but it still is not a screenshot-diff or full silhouette assertion across multiple real avatars.

## Avoid

- Approving finger work on green hand proofs alone.
- Reopening backend transport, exporter design, or App routing before exhausting the existing idle runtime seam.
- Treating exported finger channels as equivalent to bound or rendered finger articulation.
- Widening a first finger pass to intermediate or distal bones before root-finger proof is green on the existing seam.