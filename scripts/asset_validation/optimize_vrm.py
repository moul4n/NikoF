"""Surgically shrink a VRM (glTF binary) below GitHub's 100 MB blob cap without
losing model capabilities.

Two reductions, both index-preserving so the VRM 0.x extension (materials,
blendshape binds, firstPerson, humanoid, meta) and every mesh.extras.targetNames
survive untouched:

  1. Drop morph-target NORMAL deltas (keep POSITION). three.js renders morphs
     fine without morphed normals; on a toon-shaded avatar the difference is
     invisible. This is lossless to shape and keeps every morph/expression/
     wardrobe control.
  2. Downscale oversized textures (>maxTexture px) and shrink the unused VRM
     thumbnail. RGB images are re-encoded as JPEG, RGBA kept as optimized PNG.

The bin chunk, bufferViews and accessors are rebuilt from scratch with a full
old->new accessor remap, so dropping/repacking never corrupts references.

Usage:
    python optimize_vrm.py <in.vrm> <out.vrm> [--max-texture 2048] [--icon 512]
"""

from __future__ import annotations

import argparse
import io
import json
import struct
from pathlib import Path

from PIL import Image

COMPONENT_SIZE = {5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4}
TYPE_COUNT = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4, "MAT4": 16}
GLB_MAGIC = 0x46546C67
JSON_CHUNK = 0x4E4F534A
BIN_CHUNK = 0x004E4942


def read_glb(path: Path):
    data = path.read_bytes()
    magic, _ver, length = struct.unpack("<III", data[:12])
    assert magic == GLB_MAGIC, "not a GLB/VRM file"
    off = 12
    gltf = None
    binc = b""
    while off < length:
        clen, ctype = struct.unpack("<II", data[off : off + 8])
        chunk = data[off + 8 : off + 8 + clen]
        if ctype == JSON_CHUNK:
            gltf = json.loads(chunk.decode("utf-8"))
        elif ctype == BIN_CHUNK:
            binc = chunk
        off += 8 + clen
    assert gltf is not None
    return gltf, binc


def pad4(n: int) -> int:
    return (n + 3) & ~3


def accessor_element_bytes(gltf, binc, ai: int) -> bytes:
    """Return the accessor's data tightly packed (de-interleaved)."""
    acc = gltf["accessors"][ai]
    count = acc["count"]
    comp = acc["componentType"]
    ncomp = TYPE_COUNT[acc["type"]]
    elem_size = ncomp * COMPONENT_SIZE[comp]
    bv = gltf["bufferViews"][acc["bufferView"]]
    base = bv.get("byteOffset", 0) + acc.get("byteOffset", 0)
    stride = bv.get("byteStride") or elem_size
    if stride == elem_size:
        return bytes(binc[base : base + count * elem_size])
    out = bytearray(count * elem_size)
    for i in range(count):
        src = base + i * stride
        out[i * elem_size : (i + 1) * elem_size] = binc[src : src + elem_size]
    return bytes(out)


def encode_image(raw: bytes, max_dim: int) -> tuple[bytes, str]:
    img = Image.open(io.BytesIO(raw))
    img.load()
    w, h = img.size
    scale = max(w, h) / max_dim
    if scale > 1:
        img = img.resize((max(1, int(w / scale)), max(1, int(h / scale))), Image.LANCZOS)
    has_alpha = img.mode in ("RGBA", "LA") or (img.mode == "P" and "transparency" in img.info)
    out = io.BytesIO()
    if has_alpha:
        img.convert("RGBA").save(out, format="PNG", optimize=True)
        return out.getvalue(), "image/png"
    img.convert("RGB").save(out, format="JPEG", quality=90, optimize=True)
    return out.getvalue(), "image/jpeg"


