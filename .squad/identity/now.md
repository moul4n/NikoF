Current Focus
=============

updated_at: 2026-05-14T11:42:00+01:00
focus_area: The first backend-owned `text_question` LLM reply seam is now landed on the existing operator-command route, with canonical assistant reply data flowing through the current session and `speech.lifecycle` envelopes while the control surface only reflects backend-owned reply state.
active_issues: []
---

What We're Focused On
---------------------

The backend now owns `POST /session/operator-command` for `text_question` and `tts_preview`, backend live `speech.lifecycle` delivery is already wired on the canonical snapshot and cursor contract, and `text_question` now routes through a real local text-generation adapter that publishes backend-owned assistant reply state on the same session and `speech.lifecycle` envelopes. The control surface only adds the minimal follow-up needed to show that backend reply, and the display surface remains read-only with respect to operator commands and reply rendering.

Keep the follow-on queue narrow and non-debug. Preserve the existing operator-command path and command types, keep active-character selection as the only selection control, and treat additional operator or debug controls as deferred work. That deferred queue currently includes provider-profile switching, animation debug actions such as `wave`, extra control-surface debug toggles or diagnostics, any new operator command beyond the landed `text_question` and `tts_preview` pair, and memory-augmented prompt or retrieval work until this first backend-owned reply seam is stable. Updated by Scribe after the LLM reply batch landed.
