# Progress Report

Updated: 2026-05-14

## Implemented

- Stage 1 frontend bridge repairs are in place, including the backend envelope alignment and the invalid active-character rejection rollback path.
- The frontend production build is repaired and currently passes from `frontend/`.
- The backend now exposes provider-agnostic speech service interfaces and configuration-aware adapter shells for the planned Faster-Whisper and GPT-SoVITS providers.
- The backend now exposes `GET /session/speech-lifecycle` as a read surface for ordered `speech.lifecycle` snapshot envelopes around canonical session events.
- Runtime proof coverage now includes the frontend Stage 1 character-flow path and the frontend speech-lifecycle snapshot consumer.

## Validated

- `npm run build` passes in `frontend/`.
- `frontend-stage1-bridge-surface` is green for the repaired bridge envelope and selection handling.
- `frontend-stage1-character-flow-runtime` proves the frontend bridge consumes the backend catalog envelope and reconciles selection outcomes against backend-confirmed state.
- `backend-speech-contracts` baselines the speech adapter profiles, canonical `transcription.status` and `speech.synthesis` session events, and the ordered `speech.lifecycle` snapshot envelope.
- `frontend-speech-lifecycle-runtime` proves the frontend consumer preserves cursor order and the canonical transcription and synthesis events from the backend snapshot surface.

## Current Boundary

- Real Faster-Whisper and GPT-SoVITS execution is not wired yet.
- Live speech delivery over SSE or WebSocket is not implemented yet.
- The current speech seam is a deterministic contract and runtime-proof slice, not a live end-to-end speech pipeline.