---
name: official-idle-wrist-follow-through
description: Keep idle.default wrist or hand follow-through validation on the existing official idle runtime seam unless the slice widens beyond the current hand proof
domain: testing
confidence: high
source: earned
updated_at: 2026-05-18T10:58:02.4627970Z
---

## Context

Use this when `idle.default` needs more visible wrist or hand follow-through, but the change is still local to official idle playback weighting rather than App routing, backend transport, exporter shape, or finger-bone wiring.

## Pattern

- Start with `frontend-avatar-idle-default-runtime`; it is the cheapest existing executable check that already covers official idle hands.
- Keep the implementation local to `frontend/src/avatar/runtime/officialPunchClipPlayback.ts` when possible.
- If the hand proof already shows explicit pitch-dominant authored-versus-rendered sign agreement but the wrists still read flat next to a stronger elbow pass, prefer a modest `LeftHand` and `RightHand` pitch-first local-rotation scale before reopening exporter, App routing, or finger binding.
- Treat `LeftHand` and `RightHand` as the wrist approval surface when the production slice only retunes hand local rotation on `official_idle_stability`.
- Require the official idle route, unchanged targeted-bone ownership, unchanged App-owned playback orchestration, and unchanged grounding proof on the same seam.
- Read the `official_idle_rendered_pose_surface` hand records, not only the top-level scenario status.
- Treat the current seam as sufficient for approval when the scenario still reports:
  - rendered excursion above threshold for the hand bones
  - explicit hand-axis sign proof
  - return to loop-start settle for the lower-arm or hand follow-through slice
  - no grounding regression on the same seam
- Require a focused proof extension before approval if the wrist slice:
  - widens beyond `LeftHand` and `RightHand` into finger bones
  - changes route selection or targeted-bone boundaries
  - depends on wrist yaw or roll fidelity that the current pitch-dominant hand proof does not directly assert

## Residual Risk

- The harness uses a fake rig and sampled runtime poses, so it can miss morphology-specific wrist silhouette drift, transient motion between sampled times, or incorrect yaw or roll behavior that still preserves the current pitch-dominant hand proof.

## Avoid

- Adding a new browser or visual system before exhausting the existing idle runtime seam.
- Approving a wrist change that implicitly relies on finger motion or a widened target set without adding proof.
- Treating a hand-bone pass as evidence of finger articulation or full wrist-axis correctness.