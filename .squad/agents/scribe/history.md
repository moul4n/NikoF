# Project Context

- **Project:** NikoF
- **Created:** 2026-05-14

## Core Context

Agent Scribe initialized and ready for work.

## Recent Updates

📌 Team initialized on 2026-05-14

📌 2026-05-14T08:57:41.6820932+01:00: Planning artifacts landed in README.md, docs/ARCHITECTURE.md, and docs/IMPLEMENTATION_PLAN.md

📌 2026-05-14: Repaired squad continuity state by restoring missing `.squad/log/`, `.squad/orchestration-log/`, and `.squad/decisions/inbox/`, and removed an accidental pasted patch block from Mouse history.

📌 2026-05-14: Aligned Scribe and Ralph support-role charters with the current squad roster so Scribe is documented as the session logger and continuity maintainer, and Ralph as the work monitor.

📌 2026-05-14T12:15:50.9004620Z: Merged the pending Scribe inbox decisions into `.squad/decisions.md` and logged the continuity pass, including the Stage 1 bridge audit finding of a frontend/backend contract mismatch.

📌 2026-05-14T12:30:00.8688200Z: Logged the Stage 1 bridge repair continuity pass after the frontend/backend bridge envelope mismatch and rejection rollback path were fixed, and after the `frontend-stage1-bridge-surface` stability scenario was extended to cover the rejection path.

📌 2026-05-14: Merged the remaining frontend-stage1-bridge rollback assertion inbox decision into `.squad/decisions.md` and cleared the decision inbox.

📌 2026-05-14T13:46:07.7392187+01:00: Updated squad state after confirming the repaired frontend build passes, the Stage 1 bridge stability scenario is green, and the provider-agnostic backend speech-contract slice is now baseline-covered.

📌 2026-05-14: Logged the next-step batch after provider-agnostic speech service interfaces, the `speech.lifecycle` transport snapshot contract, and the runtime-executed frontend/backend character-flow check landed, without adding any new decision record.

📌 2026-05-14: Logged the continuity pass after the Faster-Whisper and GPT-SoVITS adapter shells, the backend `GET /session/speech-lifecycle` read surface, and the frontend runtime speech snapshot proof landed, without adding a new decision record.

📌 2026-05-15: Logged the animation continuity pass after the backend animation contract became a real resolution seam, the promoted semantic DSL target schema was documented, and staged-versus-promoted animation boundaries were locked by the stability baseline.

📌 2026-05-15: Logged the idle.default continuity pass after the Unity batch export produced the generated shared runtime payload and semantic candidate, the avatar viewer seeded idle.default as its default base layer, and `frontend` returned to a green build.

📌 2026-05-15: Logged the backend-owned animation control continuity pass after `/session/animation` became the frontend shell's normal default-idle source, with the local `idle.default` clone retained only as a fetch-failure fallback.

📌 2026-05-15: Logged the lifecycle-driven animation control batch after backend session animation began resolving from canonical lifecycle state and the frontend started updating backend lifecycle state instead of owning active base animation mode locally.

📌 2026-05-15: Checked the empty decision inbox and logged the current web-first live animation seam only: the control shell now derives conversation lifecycle from canonical speech state, pushes it through `PUT /session/lifecycle-state`, and plays the backend-selected `idle.default`, `listen.loop`, or `speak.loop` command from the backend animation snapshot, with the local idle clone left as failure fallback only.

📌 2026-05-15: Merged the pending Switch humanoid-playback decisions into `.squad/decisions.md`, updated current continuity to mark arm calibration no longer blocked after live `/display/` verification, and logged the remaining issue as web-playback polish and exporter fidelity rather than the visible but unrelated backend speech lifecycle 422 responses.

📌 2026-05-15: Logged the refresh-regression continuity pass after live browser review showed the arms rising again on refresh, the loaded debug snapshot proved the earlier sign-flip edit was still present, and the current blocker narrowed from lost refresh state to remaining elbow/arm shaping and exporter fidelity after the upper-arm input offset was removed.

📌 2026-05-15: Logged the exporter-side elbow continuity pass after the user chose the exporter path, Switch proved the source clip still carried usable lower-arm data, the Unity batch exporter derived explicit elbow-flex channels and refreshed `idle.default`, `listen.loop`, and `speak.loop`, and live `/display/` verification showed elbow-flex plus forearm-twist lower-arm bindings in the runtime debug snapshot while backend speech lifecycle 422 responses stayed out of scope.

📌 2026-05-15: Logged the full-bone audit continuity pass after the user chose option 1, Switch verified the generated runtime sidecars already carry broader humanoid data than the browser was consuming, the backend remained semantic-only, the frontend payload path was confirmed to preserve exported channels, conservative finger stretch bindings landed and were live-verified, and the remaining unbound humanoid regions were explicitly left out of scope.

📌 2026-05-15: Merged the pending Switch finger-spread inbox decision and the paired user directive into `.squad/decisions.md`, updated current continuity to reflect that both finger stretch and spread are now bound in the web viewer, appended concise hand-slice learnings, and logged the implementation plus live `/display/` verification with 10 active spread bindings while backend speech lifecycle 422 responses remained out of scope.

