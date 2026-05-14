Current Focus
=============

updated_at: 2026-05-14T12:18:00+01:00
focus_area: The first real memory and retrieval slice is now landed behind the existing backend-owned `text_question` path, with SQLite-backed same-session and same-character lexical recall enriching prompts before generation while the public transport and frontend reply ownership remain unchanged.
active_issues: []
---

What We're Focused On
---------------------

The backend now owns `POST /session/operator-command` for `text_question` and `tts_preview`, backend live `speech.lifecycle` delivery is already wired on the canonical snapshot and cursor contract, and `text_question` now routes through a real local text-generation adapter with SQLite-backed memory persistence and deterministic lexical retrieval scoped to the current session and active character. The control surface only adds the minimal follow-up needed to show backend-owned reply state, and the display surface remains read-only with respect to operator commands and reply rendering.

Keep the follow-on queue narrow and non-debug. Preserve the existing operator-command path and command types, keep active-character selection as the only selection control, and treat broader memory orchestration as out of scope until this first durable retrieval seam is hardened. That deferred queue currently includes richer memory ranking, summarization, embeddings or vector retrieval, cross-session affinity, UI-visible memory diagnostics, provider-profile switching, animation debug actions such as `wave`, extra control-surface debug toggles or diagnostics, and any new operator command beyond the landed `text_question` and `tts_preview` pair. Updated by Scribe after the SQLite-backed memory retrieval batch landed.
