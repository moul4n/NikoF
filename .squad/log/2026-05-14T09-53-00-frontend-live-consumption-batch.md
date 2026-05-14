# Session Log

- **Timestamp:** 2026-05-14T09:53:00+01:00
- **Requested by:** Jason Fletcher
- **Summary:** Scribe recorded the frontend live-consumption batch after the shell moved from snapshot-only polling to backend-owned `speech.lifecycle` SSE consumption with snapshot bootstrap and fallback preserved. The frontend loader now appends canonical envelopes and advances cursors without introducing a second transport contract, the runtime and stability harness prove both snapshot continuity and appended live synthesis delivery, and the already-green `frontend` build plus full PowerShell stability suite remain the verification baseline for this published slice.
