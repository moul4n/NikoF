# Squad Decisions

## Active Decisions

### 2026-05-14T08:57:41.6820932+01:00: User directive

**By:** Jason Fletcher (via Copilot)
**What:** Prefer UniVRM 1.0 as the standard avatar/model system for rigging, compatibility, and sourcing interchangeable character models.
**Why:** User wants the project designed around a standard model pipeline that supports existing community models and new artist-produced assets.

### 2026-05-14T08:57:41.6820932+01:00: Initial architecture planning baseline

**By:** Trinity
**What:** Established UniVRM 1.0 as the baseline character package standard, with manifest-driven swap compatibility, shared animation libraries, and per-character overrides isolated to asset metadata rather than application branching. Also fixed the initial repo split around `frontend/`, `backend/`, `assets/`, `models/`, `scripts/`, `tests/`, and `docs/` so later work can proceed in thin vertical slices.
**Why:** The project's core risk is interface drift between avatar assets, frontend runtime, backend orchestration, and local providers. Locking the character contract and repo boundaries early reduces rework and lets frontend, backend, asset, and test work advance in parallel.

### 2026-05-14T08:57:41.6820932+01:00: 2026 technical blueprint directive

**By:** Jason Fletcher (via Copilot)
**What:** Add the 2026 technical blueprint to the squad context, including the preferred model stack (GPT-SoVITS, Faster-Whisper, LLaMA 3.1 8B Q4, MediaPipe plus CLIP, SQLite plus ChromaDB), the full voice and vision workflows, and the refined development stages.
**Why:** User wants the project blueprint and team context aligned with a more concrete target architecture and model selection baseline.

### 2026-05-14T08:57:41.6820932+01:00: 2026 blueprint baseline and stage reorder

**By:** Trinity
**What:** Adopt GPT-SoVITS latest stable 2026 fork as the default TTS baseline, Faster-Whisper Medium with Small fallback for STT, LLaMA 3.1 8B Q4_K_M as the local LLM baseline, MediaPipe Face Mesh as the realtime tracking baseline, optional CLIP as non-blocking vision enrichment, and SQLite plus ChromaDB or FAISS with `bge-small-en` and `MiniLM-L6-v2` fallback for memory retrieval. Lock the end-to-end workflows as `Mic -> STT -> Memory -> LLM -> TTS -> Avatar` and `Camera -> MediaPipe -> optional CLIP -> backend context -> avatar reactions`, with vision explicitly outside the critical voice path.
**Why:** The older planning docs captured the broad system shape, but they did not pin the refined 2026 local model stack or the explicit delivery sequence needed for the Windows 10/11 and 12 GB NVIDIA target profile.

### 2026-05-14T08:57:41.6820932+01:00: Delivery sequencing clarification

**By:** Trinity
**What:** Re-sequence delivery into Stage 0 contract foundation, then backend skeleton, frontend VRM rendering, STT + TTS integration, local LLM + memory, animation DSL, vision pipeline, character swapping, and optimization + polish. Preserve contract-first review gates even though user-facing character swapping is intentionally hardened later in the build.
**Why:** The explicit stage order reduces integration ambiguity, while the Stage 0 contract gate prevents late-stage character or provider work from reopening frontend-backend seams.

## Governance

- All meaningful changes require team consensus
- Document architectural decisions here
- Keep history focused on work, decisions focused on direction
