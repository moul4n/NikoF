# Bootstrap Scaffold

This folder provides the Windows-first bootstrap path promised by the repo docs. The current scaffold is intentionally conservative: it prepares the expected local storage layout, checks the required base toolchain, writes machine-local helper files, and prints the manual next steps for heavyweight providers and models.

## Run It

From the repo root:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\bootstrap\bootstrap.ps1
```

Optional override for the local storage root:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\bootstrap\bootstrap.ps1 -LocalRoot D:\NikoF
```

## What It Does

- Creates the documented local storage roots under `%LOCALAPPDATA%\NikoF` by default.
- Falls back to `.local\nikof` only when `LOCALAPPDATA` is unavailable or you pass `-LocalRoot`.
- Checks for `git`, Python via `py -3`, `node`, and `npm`.
- Writes `.local/bootstrap/session-env.ps1` with the canonical `NIKOF_*` environment variables for the current machine.
- Writes `.local/bootstrap/bootstrap-report.json` with tool and provider status.
- Reports where the baseline LLM, STT, TTS, embedding, and optional provider payloads are expected.

## What It Does Not Do

- It does not download GGUF, Faster-Whisper, GPT-SoVITS, embedding, or other heavyweight payloads automatically.
- It does not install vendor runtimes with uncertain licensing or machine-specific side effects.
- It does not modify frontend code or machine-global environment variables.

## Canonical Local Path Contract

The bootstrap script and backend settings now share these environment variables:

- `NIKOF_LOCAL_ROOT`
- `NIKOF_MODELS_ROOT`
- `NIKOF_LLM_MODELS_ROOT`
- `NIKOF_STT_MODELS_ROOT`
- `NIKOF_TTS_MODELS_ROOT`
- `NIKOF_EMBEDDINGS_ROOT`
- `NIKOF_PROVIDERS_ROOT`
- `NIKOF_CACHE_ROOT`

Dot-source the generated helper in a PowerShell session when you want those values loaded temporarily:

```powershell
. .\.local\bootstrap\session-env.ps1
```

## Manual Provider Follow-Up

The manifest file [bootstrap.targets.json](/c:/Users/fletc/Sources/NikoF/scripts/bootstrap/bootstrap.targets.json) records the expected folder names and upstream/manual-install notes for the current baseline.

For the speech slice, the backend now expects these local entrypoints in addition to the model payload roots:

- Faster-Whisper: if the backend environment does not already provide the `faster_whisper` package, place a provider-local Python entrypoint at `NIKOF_PROVIDERS_ROOT\stt\faster-whisper\transcribe.py` or `main.py`.
- GPT-SoVITS: place a provider-local Python entrypoint at `NIKOF_PROVIDERS_ROOT\tts\gpt-sovits\synthesize.py` or `api_server.py`.
- Both entrypoints should accept one JSON request on stdin and emit one normalized JSON response on stdout so the backend can keep provider-specific details out of its API payloads.

After placing the required payloads in local storage, rerun bootstrap and then run the contract gate:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\asset_validation\validate-contracts.ps1
```

The prereq surface is also tracked by the stability harness through snapshot scenarios that compare tool availability, expected provider payload locations, and the generated bootstrap report key surface against checked-in baselines:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\testing\Invoke-StabilitySuite.ps1 -Scenario bootstrap-prerequisites,bootstrap-report-surface
```
