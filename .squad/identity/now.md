Current Focus
=============

updated_at: 2026-05-14T12:45:00+01:00
focus_area: Backend `text_question` replies now land fully on the canonical `speech.lifecycle` stream, with backend-owned `assistant.message` plus `speech.synthesis` publication driving a read-only display reaction on the existing lifecycle seam while richer playback and animation behavior remain deferred.
active_issues: []
---

What We're Focused On
---------------------

The backend now owns the full `text_question` reply path on `POST /session/operator-command`: successful replies publish both `assistant.message` and backend-owned `speech.synthesis` activity onto the canonical `speech.lifecycle` stream, and the display surface reacts by reading that existing lifecycle state instead of introducing a second transport or any display-owned write model. The previously landed SQLite-backed same-session and same-character lexical retrieval remains the prompt-enrichment seam behind that command path, while lifecycle publication and display reaction are now the visible confirmation of backend reply ownership.

Keep the follow-on queue narrow and non-debug. Preserve the existing operator-command path and command types, keep active-character selection as the only selection control, and continue treating richer playback controls, animation coupling, audio transport expansion, broader memory orchestration, embeddings or vector retrieval, cross-session affinity, UI-visible memory diagnostics, provider-profile switching, animation debug actions such as `wave`, extra control-surface debug toggles or diagnostics, and any new operator command beyond the landed `text_question` and `tts_preview` pair as out of scope. Updated by Scribe after the canonical reply synthesis and display-reaction batch landed.
