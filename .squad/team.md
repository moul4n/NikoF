# Squad Team

> Local-only anime companion with interchangeable VRM characters, voice, memory, and a local LLM.

## Coordinator

| Name | Role | Notes |
| --- | --- | --- |
| Squad | Coordinator | Routes work, enforces handoffs and reviewer gates. |

## Members

| Name | Role | Charter | Status |
| --- | --- | --- | --- |
| Trinity | Lead | `.squad/agents/trinity/charter.md` | ✅ Active |
| Switch | Frontend Dev | `.squad/agents/switch/charter.md` | ✅ Active |
| Tank | Backend Dev | `.squad/agents/tank/charter.md` | ✅ Active |
| Link | AI/Audio Dev | `.squad/agents/link/charter.md` | ✅ Active |
| Mouse | Tester | `.squad/agents/mouse/charter.md` | ✅ Active |
| Scribe | Session Logger | `.squad/agents/scribe/charter.md` | 📋 Silent |
| Ralph | Work Monitor | `.squad/agents/ralph/charter.md` | 🔄 Monitor |

## Project Context

- **Owner:** Jason Fletcher
- **Project:** NikoF
- **Stack:** Windows 10/11-first local stack with Python 3.10+, FastAPI/Starlette, React + TypeScript + Vite, three.js + UniVRM 1.0 via three-vrm, Faster-Whisper Medium with Small fallback, GPT-SoVITS latest stable 2026 fork, LLaMA 3.1 8B Q4_K_M via Ollama or llama.cpp, SQLite plus ChromaDB or FAISS, `bge-small-en` with `MiniLM-L6-v2` fallback, MediaPipe Face Mesh, and optional CLIP enrichment
- **Description:** Local-only anime companion for Windows 10/11 with interchangeable UniVRM characters, a voice-first conversation loop, persistent memory, shared animation DSL playback, and an optional non-blocking vision path for richer reactions
- **Created:** 2026-05-14T08:57:41.6820932+01:00
