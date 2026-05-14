Current Focus
=============

updated_at: 2026-05-14T13:48:00+01:00
focus_area: The frontend now consumes backend-authored `speech.synthesis` viseme metadata on the existing lifecycle seam and hands it to a runtime-local lip-sync reaction path, while degrading cleanly to coarse speaking playback when viseme timing is unavailable or unusable.
active_issues: []
---

What We're Focused On
---------------------

The backend-owned canonical `speech.synthesis` contract still carries optional playback-ready `audio_reference` metadata alongside the existing timing, segment, phoneme, and viseme fields on the same `speech.lifecycle` envelope. The frontend shell now keeps `App.tsx` as the only synthesis-event consumer and passes viseme and timing data into a runtime-local speech reaction API so the avatar runtime can schedule local viseme reactions when `synthesis.timing.viseme_slots` is usable, while degrading in-place to the existing coarse `speak` window when that viseme data is absent or unusable.

Keep the follow-on queue narrow and non-debug. Preserve the existing operator-command path and command types, keep active-character selection as the only selection control, and continue treating full phoneme inference, richer facial animation, transport expansion, broader memory orchestration, embeddings or vector retrieval, cross-session affinity, UI-visible memory diagnostics, provider-profile switching, animation debug actions such as `wave`, extra control-surface debug toggles or diagnostics, and any new operator command beyond the landed `text_question` and `tts_preview` pair as out of scope. Updated by Scribe after the frontend-only viseme runtime reaction slice landed on top of the existing backend-owned synthesis seam.
