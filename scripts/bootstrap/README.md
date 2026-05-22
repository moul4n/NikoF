# Bootstrap Scaffold

This folder provides the Windows-first bootstrap path promised by the repo docs. The current scaffold is intentionally conservative: it prepares the expected local storage layout, checks the required base toolchain, writes machine-local helper files, exports per-provider remediation hints, and prints concrete hook commands for heavyweight providers and models.

## Run It

From the repo root:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\bootstrap\bootstrap.ps1
```

When you want the repo to install the safe prerequisites on a Windows machine instead of only reporting them, run:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\bootstrap\install-prerequisites.ps1 -AllSafe
```

For normal day-to-day local use after bootstrap, the preferred full-stack startup path is:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\bootstrap\run-dev-stack.ps1
```

That supervisor starts frontend plus backend together, keeps STT and TTS ownership with the backend, and is the startup path users, developers, and AI agents should prefer. For automation that should prove startup and still leave the machine clean, add `-StopAfterSeconds 15` or a similar bounded value.

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
- Writes `.local/bootstrap/hints/*.txt` with one actionable remediation note per provider prerequisite.
- For Faster-Whisper Medium, scaffolds the local-only `runtime.json` and `install-plan.json` files plus the provider-side `runtime.json`, then records explicit acceptance targets and blocker details for the payload root and provider entrypoint.
- For GPT-SoVITS, records explicit acceptance targets and live blocker details in the hint files and bootstrap report so a scaffolded machine can tell you which local proof is still missing.
- Reports where the baseline LLM, STT, TTS, embedding, and optional provider payloads are expected, plus the hook command to run for each missing prerequisite.

## What It Does Not Do

- It does not auto-download Faster-Whisper, GPT-SoVITS, embedding, or other heavyweight payloads with licensing or runtime ambiguity.
- It only automates the safe Ollama model pull hook when the `ollama` command is already available on the machine.
- It does not silently install vendor runtimes with uncertain licensing or machine-specific side effects.
- It does not modify frontend code or machine-global environment variables.
- Manual LLM, STT, and TTS hooks scaffold local-only `runtime.json` and `install-plan.json` files, but they never download vendor payloads for you.

The new installer wrapper keeps that contract explicit:

- `install-prerequisites.ps1 -AllSafe` installs or reuses Git, Python, Node.js, the repo `.venv`, backend and frontend dependencies, Ollama, the baseline Ollama model, and the Faster-Whisper Medium payload plus provider wrappers.
- If Hugging Face is blocked on the target machine, pass `-SttModelSourcePath` to copy an approved Faster-Whisper Medium payload from another machine-local export instead of downloading it.
- GPT-SoVITS is still a source-path handoff because the approved runtime and weights are machine-local artifacts, not repo assets.
- If you have those approved GPT-SoVITS artifacts on another machine, pass `-TtsProviderSourcePath` and `-TtsModelSourcePath` so the installer can copy them into the managed local roots and then rerun validation.

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

The bootstrap summary now prints a hook command for every missing provider prerequisite:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\bootstrap\bootstrap.ps1 -RunHook <hook-id>
```

Safe command hooks run only when the manifest marks them safe for automation. Today that means the Ollama model pull hook:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\bootstrap\bootstrap.ps1 -RunHook ollama-pull-llama3.1-8b
```

That hook runs `ollama pull llama3.1:8b` and then writes a local readiness marker under `NIKOF_LLM_MODELS_ROOT\ollama-llama3.1-8b\.installed.json` so the bootstrap report can reflect the repo-facing model staging state without copying Ollama's own cache into git.

Manual-only hooks do not fake installation. They scaffold the local-only manifest files that the machine should use next, print the next step again, and point you at the matching hint file under `.local/bootstrap/hints/`.

For the GPT-SoVITS lane, the generated hint and report now separate the two machine-local acceptance targets explicitly:

- Payload proof under `NIKOF_TTS_MODELS_ROOT\gpt-sovits`, where at least one non-manifest payload file or folder must exist beyond `runtime.json` and `install-plan.json`.
- Provider proof under `NIKOF_PROVIDERS_ROOT\tts\gpt-sovits`, where one accepted entrypoint file must exist at `synthesize.py` or `api_server.py`.

If either proof is missing, bootstrap records a blocker with the exact expected path and accepted file variants instead of only reporting the shared `scaffolded` state.

For the required Faster-Whisper Medium lane, the generated hint and report now separate the two machine-local acceptance targets explicitly:

- Payload proof under `NIKOF_STT_MODELS_ROOT\faster-whisper-medium`, where at least one non-manifest payload file or folder must exist beyond `runtime.json` and `install-plan.json`.
- Provider proof under `NIKOF_PROVIDERS_ROOT\stt\faster-whisper`, where one accepted entrypoint file must exist at `transcribe.py` or `main.py`.

If either proof is missing, bootstrap records a blocker with the exact expected path and accepted file variants instead of only reporting the shared `scaffolded` state.

Current hook-side manifest scaffolding for the local LLM and TTS lane:

- `ollama-pull-llama3.1-8b` writes `NIKOF_LLM_MODELS_ROOT\ollama-llama3.1-8b\runtime.json` if it is missing, then performs the safe `ollama pull` and writes the `.installed.json` readiness marker.
- `tts-manual-gpt-sovits` writes `NIKOF_TTS_MODELS_ROOT\gpt-sovits\runtime.json` plus `NIKOF_TTS_MODELS_ROOT\gpt-sovits\install-plan.json`, then stops so you can acquire the approved GPT-SoVITS payload manually.
- `tts-provider-manual` writes `NIKOF_PROVIDERS_ROOT\tts\gpt-sovits\runtime.json`, then stops so you can place the local provider entrypoint without committing vendor code.
- `ollama-install-windows` does not install Ollama, but the reported runtime config path is `NIKOF_PROVIDERS_ROOT\llm\ollama\runtime.json` if you need a non-default endpoint.

The companion installer can now acquire the current GPT-SoVITS v2Pro baseline directly:

- `powershell -ExecutionPolicy Bypass -File .\scripts\bootstrap\install-prerequisites.ps1 -InstallGptSovitsV2Pro` downloads the Windows package and source archive, stages the provider runtime and pretrained-model requirements, stages the model-side v2Pro payload, and rewrites the local GPT-SoVITS runtime manifests as UTF-8 without BOM.
- That flow intentionally stops short of inventing a voice profile. You still need `NIKOF_TTS_MODELS_ROOT\gpt-sovits\speakers\default.json` plus at least one reference wav under `NIKOF_TTS_MODELS_ROOT\gpt-sovits\reference-audio` before a real `tts_preview` can succeed.

Current hook-side manifest scaffolding for the required STT lane:

- The default bootstrap run writes `NIKOF_STT_MODELS_ROOT\faster-whisper-medium\runtime.json`, `NIKOF_STT_MODELS_ROOT\faster-whisper-medium\install-plan.json`, and `NIKOF_PROVIDERS_ROOT\stt\faster-whisper\runtime.json` if they are missing.
- `stt-manual-medium` re-creates the model-side scaffolds only, then stops so you can place the approved Faster-Whisper Medium payload manually.
- `stt-provider-manual` re-creates the provider-side runtime manifest only, then stops so you can place the local provider entrypoint without committing vendor code.

For the speech slice, the backend now expects these local entrypoints in addition to the model payload roots:

- Faster-Whisper: place a provider-local Python entrypoint at `NIKOF_PROVIDERS_ROOT\stt\faster-whisper\transcribe.py` or `main.py` for the current managed medium-model lane.
- GPT-SoVITS: place a provider-local Python entrypoint at `NIKOF_PROVIDERS_ROOT\tts\gpt-sovits\synthesize.py` or `api_server.py`.
- Both entrypoints should accept one JSON request on stdin and emit one normalized JSON response on stdout so the backend can keep provider-specific details out of its API payloads.
- GPT-SoVITS can now also read `NIKOF_PROVIDERS_ROOT\tts\gpt-sovits\runtime.json` for a machine-local `entrypoint`, `python_executable`, and `timeout_seconds` override, and it treats those values as local-only runtime wiring rather than repo config.
- Faster-Whisper can now also read `NIKOF_PROVIDERS_ROOT\stt\faster-whisper\runtime.json` for a machine-local `entrypoint`, `python_executable`, and `timeout_seconds` override, and it treats those values as local-only runtime wiring rather than repo config.

The canonical local roots for the current LLM and TTS flow are:

- `NIKOF_LLM_MODELS_ROOT\ollama-llama3.1-8b` for the repo-facing Ollama model hint and readiness marker.
- `NIKOF_TTS_MODELS_ROOT\gpt-sovits` for the GPT-SoVITS runtime payload and voice weights.
- `NIKOF_PROVIDERS_ROOT\llm\ollama` for local Ollama endpoint notes or shims when you need them.
- `NIKOF_PROVIDERS_ROOT\tts\gpt-sovits` for the backend-facing GPT-SoVITS entrypoint wrapper.

The canonical local-only manifest files under those roots are:

- `NIKOF_LLM_MODELS_ROOT\ollama-llama3.1-8b\runtime.json` for an optional machine-local model-tag override.
- `NIKOF_PROVIDERS_ROOT\llm\ollama\runtime.json` for an optional machine-local Ollama endpoint override.
- `NIKOF_TTS_MODELS_ROOT\gpt-sovits\install-plan.json` for the manual GPT-SoVITS acquisition checklist.
- `NIKOF_TTS_MODELS_ROOT\gpt-sovits\runtime.json` for machine-local GPT-SoVITS model and speaker metadata.
- `NIKOF_PROVIDERS_ROOT\tts\gpt-sovits\runtime.json` for machine-local adapter entrypoint and Python-executable overrides.

When you start the backend through `python -m app.dev_server`, it now reuses the same bootstrap contract and prints degraded-mode startup guidance for missing required LLM and TTS prerequisites, including the matching hook command.

After placing the required payloads in local storage, rerun bootstrap and then run the contract gate:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\asset_validation\validate-contracts.ps1
```

The prereq surface is also tracked by the stability harness through snapshot scenarios that compare tool availability, expected provider payload locations, and the generated bootstrap report key surface against checked-in baselines:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\testing\Invoke-StabilitySuite.ps1 -Scenario bootstrap-prerequisites,bootstrap-report-surface
```
