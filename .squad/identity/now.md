updated_at: 2026-05-14
focus_area: Canonical speech event persistence, real adapter execution paths, and the frontend snapshot bridge are now landed; next wire the backend turn pipeline into the event stream, then add live delivery and transport-aware runtime checks without widening the envelope
active_issues: []
---

# What We're Focused On

The current repo state now includes a backend-owned event store for canonical session and `speech.lifecycle` events, configuration-aware Faster-Whisper and GPT-SoVITS adapter execution paths behind provider-agnostic speech interfaces, and a runtime-executed frontend speech-lifecycle snapshot bridge that preserves cursor ordering plus the canonical transcription and synthesis events. The full stability suite is green across the current contract, degraded-adapter, event-store, and frontend runtime proofs. The next seam stays intentionally narrow: wire the real backend turn pipeline to publish into the existing event stream, then layer live delivery and frontend live consumption on top of the same ordered envelope without widening into transport-specific payloads or provider-specific route shapes.
Updated by Ralph to reflect the landed event store, real speech adapter execution paths, frontend speech-lifecycle bridge, and green stability batch.
