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
4. Let bootstrap create or validate the local storage roots under `%LOCALAPPDATA%\NikoF` by default, or fall back to the documented repo-local sandbox only when `LOCALAPPDATA` is unavailable.
5. Review the generated report under `.local/bootstrap/bootstrap-report.json` and the session helper `.local/bootstrap/session-env.ps1`.
6. Review the printed provider states and the matching `.local/bootstrap/hints/*.txt` files for blocked providers or runtimes. A normal bootstrap run now scaffolds the Faster-Whisper Medium and GPT-SoVITS local-only `runtime.json` and `install-plan.json` files automatically, while only the safe Ollama model pull remains automated. Faster-Whisper and GPT-SoVITS payload acquisition and provider entrypoint placement are still explicit manual steps.
7. Run repository validation commands, starting with the contract validation script, then backend and frontend startup checks.
8. Continue work only after the environment matches the documented baseline.

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

Current concrete local asset expectations:

- Ollama runtime install path stays machine-managed, but NikoF uses `NIKOF_PROVIDERS_ROOT\llm\ollama` for repo-facing notes or endpoint hints and `NIKOF_LLM_MODELS_ROOT\ollama-llama3.1-8b` for the local readiness marker after a successful `ollama pull llama3.1:8b`.
- Faster-Whisper Medium payloads live under `NIKOF_STT_MODELS_ROOT\faster-whisper-medium` and remain outside git.
- The backend-facing Faster-Whisper wrapper lives under `NIKOF_PROVIDERS_ROOT\stt\faster-whisper\transcribe.py` or `main.py`.
- Machine-local Faster-Whisper runtime shaping can live in `runtime.json` under that STT model root or the matching provider root. Keep machine-specific model and execution details there rather than in repo-tracked config.
- GPT-SoVITS payloads live under `NIKOF_TTS_MODELS_ROOT\gpt-sovits` and remain outside git.
- The backend-facing GPT-SoVITS wrapper lives under `NIKOF_PROVIDERS_ROOT\tts\gpt-sovits\synthesize.py` or `api_server.py`.
- Machine-local GPT-SoVITS runtime shaping can live in `runtime.json` under that TTS model root or the matching provider root. Keep speaker ids, reference audio paths, prompt text, and other vendor-specific payload details there rather than in repo-tracked config.
- The local-only runtime manifests live at `NIKOF_PROVIDERS_ROOT\llm\ollama\runtime.json`, `NIKOF_LLM_MODELS_ROOT\ollama-llama3.1-8b\runtime.json`, `NIKOF_STT_MODELS_ROOT\faster-whisper-medium\runtime.json`, `NIKOF_PROVIDERS_ROOT\stt\faster-whisper\runtime.json`, `NIKOF_TTS_MODELS_ROOT\gpt-sovits\runtime.json`, and `NIKOF_PROVIDERS_ROOT\tts\gpt-sovits\runtime.json`.
- The manual Faster-Whisper acquisition checklist lives at `NIKOF_STT_MODELS_ROOT\faster-whisper-medium\install-plan.json` and is created by the `stt-manual-medium` hook.
- The manual GPT-SoVITS acquisition checklist lives at `NIKOF_TTS_MODELS_ROOT\gpt-sovits\install-plan.json` and is created by the `tts-manual-gpt-sovits` hook.

Startup behavior now mirrors that contract: `backend/app/dev_server.py` warns on missing required local LLM, STT, and TTS prerequisites before Uvicorn starts, prints the expected canonical path, prints the runtime-config or install-plan path when one exists, includes the matching bootstrap resume hook command, and points at the generated hint file so a crashed or fresh session can reopen the exact remediation path.
For Faster-Whisper Medium specifically, startup now also prints the managed acceptance targets and any still-blocked local proof so the user can see whether the remaining issue is model payload placement, provider entrypoint placement, or both.
For GPT-SoVITS specifically, startup now also prints the managed acceptance targets and any still-blocked local proof so the user can see whether the remaining issue is payload placement, provider entrypoint placement, or both.

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
