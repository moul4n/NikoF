# Setup And Continuity

## Purpose

This document defines how NikoF stays portable across Windows machines without committing local AI payloads or relying on undocumented setup knowledge. It is the operational companion to the architecture and implementation plan.

## What Is Committed To Git

Committed:

- Source code under `frontend/`, `backend/`, and shared scripts.
- Contracts, schemas, manifests, fixture payloads, and validation logic.
- Character package metadata and small placeholder assets that are intentionally part of the repo contract.
- Documentation that explains architecture, setup, delivery stages, and work ownership.
- Squad continuity files under `.squad/`, excluding transient logs, inbox state, and other ignored runtime scratch data.

Not committed:

- LLM weights, GGUF files, Whisper model payloads, GPT-SoVITS voice weights, embedding model payloads, and similar large model assets.
- Provider runtimes or installers that are heavyweight, machine-specific, license-constrained, or already distributed by an upstream provider.
- Generated local caches, downloaded package archives, vector indexes built from local data, and machine-specific runtime state.

Rule: if an artifact is large, vendor-distributed, environment-specific, or can be re-acquired from a documented source, it belongs in local storage and bootstrap flow, not in Git.

## Local Storage Policy

Preferred local-only storage roots on Windows:

- `%LOCALAPPDATA%\NikoF\models\llm`
- `%LOCALAPPDATA%\NikoF\models\stt`
- `%LOCALAPPDATA%\NikoF\models\tts`
- `%LOCALAPPDATA%\NikoF\models\embeddings`
- `%LOCALAPPDATA%\NikoF\providers`
- `%LOCALAPPDATA%\NikoF\cache`

Expectations:

- Source code should resolve these paths through environment variables, backend settings, or bootstrap-generated configuration rather than hardcoded machine paths.
- If a repo-adjacent local cache is temporarily needed during development, it must be explicitly documented as local-only and ignored by Git.
- Character assets that are part of the contract remain under `assets/`; downloaded models and provider payloads do not.

## Expected Bootstrap Flow On A Fresh Windows Machine

1. Clone the repository.
2. Read `README.md`, this document, and the current squad docs to understand the expected stack and work state.
3. Run `powershell -ExecutionPolicy Bypass -File .\scripts\bootstrap\bootstrap.ps1` from the repo root.
4. If you want the repo to perform the safe Windows bring-up work automatically, run `powershell -ExecutionPolicy Bypass -File .\scripts\bootstrap\install-prerequisites.ps1 -AllSafe` instead of doing the base install steps by hand.
5. Let bootstrap create or validate the local storage roots under `%LOCALAPPDATA%\NikoF` by default, or fall back to the documented repo-local sandbox only when `LOCALAPPDATA` is unavailable.
6. Review the generated report under `.local/bootstrap/bootstrap-report.json` and the session helper `.local/bootstrap/session-env.ps1`.
7. Review the printed provider states and the matching `.local/bootstrap/hints/*.txt` files for blocked providers or runtimes. A normal bootstrap run now scaffolds the Faster-Whisper Medium and GPT-SoVITS local-only `runtime.json` and `install-plan.json` files automatically, while only the safe Ollama model pull remains automated. Faster-Whisper payload download is now available through the installer wrapper, while GPT-SoVITS payload acquisition and provider placement still require an approved local source path.
8. Run repository validation commands, starting with the contract validation script, then backend and frontend startup checks.
9. Continue work only after the environment matches the documented baseline.

The bootstrap contract is successful when a second Windows machine can reconstruct the intended environment without needing undocumented chat history or the original developer's shell profile.

## Manual Fallback When Automation Is Not Viable

Some prerequisites cannot be redistributed or installed safely by script. In that case, documentation and scripts must still leave the machine in a recoverable state.

Required manual-install guidance for each non-automated provider:

- What needs to be downloaded or installed.
- The authoritative upstream source or vendor page.
- Any version or compatibility constraint the project assumes.
- The expected install or extraction location.
- Environment variables, settings keys, or config files needed for discovery.
- A validation command or observable check proving the dependency is ready.
- The next bootstrap or startup step after the manual action is complete.

