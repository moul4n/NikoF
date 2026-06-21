# TTS Engine Benchmark — GPT-SoVITS vs Kokoro vs XTTS-v2

**Date:** 2026-06-21 · **Box:** test machine (12 GB GPU, Ollama `llama3.2:3b`) · **Harness:**
`scripts/testing/latency_bench.py` driving the real LLM→TTS path with `NIKOF_TTS_SEGMENTATION=1`
and `NIKOF_LLM_STREAMING=1`. Engine selected by `NIKOF_TTS_ENGINE`.

## Results (real, end-to-end)

`first_audio` = prompt sent → first `speech.synthesis` segment published. `server_llm` from
`/system/resources` turn telemetry. "TTS slice" ≈ `first_audio − server_llm` for single-segment.

| Engine | Where | Short reply first-audio | Long reply first-audio | per-segment | TTS slice | VRAM |
|---|---|---|---|---|---|---|
| GPT-SoVITS | GPU | ~5.9 s | **7–14 s** | ~700 ms | ~1.5 s | ~3.5 GB |
| **Kokoro-82M** | CPU | **~5.6 s** | **~5.5 s** | **~470 ms** | **~1.0 s** | **0 (frees ~3.5 GB)** |
| XTTS-v2 | **GPU** (RTX 4070) | ~5.5 s | ~5.6–6.5 s | ~1.0 s | ~1.2 s | ~1.9 GB |
| XTTS-v2 | CPU | ~10 s | (not run) | — | ~5.6 s | (CPU) |

LLM generation was **~4.3–6.4 s** across all runs (large persona/planner prompt on a 3B model).

XTTS-v2 on GPU: warm synth RTF ~0.22 (~1.0 s to render a ~4.8 s clip), ~1.9 GB VRAM. CUDA build
used: `torch 2.8.0+cu128`. First-audio is competitive (LLM-bound) but per-segment (~1.0 s) is the
slowest of the three — XTTS is heavier per synth even on GPU.

## Conclusions

1. **The LLM is the bottleneck (~4.5–5.4 s), not TTS.** Streaming/segmentation overlaps TTS with
   the LLM; it cannot speed the LLM up.
2. **Kokoro is the clear fast-TTS winner.** It pins first-audio to ≈ the LLM time — on long replies
   it cut first-audio from GPT-SoVITS's **7–14 s to ~5.5 s** — synthesizes segments in ~470 ms, and
   **frees ~3.5 GB VRAM** (runs on CPU/in-process). Trade-off: preset voice, no cloning.
3. **XTTS-v2 on CPU is slow (~5.6 s/utterance).** Its value is voice cloning; it needs a CUDA GPU
   (CUDA torch ~2.5 GB + VRAM contention) to be speed-competitive. Not recommended for the latency
   goal unless cloning is required.

**Next lever for first-audio: the LLM** — trim the planner prompt, use a faster local model, or the
Claude Haiku backend (Phase 5). TTS is no longer the long pole once Kokoro is used.

## Reproduce

Install engines (optional extras in `backend/pyproject.toml`):

```powershell
.venv\Scripts\python.exe -m pip install -e backend[kokoro]
# XTTS (heavy; CPU shown — use a CUDA torch build for speed):
.venv\Scripts\python.exe -m pip install -e backend[xtts]
```

Models / assets (under `<NIKOF_TTS_MODELS_ROOT>` = `%LOCALAPPDATA%\NikoF\models\tts` by default):
- **Kokoro**: `kokoro/kokoro-v1.0.onnx` + `kokoro/voices-v1.0.bin`
  (github.com/thewh1teagle/kokoro-onnx releases, model-files-v1.0).
- **XTTS**: `xtts/reference.wav` (~6 s speaker sample to clone). Set `COQUI_TOS_AGREED=1`; the
  1.8 GB model auto-downloads on first synth.

Run a comparison (restart the backend with each engine, then):

```powershell
$env:NIKOF_TTS_ENGINE = "kokoro"   # or "xtts" or unset for gpt-sovits
$env:NIKOF_TTS_SEGMENTATION = "1"; $env:NIKOF_LLM_STREAMING = "1"
# start backend, then:
.venv\Scripts\python.exe scripts\testing\latency_bench.py --runs 6 --warmup 1
```

The harness records the active engine (`/system/resources` `runtime_tuning.tts_engine`) and writes
a JSON artifact under `.local/monitoring/`.
