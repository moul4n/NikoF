from __future__ import annotations

import argparse
import json
import re
from pathlib import Path


DEFAULT_REPO_ROOT = Path(__file__).resolve().parents[2]


SAFE_FIELD_PATTERNS = {
    "name": re.compile(r"^\s{2}m_Name:\s*(.+?)\s*$"),
    "sample_rate": re.compile(r"^\s{2}m_SampleRate:\s*([-0-9.]+)\s*$"),
    "start_time": re.compile(r"^\s{4}m_StartTime:\s*([-0-9.]+)\s*$"),
    "stop_time": re.compile(r"^\s{4}m_StopTime:\s*([-0-9.]+)\s*$"),
    "loop_time": re.compile(r"^\s{4}m_LoopTime:\s*([-0-9.]+)\s*$"),
}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Extract safe metadata from a Unity text .anim file into a staged JSON sidecar."
    )
    parser.add_argument("source", type=Path, help="Path to the Unity text .anim file.")
    parser.add_argument("output", type=Path, help="Path to write the JSON sidecar.")
    parser.add_argument(
        "--semantic-id",
        required=True,
        help="Candidate semantic animation id for the staged source clip.",
    )
    parser.add_argument(
        "--repo-root",
        type=Path,
        default=DEFAULT_REPO_ROOT,
        help="Repository root used to normalize stored source paths.",
    )
    return parser.parse_args()


def extract_safe_metadata(source_path: Path) -> dict[str, object]:
    extracted: dict[str, object] = {}

    with source_path.open("r", encoding="utf-8") as handle:
        for raw_line in handle:
            for field_name, pattern in SAFE_FIELD_PATTERNS.items():
                if field_name in extracted:
                    continue
                match = pattern.match(raw_line)
                if not match:
                    continue
                value = match.group(1)
                if field_name == "name":
                    extracted[field_name] = value
                elif field_name == "sample_rate":
                    extracted[field_name] = int(float(value))
                else:
                    extracted[field_name] = float(value)

    missing_fields = [field for field in SAFE_FIELD_PATTERNS if field not in extracted]
    if missing_fields:
        missing = ", ".join(missing_fields)
        raise ValueError(f"Missing required Unity metadata fields: {missing}")

    return extracted


def to_repo_relative_path(path: Path, repo_root: Path) -> str:
    resolved_path = path.resolve()
    resolved_repo_root = repo_root.resolve()

    try:
        return resolved_path.relative_to(resolved_repo_root).as_posix()
    except ValueError as error:
        raise ValueError(
            f"Source path must live under repo root {resolved_repo_root.as_posix()}: {resolved_path.as_posix()}"
        ) from error


def build_sidecar(source_repo_path: str, semantic_id: str, metadata: dict[str, object]) -> dict[str, object]:
    return {
        "semantic_id": semantic_id,
        "stage": "staged_raw_unity_source",
        "approved_for_shared_library": False,
        "promotion_status": "not_promoted",
        "source": {
            "kind": "unity_text_animation_clip",
            "path": source_repo_path,
            "provenance": "raw_source_asset",
        },
        "unity_clip": {
            "name": metadata["name"],
            "sample_rate": metadata["sample_rate"],
            "start_time": metadata["start_time"],
            "stop_time": metadata["stop_time"],
            "loop_time": metadata["loop_time"],
        },
    }


def main() -> int:
    args = parse_args()
    repo_root = args.repo_root.resolve()
    source_path = args.source.resolve()
    output_path = args.output.resolve()

    if source_path.suffix.lower() != ".anim":
        raise ValueError(f"Expected a .anim source file, got: {source_path.name}")

    metadata = extract_safe_metadata(source_path)
    sidecar = build_sidecar(to_repo_relative_path(source_path, repo_root), args.semantic_id, metadata)

    output_path.parent.mkdir(parents=True, exist_ok=True)
    with output_path.open("w", encoding="utf-8", newline="\n") as handle:
        json.dump(sidecar, handle, indent=2)
        handle.write("\n")

    print(f"Wrote staged metadata sidecar to {output_path.as_posix()}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())