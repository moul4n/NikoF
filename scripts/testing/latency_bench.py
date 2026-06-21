"""Latency & streaming benchmark for the NikoF speech pipeline.

Drives the canonical write seam (POST /session/operator-command) with real
prompts against a live backend and measures, from the live speech-lifecycle
stream, the timings that matter for "mouth-to-ear":

  - response_ms       : operator-command HTTP round trip
  - assistant_ms      : until the assistant.message (reply text) event appears
  - first_audio_ms    : until the FIRST speech.synthesis event (first segment)
  - total_ms          : until the final segment (is_final) is published
  - segment_count     : number of speech.synthesis segments for the turn
  - server llm/tts/total ms : the backend's own per-stage turn telemetry

It also records the active runtime tuning (segmentation/streaming flags) so each
result is self-documenting, and fetches the first segment's audio artifact to
confirm real, playable output. Stdlib only.

Run against a live backend (models loaded):

    .venv\\Scripts\\python.exe scripts/testing/latency_bench.py --runs 5

Compare configs by restarting the backend with different env, e.g.
NIKOF_TTS_SEGMENTATION=1 and NIKOF_LLM_STREAMING=1, then re-running.
"""

from __future__ import annotations

import argparse
import json
import statistics
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path


DEFAULT_PROMPTS = [
    "Tell me about your day in three short sentences.",
    "What is your favorite season, and why? Keep it brief.",
    "Give me a two sentence pep talk for the morning.",
]


def _http_json(url: str, *, method: str = "GET", payload: dict | None = None, timeout: float = 30.0) -> dict:
    data = json.dumps(payload).encode("utf-8") if payload is not None else None
    headers = {"Content-Type": "application/json"} if data is not None else {}
    request = urllib.request.Request(url, data=data, headers=headers, method=method)
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return json.loads(response.read().decode("utf-8"))


def _http_bytes(url: str, *, timeout: float = 30.0) -> bytes:
    with urllib.request.urlopen(url, timeout=timeout) as response:
        return response.read()


def _baseline_cursor(base_url: str) -> str | None:
    snapshot = _http_json(f"{base_url}/session/speech-lifecycle")
    return snapshot.get("next_cursor")


def _percentile(values: list[float], pct: float) -> float | None:
    if not values:
        return None
    ordered = sorted(values)
    if len(ordered) == 1:
        return ordered[0]
    rank = pct / 100 * (len(ordered) - 1)
    low = int(rank)
    high = min(low + 1, len(ordered) - 1)
    return ordered[low] + (ordered[high] - ordered[low]) * (rank - low)


def run_once(base_url: str, prompt: str, *, poll_seconds: float, timeout_seconds: float) -> dict:
    cursor = _baseline_cursor(base_url)
    start = time.perf_counter()
    response = _http_json(
        f"{base_url}/session/operator-command",
        method="POST",
        payload={"command_type": "text_question", "text": prompt, "locale": "en-US"},
    )
    response_ms = (time.perf_counter() - start) * 1000.0

    assistant_ms: float | None = None
    segments: list[dict] = []
    seen_synthesis: set[str] = set()
    final_seen = False

    deadline = time.perf_counter() + timeout_seconds
    while time.perf_counter() < deadline and not final_seen:
        query = f"{base_url}/session/speech-lifecycle"
        if cursor:
            query += f"?cursor={urllib.parse.quote(cursor, safe='')}"
        try:
            snapshot = _http_json(query)
        except urllib.error.URLError:
            time.sleep(poll_seconds)
            continue

        for envelope in snapshot.get("events", []):
            event = envelope.get("event", {})
            event_type = event.get("event_type")
            now_ms = (time.perf_counter() - start) * 1000.0
            if event_type == "assistant.message" and assistant_ms is None:
                assistant_ms = now_ms
            elif event_type == "speech.synthesis":
                event_id = envelope.get("event_id")
                if event_id in seen_synthesis:
                    continue
                seen_synthesis.add(event_id)
                synthesis = event.get("synthesis", {})
                segments.append(
                    {
                        "observed_ms": round(now_ms, 1),
                        "segment_index": synthesis.get("segment_index"),
                        "is_final": synthesis.get("is_final"),
                        "status": synthesis.get("status"),
                        "event_id": event_id,
                        "audio_reference": synthesis.get("audio_reference"),
                    }
                )
                if synthesis.get("is_final", True) and synthesis.get("status") == "ready":
                    final_seen = True
        if not final_seen:
            time.sleep(poll_seconds)

    audio_segments = [seg for seg in segments if seg["status"] == "ready"]
    first_audio_ms = audio_segments[0]["observed_ms"] if audio_segments else None
    total_ms = audio_segments[-1]["observed_ms"] if (audio_segments and final_seen) else None

    # Confirm the first segment is real, playable output.
    first_audio_bytes: int | None = None
    if audio_segments:
        try:
            first_audio_bytes = len(
                _http_bytes(f"{base_url}/session/speech-artifacts/{audio_segments[0]['event_id']}/audio")
            )
        except (urllib.error.URLError, urllib.error.HTTPError):
            first_audio_bytes = None

    server = {}
    try:
        resources = _http_json(f"{base_url}/system/resources")
        last = (resources.get("turn_telemetry") or {}).get("last") or {}
        server = {
            "llm_ms": last.get("llm_ms"),
            "tts_ms": last.get("tts_ms"),
            "total_ms": last.get("total_ms"),
            "deferred_synthesis": last.get("deferred_synthesis"),
        }
    except urllib.error.URLError:
        server = {}

    return {
        "prompt": prompt,
        "status": response.get("status"),
        "response_ms": round(response_ms, 1),
        "assistant_ms": round(assistant_ms, 1) if assistant_ms is not None else None,
        "first_audio_ms": round(first_audio_ms, 1) if first_audio_ms is not None else None,
        "total_ms": round(total_ms, 1) if total_ms is not None else None,
        "segment_count": len(audio_segments),
        "completed": final_seen,
        "first_audio_bytes": first_audio_bytes,
        "server": server,
        "segments": segments,
    }


