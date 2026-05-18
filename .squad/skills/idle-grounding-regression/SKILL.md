---
name: idle-grounding-regression
description: Keep idle.default grounding regressions on the existing frontend stability seam
domain: testing
confidence: high
source: earned
updated_at: 2026-05-18T10:26:38.8609715Z
---

## Context

Use this when `idle.default` visually floats above the floor or loses grounded stance while the existing frontend runtime stability scenario still passes.

## Pattern

- Start with `frontend-avatar-idle-default-runtime`; it is the cheapest executable seam for idle runtime regressions.
- Do not add a new test harness if the bug is about idle grounding on the existing runtime path.
- Keep the assertion adjacent to the current official idle rendered-pose proof so route selection, playback, and grounding stay in one focused scenario.
- Assert world-space grounding, not only local bone rotations. A torso-only or arm-only rendered-pose proof can stay green while both feet float together.
- Reuse the runtime's own grounding contact set: `LeftFoot`, `RightFoot`, `LeftToes`, and `RightToes`.
- Record loop-start grounded world-space Y and sampled grounded world-space Y for those contact points after the same grounding path the runtime calls.
- Fail when the sampled minimum grounded contact point is above a tight zero-floor epsilon, or when a foot contact point drifts upward from its grounded loop-start value beyond that epsilon.
- If the minimum contact point stays at floor height only because a toe remains lowest while both feet rise, fix the idle floor-grounding controller locally before reopening official idle export or App orchestration.
- When both feet and toes are present, prefer feet when resolving the idle grounding floor height; otherwise toe-tip anchoring can hide floating feet while the broad idle seam still looks green.

## Notes

- `grounded_loop_start_contact_points_touch_floor` is a harness-sanity check, not the primary acceptance gate. The must-have regression proof is sampled grounded minimum contact plus no upward foot drift from the grounded loop-start sample.


## Anti-Patterns

- Adding a brand-new browser E2E or visual-diff system before extending the existing stability scenario.
- Approving an idle-grounding fix on the strength of torso, arm, or local-rotation assertions alone.
- Using only authored `FootT.*` or `RootT.*` channels as proof of grounded output without checking post-grounding world-space contact.