Manual fallback rule: the repo should never say only "install this yourself". It must say where to get it, where to place it, how to point the app at it, and how to verify success.

The bootstrap scaffold's current contract is intentionally conservative:

- It creates the expected local folder layout and writes a machine-local session env helper.
- It checks required tools such as Git, Python, and Node.js.
- It exports per-provider hint files under `.local/bootstrap/hints/` and prints a bootstrap hook command for every missing provider prerequisite.
- It scaffolds the Faster-Whisper Medium machine-local `runtime.json` files and `install-plan.json` during a normal bootstrap run so startup warnings and bootstrap hints point at the same concrete STT paths on a fresh machine.
- It can safely run `ollama pull llama3.1:8b` through `bootstrap.ps1 -RunHook ollama-pull-llama3.1-8b` when Ollama is already installed.
- It scaffolds the GPT-SoVITS machine-local `runtime.json` files and `install-plan.json` during a normal bootstrap run so startup warnings and bootstrap hints point at the same concrete paths on a fresh machine.
- It records explicit Faster-Whisper Medium acceptance targets and blocker details in the generated bootstrap report and hint files so a scaffolded machine can still tell you whether the missing proof is the model payload root, the provider entrypoint, or both.
- It records explicit GPT-SoVITS acceptance targets and blocker details in the generated bootstrap report and hint files so a scaffolded machine can still tell you whether the missing proof is the payload root, the provider entrypoint, or both.
- It keeps the Faster-Whisper manual hook surface as a re-scaffold path if those local manifests are deleted mid-setup.
- It keeps the GPT-SoVITS manual hook surface as a re-scaffold path if those local manifests are deleted mid-setup.
- Faster-Whisper scaffold files alone are not a ready install: bootstrap and backend startup now report `scaffolded` until a non-manifest payload exists under `NIKOF_STT_MODELS_ROOT\faster-whisper-medium` and a provider entrypoint exists under `NIKOF_PROVIDERS_ROOT\stt\faster-whisper`.
- GPT-SoVITS scaffold files alone are not a ready install: bootstrap and backend startup now report `scaffolded` until a non-manifest payload exists under `NIKOF_TTS_MODELS_ROOT\gpt-sovits` and a provider entrypoint exists under `NIKOF_PROVIDERS_ROOT\tts\gpt-sovits`.
- It does not blindly download Whisper, GPT-SoVITS, embedding, or other heavyweight payloads with uncertain redistribution or installer side effects.

The companion installer wrapper now automates the safe subset of that contract on Windows:

- It can install or reuse Git, Python, Node.js, Ollama, the repo `.venv`, backend dependencies, and frontend dependencies.
- It can pull the repo baseline Ollama model through the existing safe bootstrap hook.
- It can download Faster-Whisper Medium into the managed STT root and generate the local provider wrappers from repo code.
- If Hugging Face is blocked on the target machine, it can instead copy the approved Faster-Whisper Medium payload from another machine-local export through `-SttModelSourcePath`.
- It can now download and stage the current GPT-SoVITS v2Pro Windows package plus source tree through `-InstallGptSovitsV2Pro`, including the provider runtime, provider-side pretrained models, and the model-side v2Pro payload.
- It still does not invent a voice profile. Even after `-InstallGptSovitsV2Pro`, actual synthesis requires `NIKOF_TTS_MODELS_ROOT\gpt-sovits\speakers\default.json` plus at least one reference wav under `NIKOF_TTS_MODELS_ROOT\gpt-sovits\reference-audio`.
- If you already have an approved local GPT-SoVITS export, you can still use `-TtsProviderSourcePath` and `-TtsModelSourcePath` instead of the built-in download flow.

Current concrete local asset expectations:

