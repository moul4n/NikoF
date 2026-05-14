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
- `bootstrap-prerequisites`: snapshots the current bootstrap prerequisite surface, including required tool availability and missing provider payload expectations inside a harness-owned sandbox.
- `backend-stage1-contracts`: snapshots the locked Stage 1 backend route registrations plus the current normalized outputs for `GET /health`, `GET /characters`, and `GET` plus `PUT /session/active-character`, including the canonical normalized session-event payload embedded in the active-character responses.

## Diff Behavior

Each scenario writes a current snapshot under `artifacts/current/<run-id>/`. When a baseline exists, the harness compares the serialized JSON snapshot to the checked-in baseline and emits a `.diff.txt` file when lines differ.

The default mode is comparison only. Baselines are rewritten only when `-RefreshBaselines` is passed intentionally.

For the backend Stage 1 scenario, the harness sets backend local-root environment variables to a harness-owned sandbox before importing the app snapshot helper. That keeps `GET /health` deterministic across machines while still leaving live transport frames, frontend UI text, animation commands, provider diagnostics, and wider failure-path matrices out of scope.

The same scenario also normalizes session-event timestamps to `<generated-at>` so payload shape changes still surface without failing every compare run on wall-clock time alone.

## Mouse Owns Next

- Add Stage 1 backend session and manifest-summary scenarios once those outputs stabilize.
- Add failure-path baselines for missing providers and widened payload regressions.
- Add bootstrap artifact assertions after the bootstrap report contract is intentionally hardened.