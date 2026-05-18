"""
Extract RootT.x/y/z curves from a Unity .anim file and sample them at 30fps,
then inject into the runtime JSON as local_position_samples on the Hips bone.
"""
import json
import re
import sys
from pathlib import Path


def parse_anim_curves(anim_path: Path) -> dict[str, list[dict]]:
    """Parse RootT.x, RootT.y, RootT.z curve keyframes from Unity .anim YAML."""
    text = anim_path.read_text(encoding="utf-8")

    curves: dict[str, list[dict]] = {}

    # Find each RootT attribute section
    for axis in ("x", "y", "z"):
        attr_tag = f"attribute: RootT.{axis}"
        attr_idx = text.find(attr_tag)
        if attr_idx == -1:
            print(f"WARNING: {attr_tag} not found in {anim_path}")
            curves[axis] = []
            continue

        # Walk backwards from the attribute tag to find the curve's m_Curve start
        # The structure is: curve: { m_Curve: [...keyframes...] } then attribute: RootT.x
        curve_section_end = attr_idx
        # Find the m_Curve block - search backwards for "m_Curve:"
        search_start = max(0, attr_idx - 50000)
        section = text[search_start:curve_section_end]

        # Find the last "m_Curve:" before this attribute
        mcurve_positions = [m.start() for m in re.finditer(r"m_Curve:", section)]
        if not mcurve_positions:
            print(f"WARNING: Could not find m_Curve for RootT.{axis}")
            curves[axis] = []
            continue

        mcurve_start = search_start + mcurve_positions[-1]
        curve_text = text[mcurve_start:curve_section_end]

        # Parse keyframes
        keyframes = []
        for kf_match in re.finditer(
            r"time:\s*([\d.eE+-]+)\s*\n\s*value:\s*([\d.eE+-]+)\s*\n\s*inSlope:\s*([\d.eE+-]+)\s*\n\s*outSlope:\s*([\d.eE+-]+)",
            curve_text,
        ):
            keyframes.append({
                "time": float(kf_match.group(1)),
                "value": float(kf_match.group(2)),
                "inSlope": float(kf_match.group(3)),
                "outSlope": float(kf_match.group(4)),
            })

        curves[axis] = keyframes
        print(f"  RootT.{axis}: {len(keyframes)} keyframes, "
              f"time range [{keyframes[0]['time']:.3f}, {keyframes[-1]['time']:.3f}]")

    return curves


def hermite_interpolate(t: float, t0: float, v0: float, out_slope0: float,
                        t1: float, v1: float, in_slope1: float) -> float:
    """Cubic Hermite interpolation between two keyframes."""
    dt = t1 - t0
    if dt <= 0:
        return v0
    u = (t - t0) / dt
    u2 = u * u
    u3 = u2 * u

    # Hermite basis functions
    h00 = 2 * u3 - 3 * u2 + 1
    h10 = u3 - 2 * u2 + u
    h01 = -2 * u3 + 3 * u2
    h11 = u3 - u2

    return h00 * v0 + h10 * (out_slope0 * dt) + h01 * v1 + h11 * (in_slope1 * dt)


def sample_curve(keyframes: list[dict], times: list[float]) -> list[float]:
    """Sample a curve at the given times using cubic Hermite interpolation."""
    if not keyframes:
        return [0.0] * len(times)

    samples = []
    kf_idx = 0

    for t in times:
        # Clamp to curve range
        if t <= keyframes[0]["time"]:
            samples.append(keyframes[0]["value"])
            continue
        if t >= keyframes[-1]["time"]:
            samples.append(keyframes[-1]["value"])
            continue

        # Find the segment [kf_idx, kf_idx+1] containing t
        while kf_idx < len(keyframes) - 2 and keyframes[kf_idx + 1]["time"] < t:
            kf_idx += 1

        kf0 = keyframes[kf_idx]
        kf1 = keyframes[kf_idx + 1]

        val = hermite_interpolate(
            t, kf0["time"], kf0["value"], kf0["outSlope"],
            kf1["time"], kf1["value"], kf1["inSlope"]
        )
        samples.append(val)

    return samples


def main():
    repo_root = Path(__file__).resolve().parent.parent.parent
    anim_path = repo_root / "assets" / "animations" / "raw" / "idle.anim"
    runtime_path = repo_root / "assets" / "animations" / "generated" / "shared" / "idle.default" / "idle.default.runtime.json"

    if not anim_path.exists():
        print(f"ERROR: {anim_path} not found")
        sys.exit(1)
    if not runtime_path.exists():
        print(f"ERROR: {runtime_path} not found")
        sys.exit(1)

    print(f"Parsing {anim_path}...")
    curves = parse_anim_curves(anim_path)

    print(f"\nLoading {runtime_path}...")
    runtime = json.loads(runtime_path.read_text(encoding="utf-8"))

    # Get sampling times
    times_s = runtime["sampling"]["times_s"]
    print(f"  Sampling at {len(times_s)} frames ({times_s[0]:.3f}s to {times_s[-1]:.3f}s)")

    # Sample each axis
    pos_x = sample_curve(curves["x"], times_s)
    pos_y = sample_curve(curves["y"], times_s)
    pos_z = sample_curve(curves["z"], times_s)

    print(f"\n  RootT.x sampled: [{min(pos_x):.6f}, {max(pos_x):.6f}]")
    print(f"  RootT.y sampled: [{min(pos_y):.6f}, {max(pos_y):.6f}]")
    print(f"  RootT.z sampled: [{min(pos_z):.6f}, {max(pos_z):.6f}]")

    # Find the Hips bone in the runtime JSON and add position samples
    bones = runtime["export_audit"]["bone_transform_comparison"]["bones"]
    hips_bone = None
    for bone in bones:
        if bone.get("human_body_bone") == "Hips" or bone.get("name") == "hips":
            hips_bone = bone
            break

    if not hips_bone:
        print("ERROR: Could not find Hips bone in runtime JSON")
        sys.exit(1)

    hips_bone["local_position_samples"] = {
        "x": pos_x,
        "y": pos_y,
        "z": pos_z,
    }

    # Also mark that position data is available
    runtime["export_audit"]["has_root_position_samples"] = True

    # Write back
    runtime_path.write_text(json.dumps(runtime, indent=2, ensure_ascii=False), encoding="utf-8")
    print(f"\nWrote updated runtime JSON to {runtime_path}")
    print("  Added local_position_samples to Hips bone")


if __name__ == "__main__":
    main()