- Ollama runtime install path stays machine-managed, but NikoF uses `NIKOF_PROVIDERS_ROOT\llm\ollama` for repo-facing notes or endpoint hints and `NIKOF_LLM_MODELS_ROOT\ollama-llama3.1-8b` for the local readiness marker after a successful `ollama pull llama3.1:8b`.
- Faster-Whisper Medium payloads live under `NIKOF_STT_MODELS_ROOT\faster-whisper-medium` and remain outside git.
- The backend-facing Faster-Whisper wrapper lives under `NIKOF_PROVIDERS_ROOT\stt\faster-whisper\transcribe.py` or `main.py`.
- Machine-local Faster-Whisper runtime shaping can live in `runtime.json` under that STT model root or the matching provider root. Keep machine-specific model and execution details there rather than in repo-tracked config.
- GPT-SoVITS payloads live under `NIKOF_TTS_MODELS_ROOT\gpt-sovits` and remain outside git.
- The backend-facing GPT-SoVITS wrapper lives under `NIKOF_PROVIDERS_ROOT\tts\gpt-sovits\synthesize.py` for one-shot invocation and may expose a persistent server through `api_v2.py`, `api.py`, or `api_server.py`.
- Machine-local GPT-SoVITS runtime shaping can live in `runtime.json` under that TTS model root or the matching provider root. Keep speaker ids, reference audio paths, prompt text, and other vendor-specific payload details there rather than in repo-tracked config.
- On the current dev machine, the managed GPT-SoVITS v2Pro install now starts successfully with `pretrained_models/s1v3.ckpt` plus `pretrained_models/v2Pro/s2Gv2Pro.pth`, but the provider root also needs the vendor `GPT_SoVITS/pretrained_models` subtree, including `GPT_SoVITS/pretrained_models/sv/pretrained_eres2netv2w24s4ep4.ckpt`.
- Starting the sidecar is not the same as producing audio: the current remaining machine-local synthesis requirement is still a speaker manifest and reference wav.
- The local-only runtime manifests live at `NIKOF_PROVIDERS_ROOT\llm\ollama\runtime.json`, `NIKOF_LLM_MODELS_ROOT\ollama-llama3.1-8b\runtime.json`, `NIKOF_STT_MODELS_ROOT\faster-whisper-medium\runtime.json`, `NIKOF_PROVIDERS_ROOT\stt\faster-whisper\runtime.json`, `NIKOF_TTS_MODELS_ROOT\gpt-sovits\runtime.json`, and `NIKOF_PROVIDERS_ROOT\tts\gpt-sovits\runtime.json`.
- The manual Faster-Whisper acquisition checklist lives at `NIKOF_STT_MODELS_ROOT\faster-whisper-medium\install-plan.json` and is created by the `stt-manual-medium` hook.
- The manual GPT-SoVITS acquisition checklist lives at `NIKOF_TTS_MODELS_ROOT\gpt-sovits\install-plan.json` and is created by the `tts-manual-gpt-sovits` hook.

Startup behavior now mirrors that contract: `backend/app/dev_server.py` warns on missing required local LLM, STT, and TTS prerequisites before Uvicorn starts, prints the expected canonical path, prints the runtime-config or install-plan path when one exists, includes the matching bootstrap resume hook command, and points at the generated hint file so a crashed or fresh session can reopen the exact remediation path.
For Faster-Whisper Medium specifically, startup now also prints the managed acceptance targets and any still-blocked local proof so the user can see whether the remaining issue is model payload placement, provider entrypoint placement, or both.
For GPT-SoVITS specifically, startup now also prints the managed acceptance targets and any still-blocked local proof so the user can see whether the remaining issue is payload placement, provider entrypoint placement, or both.
The live GPT-SoVITS path now launches one backend-owned sidecar and writes sidecar stdout and stderr to `%LOCALAPPDATA%\NikoF\logs\tts\tts-server-*.log`. When TTS requests degrade to `unavailable`, inspect those log files first.
The backend resource monitor's owned-process table depends on the backend environment matching `backend/pyproject.toml`; if `psutil` is missing from the active `.venv`, the API will return an empty `owned_processes` list until the environment is resynced.
Current measured TTS baseline on the active dev machine, captured on 2026-05-21 after the lifecycle-fallback fix:

