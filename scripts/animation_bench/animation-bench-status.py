#!/usr/bin/env python3
"""Report animation coverage for the NikoF shared library.

Cross-references the DSL registry (assets/animations/dsl/shared/animations.json)
against the runtime sources actually present, so you can see, per semantic id:
  - vrma : a native clip at assets/animations/library/shared/<id>.vrma
           (the runtime prefers this; see vrmaAssetResolution.ts)
  - gen  : a generated runtime payload at assets/animations/generated/shared/<id>/
           (the Mixamo-FBX retarget path)
and flags any .vrma present but NOT registered (orphans).

Use it after dropping a converted .vrma into library/shared/ to confirm the
clip is wired, and to spot gaps. Stdlib only.

Usage:
    python scripts/animation_bench/animation-bench-status.py
"""
from __future__ import annotations

import json
import os

ROOT = os.getcwd()
REGISTRY = "assets/animations/dsl/shared/animations.json"
VRMA_DIR = "assets/animations/library/shared"
GENERATED_DIR = "assets/animations/generated/shared"

# Conversational/idle/emote clips worth having for a chat companion that the set
# commonly lacks. NOT action moves (kick, shoot, jump) — those don't fit.
SUGGESTED_GAPS = [
    "gesture.nod.once (agree / 'yes')",
    "gesture.shake.once (disagree / 'no')",
    "gesture.shrug.once (dunno / uncertain)",
    "gesture.bow.once (greeting / thanks)",
    "gesture.point.self.once (refer to self)",
    "emote.laugh.once (amused)",
    "emote.think.tap.once (pondering variant)",
    "idle.listening.loop (attentive lean while user speaks)",
    "idle.talking.loop (subtle hand motion while replying)",
]


def main() -> int:
    if not os.path.isfile(REGISTRY):
        print(f"registry not found: {REGISTRY} (run from repo root)")
        return 1

    registry = json.load(open(REGISTRY, encoding="utf-8"))
    registered = sorted(registry.get("sidecars", {}).keys())

    vrma_ids = set()
    if os.path.isdir(VRMA_DIR):
        vrma_ids = {os.path.splitext(f)[0] for f in os.listdir(VRMA_DIR) if f.endswith(".vrma")}

    def has_generated(sid: str) -> bool:
        return os.path.isdir(os.path.join(GENERATED_DIR, sid))

    print(f"Shared animation coverage ({len(registered)} registered)")
    print(f"  {'semantic id':<32} {'vrma':<6} generated")
    print("  " + "-" * 52)
    for sid in registered:
        v = "yes" if sid in vrma_ids else "-"
        g = "yes" if has_generated(sid) else "-"
        print(f"  {sid:<32} {v:<6} {g}")

    orphans = sorted(vrma_ids - set(registered))
    if orphans:
        print("\n  .vrma present but NOT registered (add the semantic id to wire it):")
        for o in orphans:
            print(f"    - {VRMA_DIR}/{o}.vrma")

    vrma_count = sum(1 for s in registered if s in vrma_ids)
    print(f"\n  native .vrma: {vrma_count}/{len(registered)} registered ids "
          f"(rest fall back to the Mixamo-FBX retarget path)")

    print("\nSuggested gap-fill clips for a chat companion (emotes / idles / conversational):")
    for s in SUGGESTED_GAPS:
        print(f"  - {s}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
