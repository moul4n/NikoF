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
6. Complete the documented manual steps for blocked providers or runtimes. The bootstrap scaffold does not pull heavyweight model payloads automatically.
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
- It reports missing provider assets and points to manual next actions.
- It does not download GGUF, Whisper, GPT-SoVITS, embedding, or other heavyweight payloads blindly.

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
