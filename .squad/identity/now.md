updated_at: 2026-05-14
focus_area: Canonical speech event persistence, real adapter execution paths, and the frontend snapshot bridge are now landed; the next batch is backend turn-pipeline publication into the existing ordered envelope plus publication-scoped stability, while live delivery, frontend live consumption, and transport-aware runtime checks remain queued behind that
active_issues: []
---

# What We're Focused On

The current repo state now includes a backend-owned event store for canonical session and `speech.lifecycle` events, configuration-aware Faster-Whisper and GPT-SoVITS adapter execution paths behind provider-agnostic speech interfaces, and a runtime-executed frontend speech-lifecycle snapshot bridge that preserves cursor ordering plus the canonical transcription and synthesis events. The full stability suite is green across the current contract, degraded-adapter, event-store, and frontend runtime proofs. The next seam stays intentionally narrow: add one explicit backend turn-pipeline publication path that emits into the existing ordered event stream and prove that publication behavior in stability coverage. Live delivery, frontend live consumption, and transport-aware runtime checks stay queued until that publication seam exists in code.
Updated by Ralph to reflect the landed event store, real speech adapter execution paths, frontend speech-lifecycle bridge, and green stability batch.
