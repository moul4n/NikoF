# Project Context

- **Owner:** Jason Fletcher
- **Project:** Local-only anime companion with interchangeable VRM characters, local voice pipeline, persistent memory, and AI-authored animation scripts
- **Stack:** Python backend, FastAPI/Starlette, React + TypeScript + Vite, three.js + three-vrm, Faster-Whisper, Ollama/llama.cpp, GPT-SoVITS, SQLite, Chroma/FAISS
- **Created:** 2026-05-14T08:57:41.6820932+01:00

## Learnings

- Windows-first offline app; low latency and modular boundaries are primary constraints.
- Character swapping, shared animations, and character-specific overrides are core design requirements.
- UniVRM 1.0 should be treated as the required character interchange standard, with swap compatibility enforced through manifest validation rather than runtime special cases.
- The repo should split early into `frontend/`, `backend/`, `assets/`, `models/`, `scripts/`, `tests/`, and `docs/` so character, runtime, provider, and validation work can move independently.
- The delivery order should prioritize contracts and a character shell before full provider integration; otherwise STT, TTS, and animation work will couple against unstable interfaces.
- 2026-05-14T08:57:41.6820932+01:00: The initial test avatar intake should always reserve exactly three stable package ids under `assets/characters/test-vrm-01..03/` so frontend, backend, and validation work can move before final naming is settled.
- 2026-05-14T08:57:41.6820932+01:00: Missing VRM identity metadata is a packaging problem, not a viewer problem; solve it with scaffolded manifest and `metadata/identity.json` files, never runtime special cases.
- 2026-05-14T08:57:41.6820932+01:00: Shared animation assets, generated motion, and per-character overrides need separate storage roots or the animation contract will blur immediately.
- 2026-05-14T08:57:41.6820932+01:00: Treat the 2026 local model stack as an interface contract, not a loose preference: Faster-Whisper Medium with Small fallback, GPT-SoVITS latest stable 2026 fork, LLaMA 3.1 8B Q4_K_M, MediaPipe Face Mesh, optional CLIP, SQLite plus ChromaDB or FAISS, and `bge-small-en` with `MiniLM-L6-v2` fallback.
- 2026-05-14T08:57:41.6820932+01:00: The voice path is `Mic -> STT -> Memory -> LLM -> TTS -> Avatar`, and the vision path is `Camera -> MediaPipe -> optional CLIP -> backend context -> avatar reactions`; vision must stay optional and outside the core voice-turn latency budget.
- 2026-05-14T08:57:41.6820932+01:00: Keep planning contract-first even when user-facing character swapping is scheduled later; lock manifest, session, animation, and vision event boundaries early, then harden multi-character behavior only after the core voice, memory, and reaction loops exist.
- 2026-05-14T08:57:41.6820932+01:00: Portability is now a first-class project rule. Never treat local model weights, provider runtimes, caches, or other heavyweight prerequisites as committed repo contents; document them as bootstrap-managed or manual-install local dependencies instead.
- 2026-05-14T08:57:41.6820932+01:00: Cross-machine continuity must be explicit in checked-in docs and `.squad/` state so Jason or another developer can resume on a fresh Windows machine without hidden setup knowledge.
- 2026-05-14T08:57:41.6820932+01:00: For this squad, persistent model intent belongs in `.squad/config.json` plus a decision record, not just session behavior, because VS Code may ignore per-subagent model overrides while CLI-compatible surfaces can still honor them.
- 2026-05-14T08:57:41.6820932+01:00: Cost-weighted defaulting works best here when low-consequence coordination stays on `claude-haiku-4.5` and the code- and review-heavy agents are explicitly pinned to `claude-sonnet-4.6`; reserve Opus-class models for rare, manual deep-review exceptions rather than normal routing.
- 2026-05-14T08:57:41.6820932+01:00: In this environment, persistent squad config exposes `gpt-5.4` and `gpt-5.4-mini` as the usable GPT-5.4 family labels. Treat `gpt-5.4-mini` as the cheap routine default and `gpt-5.4` as the standard core-work override, rather than trying to persist non-existent medium or high SKU names.
- 2026-05-14T08:57:41.6820932+01:00: Stage 1 should deepen only the provider-agnostic contract seam already visible in the scaffold: health, manifest summaries, active-character selection, and normalized session events. Do not let this batch absorb live streaming, provider remediation depth, animation-resolution behavior, or multi-character frontend work.
- 2026-05-14T08:57:41.6820932+01:00: Switch can rely on manifest-derived asset URLs and the default-character shell that already exists in the frontend scaffold, but not on backend-driven catalog loading or session-event streaming yet. Mouse should snapshot stable JSON contract outputs, not placeholder UI text or future transport behavior.
- 2026-05-14T08:57:41.6820932+01:00: Once the frontend starts consuming backend character summaries, keep the backend authoritative only for manifest-summary and active-character state. Manifest documents and asset URL resolution should stay frontend-local and character-id-derived until the team explicitly opens a backend asset-serving contract.
- 2026-05-14T08:57:41.6820932+01:00: Link's next Stage 3 slice should stop at normalized STT and TTS adapter request-response shapes plus speech timing metadata. Real provider invocation, transport streaming, provider remediation, and bootstrap download behavior remain separate follow-on work.
- 2026-05-14T08:57:41.6820932+01:00: After a landed batch changes the active dependency chain, treat `.squad/identity/now.md` as the queue source of truth and update `docs/NEXT_STEPS.md` plus the `Immediate Handoff` section in `docs/WORKSTREAMS.md` together. Otherwise finished infrastructure can linger as false future work and misroute the next slice.
