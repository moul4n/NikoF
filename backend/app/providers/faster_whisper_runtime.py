from __future__ import annotations

import argparse
import json
import logging
import math
import os
import queue
import sys
import threading
import time
import wave
from collections import deque
from dataclasses import dataclass
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urlparse

try:
    import numpy as np
except ModuleNotFoundError:  # pragma: no cover - runtime dependency
    np = None  # type: ignore[assignment]

try:
    import sounddevice as sounddevice
except ModuleNotFoundError:  # pragma: no cover - runtime dependency
    sounddevice = None  # type: ignore[assignment]

try:
    from faster_whisper import WhisperModel
except ModuleNotFoundError:  # pragma: no cover - runtime dependency
    WhisperModel = None  # type: ignore[assignment]


logger = logging.getLogger(__name__)

SERVER_SAMPLE_RATE_HZ = 16000
SERVER_BLOCK_SIZE = 1600
MIN_UTTERANCE_SECONDS = 0.45
MAX_UTTERANCE_SECONDS = 15.0
MIN_RMS_THRESHOLD = 0.012
SPEECH_START_BLOCKS = 3
SPEECH_END_BLOCKS = 8


def _resolve_locale_language(locale: str | None) -> str | None:
    raw_locale = str(locale or "").strip()
    if not raw_locale:
        return None

    language = raw_locale.split("-", 1)[0].strip().lower()
    return language or None


def _read_wav_audio(audio_path: Path) -> tuple[Any, int]:
    if np is None:
        raise RuntimeError("numpy is required")

    with wave.open(str(audio_path), "rb") as handle:
        sample_rate = handle.getframerate()
        channels = handle.getnchannels()
        sample_width = handle.getsampwidth()
        frames = handle.readframes(handle.getnframes())

    if sample_width == 2:
        dtype = np.int16
        scale = 32768.0
    elif sample_width == 4:
        dtype = np.int32
        scale = float(2 ** 31)
    else:
        raise RuntimeError("unsupported wav format")

    audio = np.frombuffer(frames, dtype=dtype).astype(np.float32) / scale
    if channels > 1:
        audio = audio.reshape(-1, channels).mean(axis=1)
    return audio, sample_rate


def _resample_audio(audio: Any, source_rate_hz: int, target_rate_hz: int) -> Any:
    if np is None or source_rate_hz == target_rate_hz:
        return audio

    if audio.size == 0:
        return audio

    source_positions = np.linspace(0.0, 1.0, num=audio.shape[0], endpoint=False)
    target_length = max(1, int(round(audio.shape[0] * target_rate_hz / source_rate_hz)))
    target_positions = np.linspace(0.0, 1.0, num=target_length, endpoint=False)
    return np.interp(target_positions, source_positions, audio).astype(np.float32)


def _load_model(model_root: Path) -> tuple[Any, str, str]:
    if WhisperModel is None:
        raise RuntimeError("faster-whisper is not installed")

    prefer_gpu = os.environ.get("NIKOF_STT_ALLOW_GPU", "0").strip().lower() in {"1", "true", "yes", "on"}
    device_policy = os.environ.get("NIKOF_STT_DEVICE_POLICY", "auto").strip().lower() or "auto"
    model_path = str(model_root)

    if device_policy != "cpu" and prefer_gpu:
        try:
            return WhisperModel(model_path, device="cuda", compute_type="float16"), "cuda", "float16"
        except Exception:
            logger.exception("Faster-Whisper GPU load failed; falling back to CPU")

    return WhisperModel(model_path, device="cpu", compute_type="int8"), "cpu", "int8"


