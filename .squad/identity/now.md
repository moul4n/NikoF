Current Focus
=============

updated_at: 2026-05-14T13:18:00+01:00
focus_area: Backend-owned canonical `speech.synthesis` now carries optional playback-ready `audio_reference` metadata on the existing `speech.lifecycle` seam, and the frontend display shell consumes that same synthesis event to drive coarse speaking playback without widening transport ownership.
active_issues: []
---

What We're Focused On
---------------------

The backend-owned canonical `speech.synthesis` contract now carries optional playback-ready `audio_reference` metadata alongside the existing timing, segment, phoneme, and viseme fields when playable audio exists, and that data still flows on the same `speech.lifecycle` envelope authored by the backend. The frontend shell now reads that canonical synthesis event, uses backend-owned playback data for the audio handoff, and drives a coarse avatar `speak` window from the same lifecycle seam without introducing a second transport, frontend-owned playback contract, or a new command path.

Keep the follow-on queue narrow and non-debug. Preserve the existing operator-command path and command types, keep active-character selection as the only selection control, and continue treating full viseme-driven animation, richer playback controls, transport expansion, broader memory orchestration, embeddings or vector retrieval, cross-session affinity, UI-visible memory diagnostics, provider-profile switching, animation debug actions such as `wave`, extra control-surface debug toggles or diagnostics, and any new operator command beyond the landed `text_question` and `tts_preview` pair as out of scope. Updated by Scribe after the playback-ready synthesis metadata and coarse frontend speaking-consumption batch landed.
