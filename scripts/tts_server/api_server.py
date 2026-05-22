"""Persistent GPT-SoVITS HTTP inference server.

Keeps the model loaded in GPU memory and serves synthesis requests over HTTP.
Designed to be launched by NikoF's GPTSoVITSServerManager (tts_server.py).

Endpoints:
    GET  /health     -> {"status": "ready", "model": "...", "vram_mb": ...}
    POST /synthesize -> {"status": "ready", "audio_reference": "...", "timing": {...}}
    POST /shutdown   -> {"status": "shutting_down"}

Launch:
    python api_server.py --host 127.0.0.1 --port 9880 \
        --model-root %LOCALAPPDATA%\\NikoF\\models\\tts\\gpt-sovits \
        --weights-root ./weights \
        --reference-audio-root ./reference-audio
"""

from __future__ import annotations

import argparse
import contextlib
import gc
import io
import json
import os
import signal
import subprocess
import sys
import threading
import traceback
import uuid
from http.server import HTTPServer, BaseHTTPRequestHandler
from pathlib import Path
from typing import Any


PROVIDER_ROOT = Path(__file__).resolve().parent
DEFAULT_GPT_MODEL = "s1bert25hz-2kh-longer-epoch=68e-step=50232.ckpt"
DEFAULT_SOVITS_MODEL = "s2G488k.pth"

# Disable automatic garbage collection — PyTorch tensor destructors cause
# prolonged GPU activity when GC runs.  We rely on refcounting instead.
gc.disable()
OWNER_POLL_INTERVAL_SECONDS = 2.0

# Globals set during startup
_model_root: Path = Path(".")
_speaker_manifest: dict[str, Any] = {}
_get_tts_wav: Any = None
_i18n: Any = None
_model_name: str = "gpt-sovits"
_owner_pid: int | None = None
_lock = threading.Lock()


# ──────────────────────────────────────────────────────────────────
# Helpers (adapted from synthesize.py)
# ──────────────────────────────────────────────────────────────────


def _read_json(path: Path) -> dict[str, Any]:
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    return payload if isinstance(payload, dict) else {}


def _coerce_int(value: Any, default: int) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def _coerce_float(value: Any, default: float) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def _coerce_bool(value: Any, default: bool) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        normalized = value.strip().lower()
        if normalized in {"1", "true", "yes", "on"}:
            return True
        if normalized in {"0", "false", "no", "off"}:
            return False
    return default


def _resolve_existing_path(root: Path, raw_value: Any) -> Path | None:
    if not isinstance(raw_value, str) or not raw_value.strip():
        return None
    candidate = Path(raw_value.strip())
    if not candidate.is_absolute():
        candidate = (root / candidate).resolve()
    else:
        candidate = candidate.resolve()
    return candidate if candidate.exists() else None


def _merge_settings(*sources: Any) -> dict[str, Any]:
    merged: dict[str, Any] = {}
    for source in sources:
        if not isinstance(source, dict):
            continue
        for key, value in source.items():
            if value is None:
                continue
            merged[key] = value
    return merged


def _owner_pid_from_env() -> int | None:
    raw_owner_pid = os.environ.get("NIKOF_TTS_OWNER_PID", "").strip()
    if not raw_owner_pid:
        return None
    try:
        return int(raw_owner_pid)
    except ValueError:
        return None


def _owner_process_exists(owner_pid: int | None) -> bool:
    if owner_pid is None or owner_pid <= 0:
        return False

    if sys.platform == "win32":
        creationflags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
        try:
            completed = subprocess.run(
                ["tasklist", "/FI", f"PID eq {owner_pid}", "/FO", "CSV", "/NH"],
                capture_output=True,
                text=True,
                check=False,
                creationflags=creationflags,
            )
        except OSError:
            return False
        output = (completed.stdout or "").strip()
        return completed.returncode == 0 and output and "No tasks are running" not in output and f'"{owner_pid}"' in output

    try:
        os.kill(owner_pid, 0)
    except OSError:
        return False
    return True


def _language_label(raw_value: Any) -> str:
    normalized = str(raw_value or "").strip().lower().replace("_", "-")
    if normalized.startswith("ja") or normalized in {"japanese", "jp", "\u65e5\u6587"}:
        return _i18n("\u65e5\u6587")
    if normalized.startswith("zh") or normalized in {"chinese", "cn", "\u4e2d\u6587"}:
        return _i18n("\u4e2d\u6587")
    return _i18n("\u82f1\u6587")


