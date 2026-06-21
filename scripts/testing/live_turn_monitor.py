"""Live mic-to-ear turn monitor for NikoF.

Watches the canonical speech-lifecycle stream and prints, in real time, every
turn's pipeline as it happens — interim captions, the confirmed transcript, the
assistant reply, and each synthesized audio segment — with per-stage timings,
then a per-turn summary cross-checked against the backend's own turn telemetry.

Use it while speaking into the mic (Parakeet STT + Kokoro TTS + qwen3) to see
where the latency goes end to end. Stdlib only; talks to the running backend.

    .venv\\Scripts\\python.exe scripts/testing/live_turn_monitor.py
    .venv\\Scripts\\python.exe scripts/testing/live_turn_monitor.py --start-listening
    .venv\\Scripts\\python.exe scripts/testing/live_turn_monitor.py --list-devices

Notes
- "last partial -> final" approximates end-of-speech detection + final decode.
- For STT voice turns the backend runs TTS in a background thread, so server
  tts_ms is None; this monitor measures first/last audio from the lifecycle
  timestamps instead. Server llm_ms is shown from turn telemetry.
"""

from __future__ import annotations

import argparse
import json
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime


def _http_json(url: str, *, method: str = "GET", payload: dict | None = None, timeout: float = 10.0) -> dict:
    data = json.dumps(payload).encode("utf-8") if payload is not None else None
    headers = {"Content-Type": "application/json"} if data is not None else {}
    request = urllib.request.Request(url, data=data, headers=headers, method=method)
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return json.loads(response.read().decode("utf-8"))


def _parse_ts(raw: str | None) -> float | None:
    if not raw:
        return None
    text = raw.strip().replace("Z", "+00:00")
    try:
        return datetime.fromisoformat(text).timestamp()
    except ValueError:
        return None


def _fmt_delta(seconds: float | None) -> str:
    return f"{seconds:6.2f}s" if seconds is not None else "   —  "


GREY = "\033[90m"
CYAN = "\033[96m"
GREEN = "\033[92m"
YELLOW = "\033[93m"
BOLD = "\033[1m"
RESET = "\033[0m"


class TurnTracker:
    """Groups lifecycle events into turns and prints timings."""

    def __init__(self, base_url: str) -> None:
        self._base_url = base_url
        self._reset()

    def _reset(self) -> None:
        self.partial_count = 0
        self.first_partial_ts: float | None = None
        self.last_partial_ts: float | None = None
        self.final_transcript_ts: float | None = None
        self.final_transcript: str | None = None
        self.assistant_ts: float | None = None
        self.first_audio_ts: float | None = None
        self.segment_count = 0
        self.final_audio_ts: float | None = None
        self.open = False

    def handle(self, event: dict) -> None:
        event_type = event.get("event_type")
        ts = _parse_ts(event.get("timestamp")) or time.time()

        if event_type == "transcript.partial":
            transcript = ((event.get("transcription") or {}).get("transcript") or "").strip()
            self.partial_count += 1
            if self.first_partial_ts is None:
                self.first_partial_ts = ts
            self.last_partial_ts = ts
            self.open = True
            print(f"{GREY}  ~ caption   {transcript!r}{RESET}")

        elif event_type == "transcription.status":
            # A new final transcript starts/closes a turn.
            if self.open and self.final_transcript_ts is not None:
                self._summarize()
                self._reset()
            transcript = ((event.get("transcription") or {}).get("transcript") or "").strip()
            self.final_transcript = transcript
            self.final_transcript_ts = ts
            self.open = True
            print(f"{BOLD}{CYAN}● heard     {transcript!r}{RESET}")

        elif event_type == "assistant.message":
            assistant = event.get("assistant") or {}
            text = (assistant.get("text") or "").strip()
            self.assistant_ts = ts
            rel = self._rel(ts)
            print(f"{GREEN}  → reply    [{_fmt_delta(rel)}] {text!r}{RESET}")

        elif event_type == "speech.synthesis":
            synthesis = event.get("synthesis") or {}
            if synthesis.get("status") != "ready":
                return
            seg = synthesis.get("segment_index")
            is_final = synthesis.get("is_final", True)
            self.segment_count += 1
            if self.first_audio_ts is None:
                self.first_audio_ts = ts
            self.final_audio_ts = ts
            rel = self._rel(ts)
            tag = "FIRST AUDIO" if self.segment_count == 1 else f"seg {seg}"
            marker = " (final)" if is_final else ""
            print(f"{YELLOW}  ♪ audio    [{_fmt_delta(rel)}] {tag}{marker}{RESET}")
            if is_final:
                self._summarize()
                self._reset()

    def _rel(self, ts: float) -> float | None:
        if self.final_transcript_ts is None:
            return None
        return ts - self.final_transcript_ts

    def _summarize(self) -> None:
        if self.final_transcript_ts is None:
            return
        endpoint_gap = (
            self.final_transcript_ts - self.last_partial_ts
            if self.last_partial_ts is not None
            else None
        )
        server_llm = self._server_llm_ms()
        print(f"{BOLD}  ── turn summary ─────────────────────────────{RESET}")
        print(f"     transcript           {self.final_transcript!r}")
        print(f"     interim captions     {self.partial_count}")
        if endpoint_gap is not None:
            print(f"     last caption→final   {_fmt_delta(endpoint_gap)}  (endpointing + final decode)")
        print(f"     final→reply text     {_fmt_delta(self._rel(self.assistant_ts) if self.assistant_ts else None)}")
        print(f"     final→first audio    {_fmt_delta(self._rel(self.first_audio_ts) if self.first_audio_ts else None)}")
        print(f"     final→last audio     {_fmt_delta(self._rel(self.final_audio_ts) if self.final_audio_ts else None)}  ({self.segment_count} segment(s))")
        if server_llm is not None:
            print(f"     server llm_ms        {server_llm/1000:6.2f}s")
        print(f"{BOLD}  ─────────────────────────────────────────────{RESET}\n")

    def _server_llm_ms(self) -> float | None:
        try:
            resources = _http_json(f"{self._base_url}/system/resources")
        except urllib.error.URLError:
            return None
        last = (resources.get("turn_telemetry") or {}).get("last") or {}
        value = last.get("llm_ms")
        return float(value) if isinstance(value, (int, float)) else None


