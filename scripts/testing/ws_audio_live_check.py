"""Live end-to-end check for the Phase 2 binary-audio WebSocket transport.

Subscribes to /session/stream, fires a real turn via POST
/session/operator-command, and verifies that synthesized segment audio is
pushed over the WebSocket as paired header+binary frames (independent of the
SSE lifecycle + artifact-fetch fallback). Also fetches /system/resources to
confirm the active engine and reports per-segment WS first-audio timing.

Run against a live backend (Kokoro engine, models loaded):

    .venv\\Scripts\\python.exe scripts/testing/ws_audio_live_check.py

Requires the `websockets` package (a backend core dep).
"""

from __future__ import annotations

import argparse
import asyncio
import json
import struct
import time
import urllib.request

import websockets


def _http_json(url: str, *, method: str = "GET", payload: dict | None = None, timeout: float = 30.0) -> dict:
    data = json.dumps(payload).encode("utf-8") if payload is not None else None
    headers = {"Content-Type": "application/json"} if data is not None else {}
    request = urllib.request.Request(url, data=data, headers=headers, method=method)
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return json.loads(response.read().decode("utf-8"))


def _is_wav(audio: bytes) -> bool:
    return len(audio) > 12 and audio[0:4] == b"RIFF" and audio[8:12] == b"WAVE"


def _wav_duration_ms(audio: bytes) -> float | None:
    # Minimal WAV parse: find 'fmt ' (sample rate, channels, bits) and 'data' size.
    if not _is_wav(audio):
        return None
    try:
        idx = 12
        sample_rate = channels = bits = data_size = None
        while idx + 8 <= len(audio):
            chunk_id = audio[idx : idx + 4]
            chunk_size = struct.unpack_from("<I", audio, idx + 4)[0]
            body = idx + 8
            if chunk_id == b"fmt ":
                channels = struct.unpack_from("<H", audio, body + 2)[0]
                sample_rate = struct.unpack_from("<I", audio, body + 4)[0]
                bits = struct.unpack_from("<H", audio, body + 14)[0]
            elif chunk_id == b"data":
                data_size = chunk_size
            idx = body + chunk_size + (chunk_size & 1)
        if sample_rate and channels and bits and data_size:
            frames = data_size / (channels * (bits // 8))
            return frames / sample_rate * 1000.0
    except struct.error:
        return None
    return None


async def run_check(base_url: str, ws_url: str, prompt: str, timeout_s: float) -> int:
    resources = _http_json(f"{base_url}/system/resources")
    tuning = resources.get("runtime_tuning", {})
    llm_model = (resources.get("llm_sidecar") or {}).get("model_name")
    print("Active config:")
    print(f"  llm_model                = {llm_model}")
    print(f"  tts_engine               = {tuning.get('tts_engine')}")
    print(f"  tts_segmentation_enabled = {tuning.get('tts_segmentation_enabled')}")
    print(f"  llm_streaming_enabled    = {tuning.get('llm_streaming_enabled')}")
    print()

    async with websockets.connect(ws_url, max_size=8 * 1024 * 1024) as websocket:
        # Drain the initial snapshot control frame so we start clean.
        snapshot_raw = await asyncio.wait_for(websocket.recv(), timeout=10.0)
        snapshot = json.loads(snapshot_raw)
        print(f"WS connected; snapshot kind={snapshot.get('kind')} event={snapshot.get('event')}")

        # Fire the turn now that we are a subscriber (so has_subscribers is true).
        start = time.perf_counter()
        command = _http_json(
            f"{base_url}/session/operator-command",
            method="POST",
            payload={"command_type": "text_question", "text": prompt, "locale": "en-US"},
        )
        print(f"Turn fired: status={command.get('status')!r} prompt={prompt!r}\n")

        segments: list[dict] = []
        pending_header: dict | None = None
        first_audio_ms: float | None = None
        deadline = time.perf_counter() + timeout_s
        final_seen = False

        while not final_seen and time.perf_counter() < deadline:
            try:
                frame = await asyncio.wait_for(websocket.recv(), timeout=deadline - time.perf_counter())
            except asyncio.TimeoutError:
                break

            if isinstance(frame, str):
                try:
                    message = json.loads(frame)
                except json.JSONDecodeError:
                    continue
                if message.get("event") == "speech.audio":
                    pending_header = message
                # speech.lifecycle control frames are ignored here.
                continue

            # Binary frame: WAV bytes for the most recent speech.audio header.
            header = pending_header
            pending_header = None
            if header is None:
                print("  ! binary frame with no preceding header (dropped)")
                continue

            now_ms = (time.perf_counter() - start) * 1000.0
            if first_audio_ms is None:
                first_audio_ms = now_ms

            duration_ms = _wav_duration_ms(frame)
            record = {
                "segment_index": header.get("segment_index"),
                "is_final": header.get("is_final"),
                "header_bytes": header.get("bytes"),
                "recv_bytes": len(frame),
                "observed_ms": round(now_ms, 1),
                "is_wav": _is_wav(frame),
                "audio_ms": round(duration_ms, 1) if duration_ms else None,
            }
            segments.append(record)
            print(
                f"  seg {record['segment_index']:>2}  ws@{record['observed_ms']:>7.1f}ms  "
                f"{record['recv_bytes']:>7d}B  wav={record['is_wav']}  "
                f"audio={record['audio_ms']}ms  final={record['is_final']}"
            )
            if header.get("is_final"):
                final_seen = True

    print()
    ok = bool(segments) and all(s["is_wav"] and s["recv_bytes"] == s["header_bytes"] for s in segments)
    print("=== Summary ===")
    print(f"  segments over WS     = {len(segments)}")
    print(f"  first audio (WS)     = {round(first_audio_ms, 1) if first_audio_ms else None} ms")
    print(f"  final segment seen   = {final_seen}")
    print(f"  all frames valid WAV = {ok}")
    if not segments:
        print("\nFAIL: no binary audio frames received over the WebSocket.")
        return 1
    if not ok:
        print("\nFAIL: a frame was not a valid WAV or byte-count mismatched its header.")
        return 1
    print("\nPASS: synthesized audio streamed over the WebSocket transport.")
    return 0


def main() -> None:
    parser = argparse.ArgumentParser(description="Live binary-audio WebSocket check")
    parser.add_argument("--base-url", default="http://127.0.0.1:8000")
    parser.add_argument("--ws-url", default="ws://127.0.0.1:8000/session/stream")
    parser.add_argument("--prompt", default="Tell me about your day in three short sentences.")
    parser.add_argument("--timeout", type=float, default=60.0)
    args = parser.parse_args()

    exit_code = asyncio.run(
        run_check(args.base_url.rstrip("/"), args.ws_url, args.prompt, args.timeout)
    )
    raise SystemExit(exit_code)


if __name__ == "__main__":
    main()