def _timing_payload(*, sample_rate: int, sample_count: int, text: str) -> dict[str, Any]:
    duration_ms = int(round((sample_count / sample_rate) * 1000)) if sample_rate > 0 else 0
    return {
        "utterance_duration_ms": duration_ms,
        "segment_ranges": [
            {"start_ms": 0, "end_ms": duration_ms, "text": text},
        ],
        "audio_format": {
            "container": "wav",
            "encoding": "pcm_s16le",
            "sample_rate_hz": sample_rate,
            "channels": 1,
        },
    }


# ──────────────────────────────────────────────────────────────────
# Model loading (one-time at startup)
# ──────────────────────────────────────────────────────────────────


def _load_model(model_root: Path) -> None:
    """Load GPT-SoVITS model into memory. Called once at startup."""
    global _get_tts_wav, _i18n, _model_root, _speaker_manifest, _model_name

    _model_root = model_root

    model_runtime = _read_json(model_root / "runtime.json")
    speaker_manifest_path = _resolve_existing_path(
        model_root,
        model_runtime.get("speaker_manifest") or "speakers/default.json",
    )
    _speaker_manifest = _read_json(speaker_manifest_path) if speaker_manifest_path else {}

    settings = _merge_settings(_speaker_manifest, model_runtime)

    pretrained_root = model_root / "pretrained_models"
    gpt_model = _resolve_existing_path(
        model_root,
        settings.get("gpt_model") or settings.get("gpt_path") or settings.get("gpt_weights"),
    ) or _resolve_existing_path(pretrained_root, DEFAULT_GPT_MODEL)

    sovits_model = _resolve_existing_path(
        model_root,
        settings.get("sovits_model") or settings.get("sovits_path") or settings.get("sovits_weights"),
    ) or _resolve_existing_path(pretrained_root, DEFAULT_SOVITS_MODEL)

    bert_path = _resolve_existing_path(
        model_root,
        settings.get("bert_path") or "pretrained_models/chinese-roberta-wwm-ext-large",
    )
    hubert_path = _resolve_existing_path(
        model_root,
        settings.get("cnhubert_path") or settings.get("hubert_path") or "pretrained_models/chinese-hubert-base",
    )

    if not all([gpt_model, sovits_model, bert_path, hubert_path]):
        missing = [
            name for name, val in [
                ("gpt_model", gpt_model),
                ("sovits_model", sovits_model),
                ("bert_path", bert_path),
                ("hubert_path", hubert_path),
            ] if val is None
        ]
        raise RuntimeError(f"Missing model assets: {missing}")

    # Set environment for GPT-SoVITS
    os.environ["gpt_path"] = str(gpt_model)
    os.environ["sovits_path"] = str(sovits_model)
    os.environ["bert_path"] = str(bert_path)
    os.environ["cnhubert_base_path"] = str(hubert_path)
    os.environ["is_half"] = str(_coerce_bool(settings.get("is_half"), False))
    os.environ["PYTHONIOENCODING"] = "utf-8"
    os.environ["PATH"] = str(PROVIDER_ROOT) + os.pathsep + os.environ.get("PATH", "")

    if str(PROVIDER_ROOT) not in sys.path:
        sys.path.insert(0, str(PROVIDER_ROOT))
    package_root = PROVIDER_ROOT / "GPT_SoVITS"
    if str(package_root) not in sys.path:
        sys.path.insert(0, str(package_root))

    # Import GPT-SoVITS (this triggers model loading into GPU)
    log_buffer = io.StringIO()
    original_cwd = Path.cwd()
    os.chdir(PROVIDER_ROOT)
    try:
        with contextlib.redirect_stdout(log_buffer), contextlib.redirect_stderr(log_buffer):
            from GPT_SoVITS.inference_webui import get_tts_wav, i18n  # type: ignore
            from GPT_SoVITS import inference_webui as _iw  # type: ignore
            _get_tts_wav = get_tts_wav
            _i18n = i18n
            # Cap per-segment generation at 30s (default 54s).  The post-generation
            # duration cap (1s/word + 2s, max 30s) trims the final audio anyway.
            _iw.max_sec = 30
    finally:
        os.chdir(original_cwd)

    _model_name = f"gpt-sovits ({gpt_model.stem if gpt_model else 'unknown'})"
    print(f"[api_server] Model loaded: {_model_name}", flush=True)
    print(f"[api_server] GPT: {gpt_model}", flush=True)
    print(f"[api_server] SoVITS: {sovits_model}", flush=True)