def optimize(in_path: Path, out_path: Path, max_texture: int, icon_dim: int) -> None:
    gltf, binc = read_glb(in_path)
    accessors = gltf["accessors"]
    images = gltf.get("images", [])

    # 1. Identify morph-target NORMAL accessors to drop, and all "kept" accessors.
    morph_normal: set[int] = set()
    referenced_elsewhere: set[int] = set()
    for mesh in gltf["meshes"]:
        for prim in mesh["primitives"]:
            if "indices" in prim:
                referenced_elsewhere.add(prim["indices"])
            for ai in prim.get("attributes", {}).values():
                referenced_elsewhere.add(ai)
            for target in prim.get("targets", []) or []:
                if "POSITION" in target:
                    referenced_elsewhere.add(target["POSITION"])
                if "NORMAL" in target:
                    morph_normal.add(target["NORMAL"])
    for skin in gltf.get("skins", []):
        if "inverseBindMatrices" in skin:
            referenced_elsewhere.add(skin["inverseBindMatrices"])
    for anim in gltf.get("animations", []):
        for sampler in anim.get("samplers", []):
            referenced_elsewhere.update([sampler["input"], sampler["output"]])

    drop = {ai for ai in morph_normal if ai not in referenced_elsewhere}

    # 2. Rebuild bin + bufferViews + accessors with an old->new accessor remap.
    new_bin = bytearray()
    new_bufferviews: list[dict] = []
    new_accessors: list[dict] = []
    accessor_map: dict[int, int] = {}

    def add_bufferview(payload: bytes, target: int | None = None) -> int:
        while len(new_bin) % 4:
            new_bin.append(0)
        offset = len(new_bin)
        new_bin.extend(payload)
        bv = {"buffer": 0, "byteOffset": offset, "byteLength": len(payload)}
        if target is not None:
            bv["target"] = target
        new_bufferviews.append(bv)
        return len(new_bufferviews) - 1

    for oi, acc in enumerate(accessors):
        if oi in drop:
            continue
        payload = accessor_element_bytes(gltf, binc, oi)
        bv_index = add_bufferview(payload)
        new_acc = {k: v for k, v in acc.items() if k not in ("bufferView", "byteOffset")}
        new_acc["bufferView"] = bv_index
        accessor_map[oi] = len(new_accessors)
        new_accessors.append(new_acc)

    # 3. Re-encode images and append their bufferViews.
    image_bv_map: dict[int, int] = {}
    for ii, image in enumerate(images):
        bv = gltf["bufferViews"][image["bufferView"]]
        raw = binc[bv.get("byteOffset", 0) : bv.get("byteOffset", 0) + bv["byteLength"]]
        is_icon = "icon" in (image.get("name", "").lower())
        encoded, mime = encode_image(raw, icon_dim if is_icon else max_texture)
        image_bv_map[ii] = add_bufferview(encoded)
        image["mimeType"] = mime

    # 4. Remap all accessor references.
    def remap(ai: int) -> int:
        return accessor_map[ai]

    for mesh in gltf["meshes"]:
        for prim in mesh["primitives"]:
            if "indices" in prim:
                prim["indices"] = remap(prim["indices"])
            prim["attributes"] = {k: remap(v) for k, v in prim["attributes"].items()}
            new_targets = []
            for target in prim.get("targets", []) or []:
                nt = {k: remap(v) for k, v in target.items() if v not in drop}
                new_targets.append(nt)
            if "targets" in prim:
                prim["targets"] = new_targets
    for skin in gltf.get("skins", []):
        if "inverseBindMatrices" in skin:
            skin["inverseBindMatrices"] = remap(skin["inverseBindMatrices"])
    for anim in gltf.get("animations", []):
        for sampler in anim.get("samplers", []):
            sampler["input"] = remap(sampler["input"])
            sampler["output"] = remap(sampler["output"])
    for ii, image in enumerate(images):
        image["bufferView"] = image_bv_map[ii]

    gltf["accessors"] = new_accessors
    gltf["bufferViews"] = new_bufferviews
    gltf["buffers"] = [{"byteLength": len(new_bin)}]

    # 5. Write GLB.
    json_bytes = json.dumps(gltf, separators=(",", ":")).encode("utf-8")
    json_bytes += b" " * (pad4(len(json_bytes)) - len(json_bytes))
    bin_bytes = bytes(new_bin) + b"\x00" * (pad4(len(new_bin)) - len(new_bin))
    total = 12 + 8 + len(json_bytes) + 8 + len(bin_bytes)
    with out_path.open("wb") as fh:
        fh.write(struct.pack("<III", GLB_MAGIC, 2, total))
        fh.write(struct.pack("<II", len(json_bytes), JSON_CHUNK))
        fh.write(json_bytes)
        fh.write(struct.pack("<II", len(bin_bytes), BIN_CHUNK))
        fh.write(bin_bytes)

    in_mb = in_path.stat().st_size / 1024 / 1024
    out_mb = out_path.stat().st_size / 1024 / 1024
    print(f"dropped {len(drop)} morph-normal accessors; kept {len(new_accessors)} accessors")
    print(f"{in_path.name}: {in_mb:.1f} MB -> {out_path.name}: {out_mb:.1f} MB")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("input")
    ap.add_argument("output")
    ap.add_argument("--max-texture", type=int, default=2048)
    ap.add_argument("--icon", type=int, default=512)
    args = ap.parse_args()
    optimize(Path(args.input), Path(args.output), args.max_texture, args.icon)


if __name__ == "__main__":
    main()
