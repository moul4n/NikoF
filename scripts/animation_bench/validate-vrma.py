#!/usr/bin/env python3
"""Validate a VRM Animation (.vrma) file for the NikoF runtime.

A .vrma is a glTF 2.0 GLB carrying the `VRMC_vrm_animation` extension: humanoid
bone rotation tracks (plus optional expression / lookAt tracks) keyed to the VRM
humanoid bone map, so one clip plays on any VRM. This checks that a candidate
file is a well-formed .vrma our @pixiv/three-vrm-animation loader can consume,
and prints a summary (humanoid bones mapped, duration, expression/lookAt tracks).

Reads only the glTF JSON chunk + accessor metadata — no geometry, no deps.

Usage:
    python scripts/animation_bench/validate-vrma.py PATH [PATH ...]
    python scripts/animation_bench/validate-vrma.py assets/animations/library/shared
    python scripts/animation_bench/validate-vrma.py --json PATH
Exit code is non-zero if any file fails validation.
"""
from __future__ import annotations

import argparse
import glob
import json
import os
import struct
import sys

GLB_MAGIC = 0x46546C67
CHUNK_JSON = 0x4E4F534A

# The VRM 1.0 humanoid required bones (subset most clips should carry). Missing
# optional bones (fingers, eyes) is fine; missing these reads as a weak retarget.
CORE_HUMAN_BONES = [
    "hips", "spine", "chest", "neck", "head",
    "leftUpperArm", "leftLowerArm", "leftHand",
    "rightUpperArm", "rightLowerArm", "rightHand",
    "leftUpperLeg", "leftLowerLeg", "leftFoot",
    "rightUpperLeg", "rightLowerLeg", "rightFoot",
]


def read_gltf_document(path: str) -> dict | None:
    """Parse a .vrma as either binary GLB or JSON glTF — the runtime loads both."""
    with open(path, "rb") as f:
        data = f.read()
    if len(data) < 12:
        return None
    magic = struct.unpack("<I", data[:4])[0]
    if magic == GLB_MAGIC:
        _ver, length = struct.unpack("<II", data[4:12])
        off = 12
        while off < length:
            clen, ctype = struct.unpack("<II", data[off:off + 8])
            off += 8
            if ctype == CHUNK_JSON:
                return json.loads(data[off:off + clen].decode("utf-8"))
            off += clen
        return None
    # JSON glTF (.gltf-form .vrma)
    if data.lstrip()[:1] == b"{":
        try:
            return json.loads(data.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            return None
    return None


def estimate_duration_s(g: dict) -> float | None:
    """Longest animation sampler input time, from accessor `max` (no binary read)."""
    accessors = g.get("accessors", [])
    longest = 0.0
    found = False
    for anim in g.get("animations", []):
        for sampler in anim.get("samplers", []):
            acc = accessors[sampler["input"]] if 0 <= sampler.get("input", -1) < len(accessors) else None
            if acc and isinstance(acc.get("max"), list) and acc["max"]:
                found = True
                longest = max(longest, float(acc["max"][0]))
    return longest if found else None


def validate(path: str) -> dict:
    result: dict = {"path": path, "ok": False, "errors": [], "warnings": []}
    g = read_gltf_document(path)
    if g is None:
        result["errors"].append("not a valid .vrma (not GLB or JSON glTF)")
        return result

    exts = g.get("extensions", {})
    if "VRMC_vrm_animation" not in exts:
        result["errors"].append("missing VRMC_vrm_animation extension (not a VRM Animation)")
        return result
    if "VRMC_vrm_animation" not in g.get("extensionsUsed", []):
        result["warnings"].append("VRMC_vrm_animation not listed in extensionsUsed")

    vrma = exts["VRMC_vrm_animation"]
    human_bones = vrma.get("humanoid", {}).get("humanBones", {})
    expressions = vrma.get("expressions", {})
    look_at = vrma.get("lookAt")
    anims = g.get("animations", [])

    result["spec_version"] = vrma.get("specVersion")
    result["animation_count"] = len(anims)
    result["humanoid_bones_mapped"] = len(human_bones)
    result["expression_tracks"] = len((expressions or {}).get("preset", {})) + len((expressions or {}).get("custom", {}))
    result["has_lookat"] = look_at is not None
    result["duration_s"] = estimate_duration_s(g)

    if not anims:
        result["errors"].append("no animations[] in the glTF")
    missing_core = [b for b in CORE_HUMAN_BONES if b not in human_bones]
    if "hips" not in human_bones:
        result["errors"].append("humanoid.humanBones has no 'hips' — cannot retarget")
    elif missing_core:
        result["warnings"].append(f"missing core humanoid bones: {', '.join(missing_core)}")
    if result["duration_s"] is not None and result["duration_s"] <= 0:
        result["warnings"].append("animation duration is 0s")

    result["ok"] = not result["errors"]
    return result


def iter_paths(paths: list[str]) -> list[str]:
    out: list[str] = []
    for p in paths:
        if os.path.isdir(p):
            out.extend(sorted(glob.glob(os.path.join(p, "**", "*.vrma"), recursive=True)))
        else:
            out.append(p)
    return out


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("paths", nargs="+", help=".vrma files or directories")
    ap.add_argument("--json", action="store_true", help="emit machine-readable JSON")
    args = ap.parse_args(argv)

    files = iter_paths(args.paths)
    if not files:
        print("no .vrma files found", file=sys.stderr)
        return 1

    results = [validate(f) for f in files]
    if args.json:
        print(json.dumps(results, indent=2))
        return 0 if all(r["ok"] for r in results) else 1

    for r in results:
        status = "PASS" if r["ok"] else "FAIL"
        print(f"[{status}] {r['path']}")
        if r.get("animation_count") is not None and "VRMC" not in str(r.get("errors")):
            dur = r.get("duration_s")
            print(f"        spec={r.get('spec_version')} anims={r.get('animation_count')} "
                  f"bones={r.get('humanoid_bones_mapped')} "
                  f"expr={r.get('expression_tracks')} lookAt={r.get('has_lookat')} "
                  f"duration={dur:.2f}s" if dur is not None else
                  f"        spec={r.get('spec_version')} anims={r.get('animation_count')} "
                  f"bones={r.get('humanoid_bones_mapped')} duration=?")
        for e in r["errors"]:
            print(f"        ERROR: {e}")
        for w in r["warnings"]:
            print(f"        warn:  {w}")

    failed = [r for r in results if not r["ok"]]
    print(f"\n{len(results) - len(failed)}/{len(results)} valid"
          + (f", {len(failed)} FAILED" if failed else ""))
    return 0 if not failed else 1


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