# ──────────────────────────────────────────────────────────────────
# Synthesis
# ──────────────────────────────────────────────────────────────────


def _synthesize(request: dict[str, Any]) -> dict[str, Any]:
    """Run TTS inference. Thread-safe via lock (model is not re-entrant)."""
    text = str(request.get("text") or "").strip()
    locale = str(request.get("locale") or "en-US")

    if not text:
        return {
            "status": "error",
            "text": "",
            "locale": locale,
            "audio_reference": None,
            "error": {"code": "empty-text", "message": "No text to synthesize."},
        }

    voice_profile = request.get("voice_profile") if isinstance(request.get("voice_profile"), dict) else {}
    settings = _merge_settings(_speaker_manifest, voice_profile)

    reference_audio = _resolve_existing_path(
        _model_root,
        settings.get("reference_audio") or settings.get("refer_wav_path"),
    )
    prompt_text = str(settings.get("prompt_text") or settings.get("reference_text") or "").strip()
    prompt_language_raw = settings.get("prompt_language") or settings.get("reference_language") or locale
    text_language_raw = settings.get("text_language") or locale

    if reference_audio is None or not prompt_text:
        return {
            "status": "error",
            "text": text,
            "locale": locale,
            "audio_reference": None,
            "error": {
                "code": "missing-speaker-reference",
                "message": "No reference audio or prompt text configured.",
            },
        }

    generated_root = _model_root / "generated"
    generated_root.mkdir(parents=True, exist_ok=True)
    audio_path = generated_root / f"tts-{uuid.uuid4().hex}.wav"

    log_buffer = io.StringIO()
    original_cwd = Path.cwd()

    with _lock:
        os.chdir(PROVIDER_ROOT)
        try:
            with contextlib.redirect_stdout(log_buffer), contextlib.redirect_stderr(log_buffer):
                chunks = list(
                    _get_tts_wav(
                        ref_wav_path=str(reference_audio),
                        prompt_text=prompt_text,
                        prompt_language=_language_label(prompt_language_raw),
                        text=text,
                        text_language=_language_label(text_language_raw),
                        top_k=_coerce_int(settings.get("top_k"), 20),
                        top_p=_coerce_float(settings.get("top_p"), 0.6),
                        temperature=_coerce_float(settings.get("temperature"), 0.6),
                        ref_free=_coerce_bool(settings.get("ref_free"), True),
                    )
                )

            if not chunks:
                raise RuntimeError("GPT-SoVITS returned no audio chunks.")

            import soundfile  # type: ignore
            import numpy as np  # type: ignore
            sample_rate, audio_data = chunks[-1]

            # Duration cap: prevent runaway generation.
            # Allow ~1s per word + 2s base (min 3s, max 30s).
            word_count = max(1, len(text.split()))
            max_duration_s = min(max(3.0, word_count * 1.0 + 2.0), 30.0)
            max_samples = int(max_duration_s * sample_rate)
            if len(audio_data) > max_samples:
                # Apply a short fade-out (20ms) to avoid click
                fade_samples = min(int(0.02 * sample_rate), max_samples)
                audio_data = audio_data[:max_samples].copy()
                fade = np.linspace(1.0, 0.0, fade_samples, dtype=audio_data.dtype)
                audio_data[-fade_samples:] *= fade

            soundfile.write(str(audio_path), audio_data, sample_rate)

        except Exception as exc:
            return {
                "status": "error",
                "text": text,
                "locale": locale,
                "audio_reference": None,
                "error": {
                    "code": "synthesis-failed",
                    "message": str(exc),
                    "details": {
                        "traceback": traceback.format_exc()[-2000:],
                        "log": log_buffer.getvalue()[-2000:],
                    },
                },
            }
        finally:
            os.chdir(original_cwd)
            # Minimal cleanup — avoid triggering CUDA work.
            try:
                del chunks  # type: ignore[possibly-undefined]
            except Exception:
                pass

    return {
        "status": "ready",
        "text": text,
        "locale": locale,
        "audio_reference": str(audio_path),
        "timing": _timing_payload(
            sample_rate=_coerce_int(sample_rate, 24000),
            sample_count=len(audio_data),
            text=text,
        ),
    }


