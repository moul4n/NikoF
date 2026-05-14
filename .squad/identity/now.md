updated_at: 2026-05-14T09:40:00+01:00
focus_area: Canonical speech event persistence, real adapter execution paths, backend turn publication, backend live delivery, and transport-scoped backend stability are now landed; the next batch is frontend live consumption on the existing `GET /session/speech-lifecycle` SSE surface plus runtime and transport-aware stability, while any broader streaming expansion remains queued behind that
active_issues: []
---

# What We're Focused On

The current repo state now includes a backend-owned event store for canonical session and `speech.lifecycle` events, configuration-aware Faster-Whisper and GPT-SoVITS adapter execution paths behind provider-agnostic speech interfaces, an explicit backend turn-publication path that appends ordered session and speech lifecycle events, backend live delivery on the existing `GET /session/speech-lifecycle` surface via SSE content negotiation, and a runtime-executed frontend speech-lifecycle snapshot bridge that preserves cursor ordering plus the canonical transcription and synthesis events. The full validation set is green across the backend event-store unit slice, contract validation, and the stability suite, including the live-delivery transport coverage that preserves the canonical envelope for both snapshot and SSE delivery. The next seam stays intentionally narrow: connect the frontend shell to the existing live SSE surface and extend runtime plus transport-aware stability without widening payload shapes or inventing a second transport contract.
Updated by Scribe to reflect the landed backend live-delivery batch, the preserved snapshot-plus-SSE envelope contract, and the queued frontend live-consumption follow-on.