def _summarize(runs: list[dict], key: str) -> dict | None:
    values = [run[key] for run in runs if isinstance(run.get(key), (int, float))]
    if not values:
        return None
    return {
        "n": len(values),
        "mean": round(statistics.fmean(values), 1),
        "p50": round(_percentile(values, 50), 1),
        "p95": round(_percentile(values, 95), 1),
        "min": round(min(values), 1),
        "max": round(max(values), 1),
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="NikoF speech pipeline latency/streaming benchmark")
    parser.add_argument("--base-url", default="http://127.0.0.1:8000")
    parser.add_argument("--runs", type=int, default=5)
    parser.add_argument("--warmup", type=int, default=1, help="discarded warmup runs")
    parser.add_argument("--poll-ms", type=int, default=20)
    parser.add_argument("--timeout", type=float, default=60.0, help="per-run seconds")
    parser.add_argument("--prompt", action="append", dest="prompts", help="prompt (repeatable)")
    parser.add_argument("--out", default=None, help="JSON artifact path")
    args = parser.parse_args()

    base_url = args.base_url.rstrip("/")
    prompts = args.prompts or DEFAULT_PROMPTS
    poll_seconds = max(0.005, args.poll_ms / 1000.0)

    try:
        resources = _http_json(f"{base_url}/system/resources")
    except urllib.error.URLError as exc:
        raise SystemExit(f"Backend not reachable at {base_url}: {exc}")
    tuning = resources.get("runtime_tuning", {})
    print("Active runtime tuning:")
    print(f"  tts_segmentation_enabled = {tuning.get('tts_segmentation_enabled')}")
    print(f"  llm_streaming_enabled    = {tuning.get('llm_streaming_enabled')}")
    print()

    for index in range(max(0, args.warmup)):
        prompt = prompts[index % len(prompts)]
        print(f"[warmup {index + 1}/{args.warmup}] {prompt!r}")
        run_once(base_url, prompt, poll_seconds=poll_seconds, timeout_seconds=args.timeout)

    runs: list[dict] = []
    for index in range(args.runs):
        prompt = prompts[index % len(prompts)]
        result = run_once(base_url, prompt, poll_seconds=poll_seconds, timeout_seconds=args.timeout)
        runs.append(result)
        print(
            f"[run {index + 1}/{args.runs}] first_audio={result['first_audio_ms']}ms "
            f"total={result['total_ms']}ms segments={result['segment_count']} "
            f"server_llm={result['server'].get('llm_ms')}ms server_tts={result['server'].get('tts_ms')}ms "
            f"completed={result['completed']}"
        )

    summary = {
        "base_url": base_url,
        "runs": len(runs),
        "runtime_tuning": tuning,
        "aggregates": {
            "response_ms": _summarize(runs, "response_ms"),
            "assistant_ms": _summarize(runs, "assistant_ms"),
            "first_audio_ms": _summarize(runs, "first_audio_ms"),
            "total_ms": _summarize(runs, "total_ms"),
            "segment_count": _summarize(runs, "segment_count"),
            "server_llm_ms": _summarize([r["server"] for r in runs], "llm_ms"),
            "server_tts_ms": _summarize([r["server"] for r in runs], "tts_ms"),
        },
        "samples": runs,
    }

    print("\n=== Aggregates (ms) ===")
    for name, stats in summary["aggregates"].items():
        if stats:
            print(f"  {name:16s} mean={stats['mean']:>8} p50={stats['p50']:>8} p95={stats['p95']:>8} (n={stats['n']})")
        else:
            print(f"  {name:16s} (no data)")

    out_path = Path(args.out) if args.out else (
        Path(__file__).resolve().parents[2]
        / ".local"
        / "monitoring"
        / f"latency-bench-{int(time.time())}.json"
    )
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(summary, indent=2), encoding="utf-8")
    print(f"\nArtifact: {out_path}")


if __name__ == "__main__":
    main()
