# Next Steps

Updated: 2026-05-14

1. Treat backend live `speech.lifecycle` delivery, real backend `text_question` execution, and the minimal control-surface assistant-reply readout as landed work; do not move reply ownership into `App.tsx`, the display surface, or a second command path.
2. Keep the immediate queue on hardening the current backend-authored reply seam: preserve `POST /session/operator-command`, the ordered store, and the canonical session plus `speech.lifecycle` envelopes while validating degraded local-LLM behavior on the same contract.
3. Do not widen this first reply slice into a second reply transport, frontend-owned reply state, provider-profile switching, or new operator commands while the backend-owned assistant path is settling.
4. Keep the active queue non-debug: animation debug actions such as `wave`, extra control-surface or display diagnostics, and other debug affordances stay deferred until they advance a real product seam.

## Deferred Todo

- Additional operator or debug controls beyond the landed `text_question` and `tts_preview` flow.
- Provider-profile switching.
- Animation debug actions such as `wave`.
- Extra control-surface or display-side debug toggles, diagnostics panels, or similar operator affordances that do not advance the backend reply path.
- Richer memory ranking, summaries, or vector retrieval beyond the landed SQLite-backed lexical recall for `text_question`.
