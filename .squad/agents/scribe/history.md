# Project Context

- **Project:** NikoF
- **Created:** 2026-05-14

## Core Context

Agent Scribe initialized and ready for work.

## Recent Updates

📌 Team initialized on 2026-05-14

📌 2026-05-14T08:57:41.6820932+01:00: Planning artifacts landed in README.md, docs/ARCHITECTURE.md, and docs/IMPLEMENTATION_PLAN.md

## Learnings

Initial setup complete.

- 2026-05-14T08:57:41.6820932+01:00: For an empty GitHub repo, the first non-interactive publish path is `git remote add origin <repo>`, `git branch -M main`, `git add -A`, `git commit -m "chore: initial project scaffold"`, then `git push -u origin main`.
- 2026-05-14T08:57:41.6820932+01:00: In Windows PowerShell, quote the upstream ref when validating tracking with git, for example `git rev-parse --abbrev-ref --symbolic-full-name "@{u}"`, or PowerShell will parse `@{...}` as a hashtable.
- 2026-05-14T08:57:41.6820932+01:00: Team focus moved from setup into architecture and phased delivery planning.
- 2026-05-14T08:57:41.6820932+01:00: UniVRM 1.0 is the user-approved baseline for avatar packaging and interchange.
- 2026-05-14T08:57:41.6820932+01:00: The refined 2026 blueprint baseline explicitly names GPT-SoVITS, Faster-Whisper Medium with Small fallback, LLaMA 3.1 8B Q4_K_M, MediaPipe Face Mesh, optional CLIP, and SQLite plus ChromaDB or FAISS as the planning contract for the Windows 10/11 local stack.
- 2026-05-14T08:57:41.6820932+01:00: Team context should describe the primary runtime as a voice-first loop with vision treated as an optional, non-blocking enrichment path rather than a core dependency.
- 2026-05-14T08:57:41.6820932+01:00: The agreed 2026 stage order is Stage 0 contracts, backend skeleton, frontend VRM rendering, STT plus TTS, local LLM plus memory, animation DSL, vision pipeline, character swapping, then optimization and polish.
