---
created_at: 2026-05-18T10:15:34.1052229Z
updated_at: 2026-05-18T10:15:34.1052229Z
owner: Switch
---

# Official Idle Grounding

## Use When

- `idle.default` no longer drifts, but the avatar still looks slightly lifted off the floor.
- The frontend is using the `official_idle_stability` playback path.
- The generated runtime payload already exports lower-body comparison bones.

## Pattern

1. Check the official idle bone filter before touching root motion.
2. If the payload already carries `left/rightUpperLeg`, `left/rightLowerLeg`, `left/rightFoot`, and `left/rightToes`, retain those bone-local rotations on the official idle route.
3. Keep authored and procedural root motion disabled for `idle.default` so the drift fix stays intact.
4. Harden the existing idle stability seam by asserting that the official route still targets the lower-body ground-contact chain.
5. If the harness uses a fake VRM, make sure that fake rig actually defines the leg and foot nodes, or the check will falsely report that the lower-body chain is absent.

## Avoid

- Reopening backend semantic animation transport when the payload already exports the needed lower-body bones.
- Reintroducing pelvis or root motion just to force feet downward.
- Trusting a fake rig that only contains torso and arm nodes for foot-contact regression coverage.