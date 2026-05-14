# Progress Report

Updated: 2026-05-14

## Implemented

- Stage 1 frontend bridge repairs are in place, including the backend envelope alignment and the invalid active-character rejection rollback path.
- The frontend production build is repaired and currently passes from `frontend/`.
- The backend now exposes provider-agnostic speech service interfaces with real Faster-Whisper and GPT-SoVITS adapter execution paths that stay inside the normalized speech contracts.
- The backend now exposes `GET /session/speech-lifecycle` as a read surface for ordered `speech.lifecycle` snapshot envelopes around canonical session events.
- Runtime proof coverage now includes the frontend Stage 1 character-flow path and the frontend speech-lifecycle snapshot consumer.
- Stability coverage now includes an event-store projection over the canonical speech envelope and a degraded-mode snapshot for the real adapter shells, both baseline-friendly and transport-neutral.

## Validated

- `npm run build` passes in `frontend/`.
- `frontend-stage1-bridge-surface` is green for the repaired bridge envelope and selection handling.
- `frontend-stage1-character-flow-runtime` proves the frontend bridge consumes the backend catalog envelope and reconciles selection outcomes against backend-confirmed state.
- `backend-speech-contracts` baselines the speech adapter profiles, canonical `transcription.status` and `speech.synthesis` session events, and the ordered `speech.lifecycle` snapshot envelope.
- `backend-speech-event-store` baselines ordered persisted-record and cursor-read projections for the current `speech.lifecycle` envelope without claiming a live store implementation yet.
- `backend-speech-real-adapter-degraded` proves the real adapter shells resolve in degraded mode with unconfigured provider bindings while staying on the current canonical speech envelope shape and making `unavailable` statuses explicit.
- `frontend-speech-lifecycle-runtime` proves the frontend consumer preserves cursor order and the canonical transcription and synthesis events from the backend snapshot surface.

## Current Boundary

- Real speech execution now depends on the expected local model roots and provider entrypoints being present under the bootstrap-managed storage contract.
- A backend-owned event store is not implemented yet; current coverage is a deterministic projection over the canonical envelope.
- Live speech delivery over SSE or WebSocket is not implemented yet.
- The current route and snapshot surface still uses scaffold lifecycle data; wiring the real adapters into the full turn pipeline is the next backend slice.
- The current speech seam is a deterministic contract and adapter-execution slice, not a live end-to-end speech pipeline.