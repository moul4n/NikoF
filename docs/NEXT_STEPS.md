# Next Steps

Updated: 2026-05-14

1. Treat `POST /session/operator-command` plus the thin control-surface client as landed work; do not move operator-command draft or submit state back into `App.tsx` or the display surface.
2. Make the next implementation batch a backend live-delivery seam: stream canonical `speech.lifecycle` updates for accepted operator commands from the existing ordered store so the immersive display can react without polling or frontend-only shortcuts.
3. Keep that live-delivery batch cursor-based and envelope-preserving, reusing the current `speech.lifecycle` document shape and `next_speech_cursor` handoff instead of inventing a second transport or widening command types.
4. Defer LLM reply generation for `text_question`, provider-profile switching, and animation debug actions such as `wave` until the live-delivery seam is stable and still backend-authored.
