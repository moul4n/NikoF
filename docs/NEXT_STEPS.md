# Next Steps

Updated: 2026-05-14

1. Land one backend-only batch: add an explicit turn-pipeline publication seam that appends canonical `session` and `speech.lifecycle` events into the existing backend-owned event store, using the landed Faster-Whisper and GPT-SoVITS execution paths without widening the ordered envelope.
2. Expand stability coverage only for that publication seam in the same batch, proving ordered event emission from the real backend turn path while keeping transport and frontend runtime checks out of scope until live delivery exists.
3. After publication lands, add live delivery on top of the existing `speech.lifecycle` contract, using SSE or WebSocket transport that reuses the same cursor and payload shape rather than inventing a second transport document.
4. After live delivery lands, extend the frontend and avatar runtime from snapshot consumption to live speech-lifecycle consumption, preserving cursor ordering, backend-confirmed character state, and the current transcription and synthesis event contract.
