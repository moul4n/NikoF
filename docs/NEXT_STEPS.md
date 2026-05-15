# Next Steps

Updated: 2026-05-14

1. Add a backend-owned event store for canonical session and `speech.lifecycle` events, with ordered persistence and cursor-based reads that keep the current snapshot contract stable.
2. Replace the current speech adapter shells with real Faster-Whisper and GPT-SoVITS execution behind the existing provider-agnostic interfaces, while keeping provider-specific details out of route payloads.
3. Add live delivery on top of the existing `speech.lifecycle` envelope, using SSE or WebSocket transport that reuses the backend-owned event contract instead of inventing a second payload shape.
4. Extend the frontend and avatar runtime from snapshot proofs to real integration by consuming live speech lifecycle delivery, real synthesis metadata, and backend-confirmed character state without regressing the repaired Stage 1 bridge path.
5. Expand stability coverage with event-store, live-delivery, and real-adapter scenarios so each new seam is baseline-checked before broader UX work lands.