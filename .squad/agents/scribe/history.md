# Project Context

- **Project:** NikoF
- **Created:** 2026-05-14

## Core Context

Agent Scribe initialized and ready for work.

## Recent Updates

📌 Team initialized on 2026-05-14

📌 2026-05-14T08:57:41.6820932+01:00: Planning artifacts landed in README.md, docs/ARCHITECTURE.md, and docs/IMPLEMENTATION_PLAN.md

📌 2026-05-14: Repaired squad continuity state by restoring missing `.squad/log/`, `.squad/orchestration-log/`, and `.squad/decisions/inbox/`, and removed an accidental pasted patch block from Mouse history.

📌 2026-05-14: Aligned Scribe and Ralph support-role charters with the current squad roster so Scribe is documented as the session logger and continuity maintainer, and Ralph as the work monitor.

📌 2026-05-14T12:15:50.9004620Z: Merged the pending Scribe inbox decisions into `.squad/decisions.md` and logged the continuity pass, including the Stage 1 bridge audit finding of a frontend/backend contract mismatch.

📌 2026-05-14T12:30:00.8688200Z: Logged the Stage 1 bridge repair continuity pass after the frontend/backend bridge envelope mismatch and rejection rollback path were fixed, and after the `frontend-stage1-bridge-surface` stability scenario was extended to cover the rejection path.

📌 2026-05-14: Merged the remaining frontend-stage1-bridge rollback assertion inbox decision into `.squad/decisions.md` and cleared the decision inbox.

📌 2026-05-14T13:46:07.7392187+01:00: Updated squad state after confirming the repaired frontend build passes, the Stage 1 bridge stability scenario is green, and the provider-agnostic backend speech-contract slice is now baseline-covered.

📌 2026-05-14: Logged the next-step batch after provider-agnostic speech service interfaces, the `speech.lifecycle` transport snapshot contract, and the runtime-executed frontend/backend character-flow check landed, without adding any new decision record.

📌 2026-05-14: Logged the continuity pass after the Faster-Whisper and GPT-SoVITS adapter shells, the backend `GET /session/speech-lifecycle` read surface, and the frontend runtime speech snapshot proof landed, without adding a new decision record.

## Learnings

Initial setup complete.

- 2026-05-14T08:57:41.6820932+01:00: For an empty GitHub repo, the first non-interactive publish path is `git remote add origin <repo>`, `git branch -M main`, `git add -A`, `git commit -m "chore: initial project scaffold"`, then `git push -u origin main`.
- 2026-05-14T08:57:41.6820932+01:00: In Windows PowerShell, quote the upstream ref when validating tracking with git, for example `git rev-parse --abbrev-ref --symbolic-full-name "@{u}"`, or PowerShell will parse `@{...}` as a hashtable.
- 2026-05-14T08:57:41.6820932+01:00: Team focus moved from setup into architecture and phased delivery planning.
- 2026-05-14T08:57:41.6820932+01:00: UniVRM 1.0 is the user-approved baseline for avatar packaging and interchange.
- 2026-05-14T08:57:41.6820932+01:00: The refined 2026 blueprint baseline explicitly names GPT-SoVITS, Faster-Whisper Medium with Small fallback, LLaMA 3.1 8B Q4_K_M, MediaPipe Face Mesh, optional CLIP, and SQLite plus ChromaDB or FAISS as the planning contract for the Windows 10/11 local stack.
- 2026-05-14T08:57:41.6820932+01:00: Team context should describe the primary runtime as a voice-first loop with vision treated as an optional, non-blocking enrichment path rather than a core dependency.
- 2026-05-14T08:57:41.6820932+01:00: The agreed 2026 stage order is Stage 0 contracts, backend skeleton, frontend VRM rendering, STT plus TTS, local LLM plus memory, animation DSL, vision pipeline, character swapping, then optimization and polish.
- 2026-05-14T08:57:41.6820932+01:00: Stage 1 execution focus is now locked around three concrete seams only: backend contract normalization, one manifest-derived default-character VRM shell in the frontend, and deterministic backend stability baselines.
- 2026-05-14T08:57:41.6820932+01:00: Stage 1 decision merges should leave the broader Trinity batch-handoff inbox note intact unless the request explicitly asks for that contract-level consolidation too.
