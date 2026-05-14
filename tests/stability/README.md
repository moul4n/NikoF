# Stability Testing

This area holds PowerShell-first regression and change-impact checks for repo-level seams that are already executable before full provider integration exists.

## Runner

Run the full suite from the repo root:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\testing\Invoke-StabilitySuite.ps1
```

Refresh stored baselines only when an approved behavior change should become the new expectation:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\testing\Invoke-StabilitySuite.ps1 -RefreshBaselines
```

Run a single scenario by id:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\testing\Invoke-StabilitySuite.ps1 -Scenario contracts-validation
```

Refresh a single scenario baseline intentionally:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\testing\Invoke-StabilitySuite.ps1 -Scenario backend-stage1-contracts -RefreshBaselines
```

## Layout

- `scenarios/scenarios.psd1`: manifest of stability scenarios, tracked inputs, and baseline targets.
- `baselines/*.json`: checked-in expected outputs for the current approved behavior.
- `artifacts/current/`: per-run current snapshots and diff files. Git-ignored.
- `artifacts/reports/`: suite reports for each run. Git-ignored.

## Initial Scenarios

- `contracts-validation`: snapshots the current contract validator command output and exit code.
- `bootstrap-prerequisites`: snapshots the declared bootstrap tooling contract from `bootstrap.targets.json` plus missing provider payload expectations inside a harness-owned sandbox. It intentionally excludes live command availability so compare mode tracks prerequisite-contract changes instead of machine-local PATH drift.
- `bootstrap-report-surface`: snapshots the shape of the generated bootstrap JSON report so added top-level fields or widened tool and provider entries fail deterministically without depending on machine-specific paths or timestamps.
- `backend-stage1-contracts`: snapshots the locked Stage 1 backend route registrations plus the current normalized outputs for `GET /health`, `GET /characters`, and `GET` plus `PUT /session/active-character`, including the owned invalid active-character rejection payload when the backend slice exposes it.
- `backend-speech-contracts`: snapshots the backend-owned provider-agnostic speech contract seam under `contracts`, including baseline `speech_adapter_profiles`, canonical `transcription.status` and `speech.synthesis` session events, and the ordered `speech.lifecycle` transport snapshot that later SSE or WebSocket delivery should reuse.
- `backend-speech-event-store`: projects the current canonical `speech.lifecycle` snapshot into deterministic persisted records plus cursor-read views so ordered event-store behavior can be regression-checked before a real store exists.
- `backend-turn-publication`: snapshots the backend turn-publication seam directly, proving `speech.lifecycle` stays empty until publication runs, that each publication appends the canonical speech events in deterministic order, and that `session.turn.published` resolves to `degraded` or `error` when STT or TTS does.
- `backend-speech-real-adapter-degraded`: snapshots the Faster-Whisper and GPT-SoVITS adapter shells in a harness-owned sandbox, proving they stay explicitly unconfigured in degraded mode while reusing the current canonical speech envelope shape with degraded `unavailable` contract statuses.
- `backend-stage1-payload-surface`: snapshots the allowed key sets for the current backend response envelopes, including selection metadata and the invalid active-character rejection envelope when present, so widened Stage 1 payloads fail even when the existing values still look valid.
- `frontend-stage1-bridge-surface`: snapshots the frontend bridge's declared `/characters` envelope and active-character response keys against the locked backend payload-surface baseline, so catalog-envelope drift and missing active-character `selection` handling fail before UI behavior is called done.
- `frontend-stage1-character-flow-runtime`: compiles a small Node TypeScript harness, feeds it the current backend Stage 1 snapshot, and executes the real frontend bridge and active-character reconciliation logic so envelope consumption, success-path confirmation, and rejection rollback are proven by runtime behavior rather than source inspection.
- `frontend-shell-split-surface`: source-inspects the React entrypoints under `frontend/src/*.tsx` plus the App-owned shell surface, recording whether every entrypoint still routes through `App` while `App.tsx` remains the sole owner of backend sync and `speech.lifecycle` consumption. Until real `/control` and `/display` entrypoints exist, this scenario records the dependency explicitly.
- `frontend-speech-lifecycle-runtime`: compiles a small Node TypeScript harness, proves the frontend loader preserves the canonical `speech.lifecycle` snapshot contract, and now also proves the live-consumption seam appends the next cursor and updated synthesis envelope without inventing a second delivery contract.

## Diff Behavior

Each scenario writes a current snapshot under `artifacts/current/<run-id>/`. When a baseline exists, the harness compares the serialized JSON snapshot to the checked-in baseline and emits a `.diff.txt` file when lines differ.

JSON-backed scenarios are compared by canonicalized content instead of raw whitespace, so PowerShell JSON formatting differences do not trigger false diffs on their own.

The default mode is comparison only. Baselines are rewritten only when `-RefreshBaselines` is passed intentionally.

For the backend Stage 1 scenarios, the harness sets backend local-root environment variables to a harness-owned sandbox before importing the app snapshot helper. That keeps `GET /health` deterministic across machines while still leaving live transport frames, frontend UI text, animation commands, provider diagnostics, and wider failure-path matrices out of scope.

Those scenarios also normalize session-event timestamps to `<generated-at>` so payload shape changes still surface without failing every compare run on wall-clock time alone.

The speech event-store and degraded-adapter scenarios follow the same rule: they snapshot only deterministic projections of the current envelope and sandbox-owned provider roots, and they never rewrite checked-in baselines unless `-RefreshBaselines` is passed for the targeted scenario.

For the bootstrap JSON surface, the harness now generates the bootstrap report inside a scenario-owned sandbox and snapshots only its stable key surface. That blocks accidental report widening without pinning machine-local paths, created directory lists, or timestamp values.

## Mouse Owns Next

- Add Stage 1 backend session and manifest-summary scenarios once those outputs stabilize.
- Keep widened-payload baselines aligned with the backend-owned Stage 1 envelopes, including the invalid active-character rejection contract when it exists on the current branch, plus the bootstrap report surface.
- Add bootstrap artifact assertions only after the bootstrap report value contract, not just its key surface, is intentionally hardened.
- Add live-delivery and real-provider execution scenarios only after Tank and Link land backend-owned transport and adapter behavior beyond the current degraded shells.
