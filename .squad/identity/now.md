updated_at: 2026-05-14T10:23:00+01:00
focus_area: The real `/control` and `/display` frontend entrypoints are now landed. The next frontend seam, if cleanup is needed, is display-only composition behind those entrypoints while keeping `App.tsx` as the only owner of backend sync, active-character confirmation, and live `speech.lifecycle` state without widening backend contracts
active_issues: []
---

# What We're Focused On

The current repo state now has the intended launch surface: `/control` and `/display` are real frontend entrypoints, the display surface is directly launchable as the presentation-first window, and backend-owned session plus `speech.lifecycle` envelopes still flow through one App-owned shell. The next seam should stay narrow. If the landed entrypoints need cleanup, extract only display-focused presentation structure under `frontend/src/app/` while keeping `App.tsx` as the sole owner of backend sync, active-character confirmation, and live `speech.lifecycle` consumption. Do not widen backend contracts, reintroduce a query-parameter surface toggle, or duplicate entrypoint-owned state just to reorganize presentation code.
Updated by Scribe after the real `/control` and `/display` entrypoint split landed and the next frontend seam narrowed to optional display-only composition cleanup.
