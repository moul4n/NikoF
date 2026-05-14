# Backend Scaffold

This backend slice is intentionally minimal. It defines stable boundaries for session,
character, and animation concerns before FastAPI routes or local provider adapters are
implemented.

## Current scope

- `app/main.py` exposes an application shell and an optional FastAPI-compatible entrypoint.
- `app/api/router.py` lists the Stage 1 HTTP surface without binding the project to a web framework yet.
- `app/services/character.py` is the first real service stub and reads character manifests from `assets/characters/`.
- `app/services/session.py` and `app/services/animation.py` define coherent seams for later orchestration work.
- `GET /health`, `GET /characters`, and `GET` or `PUT /session/active-character` all stay provider-agnostic and can be inspected without local model installs.

## Later integration points

- Real HTTP handlers belong in `app/api/` once FastAPI is introduced.
- Local STT, LLM, TTS, and memory providers should sit behind dedicated services, not route modules.
- Persistent session state can replace the in-memory session stub without changing route contracts.

## Quick check

From the repo root:

```powershell
Set-Location backend
python -m app.main
python -m compileall app
```

`python -m app.main` prints a normalized contract snapshot for the current scaffold so you can inspect Stage 1 responses without FastAPI or any STT, TTS, LLM, or memory providers installed.
