"""Quick verification of exported bone rotations."""
import json
import math
from pathlib import Path

runtime_path = Path(__file__).resolve().parent.parent.parent / "assets/animations/generated/shared/idle.default/idle.default.runtime.json"
data = json.loads(runtime_path.read_text(encoding="utf-8"))

bones = data["export_audit"]["bone_transform_comparison"]["bones"]

print("Bone rotation analysis (with natural posture rig):")
print("=" * 70)
for bone in bones:
    name = bone["name"]
    max_angle = bone["max_angle_from_first_frame_deg"]
    fr = bone["first_local_rotation"]
    qx, qy, qz, qw = fr["x"], fr["y"], fr["z"], fr["w"]
    half_angle = math.acos(min(1.0, abs(qw)))
    angle_from_identity = math.degrees(2 * half_angle)
    print(f"  {name:20s}  rest_offset={angle_from_identity:6.2f} deg  anim_delta={max_angle:.2f} deg")

print()
print("Spine chain first-frame (x component = forward lean):")
spine_bones = ["hips", "spine", "chest", "upperChest", "neck", "head"]
for bone in bones:
    if bone["name"] in spine_bones:
        fr = bone["first_local_rotation"]
        x_val = fr["x"]
        lean_deg = math.degrees(2 * math.asin(min(1.0, abs(x_val)))) if abs(x_val) < 1 else 90
        direction = "forward" if x_val > 0 else "backward"
        print(f"  {bone['name']:15s}  x={x_val:+.5f}  (~{lean_deg:.1f} deg {direction})")
