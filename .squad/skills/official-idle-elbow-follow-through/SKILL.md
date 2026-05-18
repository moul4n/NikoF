---
name: official-idle-elbow-follow-through
description: Keep idle.default elbow or lower-arm follow-through validation on the existing official idle runtime seam
domain: testing
confidence: high
source: earned
updated_at: 2026-05-18T10:39:11.4419754Z
---

## Context

Use this when `idle.default` needs more visible elbow bend or lower-arm follow-through, but the change is still local to official idle playback weighting rather than App routing, backend transport, or exporter shape.

## Pattern

- Start with `frontend-avatar-idle-default-runtime`; it is the cheapest existing executable check that already covers official idle lower arms.
- Keep the implementation local to `frontend/src/avatar/runtime/officialPunchClipPlayback.ts` when possible.
- If the generated idle payload already exports elbow-flex and lower-arm comparison quaternions but authored lower-arm excursion is still small, prefer a modest lower-arm pitch-first local-rotation scale over exporter or App-route changes.
- Require `official_idle_stability` route selection, unchanged targeted-bone ownership, and unchanged App-owned playback orchestration.
- Read the `official_idle_rendered_pose_surface` lower-arm slice, not only the top-level scenario status.
- Treat `leftLowerArm` and `rightLowerArm` as meaningfully constrained only when the scenario still reports:
  - rendered excursion above threshold
  - authored-versus-rendered pitch or roll sign agreement
  - return to loop-start settle for the lower-arm or hand follow-through slice
  - no grounding regression on the same seam
- For weighting-only elbow passes, accept a baseline refresh when the intended delta is limited to lower-arm rendered excursion or rendered-to-normalized separation and the settle or grounding booleans do not change.
- Accept a focused baseline refresh only when it is limited to the intended lower-arm or hand rendered-pose evidence.

## Residual Risk

- The harness uses a fake rig and sampled runtime poses, so it can miss morphology-specific silhouette changes or transient elbow artifacts between sampled times.

## Avoid

- Adding a new browser or visual system before exhausting the existing idle runtime seam.
- Approving a change that also alters route selection, target-bone coverage, or App-owned playback control without widening proof.
- Treating whitespace-only full-file stability diffs as semantic failures on this scenario.