def _print_active_config(base_url: str) -> None:
    try:
        resources = _http_json(f"{base_url}/system/resources")
    except urllib.error.URLError as exc:
        raise SystemExit(f"Backend not reachable at {base_url}: {exc}")
    tuning = resources.get("runtime_tuning", {})
    llm_model = (resources.get("llm_sidecar") or {}).get("model_name")
    print(f"{BOLD}NikoF live turn monitor{RESET}  (Ctrl+C to stop)")
    print(f"  stt_engine   = {tuning.get('stt_engine')}   partials={tuning.get('stt_partials_enabled')}")
    print(f"  tts_engine   = {tuning.get('tts_engine')}")
    print(f"  llm_model    = {llm_model}   streaming={tuning.get('llm_streaming_enabled')} lean={tuning.get('llm_lean_planner')}")
    print(f"  segmentation = {tuning.get('tts_segmentation_enabled')}\n")
    print("Speak into the mic; turns appear below.\n")


def main() -> None:
    parser = argparse.ArgumentParser(description="Live mic-to-ear turn monitor")
    parser.add_argument("--base-url", default="http://127.0.0.1:8000")
    parser.add_argument("--poll-ms", type=int, default=50)
    parser.add_argument("--start-listening", action="store_true", help="enable the mic before monitoring")
    parser.add_argument("--stop-listening", action="store_true", help="disable the mic and exit")
    parser.add_argument("--list-devices", action="store_true", help="list input devices and exit")
    args = parser.parse_args()

    base_url = args.base_url.rstrip("/")

    if args.list_devices:
        devices = _http_json(f"{base_url}/session/stt/devices").get("devices", [])
        for device in devices:
            mark = " (default)" if device.get("default") else ""
            print(f"  [{device.get('device_id')}] {device.get('label')}{mark}")
        return

    if args.stop_listening:
        _http_json(f"{base_url}/session/stt/listening", method="PUT", payload={"enabled": False})
        print("Mic listening disabled.")
        return

    _print_active_config(base_url)

    if args.start_listening:
        try:
            _http_json(f"{base_url}/session/stt/listening", method="PUT", payload={"enabled": True})
            print(f"{GREEN}Mic listening enabled.{RESET}\n")
        except urllib.error.URLError as exc:
            print(f"{YELLOW}Could not enable listening ({exc}); start it from the control surface.{RESET}\n")

    tracker = TurnTracker(base_url)
    poll_seconds = max(0.02, args.poll_ms / 1000.0)
    cursor: str | None = None
    seen: set[str] = set()

    # Start from the live tail so we only show new turns.
    try:
        snapshot = _http_json(f"{base_url}/session/speech-lifecycle")
        cursor = snapshot.get("next_cursor")
    except urllib.error.URLError as exc:
        raise SystemExit(f"Backend not reachable: {exc}")

    try:
        while True:
            query = f"{base_url}/session/speech-lifecycle"
            if cursor:
                query += f"?cursor={urllib.parse.quote(cursor, safe='')}"
            try:
                snapshot = _http_json(query)
            except urllib.error.URLError:
                time.sleep(poll_seconds)
                continue

            for envelope in snapshot.get("events", []):
                event_id = envelope.get("event_id") or envelope.get("cursor")
                if event_id in seen:
                    continue
                seen.add(event_id)
                tracker.handle(envelope.get("event", {}))

            cursor = snapshot.get("next_cursor") or cursor
            time.sleep(poll_seconds)
    except KeyboardInterrupt:
        print("\nStopped.")


if __name__ == "__main__":
    main()