def _transcribe_audio(model_root: Path, audio: Any, *, locale: str) -> dict[str, Any]:
    if np is None:
        raise RuntimeError("numpy is not installed")

    model, device, compute_type = _load_model(model_root)
    segments, _info = model.transcribe(
        audio.astype(np.float32),
        language=_resolve_locale_language(locale),
        beam_size=1,
        vad_filter=False,
        condition_on_previous_text=False,
        compression_ratio_threshold=2.4,
        no_speech_threshold=0.55,
    )

    transcript_parts: list[str] = []
    segment_ranges: list[dict[str, Any]] = []
    confidences: list[float] = []
    for segment in segments:
        text = str(getattr(segment, "text", "") or "").strip()
        if not text:
            continue

        transcript_parts.append(text)
        segment_ranges.append(
            {
                "start_ms": int(round(float(getattr(segment, "start", 0.0)) * 1000)),
                "end_ms": int(round(float(getattr(segment, "end", 0.0)) * 1000)),
                "text": text,
            }
        )
        avg_logprob = getattr(segment, "avg_logprob", None)
        if avg_logprob is not None:
            confidences.append(max(0.0, min(1.0, math.exp(float(avg_logprob)))))

    transcript = " ".join(transcript_parts).strip()
    duration_ms = int(round(audio.shape[0] * 1000 / SERVER_SAMPLE_RATE_HZ)) if getattr(audio, "shape", None) else 0
    confidence = sum(confidences) / len(confidences) if confidences else None
    success = bool(transcript)

    return {
        "status": "final" if success else "unavailable",
        "transcript": transcript or "Local transcription is unavailable.",
        "locale": locale,
        "confidence": confidence,
        "timing": {
            "utterance_duration_ms": duration_ms,
            "segment_ranges": segment_ranges,
            "audio_format": {
                "container": "wav",
                "encoding": "pcm_f32le",
                "sample_rate_hz": SERVER_SAMPLE_RATE_HZ,
                "channels": 1,
            },
        },
        "device": device,
        "compute_type": compute_type,
    }


def run_stdin_transcribe() -> int:
    payload = json.loads(sys.stdin.read() or "{}")
    model_root = Path(str(payload.get("model_root") or "")).expanduser()
    locale = str(payload.get("locale") or "en-US")
    audio_reference = str(payload.get("audio_reference") or "").strip()

    if not model_root.exists():
        sys.stdout.write(json.dumps({
            "status": "unavailable",
            "transcript": payload.get("transcript_hint") or "Local transcription is unavailable.",
            "locale": locale,
            "confidence": payload.get("confidence_hint"),
            "timing": payload.get("timing") or {"utterance_duration_ms": 0},
        }))
        return 0

    audio_path = Path(audio_reference)
    if not audio_path.is_file():
        sys.stdout.write(json.dumps({
            "status": "unavailable",
            "transcript": payload.get("transcript_hint") or "Local transcription is unavailable.",
            "locale": locale,
            "confidence": payload.get("confidence_hint"),
            "timing": payload.get("timing") or {"utterance_duration_ms": 0},
        }))
        return 0

    try:
        audio, sample_rate = _read_wav_audio(audio_path)
        audio = _resample_audio(audio, sample_rate, SERVER_SAMPLE_RATE_HZ)
        response = _transcribe_audio(model_root, audio, locale=locale)
    except Exception as exc:
        logger.exception("One-shot transcription failed")
        response = {
            "status": "error",
            "transcript": payload.get("transcript_hint") or "Local transcription is unavailable.",
            "locale": locale,
            "confidence": payload.get("confidence_hint"),
            "timing": payload.get("timing") or {"utterance_duration_ms": 0},
            "reason": str(exc),
        }

    sys.stdout.write(json.dumps(response))
    return 0


@dataclass(slots=True, frozen=True)
class RuntimeEvent:
    sequence: int
    event_type: str
    timestamp_epoch: float
    payload: dict[str, Any]


