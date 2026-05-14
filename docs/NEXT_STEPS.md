# Next Steps

Updated: 2026-05-14

1. Treat `/control` and `/display` as the canonical frontend launch surfaces now that the real entrypoint split has landed; do not reintroduce the query-parameter surface toggle.
2. Keep `App.tsx` as the single owner of backend sync, active-character confirmation, and live `speech.lifecycle` state while the next frontend seam extracts only presentation-first display composition under `frontend/src/app/` when that split buys clarity.
3. Limit the next display-focused batch to minimal-chrome and fullscreen-ready presentation structure behind the real entrypoints, and keep operator or debug affordances on the control side unless they fit without backend contract changes.
4. Keep backend transport, cursor flow, manifest-local asset resolution, and the canonical `speech.lifecycle` envelope unchanged while that display-only composition seam lands.
