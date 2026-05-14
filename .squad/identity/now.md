Current Focus
=============

updated_at: 2026-05-14T10:56:00+01:00
focus_area: The backend-authoritative operator command seam is now landed. The next seam is live delivery of canonical `speech.lifecycle` updates so accepted operator commands drive the immersive display through backend-owned streams rather than polling or frontend side channels
active_issues: []
---

What We're Focused On
---------------------

The backend now owns `POST /session/operator-command` for `text_question` and `tts_preview`, and the control surface publishes through a thin control-only client while the display stays read-only and reacts only to canonical backend state. The next batch should reuse the existing ordered event store plus the `next_speech_cursor` handoff to add backend live delivery for canonical `speech.lifecycle` updates, then have the immersive display consume that stream without polling hacks, a second command path, or local display-side write state.

Keep the follow-on seam narrow. Preserve the existing operator-command path and command types, keep active-character selection as the only selection control, and do not widen into provider-profile switching, animation debug actions such as `wave`, or a new LLM reply contract until the live-delivery seam is stable. Updated by Scribe after the operator-command batch landed.