class HotMicRuntime:
    def __init__(self, *, model_root: Path, locale: str = "en-US") -> None:
        self._model_root = model_root
        self._locale = locale
        self._model = None
        self._compute_device = "cpu"
        self._compute_type = "int8"
        self._last_error: str | None = None
        self._state = "starting"
        self._selected_device_id: str | None = None
        self._selected_device_label: str | None = None
        self._listening = False
        self._latest_confirmed_text: str | None = None
        self._latest_confirmed_at: float | None = None
        self._total_confirmed = 0
        self._total_submitted = 0
        self._event_sequence = 0
        self._events: deque[RuntimeEvent] = deque(maxlen=256)
        self._segment_queue: queue.Queue[tuple[Any, int]] = queue.Queue(maxsize=8)
        self._processor_stop = threading.Event()
        self._processor_thread = threading.Thread(target=self._process_loop, name="stt-sidecar-process", daemon=True)
        self._stream_lock = threading.Lock()
        self._audio_lock = threading.Lock()
        self._stream = None
        self._current_chunks: list[Any] = []
        self._pre_roll: deque[Any] = deque(maxlen=3)
        self._speech_blocks = 0
        self._silence_blocks = 0
        self._speaking = False
        self._noise_floor = MIN_RMS_THRESHOLD / 2
        self._load_runtime()
        self._processor_thread.start()

    def _load_runtime(self) -> None:
        try:
            self._model, self._compute_device, self._compute_type = _load_model(self._model_root)
            self._set_state("ready")
        except Exception as exc:
            self._last_error = str(exc)
            self._set_state("error")

    def _set_state(self, state: str) -> None:
        if self._state == state:
            return
        self._state = state
        self._append_event("state.changed", {"state": state})

    def _append_event(self, event_type: str, payload: dict[str, Any]) -> None:
        self._event_sequence += 1
        self._events.append(
            RuntimeEvent(
                sequence=self._event_sequence,
                event_type=event_type,
                timestamp_epoch=time.time(),
                payload=payload,
            )
        )

    def health(self) -> dict[str, Any]:
        return {
            "status": "ready" if self._state != "error" else "error",
            "model_loaded": self._model is not None,
            "state": self._state,
            "model_name": self._model_root.name,
            "compute_device": self._compute_device,
            "compute_type": self._compute_type,
            "last_error": self._last_error,
            "selected_device_id": self._selected_device_id,
            "selected_device_label": self._selected_device_label,
            "listening": self._listening,
        }

    def snapshot(self) -> dict[str, Any]:
        return {
            **self.health(),
            "locale": self._locale,
            "latest_confirmed_text": self._latest_confirmed_text,
            "latest_confirmed_at": self._latest_confirmed_at,
            "total_confirmed": self._total_confirmed,
            "total_submitted": self._total_submitted,
            "next_sequence": self._event_sequence + 1,
        }

    def list_devices(self) -> list[dict[str, Any]]:
        if sounddevice is None:
            return []

        devices: list[dict[str, Any]] = []
        try:
            defaults = sounddevice.default.device
            default_input = defaults[0] if isinstance(defaults, (list, tuple)) and defaults else None
            for index, device in enumerate(sounddevice.query_devices()):
                if int(device.get("max_input_channels") or 0) <= 0:
                    continue
                devices.append(
                    {
                        "device_id": str(index),
                        "label": str(device.get("name") or f"Input {index}"),
                        "default": default_input == index,
                        "sample_rate_hz": int(device.get("default_samplerate") or SERVER_SAMPLE_RATE_HZ),
                        "max_input_channels": int(device.get("max_input_channels") or 1),
                    }
                )
        except Exception as exc:
            self._last_error = str(exc)
            return []

        if self._selected_device_id is None:
            default_device = next((device for device in devices if device["default"]), None)
            if default_device is not None:
                self._selected_device_id = default_device["device_id"]
                self._selected_device_label = default_device["label"]
        return devices

    def set_device(self, device_id: str | None) -> dict[str, Any]:
        devices = self.list_devices()
        target = None
        if device_id is not None:
            target = next((device for device in devices if device["device_id"] == str(device_id)), None)
        else:
            target = next((device for device in devices if device["default"]), None)

        if target is None:
            raise RuntimeError("Selected input device is unavailable")

        self._selected_device_id = str(target["device_id"])
        self._selected_device_label = str(target["label"])
        self._append_event(
            "device.selected",
            {
                "device_id": self._selected_device_id,
                "device_label": self._selected_device_label,
            },
        )

        if self._listening:
            self.stop_listening()
            self.start_listening()

        return self.snapshot()

    def start_listening(self) -> dict[str, Any]:
        if sounddevice is None:
            raise RuntimeError("python-sounddevice is not installed")
        if np is None:
            raise RuntimeError("numpy is not installed")
        if self._model is None:
            raise RuntimeError(self._last_error or "The STT model is unavailable")

        if self._selected_device_id is None:
            self.list_devices()

        with self._stream_lock:
            if self._stream is not None:
                self._listening = True
                self._set_state("listening")
                return self.snapshot()

            device_index = int(self._selected_device_id) if self._selected_device_id is not None else None
            self._stream = sounddevice.InputStream(
                device=device_index,
                samplerate=SERVER_SAMPLE_RATE_HZ,
                channels=1,
                dtype="float32",
                blocksize=SERVER_BLOCK_SIZE,
                callback=self._audio_callback,
            )
            self._stream.start()
            self._listening = True
            self._set_state("listening")
            self._append_event(
                "listening.started",
                {
                    "device_id": self._selected_device_id,
                    "device_label": self._selected_device_label,
                },
            )
        return self.snapshot()

    def stop_listening(self) -> dict[str, Any]:
        with self._stream_lock:
            if self._stream is not None:
                try:
                    self._stream.stop()
                    self._stream.close()
                finally:
                    self._stream = None

        self._listening = False
        if self._state != "error":
            self._set_state("ready")
        self._append_event("listening.stopped", {"state": self._state})
        return self.snapshot()

    def events_after(self, after_sequence: int) -> dict[str, Any]:
        return {
            "events": [
                {
                    "sequence": event.sequence,
                    "event_type": event.event_type,
                    "timestamp_epoch": event.timestamp_epoch,
                    **event.payload,
                }
                for event in self._events
                if event.sequence > after_sequence
            ],
            "next_sequence": self._event_sequence + 1,
        }

    def shutdown(self) -> dict[str, Any]:
        self.stop_listening()
        self._processor_stop.set()
        try:
            self._segment_queue.put_nowait((None, 0))
        except Exception:
            pass
        return {"status": "shutdown"}

    def _audio_callback(self, indata: Any, frames: int, _time_info: Any, status: Any) -> None:
        if status:
            self._last_error = str(status)
        if np is None:
            return

        chunk = np.asarray(indata, dtype=np.float32).reshape(-1).copy()
        if chunk.size == 0:
            return
        self._consume_chunk(chunk)

    def _consume_chunk(self, chunk: Any) -> None:
        if np is None:
            return

        rms = float(np.sqrt(np.mean(np.square(chunk)))) if chunk.size else 0.0
        threshold = max(MIN_RMS_THRESHOLD, self._noise_floor * 3.0)

        with self._audio_lock:
            if not self._speaking:
                self._pre_roll.append(chunk)
                self._noise_floor = (self._noise_floor * 0.97) + (min(rms, threshold) * 0.03)
                if rms >= threshold:
                    self._speech_blocks += 1
                    if self._state != "detected":
                        self._set_state("detected")
                else:
                    self._speech_blocks = 0
                    if self._listening and self._state == "detected":
                        self._set_state("listening")

                if self._speech_blocks >= SPEECH_START_BLOCKS:
                    self._speaking = True
                    self._current_chunks = list(self._pre_roll)
                    self._silence_blocks = 0
                    self._speech_blocks = 0
                return

            self._current_chunks.append(chunk)
            if rms >= threshold * 0.6:
                self._silence_blocks = 0
            else:
                self._silence_blocks += 1

            total_samples = sum(item.shape[0] for item in self._current_chunks)
            total_seconds = total_samples / SERVER_SAMPLE_RATE_HZ
            if self._silence_blocks < SPEECH_END_BLOCKS and total_seconds < MAX_UTTERANCE_SECONDS:
                return

            segment = np.concatenate(self._current_chunks).astype(np.float32)
            self._current_chunks = []
            self._pre_roll.clear()
            self._speaking = False
            self._silence_blocks = 0

        duration_ms = int(round(segment.shape[0] * 1000 / SERVER_SAMPLE_RATE_HZ))
        if duration_ms < int(MIN_UTTERANCE_SECONDS * 1000):
            if self._listening:
                self._set_state("listening")
            return

        try:
            self._segment_queue.put_nowait((segment, duration_ms))
            self._set_state("processing")
        except queue.Full:
            self._last_error = "STT processing queue is full"
            self._append_event("segment.dropped", {"reason": self._last_error})
            if self._listening:
                self._set_state("listening")

    def _process_loop(self) -> None:
        while not self._processor_stop.is_set():
            try:
                audio, duration_ms = self._segment_queue.get(timeout=0.2)
            except queue.Empty:
                continue

            if audio is None:
                break

            started_at = time.time()
            try:
                segments, _info = self._model.transcribe(
                    audio,
                    language=_resolve_locale_language(self._locale),
                    beam_size=1,
                    vad_filter=False,
                    condition_on_previous_text=False,
                    compression_ratio_threshold=2.4,
                    no_speech_threshold=0.55,
                )
                transcript_parts: list[str] = []
                segment_ranges: list[dict[str, Any]] = []
                confidences: list[float] = []
                for segment in segments:
                    text = str(getattr(segment, "text", "") or "").strip()
                    if not text:
                        continue
                    transcript_parts.append(text)
                    segment_ranges.append(
                        {
                            "start_ms": int(round(float(getattr(segment, "start", 0.0)) * 1000)),
                            "end_ms": int(round(float(getattr(segment, "end", 0.0)) * 1000)),
                            "text": text,
                        }
                    )
                    avg_logprob = getattr(segment, "avg_logprob", None)
                    if avg_logprob is not None:
                        confidences.append(max(0.0, min(1.0, math.exp(float(avg_logprob)))))

                transcript = " ".join(transcript_parts).strip()
                if transcript:
                    confidence = sum(confidences) / len(confidences) if confidences else None
                    self._latest_confirmed_text = transcript
                    self._latest_confirmed_at = time.time()
                    self._total_confirmed += 1
                    self._total_submitted += 1
                    self._append_event(
                        "transcript.confirmed",
                        {
                            "state": "processing",
                            "transcript": transcript,
                            "locale": self._locale,
                            "confidence": confidence,
                            "duration_ms": duration_ms,
                            "segment_ranges": segment_ranges,
                            "latency_ms": int(round((time.time() - started_at) * 1000)),
                        },
                    )
            except Exception as exc:
                self._last_error = str(exc)
                self._append_event(
                    "transcript.error",
                    {
                        "state": "error",
                        "message": self._last_error,
                    },
                )
                self._set_state("error")
            finally:
                if self._listening and self._state != "error":
                    self._set_state("listening")


