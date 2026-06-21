"""STT WER A/B bench — Faster-Whisper medium vs Parakeet TDT 0.6B v2.

Phase 3 decision gate (docs/PHASE3_STREAMING_STT_DESIGN.md): before switching the
default recognizer to Parakeet, confirm its accuracy is within a chosen WER
threshold of Faster-Whisper medium on representative clips, and compare latency.

For each .wav under --stt-dir it transcribes with both engines (building each
model once), computes:
  - WER vs a ground-truth reference, when a sidecar text file exists
    (<clip>.txt or <clip>.ref.txt); else N/A.
  - cross-engine divergence (Parakeet vs Whisper as a pseudo-reference) so the
    A/B is still meaningful without ground truth.
  - per-clip transcription latency.

Run on the box with the GPU free (models loaded):

    $env:NIKOF_STT_ALLOW_GPU = "1"
    .venv\\Scripts\\python.exe scripts/testing/stt_wer_bench.py --stt-dir .local/stt-tests

Stdlib + numpy + the project's STT providers only (no jiwer dependency).
"""

from __future__ import annotations

import argparse
import glob
import json
import os
import statistics
import sys
import time
from pathlib import Path
from typing import Any, Callable


REPO_ROOT = Path(__file__).resolve().parents[2]
BACKEND_ROOT = REPO_ROOT / "backend"
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))


def _normalize_words(text: str) -> list[str]:
    """Lowercase, drop punctuation (keep intra-word apostrophes), split on
    whitespace — a standard WER tokenization."""
    cleaned: list[str] = []
    for raw in text.lower().split():
        token = "".join(ch for ch in raw if ch.isalnum() or ch == "'")
        token = token.strip("'")
        if token:
            cleaned.append(token)
    return cleaned


def word_error_rate(reference: str, hypothesis: str) -> float | None:
    """Levenshtein word error rate = (S + D + I) / N_ref. None if no reference
    words. 0.0 = identical; can exceed 1.0 when the hypothesis is much longer."""
    ref = _normalize_words(reference)
    hyp = _normalize_words(hypothesis)
    if not ref:
        return None

    # Classic DP edit distance over word sequences.
    previous = list(range(len(hyp) + 1))
    for i, ref_word in enumerate(ref, start=1):
        current = [i]
        for j, hyp_word in enumerate(hyp, start=1):
            cost = 0 if ref_word == hyp_word else 1
            current.append(
                min(
                    previous[j] + 1,        # deletion
                    current[j - 1] + 1,     # insertion
                    previous[j - 1] + cost  # substitution / match
                )
            )
        previous = current
    return previous[-1] / len(ref)


def _load_reference(wav_path: Path) -> str | None:
    for suffix in (".ref.txt", ".txt"):
        candidate = wav_path.with_suffix(suffix)
        if candidate.is_file():
            return candidate.read_text(encoding="utf-8").strip()
    return None


def _load_audio_16k(wav_path: Path) -> Any:
    from app.providers.faster_whisper_runtime import (
        SERVER_SAMPLE_RATE_HZ,
        _read_wav_audio,
        _resample_audio,
    )

    audio, sample_rate = _read_wav_audio(wav_path)
    return _resample_audio(audio, sample_rate, SERVER_SAMPLE_RATE_HZ)


def _build_whisper_transcriber(model_root: Path, locale: str) -> Callable[[Any], str]:
    from app.providers.faster_whisper_runtime import _load_model, _resolve_locale_language

    model, _device, _compute = _load_model(model_root)
    language = _resolve_locale_language(locale)

    def _transcribe(audio: Any) -> str:
        segments, _info = model.transcribe(
            audio,
            language=language,
            beam_size=1,
            vad_filter=False,
            condition_on_previous_text=False,
            compression_ratio_threshold=2.4,
            no_speech_threshold=0.55,
        )
        return " ".join(str(getattr(s, "text", "") or "").strip() for s in segments).strip()

    return _transcribe


def _build_parakeet_transcriber(locale: str) -> Callable[[Any], str]:
    from app.providers.stt_engines import ParakeetTranscriptionEngine, resolve_parakeet_model_root

    engine = ParakeetTranscriptionEngine(resolve_parakeet_model_root())
    engine.ensure_ready()

    def _transcribe(audio: Any) -> str:
        return engine.transcribe(audio, locale=locale).transcript

    return _transcribe


