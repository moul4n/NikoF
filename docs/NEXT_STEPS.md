# Next Steps

Updated: 2026-05-14

1. Wire the backend turn pipeline to publish canonical `session` and `speech.lifecycle` events into the existing backend-owned event store, using the landed Faster-Whisper and GPT-SoVITS execution paths without widening the ordered envelope.
2. Add live delivery on top of the existing `speech.lifecycle` contract, using SSE or WebSocket transport that reuses the same cursor and payload shape rather than inventing a second transport document.
3. Extend the frontend and avatar runtime from snapshot consumption to live speech-lifecycle consumption, preserving cursor ordering, backend-confirmed character state, and the current transcription and synthesis event contract.
4. Expand stability coverage from the green snapshot, event-store, and degraded-adapter proofs into backend turn-pipeline publication, live-delivery, and transport-aware frontend runtime scenarios once those seams exist in code.