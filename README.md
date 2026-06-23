# NikoF

NikoF is a Windows 10/11-first, local-only anime companion that combines a web UI, a rendered VRM avatar, low-latency speech I/O, optional camera-driven reactions, a local language model, persistent memory, and a reusable animation runtime. The target machine is an NVIDIA-friendly Windows box with about 12 GB of VRAM, so the system is staged around tight latency budgets, modular adapters, predictable offline deployment, and optional vision features that never block the core conversation loop.

## Prerequisites

NikoF runs entirely on one Windows machine. You need the base toolchain below installed and on `PATH`; the heavyweight model payloads are acquired by the installer, not committed to Git.

### Base toolchain (install these yourself)

| Component | Supported version | Install command (winget) |
|---|---|---|
| Git | any recent | `winget install --id Git.Git -e` |
| Python | **3.10–3.12** (3.12 recommended; avoid 3.13+, native ML wheels lag) | `winget install --id Python.Python.3.12 -e` |
| Node.js | **LTS 20 / 22 / 24** | `winget install --id OpenJS.NodeJS.LTS -e` |
| Ollama | latest | `winget install --id Ollama.Ollama -e` |
| NVIDIA GPU + current driver | **8 GB VRAM minimum, 12 GB recommended** | vendor driver (GeForce/Studio) |

> **Lower-spec note (8 GB VRAM):** the stack runs on 8 GB, but you should not keep STT + TTS + LLM all resident at once. Prefer **Faster-Whisper Small** for STT (set `model_size` to `small` in `NIKOF_STT_MODELS_ROOT\faster-whisper-medium\runtime.json`, or install the small payload with `install-prerequisites.ps1 -InstallFasterWhisperSmall`) and expect first-token latency on cold loads. The preflight check below warns when it detects less than ~10 GB.

### Optional: standalone desktop display window

The web UI needs nothing extra. The optional Tauri desktop "stage" window (`launch-display.bat`) additionally requires:

| Component | Install command (winget) |
|---|---|
| Rust toolchain (rustup, MSVC default) | `winget install --id Rustlang.Rustup -e` |
| MSVC C++ Build Tools ("Desktop development with C++") | `winget install --id Microsoft.VisualStudio.2022.BuildTools -e` |
| WebView2 runtime | ships with Windows 11 |

### Heavyweight payloads (acquired by the installer, never committed)