📌 2026-05-15: Merged Jason's direct browser A/B approval and the pending Switch dev-switcher inbox decision into `.squad/decisions.md`, updated current continuity to reflect the landed dev-only display animation override plus punch validation on the 4174 surface, appended concise frontend-validation learnings, and logged that forced `gesture.punch.once` confirmed wrist and lower-arm quaternion delivery without isolating one new arm-chain defect beyond known weighting concerns while backend speech lifecycle 422 responses remained out of scope.

## Learnings

Initial setup complete.

- 2026-05-14T08:57:41.6820932+01:00: For an empty GitHub repo, the first non-interactive publish path is `git remote add origin <repo>`, `git branch -M main`, `git add -A`, `git commit -m "chore: initial project scaffold"`, then `git push -u origin main`.
- 2026-05-14T08:57:41.6820932+01:00: In Windows PowerShell, quote the upstream ref when validating tracking with git, for example `git rev-parse --abbrev-ref --symbolic-full-name "@{u}"`, or PowerShell will parse `@{...}` as a hashtable.
- 2026-05-14T08:57:41.6820932+01:00: Team focus moved from setup into architecture and phased delivery planning.
- 2026-05-14T08:57:41.6820932+01:00: UniVRM 1.0 is the user-approved baseline for avatar packaging and interchange.
- 2026-05-14T08:57:41.6820932+01:00: The refined 2026 blueprint baseline explicitly names GPT-SoVITS, Faster-Whisper Medium with Small fallback, LLaMA 3.1 8B Q4_K_M, MediaPipe Face Mesh, optional CLIP, and SQLite plus ChromaDB or FAISS as the planning contract for the Windows 10/11 local stack.
- 2026-05-14T08:57:41.6820932+01:00: Team context should describe the primary runtime as a voice-first loop with vision treated as an optional, non-blocking enrichment path rather than a core dependency.
- 2026-05-14T08:57:41.6820932+01:00: The agreed 2026 stage order is Stage 0 contracts, backend skeleton, frontend VRM rendering, STT plus TTS, local LLM plus memory, animation DSL, vision pipeline, character swapping, then optimization and polish.
- 2026-05-14T08:57:41.6820932+01:00: Stage 1 execution focus is now locked around three concrete seams only: backend contract normalization, one manifest-derived default-character VRM shell in the frontend, and deterministic backend stability baselines.
- 2026-05-14T08:57:41.6820932+01:00: Stage 1 decision merges should leave the broader Trinity batch-handoff inbox note intact unless the request explicitly asks for that contract-level consolidation too.
- 2026-05-15: The landed animation seam is backend-owned and engine-neutral: semantic ids resolve through shared inventory, declared character overrides, then safe fallback, while the promoted DSL schema stays distinct from staged provenance sidecars and that boundary is now stability-checked.
- 2026-05-15: The current viewer default-base path is now explicit and repo-backed: Unity batch export can emit a generated `idle.default` runtime payload plus semantic candidate, and the avatar runtime falls back to `idle.default` after load when no pending or active base animation has already been set.
- 2026-05-15: When a live browser check proves a narrow frontend playback fix, continuity should record the fix boundary and explicitly fence unrelated visible failures such as backend speech lifecycle 422s so the current blocker does not drift back to an already-resolved seam.
- 2026-05-15: When a refresh regression is reproducible but the loaded debug snapshot still contains the expected code edit, continuity should record the root cause as a runtime binding or payload issue rather than implying a lost refresh state.
- 2026-05-15: When exporter-side animation work is validated end to end, continuity should record the source-data proof, the explicit Unity editor path used to refresh runtime payloads, and the exact lower-arm channels visible in live `/display/` debug state so the remaining risk stays framed as fidelity rather than transport.
- 2026-05-15: When live verification succeeds through a newly preferred runtime path that the current debug inventory does not enumerate, continuity should say so explicitly and treat the screenshot or direct pose check as the stronger evidence until the debug surface is updated.
- 2026-05-15: When a later audit widens the verified export surface beyond the currently bound runtime surface, continuity should record both the preserved architecture boundary, such as a semantic-only backend, and the exact exported-but-intentionally-unbound channel families so follow-up work does not accidentally widen behavior.
- 2026-05-15: Once both finger stretch and conservative finger spread are bound, continuity should stop framing hands as missing basic connections and instead describe the remaining hand work as optional higher-fidelity transform hints or broader region coverage.
- 2026-05-15: Once a dev-only browser override exists for backend live versus forced reference clips, continuity should record that seam as a validation tool for future shoulder, elbow, and wrist tuning rather than continuing to describe punch A/B playback as blocked by missing UI control.
- 2026-05-15: When a live `/display/` tuning pass uses a user-supplied target screenshot, continuity should record the concrete target frame, the exact clip-local weights that changed, the display surface used for validation, and whether the remaining mismatch has narrowed from delivery defects to finer pose calibration.
