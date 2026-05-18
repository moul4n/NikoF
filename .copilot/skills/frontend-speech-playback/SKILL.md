---
name: "frontend-speech-playback"
description: "Use canonical speech lifecycle playback in the frontend without unsafe local-file shortcuts"
domain: "frontend-runtime"
confidence: "high"
source: "earned"
---

## Context

The frontend already has one canonical speech write seam, `POST /session/operator-command`, and one canonical speech read seam, `GET /session/speech-lifecycle`. When TTS preview or text-question playback is being surfaced in the shell, the frontend should not invent a second contract, should not bypass the accepted operator-command response, and should not turn backend machine-local file paths into browser playback shortcuts.

## Patterns

### 1. Keep `speech.lifecycle` authoritative

- Use the accepted `POST /session/operator-command` response only as a temporary fallback until the canonical `speech.lifecycle` cursor catches up.
- After catch-up, drive assistant text, synthesis text, playback status, and character reconciliation from the canonical lifecycle snapshot.

### 2. Only play browser-safe `audio_reference` values

- Treat `http:`, `https:`, `blob:`, `data:`, backend-relative paths, and `/api/...` paths as browser-safe playback sources.
- Treat `session://`, `file:`, and machine-local filesystem paths such as `C:\...` as non-browser-safe in the shared shell.
- When the backend publishes a non-browser-safe `audio_reference`, do not rewrite it into `file:///...`; surface the raw reference in the UI and fall back to canonical timing metadata when available.

### 3. Cleanup must be symmetric

- Clear speech reactions on successful audio completion and on timing-window completion.
- If audio playback fails after a canonical synthesis event has already been accepted, reuse the canonical timing metadata instead of silently dropping the utterance.

### 4. Preserve the seam in validation

- Keep the App-to-bridge handoff anchored on the canonical synthesis event selected from `speechLifecycleState.snapshot?.canonicalSpeechSynthesisEvent ?? null`.
- Preserve the narrow `frontend-speech-lifecycle-runtime` stability scenario as the first executable check for this slice.