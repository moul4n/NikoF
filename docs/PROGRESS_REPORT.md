# Progress Report

Updated: 2026-05-14

## Implemented

- Stage 1 frontend bridge repairs are in place, including the backend envelope alignment and the invalid active-character rejection rollback path.
- The frontend production build is repaired and currently passes from `frontend/`.
- The backend now exposes provider-agnostic speech service interfaces with real Faster-Whisper and GPT-SoVITS adapter execution paths that stay inside the normalized speech contracts.
- The backend now exposes `GET /session/speech-lifecycle` as a read surface for ordered `speech.lifecycle` snapshot envelopes around canonical session events.
- The backend now exposes `POST /session/operator-command` as the narrow operator-command seam for `text_question` and `tts_preview`, publishing canonical session and `speech.lifecycle` events through the existing event store.
- The control surface now owns a thin operator-command panel and loader client outside `App.tsx`, and the display surface remains read-only with respect to operator commands.
- Runtime proof coverage now includes the frontend Stage 1 character-flow path and the frontend speech-lifecycle snapshot consumer.
- Stability coverage now includes an event-store projection over the canonical speech envelope and a degraded-mode snapshot for the real adapter shells, both baseline-friendly and transport-neutral.

## Validated

- `npm run build` passes in `frontend/`.
- `frontend-stage1-bridge-surface` is green for the repaired bridge envelope and selection handling.
- `frontend-stage1-character-flow-runtime` proves the frontend bridge consumes the backend catalog envelope and reconciles selection outcomes against backend-confirmed state.
- `backend-speech-contracts` baselines the speech adapter profiles, canonical `transcription.status` and `speech.synthesis` session events, and the ordered `speech.lifecycle` snapshot envelope.
- `backend-speech-event-store` baselines ordered persisted-record and cursor-read projections for the current `speech.lifecycle` envelope without claiming a live store implementation yet.
- `backend-speech-real-adapter-degraded` proves the real adapter shells resolve in degraded mode with unconfigured provider bindings while staying on the current canonical speech envelope shape and making `unavailable` statuses explicit.
- `backend-operator-command-surface` locks the one backend-authored operator-command route plus the current `text_question` and `tts_preview` request or response examples.
- `frontend-speech-lifecycle-runtime` proves the frontend consumer preserves cursor order and the canonical transcription and synthesis events from the backend snapshot surface.
- `frontend-shell-split-surface` now proves that operator-command write state stays isolated to one control-only client while every real entrypoint still routes through `App` for backend sync and `speech.lifecycle` consumption.

## Current Boundary

- Real speech execution now depends on the expected local model roots and provider entrypoints being present under the bootstrap-managed storage contract.
- A backend-owned event store is not implemented yet; current coverage is a deterministic projection over the canonical envelope.
- Live speech delivery over SSE or WebSocket is not implemented yet; the next seam should publish the existing canonical `speech.lifecycle` stream without changing its envelope or cursor model.
- The operator-command route is intentionally limited to `text_question` and `tts_preview`; animation commands and provider-profile switching remain out of scope for this slice.
- Text-authored questions currently publish canonical transcription and session events only; they do not invoke an LLM reply path yet.
- The current speech seam is a deterministic contract and adapter-execution slice, not a live end-to-end speech pipeline.