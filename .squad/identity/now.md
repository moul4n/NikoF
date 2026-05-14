updated_at: 2026-05-14
focus_area: Provider-agnostic speech adapter shells, the backend speech-lifecycle read surface, and the frontend runtime speech snapshot proof are now landed; next keep transport and runtime checks narrow and deterministic
active_issues: []
---

# What We're Focused On

The current repo state now includes configuration-aware Faster-Whisper and GPT-SoVITS adapter shells behind provider-agnostic backend speech interfaces, a backend-owned `GET /session/speech-lifecycle` read surface that returns ordered `speech.lifecycle` snapshot envelopes around canonical session events, and a runtime-executed frontend speech-lifecycle snapshot proof that preserves cursor ordering plus the canonical transcription and synthesis events. `backend-speech-contracts` baselines the adapter profiles, canonical `transcription.status` and `speech.synthesis` events, and the lifecycle snapshot envelope, while `frontend-speech-lifecycle-runtime` proves the frontend consumer preserves the ordered envelopes and canonical speech event content. The next seam remains intentionally narrow: preserve these deterministic contracts and runtime checks without widening into live transport delivery, manifest serving, or provider-specific speech execution.
Updated by Scribe after recording the landed speech adapter shells, backend lifecycle read surface, and frontend runtime speech snapshot proof.
