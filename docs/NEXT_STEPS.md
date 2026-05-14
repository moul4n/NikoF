# Next Steps

Updated: 2026-05-14

1. Land one backend-only batch: add live delivery on top of the existing canonical `speech.lifecycle` envelope, using SSE or WebSocket transport that reuses the current cursor ordering and payload shape rather than inventing a second transport document.
2. Expand stability coverage only for that backend live-delivery seam in the same batch, proving transport publication preserves the canonical ordered envelope while keeping frontend live-consumption checks out of scope until the transport contract is stable.
3. After backend live delivery lands and stabilizes, extend the frontend and avatar runtime from snapshot consumption to live speech-lifecycle consumption, preserving cursor ordering, backend-confirmed character state, and the current transcription and synthesis event contract.
4. After frontend live consumption lands, add transport-aware runtime checks that prove reconnect or cursor-resume behavior without widening the canonical `speech.lifecycle` event body.
