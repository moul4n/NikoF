#!/usr/bin/env python3
"""Analyze VRM (.vrm / GLB) models for spring-bone "jiggle physics".

Reports, per model: the VRM spec version (0.x vs 1.0), the spring-bone
chains present, their parameters, and a best-effort classification of each
chain by body region (hair / breast / skirt / tail / ear / cloth) based on
bone names. Useful for auditing which characters already have jiggle and
where it is missing or weakly tuned.

A .vrm is a glTF 2.0 GLB: 12-byte header + JSON chunk + BIN chunk. Spring
bones live entirely in the JSON chunk under `extensions`, so this reads
only the JSON chunk and never touches geometry.

Usage:
    python scripts/asset_validation/analyze-springbones.py [PATH ...]

PATH may be a .vrm file or a directory (searched recursively for *.vrm).
Defaults to assets/characters/ when no path is given.
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

# Name-keyword -> body region. Best-effort; bone naming is convention, not spec.
CATEGORIES: dict[str, list[str]] = {
    "hair": ["hair", "ahoge", "ponytail", "twintail", "sidehair", "bang",
             "fringe", "forelock"],
    "breast": ["breast", "boob", "bust", "chichi", "mune", "nipple", "oppai"],
    "skirt": ["skirt", "dress", "coat", "skart", "sukato", "hem"],
    "tail": ["tail", "shippo"],
    "ear": ["ear", "mimi"],
    "cloth/other": ["cloth", "sleeve", "ribbon", "tie", "scarf", "cape",
                    "cloak", "string", "cord", "accessory", "acc", "tassel",
                    "strap"],
}


def read_glb_json(path: str) -> dict | None:
    """Return the parsed glTF JSON chunk of a GLB/VRM file, or None."""
    with open(path, "rb") as f:
        data = f.read()
    if len(data) < 12:
        return None
    magic, _ver, length = struct.unpack("<III", data[:12])
    if magic != GLB_MAGIC:
        return None
    off = 12
    while off < length:
        clen, ctype = struct.unpack("<II", data[off:off + 8])
        off += 8
        chunk = data[off:off + clen]
        off += clen
        if ctype == CHUNK_JSON:
            return json.loads(chunk.decode("utf-8"))
    return None


def classify(name: str) -> str | None:
    n = name.lower()
    for cat, keys in CATEGORIES.items():
        if any(k in n for k in keys):
            return cat
    return None


def analyze(path: str) -> dict:
    """Return a structured summary dict for one model."""
    g = read_glb_json(path)
    if g is None:
        return {"path": path, "error": "not a GLB/VRM file"}
    nodes = g.get("nodes", [])

    def nm(i: int) -> str:
        return nodes[i].get("name", "?") if 0 <= i < len(nodes) else f"#{i}"

    exts = g.get("extensions", {})
    vrm0 = exts.get("VRM", {})
    sa = vrm0.get("secondaryAnimation", {})
    sb1 = exts.get("VRMC_springBone", {})

    spec = "1.0" if "VRMC_vrm" in exts else ("0.x" if vrm0 else "?")
    summary: dict = {
        "path": path,
        "spec": spec,
        "system": "VRMC_springBone" if sb1 else ("secondaryAnimation" if sa else "NONE"),
        "chains": [],
        "categories": {},
    }
    cat_count: dict[str, int] = {}

    if sa:
        summary["colliderGroups"] = len(sa.get("colliderGroups", []))
        for bg in sa.get("boneGroups", []):
            roots = bg.get("bones", [])
            cats = sorted({c for c in (classify(nm(r)) for r in roots) if c})
            for c in cats:
                cat_count[c] = cat_count.get(c, 0) + 1
            summary["chains"].append({
                "comment": bg.get("comment", ""),
                "roots": [nm(r) for r in roots],
                "stiffness": bg.get("stiffiness"),  # sic: 0.x schema spelling
                "dragForce": bg.get("dragForce"),
                "gravityPower": bg.get("gravityPower"),
                "hitRadius": bg.get("hitRadius"),
                "colliderGroups": len(bg.get("colliderGroups", [])),
                "categories": cats,
            })
    elif sb1:
        summary["colliderGroups"] = len(sb1.get("colliderGroups", []))
        summary["colliders"] = len(sb1.get("colliders", []))
        for sp in sb1.get("springs", []):
            joints = sp.get("joints", [])
            jnodes = [j.get("node", -1) for j in joints]
            cats = sorted({c for c in (classify(nm(n)) for n in jnodes) if c})
            for c in cats:
                cat_count[c] = cat_count.get(c, 0) + 1
            summary["chains"].append({
                "name": sp.get("name", ""),
                "joints": [nm(n) for n in jnodes],
                "colliderGroups": len(sp.get("colliderGroups", [])),
                "categories": cats,
            })

    summary["categories"] = cat_count
    return summary


def iter_vrm_paths(paths: list[str]) -> list[str]:
    out: list[str] = []
    for p in paths:
        if os.path.isdir(p):
            out.extend(sorted(glob.glob(os.path.join(p, "**", "*.vrm"), recursive=True)))
        elif p.lower().endswith(".vrm"):
            out.append(p)
    return out


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("paths", nargs="*", default=["assets/characters"],
                    help="VRM files or directories (default: assets/characters)")
    ap.add_argument("--json", action="store_true", help="emit machine-readable JSON")
    args = ap.parse_args(argv)

    files = iter_vrm_paths(args.paths or ["assets/characters"])
    if not files:
        print("no .vrm files found", file=sys.stderr)
        return 1

    results = [analyze(f) for f in files]

    if args.json:
        print(json.dumps(results, indent=2))
        return 0

    for s in results:
        print("=" * 72)
        print(s["path"])
        if s.get("error"):
            print("  error:", s["error"])
            continue
        print(f"  spec: {s['spec']} | system: {s['system']} | "
              f"chains: {len(s['chains'])} | colliderGroups: {s.get('colliderGroups', 0)}")
        for c in s["chains"]:
            label = c.get("comment") or c.get("name") or ""
            roots = c.get("roots") or c.get("joints") or []
            sample = ", ".join(roots[:3])
            params = ""
            if "stiffness" in c:
                params = (f" stiff={c['stiffness']} drag={c['dragForce']} "
                          f"grav={c['gravityPower']} hit={c['hitRadius']}")
            print(f"    - [{','.join(c['categories']) or '?'}] \"{label}\""
                  f"{params} colliders={c['colliderGroups']} :: {sample}")
        cats = s["categories"]
        present = ", ".join(f"{k}({v})" for k, v in sorted(cats.items())) or "(none detected)"
        print("  >> categories present:", present)
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
