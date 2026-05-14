# Session Log

- **Timestamp:** 2026-05-14T10:23:00+01:00
- **Requested by:** Jason Fletcher
- **Summary:** Scribe recorded the landed real-entrypoint batch after the frontend shell replaced the query-parameter surface toggle with actual `/control` and `/display` entrypoints while keeping `App.tsx` as the single owner of backend synchronization, active-character confirmation, and live `speech.lifecycle` state. Continuity now points to the next narrow seam only if cleanup is needed: display-first presentation extraction behind the landed entrypoints without widening backend contracts, and this batch carries forward the already-green frontend build plus targeted and full PowerShell stability-suite runs as its validation baseline.