# ──────────────────────────────────────────────────────────────────
# HTTP Server
# ──────────────────────────────────────────────────────────────────

_shutdown_event = threading.Event()


class _RequestHandler(BaseHTTPRequestHandler):
    """Minimal HTTP handler for health, synthesis, and shutdown."""

    def log_message(self, format: str, *args: Any) -> None:
        # Suppress default access logs — we log at a higher level
        pass

    def _send_json(self, status: int, body: dict[str, Any]) -> None:
        payload = json.dumps(body).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def _read_body(self) -> bytes:
        content_length = int(self.headers.get("Content-Length", 0))
        return self.rfile.read(content_length) if content_length > 0 else b""

    def do_GET(self) -> None:
        if self.path == "/health":
            self._send_json(200, {
                "status": "ready",
                "model": _model_name,
                "owner_pid": _owner_pid,
            })
        else:
            self._send_json(404, {"error": "not_found"})

    def do_POST(self) -> None:
        if self.path == "/synthesize":
            body = self._read_body()
            try:
                request = json.loads(body) if body else {}
            except json.JSONDecodeError:
                self._send_json(400, {"error": "invalid_json"})
                return

            if not isinstance(request, dict):
                self._send_json(400, {"error": "expected_object"})
                return

            result = _synthesize(request)
            status_code = 200 if result.get("status") == "ready" else 500
            self._send_json(status_code, result)

        elif self.path == "/shutdown":
            self._send_json(200, {"status": "shutting_down"})
            _shutdown_event.set()

        else:
            self._send_json(404, {"error": "not_found"})


def _run_server(host: str, port: int) -> None:
    """Start the HTTP server and block until shutdown."""
    server = HTTPServer((host, port), _RequestHandler)
    server.timeout = 1.0  # Check shutdown_event every second

    print(f"[api_server] Listening on http://{host}:{port}", flush=True)

    def _signal_handler(sig: int, frame: Any) -> None:
        _shutdown_event.set()

    signal.signal(signal.SIGINT, _signal_handler)
    signal.signal(signal.SIGTERM, _signal_handler)

    if _owner_pid is not None:
        def _owner_watchdog() -> None:
            while not _shutdown_event.wait(OWNER_POLL_INTERVAL_SECONDS):
                if _owner_process_exists(_owner_pid):
                    continue
                print(f"[api_server] Owner pid {_owner_pid} exited; shutting down.", flush=True)
                _shutdown_event.set()
                return

        threading.Thread(target=_owner_watchdog, name="tts-owner-watchdog", daemon=True).start()

    while not _shutdown_event.is_set():
        server.handle_request()

    server.server_close()
    print("[api_server] Server shut down.", flush=True)


# ──────────────────────────────────────────────────────────────────
# CLI
# ──────────────────────────────────────────────────────────────────


def main() -> int:
    global _owner_pid

    parser = argparse.ArgumentParser(description="GPT-SoVITS persistent inference server")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=9880)
    parser.add_argument("--model-root", required=True, help="Path to NikoF TTS model root")
    parser.add_argument("--weights-root", default="./weights", help="Relative weights path (unused, kept for CLI compat)")
    parser.add_argument("--reference-audio-root", default="./reference-audio", help="Relative ref audio path (unused)")
    args = parser.parse_args()

    model_root = Path(args.model_root).resolve()
    _owner_pid = _owner_pid_from_env()
    if not model_root.exists():
        print(f"[api_server] ERROR: model root does not exist: {model_root}", file=sys.stderr)
        return 1

    print(f"[api_server] Loading model from {model_root}...", flush=True)
    try:
        _load_model(model_root)
    except Exception as exc:
        print(f"[api_server] FATAL: Failed to load model: {exc}", file=sys.stderr)
        traceback.print_exc(file=sys.stderr)
        return 1

    _run_server(args.host, args.port)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
