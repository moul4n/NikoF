# NikoF

NikoF is a Windows 10/11-first, local-only anime companion that combines a web UI, a rendered VRM avatar, low-latency speech I/O, optional camera-driven reactions, a local language model, persistent memory, and a reusable animation runtime. The target machine is an NVIDIA-friendly Windows box with about 12 GB of VRAM, so the system is staged around tight latency budgets, modular adapters, predictable offline deployment, and optional vision features that never block the core conversation loop.

## Recommended 2026 Local Baseline

- TTS: GPT-SoVITS latest stable 2026 fork.
- STT: Faster-Whisper Medium by default, with Faster-Whisper Small as the lower-VRAM fallback.
- LLM: LLaMA 3.1 8B Q4_K_M running locally through llama.cpp, Ollama, or an equivalent adapter.
- Face tracking: MediaPipe Face Mesh for realtime local camera tracking.
- Optional vision recognition: CLIP-based object or scene tagging behind a non-blocking backend adapter.
- Memory: SQLite for canonical state plus ChromaDB or FAISS for semantic retrieval.
- Embeddings: `bge-small-en` as the preferred baseline, with `MiniLM-L6-v2` as a lighter fallback.

## Core Workflows

1. Voice workflow: Mic -> STT -> Memory -> LLM -> TTS -> Avatar.
2. Vision workflow: Camera -> MediaPipe -> optional CLIP -> backend context -> avatar reactions.

The vision loop is additive. It should enrich character reactions and scene awareness without becoming a hard dependency for the core voice turn.

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

Detailed structure and contracts live in [docs/ARCHITECTURE.md](/c:/Users/fletc/Sources/NikoF/docs/ARCHITECTURE.md). Delivery stages, dependencies, and exit criteria live in [docs/IMPLEMENTATION_PLAN.md](/c:/Users/fletc/Sources/NikoF/docs/IMPLEMENTATION_PLAN.md).