def _summarize(values: list[float]) -> dict[str, float] | None:
    clean = [v for v in values if isinstance(v, (int, float))]
    if not clean:
        return None
    return {
        "n": len(clean),
        "mean": round(statistics.fmean(clean), 4),
        "min": round(min(clean), 4),
        "max": round(max(clean), 4),
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="STT WER A/B bench (Whisper vs Parakeet)")
    parser.add_argument("--stt-dir", default=str(REPO_ROOT / ".local" / "stt-tests"))
    parser.add_argument("--engines", default="faster-whisper,parakeet")
    parser.add_argument("--whisper-model-dir", default=None, help="default: <stt_models_root>/faster-whisper-medium")
    parser.add_argument("--locale", default="en-US")
    parser.add_argument("--wer-threshold", type=float, default=0.15, help="max acceptable Parakeet WER vs Whisper")
    parser.add_argument("--out", default=None)
    args = parser.parse_args()

    from app.core.settings import get_app_paths

    wav_paths = sorted(Path(p) for p in glob.glob(os.path.join(args.stt_dir, "*.wav")))
    if not wav_paths:
        raise SystemExit(f"No .wav files under {args.stt_dir}")

    whisper_root = Path(args.whisper_model_dir) if args.whisper_model_dir else (
        get_app_paths().stt_models_root / "faster-whisper-medium"
    )
    engines = [e.strip() for e in args.engines.split(",") if e.strip()]

    print(f"Clips: {len(wav_paths)} from {args.stt_dir}")
    print(f"Engines: {engines}")
    print(f"Allow GPU: {os.environ.get('NIKOF_STT_ALLOW_GPU', '0')}\n")

    builders: dict[str, Callable[[], Callable[[Any], str]]] = {
        "faster-whisper": lambda: _build_whisper_transcriber(whisper_root, args.locale),
        "parakeet": lambda: _build_parakeet_transcriber(args.locale),
    }

    # Build each engine once, then transcribe every clip (load time excluded
    # from per-clip latency).
    transcribers: dict[str, Callable[[Any], str]] = {}
    for engine in engines:
        if engine not in builders:
            raise SystemExit(f"Unknown engine: {engine}")
        print(f"Loading {engine} ...")
        transcribers[engine] = builders[engine]()

    audio_by_clip = {wav: _load_audio_16k(wav) for wav in wav_paths}
    references = {wav: _load_reference(wav) for wav in wav_paths}

    samples: list[dict[str, Any]] = []
    for wav in wav_paths:
        record: dict[str, Any] = {"clip": wav.name, "reference": references[wav], "engines": {}}
        for engine, transcribe in transcribers.items():
            start = time.perf_counter()
            transcript = transcribe(audio_by_clip[wav])
            latency_ms = round((time.perf_counter() - start) * 1000.0, 1)
            record["engines"][engine] = {
                "transcript": transcript,
                "latency_ms": latency_ms,
                "wer_vs_reference": (
                    round(word_error_rate(references[wav], transcript), 4)
                    if references[wav] else None
                ),
            }
        # Cross-engine divergence (Parakeet measured against Whisper).
        if "faster-whisper" in record["engines"] and "parakeet" in record["engines"]:
            record["parakeet_wer_vs_whisper"] = (
                round(
                    word_error_rate(
                        record["engines"]["faster-whisper"]["transcript"],
                        record["engines"]["parakeet"]["transcript"],
                    ) or 0.0,
                    4,
                )
            )
        samples.append(record)
        print(f"\n[{wav.name}]")
        if references[wav]:
            print(f"  reference: {references[wav]!r}")
        for engine in transcribers:
            data = record["engines"][engine]
            wer = data["wer_vs_reference"]
            print(f"  {engine:15s} {data['latency_ms']:>7.1f}ms  wer={wer}  {data['transcript']!r}")
        if "parakeet_wer_vs_whisper" in record:
            print(f"  parakeet vs whisper divergence: {record['parakeet_wer_vs_whisper']}")

    aggregates: dict[str, Any] = {}
    for engine in transcribers:
        aggregates[engine] = {
            "wer_vs_reference": _summarize([
                s["engines"][engine]["wer_vs_reference"]
                for s in samples
                if s["engines"][engine]["wer_vs_reference"] is not None
            ]),
            "latency_ms": _summarize([s["engines"][engine]["latency_ms"] for s in samples]),
        }
    divergences = [s["parakeet_wer_vs_whisper"] for s in samples if "parakeet_wer_vs_whisper" in s]
    parakeet_vs_whisper = _summarize(divergences)

    print("\n=== Aggregates ===")
    for engine, stats in aggregates.items():
        wer = stats["wer_vs_reference"]
        lat = stats["latency_ms"]
        wer_str = f"mean={wer['mean']}" if wer else "no reference"
        print(f"  {engine:15s} WER({wer_str})  latency mean={lat['mean'] if lat else '-'}ms")
    if parakeet_vs_whisper:
        passes = parakeet_vs_whisper["mean"] <= args.wer_threshold
        print(f"\n  Parakeet vs Whisper divergence mean={parakeet_vs_whisper['mean']} "
              f"(threshold {args.wer_threshold}) -> {'PASS' if passes else 'FAIL'}")

    summary = {
        "stt_dir": args.stt_dir,
        "engines": engines,
        "whisper_model_dir": str(whisper_root),
        "wer_threshold": args.wer_threshold,
        "aggregates": aggregates,
        "parakeet_vs_whisper": parakeet_vs_whisper,
        "samples": samples,
    }
    out_path = Path(args.out) if args.out else (
        REPO_ROOT / ".local" / "monitoring" / f"stt-wer-bench-{int(time.time())}.json"
    )
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(summary, indent=2), encoding="utf-8")
    print(f"\nArtifact: {out_path}")


if __name__ == "__main__":
    main()
