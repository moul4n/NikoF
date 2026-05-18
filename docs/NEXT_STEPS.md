# Next Steps

Updated: 2026-05-18T07:31:16.8111521Z

1. Carry the landed Faster-Whisper execution seam into the eventual operator-facing audio ingest path so real STT input uses the same normalized provider contract instead of the scaffold transcript path.
2. Broaden frontend verification around canonical TTS artifact playback now that backend `/api/session/speech-artifacts/{event_id}/audio` references are browser-playable; cover load failure, timing fallback, and operator-facing status copy.
3. Extend the fresh-machine bootstrap pattern from the current Faster-Whisper Medium and GPT-SoVITS scaffolded lanes into the remaining speech providers and bootstrap helpers without moving model payloads or vendor config into git.
4. Promote the current speech-safe prompt shaping on the `text_question` lane into structured emotion and animation hints without widening `POST /session/operator-command` or leaking provider response bodies.
5. Keep frontend and stability coverage aligned with the canonical `audio_reference` contract as the remaining speech providers adopt the same backend artifact URL path and degraded-status rules.