The canonical engine models — Kokoro (TTS), Parakeet (STT), and the qwen3:4b Ollama model — plus embedding models are downloaded/staged into machine-local roots under `%LOCALAPPDATA%\NikoF` by `install-prerequisites.ps1` — see [Fresh-Machine Bootstrap](#fresh-machine-bootstrap). The legacy fallback engines (GPT-SoVITS, Faster-Whisper, llama3.1) install only with `-InstallLegacyStack`, and GPT-SoVITS additionally needs a voice profile (`speakers\default.json` + a reference clip) that is a manual handoff.

> **If `huggingface.co` is blocked on the machine** (some networks reject its TLS), pass an HF mirror to any model-download step, e.g. `install-prerequisites.ps1 -AllSafe -HfEndpoint https://hf-mirror.com`. The installer also falls back to direct per-file downloads when the Hub's resolve API is unreachable.

## Check Your Machine (Preflight)

Before starting the stack, run the preflight doctor from the repo root. Unlike a plain folder-presence check, it verifies tested tool-version ranges, `.venv` integrity, frontend deps, GPU/VRAM capacity, a reachable Ollama daemon with the baseline model, and whether GPT-SoVITS can actually synthesise (voice profile present), not just whether files exist:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\bootstrap\Invoke-Preflight.ps1
```

Each check resolves to `ready`, `warn`, `auto-fixable`, or `manual-handoff`. To auto-repair the safe lane (toolchain, `.venv`, dependencies, Ollama model pull, Faster-Whisper) and re-check, add `-Fix` (preview with `-Fix -DryRun`):

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\bootstrap\Invoke-Preflight.ps1 -Fix
```

A machine-readable report is written to `.local\bootstrap\preflight-report.json`. The exit code is non-zero while any `auto-fixable` or `manual-handoff` item remains.

## Recommended 2026 Local Baseline

The canonical stack is the benchmarked performance stack ([docs/TTS_ENGINE_BENCHMARK.md](docs/TTS_ENGINE_BENCHMARK.md)), which `start-all` runs and `install-prerequisites.ps1 -AllSafe` installs. The original GPT-SoVITS / Faster-Whisper / llama3.1 stack remains supported as an opt-in fallback (`-InstallLegacyStack`).

- TTS: **Kokoro** (kokoro-onnx) — fast, CPU-friendly, frees VRAM, preset voice. Legacy fallback: GPT-SoVITS (voice cloning, needs a voice profile).
- STT: **Parakeet TDT 0.6B v2** (onnx-asr, CUDA EP) — lower WER and ~2× faster than Whisper. Legacy fallback: Faster-Whisper Medium, with Small for lower VRAM.
- LLM: **qwen3:4b** via Ollama (small, fast planner). Legacy fallback: LLaMA 3.1 8B Q4_K_M.
- Face tracking: MediaPipe Face Mesh for realtime local camera tracking.
- Optional vision recognition: CLIP-based object or scene tagging behind a non-blocking backend adapter.
- Memory: SQLite for canonical state plus ChromaDB or FAISS for semantic retrieval.
- Embeddings: `bge-small-en` as the preferred baseline, with `MiniLM-L6-v2` as a lighter fallback.

Engine selection is via `NIKOF_TTS_ENGINE` / `NIKOF_STT_ENGINE` / `NIKOF_LLM_MODEL` (set by `start-all`); the preflight checks whichever engines are configured.

## Core Workflows

1. Voice workflow: Mic -> STT -> Memory -> LLM -> TTS -> Avatar.
2. Vision workflow: Camera -> MediaPipe -> optional CLIP -> backend context -> avatar reactions.

The vision loop is additive. It should enrich character reactions and scene awareness without becoming a hard dependency for the core voice turn.

## Portability And Continuity Rules

- Do not commit LLMs, model weights, provider runtimes, or other heavyweight prerequisites to GitHub.
- Keep bootstrap and setup scripts responsible for acquiring prerequisites when automation is viable, and document manual download or install fallbacks when a provider cannot be redistributed or scripted safely.
- Treat repo documentation as part of the product surface: a fresh Windows machine should be able to recover the intended stack, storage layout, and execution plan from the checked-in docs alone. (`.squad/` and `.copilot/` hold legacy Copilot-era orchestration state and are historical context only — do not rely on or extend them.)

Local models and heavyweight runtimes should live outside the normal source tree or in explicitly local-only storage roots that are ignored by Git. The repository stores contracts, manifests, adapters, scripts, and instructions, not redistributable model payloads.

## Core Architecture

- `frontend/`: React + TypeScript application for chat UI, device controls, microphone and camera permissions, session state, and avatar presentation.
- `frontend/avatar/`: three.js + UniVRM 1.0 viewer layer, animation playback, stage mounting, and camera-facing presentation logic.
- `backend/`: FastAPI or Starlette orchestrator that owns session flow, speech turn coordination, optional vision-context ingestion, memory access, and model adapter APIs.
- `backend/services/stt/`: speech-to-text adapters for Faster-Whisper and related preprocessing.
- `backend/services/llm/`: local LLM adapters for LLaMA 3.1 8B Q4_K_M runtimes such as llama.cpp or Ollama.
- `backend/services/tts/`: text-to-speech adapters targeting GPT-SoVITS latest 2026 fork behind a stable synthesis contract.
- `backend/services/memory/`: SQLite-backed state, vector retrieval, and summarization boundaries.
- `backend/services/vision/`: normalized ingestion for MediaPipe-derived face state and optional CLIP object-context enrichment.
- `backend/services/animation/`: animation DSL compilation, runtime dispatch, and per-character override resolution.
- `assets/characters/`: UniVRM 1.0 character packages, manifests, expressions, voice profiles, and optional override maps.
- `assets/animations/`: shared animation clips, animation DSL assets, generated motion staging, and retargetable motion definitions.
- `docs/`: architectural contracts, implementation sequencing, and delivery planning.

UniVRM 1.0 remains the standard character format. That gives the project a stable import target for purchased or commissioned models, consistent humanoid rig expectations, and a clean path for character interchangeability with shared animation libraries plus opt-in per-character overrides.

## Delivery Stages

The explicit 2026 build order is staged below, but the project still stays contract-first: manifest schemas, session events, animation events, and service boundaries are locked before later stages widen implementation.

1. Backend skeleton.
2. Frontend VRM rendering.
3. STT + TTS integration.
4. Local LLM + memory.
5. Animation DSL.
6. Vision pipeline.
7. Character swapping.
8. Optimization + polish.

## Local Contract Validation

Run the current contract gate without any model providers or runtime services installed:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\asset_validation\validate-contracts.ps1
```

This validates scaffold character manifests, fallback identity metadata, and the local manifest-summary plus animation and session fixture payloads.

## Stability Regression Harness

Run the PowerShell-first stability harness from the repo root when you want regression or change-impact checks with tracked snapshots:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\testing\Invoke-StabilitySuite.ps1
```

Refresh the stored baselines intentionally after an approved behavior change:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\testing\Invoke-StabilitySuite.ps1 -RefreshBaselines
```

The current suite snapshots the contract validator, the bootstrap prerequisite surface, the bootstrap report JSON surface, the Stage 1 backend contract snapshot, and the Stage 1 backend payload-key surface. Checked-in baselines live under `tests/stability/baselines/`, while generated run artifacts and JSON reports are written under `tests/stability/artifacts/` and stay Git-ignored.

## TTS Soak Capture

Run the reusable TTS soak capture from the repo root when you want a machine-local JSON artifact for warm-path latency, sampled GPU usage, tail idle state, and lifecycle-poll stability:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\testing\Invoke-TtsSoak.ps1
```

Pass `-Prompts` for a short ad hoc run or `-PromptFile` for a custom prompt list. Output is written under `.local/monitoring/`.

The artifact reports both the raw TTS request counter from `GET /system/resources` and an estimated completed-request total derived from returned `audio_reference` ids. On the current backend, the resource counter can lag behind successful preview responses, so use the estimated total when you need a closer completion count during active debugging.

## Preferred Local Startup

Once the prerequisites are in place (run the [preflight](#check-your-machine-preflight) first), start the full stack from the repo root:

```bat
start-all.bat
```

This brings up the backend (which owns the STT, TTS, and LLM sidecars) and the control frontend together, and gives you one supervisor window. Stop everything with `Ctrl+C` in that window.

### Optional surfaces

- **Ops dashboard** — `startup.bat` opens a traffic-light operations dashboard at `http://127.0.0.1:8765/` with per-service Start/Stop/Restart controls. Use it to monitor and control individual services; it is not required to run the stack.
- **Desktop display window** — `launch-display.bat` opens the standalone Tauri "stage" window (requires the [optional desktop toolchain](#optional-standalone-desktop-display-window)).
- **Backend-only session** — `..\.venv\Scripts\python.exe -m app.dev_server` from `backend/`, only when you intentionally need the backend without the frontend. The frontend never owns the STT or TTS sidecars.

For bounded smoke checks or automation that must start the stack and then leave the machine clean, the supervisor accepts an auto-stop window, e.g. `-StopAfterSeconds 15`.

## Fresh-Machine Bootstrap

On a new Windows machine, run the bootstrap scaffold first:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\bootstrap\bootstrap.ps1
```

It creates the documented local storage roots, checks the base toolchain, writes a machine-local bootstrap report under `.local/bootstrap/`, and prints the manual next steps for heavyweight providers and models that stay outside Git.

When you want the repo to do the safe bring-up work for you on a fresh machine, use the installer wrapper instead:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\bootstrap\install-prerequisites.ps1 -AllSafe
```

`-AllSafe` installs or reuses the Windows base toolchain, creates the repo `.venv`, installs backend and frontend dependencies (including the `kokoro` and `parakeet` extras), installs Ollama when missing, and installs the canonical engine stack: pulls **qwen3:4b**, downloads the **Kokoro** model files, and downloads the **Parakeet** model into the managed roots — then runs the bootstrap plus contract and backend prerequisite checks. Add `-InstallLegacyStack` to also install the GPT-SoVITS / Faster-Whisper / llama3.1 fallback.

After it finishes, confirm the machine is actually ready with the [preflight](#check-your-machine-preflight) (`Invoke-Preflight.ps1`). It checks the configured engines (Kokoro / Parakeet / qwen3:4b by default).

**Optional GPU STT (≥12 GB VRAM only):** by default Parakeet runs on CPU — on ~8 GB the LLM needs the VRAM, and Parakeet on the GPU measures ~3.4 GB which would overload an 8 GB card alongside the LLM. On a card with headroom, add the CUDA runtime (pip wheels — no CUDA Toolkit or manual download) and `start-all` will enable GPU STT automatically (its `NIKOF_STT_ALLOW_GPU` default is VRAM-gated to ≥12 GB):

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\bootstrap\install-prerequisites.ps1 -InstallParakeetGpuRuntime
```

If `huggingface.co` is blocked on the current machine, pass an HF mirror so the model downloads use it (the installer also falls back to direct per-file downloads when the Hub's resolve API is unreachable):

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\bootstrap\install-prerequisites.ps1 -AllSafe -HfEndpoint https://hf-mirror.com
```

Or stage an approved model copy from another machine-local export instead of downloading it here, e.g. `-SttModelSourcePath D:\Exports\faster-whisper-medium` (legacy stack). GPT-SoVITS remains a local-source handoff (`-TtsProviderSourcePath` / `-TtsModelSourcePath`) because the repo does not commit an approved vendor runtime payload.

Detailed structure and contracts live in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). Delivery stages, dependencies, and exit criteria live in [docs/IMPLEMENTATION_PLAN.md](docs/IMPLEMENTATION_PLAN.md). Fresh-machine bootstrap and local model storage policy live in [docs/SETUP_AND_CONTINUITY.md](docs/SETUP_AND_CONTINUITY.md).