def _build_handler(runtime: HotMicRuntime) -> type[BaseHTTPRequestHandler]:
    class Handler(BaseHTTPRequestHandler):
        server_version = "NikoFStt/1.0"

        def log_message(self, format: str, *args: Any) -> None:  # noqa: A003
            logger.info("STT sidecar: " + format, *args)

        def do_GET(self) -> None:  # noqa: N802
            parsed = urlparse(self.path)
            if parsed.path == "/health":
                self._send_json(runtime.health())
                return
            if parsed.path == "/state":
                self._send_json(runtime.snapshot())
                return
            if parsed.path == "/devices":
                self._send_json({"devices": runtime.list_devices()})
                return
            if parsed.path == "/events":
                raw_after = parse_qs(parsed.query).get("after", ["0"])[0]
                try:
                    after_sequence = int(raw_after)
                except ValueError:
                    after_sequence = 0
                self._send_json(runtime.events_after(after_sequence))
                return
            self.send_error(HTTPStatus.NOT_FOUND)

        def do_POST(self) -> None:  # noqa: N802
            parsed = urlparse(self.path)
            body = self._read_json_body()
            try:
                if parsed.path == "/device":
                    self._send_json(runtime.set_device(None if body.get("device_id") is None else str(body.get("device_id"))))
                    return
                if parsed.path == "/listening/start":
                    self._send_json(runtime.start_listening())
                    return
                if parsed.path == "/listening/stop":
                    self._send_json(runtime.stop_listening())
                    return
                if parsed.path == "/shutdown":
                    self._send_json(runtime.shutdown())
                    threading.Thread(target=self.server.shutdown, daemon=True).start()
                    return
            except Exception as exc:
                self._send_json({"status": "error", "detail": str(exc)}, status=HTTPStatus.BAD_REQUEST)
                return

            self.send_error(HTTPStatus.NOT_FOUND)

        def _read_json_body(self) -> dict[str, Any]:
            raw_length = self.headers.get("content-length") or "0"
            try:
                length = int(raw_length)
            except ValueError:
                length = 0
            if length <= 0:
                return {}

            payload = self.rfile.read(length).decode("utf-8")
            decoded = json.loads(payload or "{}")
            if isinstance(decoded, dict):
                return decoded
            return {}

        def _send_json(self, payload: dict[str, Any], *, status: HTTPStatus = HTTPStatus.OK) -> None:
            encoded = json.dumps(payload).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(encoded)))
            self.end_headers()
            self.wfile.write(encoded)

    return Handler


def run_server_cli(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", default="8767")
    parser.add_argument("--model-root", required=True)
    parser.add_argument("--locale", default="en-US")
    args = parser.parse_args(argv)

    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    runtime = HotMicRuntime(model_root=Path(args.model_root), locale=args.locale)
    server = ThreadingHTTPServer((args.host, int(args.port)), _build_handler(runtime))
    try:
        server.serve_forever(poll_interval=0.2)
    finally:
        runtime.shutdown()
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(run_server_cli())