- An 8-prompt sequential soak through `POST /session/operator-command` returned `ready` for all requests and kept the GPT-SoVITS sidecar warm throughout the run.
- Sampled end-to-end request latency was 290.6 ms minimum, 881.0 ms average, and 1593.2 ms maximum for prompts between 12 and 117 characters.
- Returned synthesis timing averaged 4620 ms, so the warm path is producing audio noticeably faster than real-time for this prompt mix.
- Spot-sampled GPU usage during the soak ranged from 31% to 56% with a 49.5% average, sampled power ranged from 30.81 W to 75.79 W, and reported VRAM stayed between 4996 MiB and 5113 MiB.
- Post-soak validation repeated `GET /session/speech-lifecycle` 10 times without moving the TTS request counter or `last_request`, which is the expected proof that idle polling is no longer driving hidden synthesis work.
- The post-soak warm-idle sample was 37%, 31.29 W, and 5016 MiB, and the active GPU engines belonged to VS Code and Edge rather than the backend-owned GPT-SoVITS Python process. Treat that sample as a Windows desktop estimate, not a dedicated TTS profiler trace.
- A later 30-prompt sequential soak kept that same behavior intact: 30 of 30 requests returned `ready`, the sidecar stayed loaded, measured request latency was 478.7 ms minimum, 923.1 ms average, 1480.9 ms at the 95th percentile, and 4515.8 ms maximum, and returned utterance timing averaged 4491.3 ms.
- During that longer run, active-loop GPU spot samples ranged from 31% to 79% with a 40.5% average, sampled power averaged 71.39 W and peaked at 86.29 W, and reported VRAM ranged from 5038 MiB to 5659 MiB.
- The first post-soak request-counter sample landed at 49 instead of the expected 50, but an immediate follow-up `GET /system/resources` read caught up to 50 and stayed flat through 10 more `GET /session/speech-lifecycle` calls, so treat that one-off as counter sampling lag rather than lost work.
- The cleanest post-soak warm-idle tail captured so far after repeated preview traffic is 8%, 30.64 W, and 5888 MiB with no GPU engine above the 5% reporting threshold.
- Reuse `scripts/testing/Invoke-TtsSoak.ps1` for future warm-path checks instead of rebuilding the manual command chain. The script writes a JSON artifact under `.local/monitoring/` with per-request samples, aggregate timing and GPU summaries, tail idle data, and both the raw resource-counter total plus an artifact-sequence-based completion estimate when `GET /system/resources` lags the returned `audio_reference` ids.
- Backend default server selection now prefers dedicated headless GPT-SoVITS API entrypoints in this order: `api_v2.py`, then `api.py`, then `api_server.py`. Machines that only have the current `api_server.py` wrapper remain compatible, but newer provider installs can switch to the lighter headless API path without additional repo changes.

## Squad Continuity Expectations

Continuity is a maintained artifact, not a best effort.

- `README.md` should explain the repo-level portability rule and point to the deeper setup guide.
- `docs/ARCHITECTURE.md` should capture the storage and bootstrap design constraints.
- `docs/IMPLEMENTATION_PLAN.md` should keep setup, portability, and reproducibility in Stage 0 and relevant later acceptance criteria.
- `docs/WORKSTREAMS.md` should keep ownership explicit for bootstrap, validation, install docs, and cross-machine continuity.
- `.squad/decisions.md` should capture durable policy decisions that shape implementation.
- Agent histories should retain lasting context that helps another machine or developer resume without rediscovering assumptions.

When setup flow, local storage paths, or provider expectations change, update the architecture, implementation plan, setup guide, and relevant squad records in the same change.

## Fresh-Machine Handoff Checklist

- The repo explains what is and is not committed.
- Local-only storage roots are documented.
- Bootstrap automation and manual fallbacks are both documented.
- Validation commands are documented.
- The current project plan and decisions are present in checked-in docs and `.squad/` files.
- Another developer can identify the next work item from `docs/WORKSTREAMS.md` and squad history without asking the original author.
