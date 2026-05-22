# Squad Decisions

## Active Decisions

### 2026-05-22T15:30:00Z: Preferred local startup is the managed dev-stack supervisor

**By:** Copilot
**What:** Treat `powershell -ExecutionPolicy Bypass -File .\scripts\bootstrap\run-dev-stack.ps1` as the preferred local startup path for users, developers, and AI agents whenever the full stack is needed. Keep `..\.venv\Scripts\python.exe -m app.dev_server` as the backend-only command for intentionally scoped debugging, not as the default full-stack startup path. Use `-StopAfterSeconds` for bounded smoke checks that should leave the machine clean after proving startup.
**Why:** One repo-root supervisor command keeps frontend plus backend startup consistent, keeps STT and TTS ownership with the backend, and reduces the chance of orphaned local sidecars caused by ad hoc multi-terminal launches.

### 2026-05-19T00:00:00Z: VRMA migration architecture confirmed — backend sends semantic commands, frontend owns native VRMA playback

**By:** Trinity
**What:** Confirm the VRMA migration plan. The backend does NOT realize animation virtually or pass bone positions. The frontend loads standard `.vrma` files via `@pixiv/three-vrm-animation` and three-vrm handles all bone math, retargeting, and coordinate conversion. The backend sends semantic animation commands only (`play_animation`, `stop_animation`, `crossfade`, `set_expression`, `set_lookat`). The custom quaternion JSON pipeline (`.runtime.json` payloads, manual coordinate conversion, `officialPunchClipPlayback.ts` custom bone routing) is deprecated and scheduled for removal after Phase 2 proves visual parity.
**Why:** The custom pipeline (Unity .anim → C# HumanPoseHandler → JSON quaternion arrays → THREE.js KeyframeTrack) is a dead end: VRM models have identity rest rotations, flat bone-local quaternions without a reference skeleton cannot retarget, and the pipeline has no expression support, lookAt, hips height scaling, or retargeting. `@pixiv/three-vrm-animation` solves all of these using world-space rotation retargeting with proper parent bone matrix transforms.

### 2026-05-19T00:00:00Z: VRMA playback interface — dual-path coexistence with `"mixer" | "vrma"` route selection

**By:** Switch
**What:** Extend `AvatarRuntimePlaybackPath` from `"mixer"` to `"mixer" | "vrma"`. New modules: `vrmaPlayback.ts` (owns VRMAnimationLoaderPlugin, GLTF loading, createVRMAnimationClip retargeting, THREE.AnimationMixer control), `animationCommandHandler.ts` (accepts backend semantic commands and dispatches to vrmaPlayback or VRM expressionManager/lookAt). The `avatarRuntimePlaybackRoute.ts` route selector gains an optional `preferredPath` parameter that short-circuits legacy mixer resolution when VRMA is preferred. Default path remains `"mixer"` — VRMA is dormant until `.vrma` files exist and the path is explicitly selected.
**Why:** Both pipelines can run simultaneously during migration. The legacy humanoid-channel pipeline uses direct bone manipulation incompatible with AnimationClip tracks in the same mixer. Immediate full replacement is rejected because VRMA files don't exist yet.

### 2026-05-19T00:00:00Z: Animation command protocol — thin `animation.command` SSE events for VRMA frontend playback

**By:** Tank
**What:** Introduce `animation.command` SSE event alongside existing `session.animation` events. The backend emits both: `session.animation` (rich SessionAnimationSnapshot for observability) and `animation.command` (thin actionable envelope the frontend VRMA runtime can execute directly). Command types: `play_animation`, `stop_animation`, `crossfade`, `set_expression`, `set_lookat`. `AnimationCommandTranslator` in `backend/app/services/animation_commands.py` maintains per-session base-clip state and translates each snapshot into the appropriate thin command. Backward compatible — existing `session.animation` stream unchanged.
**Why:** The backend stays in charge of WHAT plays WHEN (state machine, semantic resolution, fallbacks). The frontend only needs to know HOW to play. Thin commands map directly to `@pixiv/three-vrm-animation` operations without translation logic on the frontend. No bone math or engine internals cross the backend boundary.

### 2026-05-18T12:08:58.9671770Z: Approve browser-adjacent idle finger hardening on the existing runtime seam

**By:** Trinity
**What:** Approve the current hardening implementation. Keep `frontend-avatar-idle-default-runtime` as the primary approval seam, and accept the added dev-only display proof because it stays browser-adjacent rather than becoming a new browser system: `frontend/src/avatar/runtime/avatarRuntime.ts` only exports an idle finger debug snapshot, while `frontend/src/app/devDisplayTools.tsx`, `frontend/src/app/App.tsx`, and `frontend/src/app/surfaceShellPresentation.tsx` only read and present that snapshot on the existing dev display rail.
**Why:** The remaining uncertainty after the approved root-finger slice was real-VRM morphology on the loaded display avatar, not route ownership, backend transport, or App control flow. The implementation answers that exact gap by sampling loaded-VRM root fingers at loop start, quarter, mid, three-quarter, and loop return on the official idle path, while the focused `frontend-avatar-idle-default-runtime` seam still passes and the touched frontend files typecheck clean. The adjacent `frontend-shell-split-surface` diff is not a blocker for this review because the observed drift is outside the stated hardening goal and does not introduce a new backend-sync, `speech.lifecycle`, or session-animation owner.

### 2026-05-18T12:24:55Z: Prerequisite summary proof stays on the existing full control-shell DOM mount

**By:** Switch
**What:** Keep the prerequisite summary card guarded on the existing `frontend-stage1-character-flow-runtime` seam and expose that seam directly through `frontend/package.json` as `npm run stability:control-summary`. Do not add Playwright or a second browser runner for this slice.
**Why:** The current Stage 1 harness already mounts the real `ControlSurfaceShell` into `jsdom`, proves the summary panel is present, and asserts the rendered LLM, STT, and TTS rows plus visible prerequisite summary strings. Exposing that exact seam as a focused command lands the smallest executable guard above the extracted control-side panel without widening dependencies, subprocess churn, or browser infrastructure.

### 2026-05-18T11:27:39.8179670Z: Official idle root-finger proof should fall back to muscle channels when comparison samples are absent

**By:** Trinity
**What:** Keep `frontend-avatar-idle-default-runtime` as the approval seam for `idle.default` root-finger work, but treat the official idle playback owner in `frontend/src/avatar/runtime/officialPunchClipPlayback.ts` as responsible for a local root-finger fallback when the checked-in sidecar omits root-finger comparison quaternions. Bind only the approved root-finger slice from the existing `*.stretched` and `*_spread` humanoid muscle channels on `official_idle_stability`, and keep the runtime proof explicit by sampling rendered finger articulation on the same fake-rig seam.
**Why:** The strengthened seam showed that the prior runtime never targeted or rendered the root fingers even though authored finger muscle channels were already present. The checked-in `idle.default` sidecar still exports no root-finger comparison bones, so reopening exporter or backend transport work would widen the batch without solving the nearest controller. A local root-finger channel fallback plus an explicit rendered-articulation proof is the smallest fix that keeps the official idle route honest and reviewable.

### 2026-05-18T11:27:39.8179670Z: Approve the official idle root-finger proof extension

**By:** Mouse
**What:** Approve the revised `idle.default` finger slice on the existing `frontend-avatar-idle-default-runtime` seam. Keep approval scoped to `frontend/src/avatar/runtime/officialPunchClipPlayback.ts` admitting only the approved root fingers on `official_idle_stability`, with runtime-channel fallback for those fingers when comparison quaternions are absent, and to the matching runtime proof extension in `scripts/testing/frontendAvatarIdleDefault.runtime.ts`.
**Why:** The fresh stability run passed on the existing seam, the refreshed baseline shows all ten approved root fingers as targeted, each finger now sources authored proof from `runtime_channels`, and each finger records explicit hand-space rendered articulation vectors, articulation excursion above threshold, dominant-axis sign agreement, and return near loop start. The remaining risk is not a contract gap on this seam but fake-rig sampled-pose coverage: some digits still move only slightly above the articulation epsilon, so morphology-specific or between-sample visual weakness on real VRMs could still exist even though the missing rendered-finger regression gap is now closed here.

### 2026-05-18T11:22:29.3528092Z: Ollama baseline setup stays on the existing bootstrap seam

**By:** Tank
**What:** Keep the Ollama baseline on the existing bootstrap seam. A normal bootstrap run now scaffolds `NIKOF_PROVIDERS_ROOT\llm\ollama\runtime.json`, and the safe `ollama-pull-llama3.1-8b` hook may execute the standard Windows install path under `%LOCALAPPDATA%\Programs\Ollama\ollama.exe` when `ollama` is not on PATH.
**Why:** The backend adapter only treats the LLM lane as configured when both `NIKOF_PROVIDERS_ROOT\llm\ollama` and `NIKOF_LLM_MODELS_ROOT\ollama-llama3.1-8b` exist. On this machine, Ollama was installed locally but unavailable on PATH inside the VS Code shell, so the existing safe hook needed to honor the standard Windows install location instead of forcing a separate install flow.

### 2026-05-18T11:22:18.2082733Z: Idle finger slice stays local to root-finger routing on the official idle seam

**By:** Switch
**What:** Keep the current `idle.default` finger pass inside `frontend/src/avatar/runtime/officialPunchClipPlayback.ts` by admitting only the root finger bones on `official_idle_stability`: thumb metacarpal plus index, middle, ring, and little proximal bones for both hands. Preserve the existing App loop fix, grounding, elbow, and wrist behavior. Extend `frontend-avatar-idle-default-runtime` on the same seam so approval requires the root-finger slice to be targeted, show rendered excursion with authored dominant-axis sign agreement, and return near loop start.
**Why:** The nearby evidence showed exported finger signal was already present while the official idle route still mapped and allowed only up to `LeftHand` and `RightHand`, so the local failure mode was dropped root-finger routing rather than backend transport, exporter absence, or App playback control. Root-finger admission is the smallest plausible articulation pass and the focused runtime seam can now falsify it without opening a broader browser-proof system.

### 2026-05-18T11:22:18.2082733Z: Idle finger approval needs explicit rendered proof on the existing runtime seam

**By:** Mouse
**What:** Keep `frontend-avatar-idle-default-runtime` as the base approval seam for the next `idle.default` finger slice, but do not approve on the current seam alone. Reuse that same scenario and harness for the narrow proof extension instead of adding a new browser-facing system. Approval requires explicit rendered finger-motion proof on `official_idle_stability`; current hand-axis, settle, and grounding checks remain necessary but are not sufficient for fingers.
**Why:** The current scenario passes and already snapshots exported finger `*.stretched` and `*.spread` channels in the generated runtime payload, but its rendered proof boundary and validation surface only cover torso, shoulders, arms, and hands. `frontend/src/avatar/runtime/officialPunchClipPlayback.ts` currently limits official idle targeted playback to bones through `LeftHand` and `RightHand`, so the existing green seam cannot falsify missing, weak, or misdirected finger articulation.

### 2026-05-18T11:22:18.2082733Z: Browser-adjacent idle finger hardening should reuse the existing runtime seam

**By:** Switch
**What:** Treat `frontend-avatar-idle-default-runtime` as the default hardening surface for the next idle finger check when a browser-adjacent proof is acceptable. Do not add a new display-surface hook for this pass. Escalate to a new live-browser hook only if review explicitly requires real-VRM morphology coverage in `/display/`.
**Why:** The focused check passed on the existing seam, and that harness already samples loop start, a proof timestamp, and final frame on `official_idle_stability` while recording targeted root-finger bones, rendered finger articulation direction in hand space, dominant-axis sign agreement, and return near loop start. The current live debug API in `avatarRuntime.ts` still exposes pose comparison only for `gesture.punch.once`, so adding a new browser hook now would widen the batch without closing a proved gap.

### 2026-05-18T11:22:18.2082733Z: Real-VRM idle finger hardening stays on the current dev display surface

**By:** Mouse
**What:** Keep `frontend-avatar-idle-default-runtime` as the executable approval seam for `idle.default` fingers, and harden the remaining real-VRM gap on the current frontend surfaces by exposing a dev-only `getIdleFingerSnapshot()` on `window.__NIKOF_AVATAR_DEBUG__` from `frontend/src/avatar/runtime/avatarRuntime.ts` and rendering it in the existing display-side dev rail. Sample the loaded VRM root fingers at loop start, quarter, mid, three-quarter, and loop return on `official_idle_stability`; do not add Playwright or a second browser runner for this pass.
**Why:** The focused discriminating check showed the current idle runtime seam already passes and the frontend already owns a working browser-adjacent debug API for punch comparison. Adding the idle finger snapshot as a sibling hook closes the real-VRM visibility gap with the minimum change set, while a frontend TypeScript no-emit compile and a passing `frontend-avatar-idle-default-runtime` rerun keep the established seam intact.

### 2026-05-18T11:13:37Z: Idle wrist approval stays on the existing official idle runtime seam

**By:** Mouse
**What:** Keep `frontend-avatar-idle-default-runtime` as the approval seam for the next `idle.default` wrist slice when the implementation stays local to `frontend/src/avatar/runtime/officialPunchClipPlayback.ts` and only retunes `LeftHand` or `RightHand` on the existing `official_idle_stability` route. Do not require a new proof extension for approval if the wrist change remains a pitch-first hand-weighting pass and the current route, targeted-bone boundary, lower-arm-or-hand follow-through booleans, and grounding booleans stay green. Require a focused proof extension before approval if the slice widens into finger motion, changes route selection or targeted bones, or depends on wrist yaw or roll fidelity that the current hand proof does not explicitly constrain.
**Why:** The existing runtime scenario already includes `leftHand` and `rightHand` in the lower-arm-or-hand follow-through slice, and the current baseline records explicit dominant-axis sign agreement, rendered excursion above threshold, return-to-loop-start settle, and unchanged grounding on the same seam. The remaining blind spot is axis specificity rather than route or payload ownership, so the current seam is still sufficient for a local pitch-first wrist retune.

### 2026-05-18T11:10:45Z: Official idle wrist slice stays local to hand weighting on the existing runtime seam

**By:** Switch
**What:** Keep the next `idle.default` wrist pass inside `frontend/src/avatar/runtime/officialPunchClipPlayback.ts` by retuning only `LeftHand` and `RightHand` on the existing `official_idle_stability` path with a modest pitch-first local-rotation scale. Preserve the existing App loop fix, targeted-bone set, grounding behavior, and earlier elbow retune, and use `frontend-avatar-idle-default-runtime` as the approval seam for this slice.
**Why:** The official idle route already targets `LeftHand` and `RightHand`, and the current runtime seam already proves dominant-axis hand sign agreement, rendered excursion, return-to-loop-start settle, and unchanged grounding on that path. The local defect was flatter wrist read after the approved elbow retune rather than a route, exporter, backend, or App-owned playback failure.

### 2026-05-18T10:48:09.9571509Z: Approve the official idle elbow weighting slice on the existing runtime seam

**By:** Mouse
**What:** Approve the current `idle.default` elbow slice as staying inside the existing `frontend-avatar-idle-default-runtime` approval seam. Treat the production change as local to `frontend/src/avatar/runtime/officialPunchClipPlayback.ts`, where `LeftLowerArm` and `RightLowerArm` now carry a modest pitch-first local rotation retune on the `official_idle_stability` path. Keep approval anchored to the unchanged focused checks: `frontend-avatar-idle-default-runtime` passes with the official idle route, targeted-bone boundary, lower-arm or hand follow-through proof, and grounded-contact proof intact, and the frontend TypeScript no-emit compile stays clean.
**Why:** The current runtime still resolves `idle.default` through `official_idle_stability`, the targeted bone set remains the same official idle slice plus the grounded contact chain, and the lower-arm follow-through slice remains explicitly separated from the previously accepted torso or shoulder slice. The refreshed baseline still shows `proof_bone_sampled_rendered_excursion_above_threshold`, `lower_arm_hand_slice_returns_near_loop_start`, and `official_idle_grounding_keeps_contact_points_on_floor` as green, which keeps the elbow retune inside the already-proven route instead of widening into exporter, backend, or App-owned playback behavior. The main residual risk is still morphology-specific or between-sample elbow silhouette drift, because this seam uses a fake rig and sampled runtime poses rather than a browser-facing visual proof across multiple VRMs.

### 2026-05-18T10:39:11.4419754Z: Idle elbow approval stays on the existing official idle runtime seam

**By:** Mouse
**What:** Treat `frontend-avatar-idle-default-runtime` as the approval seam for the next `idle.default` elbow slice when the implementation stays inside `frontend/src/avatar/runtime/officialPunchClipPlayback.ts` and preserves the existing `official_idle_stability` route plus targeted-bone boundary. Do not require a new proof extension for approval if that slice only retunes lower-arm local playback on the already-proven seam. Approve only if the scenario still shows the lower-arm follow-through proof booleans green, grounding remains green, and any baseline refresh is confined to the intended lower-arm or hand rendered-pose evidence rather than route, target-set, or App-owned orchestration drift.
**Why:** The current stability seam already proves more than arm presence: it explicitly snapshots `leftLowerArm` and `rightLowerArm`, requires rendered excursion above threshold, authored-versus-rendered pitch or roll sign agreement, and return-to-loop-start settle for the lower-arm or hand follow-through slice. Residual risk without extra proof is limited to morphology-specific or between-sample silhouette regressions because the harness uses one fake rig and one sampled pose, not a browser-facing visual check.

### 2026-05-18T10:39:11.4419754Z: Official idle elbow slice stays local to lower-arm weighting on the existing runtime seam

**By:** Switch
**What:** Keep the next `idle.default` elbow pass inside `frontend/src/avatar/runtime/officialPunchClipPlayback.ts` by adding only a modest lower-arm local-rotation scale for `LeftLowerArm` and `RightLowerArm` on the `official_idle_stability` route. Preserve the existing `App.tsx` loop fix, grounded-feet behavior, targeted-bone set, and route-selection boundary. Use `frontend-avatar-idle-default-runtime` as the approval seam for this slice and accept a baseline refresh only when the lower-arm rendered-pose evidence changes while settle and grounding proof stay unchanged.
**Why:** The generated idle payload already exports `left/right.elbow.flex` plus lower-arm comparison quaternions, so the nearest honest defect is weak official-idle playback weighting rather than missing source signal, backend transport, or App-owned playback control. The existing runtime seam already proves lower-arm follow-through, return-to-loop-start settle, and grounding on the same route, so it is sufficient coverage for a weighting-only elbow retune.

### 2026-05-18T10:26:38.8609715Z: Idle floor grounding prioritizes feet before toes on the hardened runtime seam

**By:** Trinity
**What:** Keep `frontend-avatar-idle-default-runtime` as the authoritative grounded-feet regression seam, keep the grounding contact set explicit as `LeftFoot`, `RightFoot`, `LeftToes`, and `RightToes`, and make the idle floor-grounding pass resolve floor height from feet first when feet are present before falling back to the broader contact set. Keep the runtime edit local to `frontend/src/avatar/runtime/avatarRuntime.ts`.
**Why:** The widened lower-body official idle route still allowed toe-tip anchoring to keep the minimum contact at floor height while both feet drifted upward. Prioritizing feet on the existing runtime seam is the smallest change that matches the new executable proof without reopening App orchestration, exporter behavior, or backend transport.

### 2026-05-18T10:26:38.8609715Z: Feet-preferred idle grounding closes the current floating-feet regression seam

**By:** Mouse
**What:** Approve the revised feet-to-ground slice on the existing `frontend-avatar-idle-default-runtime` seam. The production runtime now resolves idle floor height from `LeftFoot` and `RightFoot` when those bones exist, only falling back to toes when feet are absent, and the focused stability scenario proves post-grounding world-space contact for `LeftFoot`, `RightFoot`, `LeftToes`, and `RightToes` using grounded minimum-contact and per-bone upward-drift checks.
**Why:** The earlier proof could still pass while toe-tip contact masked floating feet. The current slice fixes that exact blind spot locally in the runtime and mirrors the same discriminator in the executable harness, leaving residual risk limited to unproven transient or morphology-specific grounding drift outside the sampled fake-rig seam.

### 2026-05-18T10:15:34.1052229Z: Idle grounding approval stays blocked until grounded contact proof is explicit

**By:** Mouse
**What:** Do not treat the current idle-grounding slice as approved on `frontend-avatar-idle-default-runtime` until that existing scenario records an `official_idle_grounding_surface` with loop-start and sampled world-space Y for `LeftFoot`, `RightFoot`, `LeftToes`, and `RightToes`, and fails when the minimum grounded contact rises above a small epsilon or either foot drifts upward from grounded loop start beyond that epsilon.
**Why:** The passing scenario already proves official idle route selection and torso or arm follow-through, but it would not catch a floating-feet regression returning because it never asserts the post-grounding world-space foot or toe result.

### 2026-05-18T10:15:34.1052229Z: Official idle retains the lower-body contact chain while root motion stays disabled

**By:** Switch
**What:** Keep the official `idle.default` route bone-local with authored and procedural root motion disabled, and treat the lower-body comparison chain as part of the official idle contract: `leftUpperLeg`, `leftLowerLeg`, `leftFoot`, `leftToes`, `rightUpperLeg`, `rightLowerLeg`, `rightFoot`, and `rightToes` must stay targeted when `idle.default` resolves on `official_idle_stability`. Keep regression coverage on the existing `frontend-avatar-idle-default-runtime` seam.
**Why:** The exported idle comparison data already carries the leg and foot chain, and retaining that chain is the smallest frontend-side fix that restores planted feet without reopening backend transport, exporter design, or App-owned idle loop behavior.

### 2026-05-18T10:14:35Z: Reuse the Stage 1 runtime harness for rendered prerequisite-card proof

**By:** Switch
**What:** Keep the prerequisite-card proof on the existing `frontend-stage1-character-flow-runtime` seam instead of adding Playwright or a second browser stack. Extract the production `ControlSurfaceSummaryPanel` into a tiny renderable module, have the Stage 1 harness render that real card markup under Node, and separately assert that `ControlSurfaceShell` still mounts the same panel.
**Why:** The current blind spot is rendered control-surface text, not backend payload shape or shared summary-string derivation. The wider control-shell tree is still blocked in the Node harness by extensionless browser-side TSX imports, so this is the smallest adjacent rendered proof that keeps shell and subprocess churn low while still failing if the visible prerequisite card drifts or is no longer mounted.

### 2026-05-18T10:14:35Z: Health prerequisite read model projects startup truth as thin frontend-safe lanes

**By:** Tank
**What:** Extend the existing backend-owned `/health` surface to project local prerequisite truth for the `llm`, `stt`, and `tts` lanes directly from `get_startup_runtime_prerequisites()`. Keep the public shape thin and frontend-safe by exposing only lane `state` plus blocker `id`, `status`, and `summary`; do not surface startup-only paths, evidence, remediation text, or provider internals on the health read model.
**Why:** The frontend needs one stable backend read seam for local prerequisite status and blockers, but creating a second health-specific state model would drift from the startup contract. Reusing the existing prerequisite seam keeps health, bootstrap, and startup aligned while preserving the provider-agnostic public boundary.

### 2026-05-18: Stage 1 health prerequisite baselines stay on the real health and bridge owners

**By:** Tank
**What:** Keep the landed `/health` prerequisite read model protected through the existing Stage 1 backend and frontend stability seams instead of adding a new scenario. For backend Stage 1, preserve `diagnostics.prerequisite_lanes` inside `ConvertTo-BackendStage1ScopedSnapshot`, add `backend/app/api/response_builders.py` to the `backend-stage1-contracts` and `backend-stage1-payload-surface` tracked inputs, and pin the lane plus blocker key surface in the payload baseline. For frontend Stage 1, have `frontend-stage1-bridge-surface` follow the current extracted owners: catalog-envelope reads in `frontend/src/avatar/loaders/backendCharacterFlow.ts`, rejected-selection reconciliation in `frontend/src/app/useCharacterShellState.ts`, and health-lane consumption in `frontend/src/app/surfaceShellPresentation.tsx`.
**Why:** The stability harness could look green while still projecting `/health` back to the older diagnostics shape, and the frontend bridge guard was still anchored to pre-extraction owners. Keeping the protection on the current Stage 1 seams closes that regression gap without widening the test matrix or redesigning the feature.

### 2026-05-18T11:03:00Z: Faster-Whisper Medium bootstrap truth uses the same scaffolded-state seam as GPT-SoVITS

**By:** Tank
**What:** Keep the required Faster-Whisper Medium fresh-machine lane on the existing bootstrap and startup prerequisite seam, but make that seam project-managed and explicit instead of prose-only. Bootstrap now scaffolds machine-local `runtime.json` and `install-plan.json` under `NIKOF_STT_MODELS_ROOT\faster-whisper-medium` plus `runtime.json` under `NIKOF_PROVIDERS_ROOT\stt\faster-whisper`, and both bootstrap plus backend startup report the lane as `missing`, `scaffolded`, or `ready` using two concrete acceptance targets: non-manifest payload proof under the STT model root and one accepted provider entrypoint under the managed provider root.
**Why:** The previous STT contract only exposed a generic missing blocker and manual-install prose, which made a fresh-machine Faster-Whisper setup look unmanaged and hard to resume after interruption. Reusing the GPT-SoVITS scaffold-and-blocker pattern keeps vendor payloads and provider runtimes outside git, avoids a downloader, and gives bootstrap, startup guidance, and stability coverage one honest state model for the required STT lane.

### 2026-05-18T09:15:59.7678089Z: Default bootstrap auto-scaffolds the safe GPT-SoVITS local install files

**By:** Tank
**What:** Plain `scripts/bootstrap/bootstrap.ps1` now creates the approved local GPT-SoVITS scaffold files on a fresh machine without downloading or unpacking vendor payloads: `NIKOF_TTS_MODELS_ROOT\gpt-sovits\runtime.json`, `NIKOF_TTS_MODELS_ROOT\gpt-sovits\install-plan.json`, and `NIKOF_PROVIDERS_ROOT\tts\gpt-sovits\runtime.json`. The bootstrap report and startup guidance continue to treat GPT-SoVITS as `scaffolded` until a real payload exists under the model root and a provider entrypoint exists under the provider root.
**Why:** The install-state seam was already honest about `missing`, `scaffolded`, and `ready`, but a default bootstrap run still left fresh-machine users one step short of the explicit local manifest contract unless they discovered the manual hooks. Auto-scaffolding only the reviewed local manifests keeps vendor payloads outside git, avoids silent third-party acquisition, and makes the remaining manual blockers concrete.

### 2026-05-18T08:49:31.2684780Z: GPT-SoVITS install truth uses an explicit `missing`, `scaffolded`, and `ready` seam

**By:** Trinity
**What:** Keep GPT-SoVITS on the existing bootstrap, startup, and provider prerequisite boundary, but make that boundary report explicit `missing`, `scaffolded`, and `ready` states instead of treating scaffolded folders or manifests as installed. `missing` means the managed local GPT-SoVITS model or provider roots have not been prepared. `scaffolded` means project-created `runtime.json` or `install-plan.json` manifests exist under `NIKOF_TTS_MODELS_ROOT\gpt-sovits` or `NIKOF_PROVIDERS_ROOT\tts\gpt-sovits`, but the vendor payload and-or provider entrypoint are still absent. `ready` means both the payload proof and provider entrypoint proof exist under those managed local roots outside git. Keep the seam thin: bootstrap owns scaffolding and any safe automation, startup owns user-facing prerequisite truth, and the provider adapter continues to read only from the managed local roots.
**Why:** The previous bootstrap and startup contract still let scaffold-only GPT-SoVITS state read as installed, which made a fresh-machine setup look complete before any vendor payload or provider entrypoint had been placed. Landing the state distinction first fixes the truth gap without widening into vendor auto-install automation or a new backend API surface.

### 2026-05-18T08:49:31.2684780Z: GPT-SoVITS prerequisite state stays `scaffolded` until both local proofs exist

**By:** Tank
**What:** Keep GPT-SoVITS install management on the existing bootstrap and startup prerequisite seam, but make the reported local state explicit as `missing`, `scaffolded`, or `ready`. `missing` means the managed local GPT-SoVITS manifests have not been scaffolded yet. `scaffolded` means one or more local manifests exist under `NIKOF_TTS_MODELS_ROOT\gpt-sovits` or `NIKOF_PROVIDERS_ROOT\tts\gpt-sovits`, but the machine-local payload and-or provider entrypoint proof is still absent. `ready` means both proofs exist under the managed local roots: the TTS model root contains non-manifest payload content and the provider root contains an accepted entrypoint file.
**Why:** The previous seam reduced GPT-SoVITS readiness to path existence, so the manual scaffold hook could make a fresh-machine install look complete before any payload or provider entrypoint had actually been placed. Keeping the state logic thin and local fixes the truth gap without widening into a vendor auto-installer or a new backend API surface.

### 2026-05-18T08:49:31.2684780Z: User directive

**By:** Jason Fletcher (via Copilot)
**What:** Avoid opening many subprocesses, terminals, or shells; reuse the same terminal flow where possible and wait for jobs to finish unless they are long-running apps that should remain running.
**Why:** User request - captured for team memory.

### 2026-05-18T07:31:16.8111521Z: Faster-Whisper execution is the next speech slice before broader manifest expansion

**By:** Trinity
**What:** Take the next STT/TTS implementation slice through `backend/app/services/speech.py` by making `FasterWhisperTranscriptionAdapter` own a real local execution path on the existing provider-managed roots instead of inheriting the stub transcription behavior. Keep the seam thin: reuse the existing `SpeechTranscriptionRequest` and `SpeechTranscriptionContract`, reuse the current `providers/stt/faster-whisper` plus `stt_models_root` roots, and normalize degraded `unavailable` or `error` states the same way GPT-SoVITS already does. Defer wider `runtime.json` or `install-plan.json` rollout to the remaining speech providers until this adapter defines the exact STT-side manifest keys that are actually needed.

**Why:** The current repo already has the browser-safe TTS artifact seam and a real GPT-SoVITS adapter path, but `FasterWhisperTranscriptionAdapter` still only declares a binding shell and inherits `StubSpeechTranscriptionService.transcribe()`. That makes Faster-Whisper the nearest missing real execution seam, and finishing it first avoids widening bootstrap or startup manifest churn around a contract the backend still has not exercised.

### 2026-05-18T07:31:16.8111521Z: Faster-Whisper needs a configured execution test before any wider bootstrap confidence claim

**By:** Mouse
**What:** The next cheapest falsifier is a focused backend unit test in `backend/tests/test_provider_adapter_wiring.py` that provisions `NIKOF_STT_MODELS_ROOT\faster-whisper-medium` plus `NIKOF_PROVIDERS_ROOT\stt\faster-whisper\transcribe.py`, then asserts a configured Faster-Whisper path is actually exercised through the backend seam instead of returning the inherited stub transcript. The same pass should also add a composition assertion that `build_default_api_runtime_services()` no longer hardcodes `StubSpeechTranscriptionService` when the local STT roots are configured.

**Why:** Current verification proves bootstrap prerequisite text and degraded adapter envelopes, and it proves configured LLM and TTS execution, but it never forces a configured Faster-Whisper lane to execute. That leaves the repo green even though `FasterWhisperTranscriptionAdapter` only exposes `binding_for(...)` and the default runtime composition still wires stub transcription.

### 2026-05-18T07:31:16.8111521Z: Faster-Whisper now executes on the shared local provider contract

**By:** Link
**What:** Keep Faster-Whisper on the existing speech adapter seam, but make the default backend runtime resolve STT through `build_speech_service_registry()` instead of forcing `StubSpeechTranscriptionService`. `FasterWhisperTranscriptionAdapter` now reads machine-local `runtime.json` overrides from the existing model or provider roots, accepts `transcribe.py` or `main.py` entrypoints under `NIKOF_PROVIDERS_ROOT\stt\faster-whisper`, executes the configured entrypoint, and normalizes `ready`, `unavailable`, and `error` results into the existing `SpeechTranscriptionContract`. Focused tests now prove the default runtime turn publisher emits the provider transcript instead of the scaffold transcript when local Faster-Whisper roots are configured.

**Why:** The adapter shell already matched the local-only root contract used by Ollama and GPT-SoVITS, but backend composition still pinned STT to the scaffold service so configured Faster-Whisper never ran. Reusing the same registry and runtime-manifest pattern removes that dead path without widening the backend API or inventing another config surface.

### 2026-05-18: Canonical speech audio artifacts stay session-scoped behind backend-owned event resolution

**By:** Tank
**What:** Keep machine-local synthesis audio paths inside canonical `speech.lifecycle` event-store entries only, project frontend-facing `audio_reference` values to `/api/session/speech-artifacts/{event_id}/audio`, and serve that route by resolving the current session's matching speech event back to an allowed local artifact path under the managed TTS or cache roots. Keep frontend playback consuming only that backend-owned artifact URL seam, never raw absolute paths.
**Why:** This completes the missing browser-safe playback contract without widening `POST /session/operator-command` or exposing arbitrary filesystem reads, and it lets frontend and stability coverage converge on one canonical audio artifact path.

### 2026-05-18: TTS batch guardrails stay on the existing operator and speech lifecycle seams

**By:** Trinity
**What:** Keep `POST /session/operator-command` unchanged for this batch: `tts_preview` remains a synthesis-only command and `text_question` remains the only public operator path that may invoke the LLM before canonical assistant and synthesis publication. Keep `speech.lifecycle` as the sole canonical speech delivery seam, keep model payloads, provider payloads, and machine-local `runtime.json` files outside git under the bootstrap-managed roots, and treat backend startup prerequisite guidance as the install contract. Do not accept raw machine-local filesystem paths as the durable frontend `audio_reference` contract; this pass is only end-to-end complete once frontend playback consumes a backend-safe or session-scoped audio artifact without widening provider payloads.
**Why:** The backend already preserves the thin operator seam and local-only provider roots, but the frontend playback bridge still reduces real synthesis to coarse status labels and may receive machine-local paths that are not a stable browser-facing contract. Locking the seam now prevents LLM or provider controls from leaking into the public route while giving Tank, Link, and Switch one explicit blocker to solve next.

### 2026-05-18: Frontend speech playback treats machine-local audio references as non-browser-safe

**By:** Switch
**What:** Keep `POST /session/operator-command` and `GET /session/speech-lifecycle` as the only frontend speech command and read seams, but treat machine-local or `file:` `audio_reference` values as non-browser-safe in the shared shell. The frontend playback bridge should play only browser-safe URLs, clear speech reactions on successful audio completion as well as timing completion, and fall back to canonical timing metadata with explicit UI feedback when the backend publishes a local filesystem path.
**Why:** Turning backend filesystem paths into `file:///` URLs is a local shortcut that breaks the frontend-safe boundary and makes preview behavior unreliable. The shell needs honest operator feedback and deterministic cleanup while the backend retains ownership of any future browser-safe audio transport.

### 2026-05-18: Bootstrap LLM and TTS hooks scaffold local-only manifests

**By:** Tank
**What:** Keep the fresh-machine LLM and GPT-SoVITS setup behind the existing bootstrap hook surface, but make that surface concrete by scaffolding local-only `runtime.json` and `install-plan.json` files under `NIKOF_LLM_MODELS_ROOT`, `NIKOF_TTS_MODELS_ROOT`, and `NIKOF_PROVIDERS_ROOT` instead of copying vendor payloads into the repo. `backend/app/core/settings.py` and `backend/app/dev_server.py` should surface those same paths in degraded startup guidance, and the GPT-SoVITS adapter may read only machine-local invocation overrides such as `entrypoint`, `python_executable`, and `timeout_seconds` from `NIKOF_PROVIDERS_ROOT\tts\gpt-sovits\runtime.json`.
**Why:** The previous bootstrap contract named the right roots but still left fresh-machine users guessing which concrete local files to create next, especially after a crash or machine move. One shared hook-backed manifest contract keeps vendor payloads and secrets out of git while giving bootstrap, startup guidance, and the real provider adapter the same explicit remediation path.

### 2026-05-18: Character voice defaults merge with machine-local GPT-SoVITS runtime shaping behind the existing operator seam

**By:** Link
**What:** Keep `POST /session/operator-command` unchanged, but have the backend merge the active character's checked-in `voice/profile.json` defaults with machine-local GPT-SoVITS `runtime.json` overrides under `NIKOF_TTS_MODELS_ROOT\gpt-sovits` or `NIKOF_PROVIDERS_ROOT\tts\gpt-sovits` before invoking the provider entrypoint. Also keep `text_question` on a speech-safe prompt shape and skip TTS invocation when the LLM reply is not actually ready.
**Why:** This makes the TTS lane useful without widening the transport contract, keeps speaker payloads and reference audio outside git, and prevents degraded LLM states from masquerading as a healthy voice turn.

### 2026-05-18T06:03:55.4728589Z: User directive

**By:** Jason Fletcher (via Copilot)
**What:** Keep LLM and TTS model data outside git, and wire the installer or downloader into the prerequisite startup checks.
**Why:** User request - captured for team memory.

### 2026-05-18T00:26:00+01:00: Bootstrap and backend startup share one hook-backed local runtime prerequisite contract

**By:** Tank
**What:** Align the bootstrap prerequisite manifest with the backend's actual runtime binding paths for local LLM and TTS setup. Treat `NIKOF_LLM_MODELS_ROOT\ollama-llama3.1-8b`, `NIKOF_TTS_MODELS_ROOT\gpt-sovits`, `NIKOF_PROVIDERS_ROOT\llm\ollama`, and `NIKOF_PROVIDERS_ROOT\tts\gpt-sovits` as the canonical repo-facing local roots. Add bootstrap remediation hooks and hint files for those prerequisites, allow only the Ollama model pull to run as safe automation, keep GPT-SoVITS payload acquisition manual-only, and make `backend/app/dev_server.py` print the same hook commands and expected paths before starting in degraded mode.

**Why:** The previous bootstrap contract checked only coarse model folders and a mismatched Ollama provider path, so it did not describe the paths the backend adapters actually use and left the user guessing where Ollama and GPT-SoVITS artifacts belong. One shared hook-backed contract keeps heavyweight payloads out of git while still making fresh-machine setup explicit and testable.

### 2026-05-18T00:15:43+01:00: Control-surface operator preview reads canonical lifecycle while keeping the single write seam

**By:** Switch
**What:** Keep `POST /session/operator-command` as the only control-surface write path for `text_question` and `tts_preview`. On the frontend, treat the operator panel as a thin command publisher plus a read model over the existing `speech.lifecycle` snapshot/live-delivery state: surface assistant status, synthesis status, timing or audio-reference metadata, latest lifecycle event, and cursor catch-up from the canonical lifecycle document, and only fall back to the accepted POST response until the lifecycle cursor catches up. Keep the display surface read-only.
**Why:** The coming real LLM and TTS providers already publish meaningful readiness and result state through canonical backend events. Rebuilding that status in panel-local state would create a frontend-owned shadow model, make control and display drift easier, and weaken the backend-owned command seam that Stage 2 locked down.

### 2026-05-18T00:15:43+01:00: Real operator preview lane resolves only from local managed roots

**By:** Link
**What:** Start the real backend-owned preview lane by resolving the Ollama LLaMA 3.1 path only from `NIKOF_LLM_MODELS_ROOT` plus `NIKOF_PROVIDERS_ROOT/llm/ollama`, and the GPT-SoVITS path only from `NIKOF_TTS_MODELS_ROOT` plus `NIKOF_PROVIDERS_ROOT/tts/gpt-sovits`. Allow a machine-local `runtime.json` under those roots to override runtime details such as the Ollama endpoint or model tag, but do not add new repo-tracked path settings or widen the `POST /session/operator-command` contract.
**Why:** The narrow useful slice is real provider-backed execution on the existing operator seam, not a new configuration surface. Keeping runtime discovery rooted in the managed local paths preserves fresh-machine determinism, keeps heavyweight payloads out of git-tracked locations, and lets the backend degrade honestly to normalized `unavailable` or `error` contracts when the local runtime is absent or misconfigured.

### 2026-05-18T00:15:43+01:00: Current LLM and TTS ship lane stays contract-first

**By:** Trinity
**What:** Keep Ollama plus the LLaMA 3.1 8B baseline as the first real local LLM lane on the existing `POST /session/operator-command` `text_question` seam. Keep GPT-SoVITS as the primary TTS target behind the normalized speech contract, but do not widen this batch into microphone capture, VAD, sentence streaming, fallback-TTS expansion, or new frontend controls. The immediate implementation lane is to align backend provider discovery and prerequisite checks with the already documented local-storage contract so missing local runtimes degrade cleanly through canonical `assistant.message` and `speech.synthesis` publication instead of failing behind mismatched install assumptions.

For this batch: Link should harden only the local-provider discovery and invocation contract for Ollama and GPT-SoVITS under the bootstrap-managed roots, including accepted entrypoint names and degraded `unavailable` or `error` mapping. Tank should keep `POST /session/operator-command` authoritative, preserve the canonical `speech.lifecycle` envelope, and wire prerequisite or startup diagnostics through the existing bootstrap or settings path instead of adding routes. Switch should remain read-only over canonical backend state, with no new operator affordances beyond the current control-surface status and reply readout.

**Why:** The repo already has the right backend-owned reply seam, but the current bootstrap, degraded-mode baseline, and adapter bindings do not fully agree on what counts as a present Ollama or GPT-SoVITS runtime. Shipping broader Stage 3 audio-loop work before those discovery seams align would make Link, Tank, and Switch code against contradictory local-provider assumptions.

### 2026-05-17T23:46:00+01:00: Backend router keeps patchable wrapper seam after final constructor extraction

**By:** Tank
**What:** Move the last direct constructor glue out of `backend/app/api/router.py` by adding `build_default_animation_service()` and `build_default_session_animation_live_delivery_service()` to `backend/app/api/router_composition.py`, while preserving `_build_animation_service()` and `_build_session_animation_live_delivery_service()` as compatibility wrappers in `router.py`. Treat `build_api_router()` and `build_api_contract_snapshot()` plus those router-local wrappers as the minimum safe backend router surface for now.
**Why:** `backend/tests/test_event_store.py` still patches `_build_session_animation_live_delivery_service()` directly, and the remaining router-local functions are compatibility seams rather than composition weight. Keeping the wrappers avoids widening the test seam or creating churn with no runtime payoff, while the constructor move still removes the last orphaned composition-only logic from `router.py`.

### 2026-05-17T23:26:53.4019424+01:00: Backend router entrypoint glue moves behind router composition

**By:** Tank
**What:** Keep `build_api_router()` and `build_api_contract_snapshot()` as the public seams in `backend/app/api/router.py`, but move their remaining runtime-assembly and FastAPI fallback glue into `compose_api_router()` and `compose_api_contract_snapshot()` in `backend/app/api/router_composition.py`. Preserve the router-local compatibility wrappers, especially `_build_services()`, `_build_animation_service()`, `_build_session_animation_live_delivery_service()`, and `_route_definitions()`, so focused backend tests can keep patching the existing symbols without a contract change.
**Why:** After route registration, default service construction, contract snapshot assembly, and the route-definition shell moved out, the remaining low-risk `router.py` weight was pure entrypoint composition glue. Delegating that glue trims the router without changing runtime behavior or widening any stability tracked surface because the relevant backend seams already track `backend/app/api/router.py` together with `backend/app/api/router_composition.py`.

### 2026-05-17: App runtime playback input preparation moves behind a dedicated frontend hook

**By:** Switch
**What:** Extract the App-owned runtime playback input preparation from `frontend/src/app/App.tsx` into `frontend/src/app/useRuntimePlaybackSelection.ts`. Keep the new hook responsible for dev display override option resolution, display-readiness gating, backend session-animation snapshot handoff, and offline idle fallback eligibility, while leaving `App.tsx` as the owner of the explicit `runtime.play(null)`, forced semantic command, backend snapshot command, and local idle fallback branches plus the top-level display-versus-control selection.
**Why:** After the runtime shell effects moved into `useAvatarRuntimeShell.ts`, the remaining low-risk runtime-adjacent App weight was playback-input preparation rather than the final playback command. Moving that preparation trims the shell without widening into `avatarRuntime` behavior, and the narrow stability follow-up is to add the new hook to `frontend-shell-split-surface` while keeping `frontend-avatar-idle-default-runtime` scoped to the existing App-plus-runtime-shell ownership split.

### 2026-05-17T22:22:00+01:00: App runtime shell effects move behind a dedicated frontend hook

**By:** Switch
**What:** Extract the App-owned runtime-adjacent shell effect cluster from `frontend/src/app/App.tsx` into `frontend/src/app/useAvatarRuntimeShell.ts`. Keep the new hook responsible for runtime snapshot subscription, unmount cleanup, display debug-profile and playback-path synchronization, and selected-character load priming, while leaving `App.tsx` as the owner of runtime creation, canonical synthesis selection, session-animation selection, and the final `runtime.play(...)` decision.
**Why:** After the earlier state and presentation extractions, the remaining high-value low-risk App weight was the effect-heavy runtime shell glue rather than another transport owner. Moving that cluster trims `App.tsx` without widening into `avatarRuntime` behavior, and the narrow stability follow-up is to track the new hook in `frontend-shell-split-surface` plus `frontend-avatar-idle-default-runtime`.

### 2026-05-17T22:19:27+01:00: Backend route-definition shell moves behind router composition

**By:** Tank
**What:** Move `RouteDefinition`, `RouterShell`, and the canonical route-definition list out of `backend/app/api/router.py` into `backend/app/api/router_composition.py`, while keeping `build_api_router()` and `build_api_contract_snapshot()` as the public seams in `router.py` and preserving router-level compatibility exports plus the `_route_definitions()` wrapper.
**Why:** After route registration, default service construction, and contract-snapshot assembly moved behind composition, the remaining low-risk router-only glue was the static route-definition shell. Moving that ownership trims `router.py` further without changing runtime behavior, and `backend-speech-contracts` should track `backend/app/api/router_composition.py` because the speech contract snapshot still depends on that canonical route list.

### 2026-05-17: App derived shell orchestration moves behind a dedicated frontend hook

**By:** Switch
**What:** Extract the App-owned derived shell orchestration from `frontend/src/app/App.tsx` into `frontend/src/app/useSurfaceShellOrchestration.ts`. Keep the new hook responsible for dev display override state, display-side speech lifecycle character reconciliation, latest-published command catch-up, and conversation lifecycle derivation, while leaving `App.tsx` as the owner of avatar runtime creation, snapshot subscription, character load, final runtime playback decisions, and the control-versus-display surface selector.
**Why:** After branch composition moved behind `surfaceShellPresentation.tsx`, the remaining high-value low-risk App weight was mostly shell-only derivation and handler glue. Moving that cluster trims the frontend shell monolith without widening into `avatarRuntime` behavior or creating a second transport owner.

### 2026-05-17: Backend contract snapshot assembly moves behind router composition

**By:** Tank
**What:** Keep `build_api_contract_snapshot()` as the public backend contract seam in `backend/app/api/router.py`, but move the shared snapshot assembly into `backend/app/api/router_composition.py`. Preserve the existing router-local compatibility helpers and route module ownership, and do not widen the current stability tracked inputs because `backend/app/api/router_composition.py` is already part of the tracked backend composition seam.
**Why:** After route-registration composition and default runtime service construction moved out of `router.py`, the remaining low-risk monolith weight was the shared contract-snapshot glue. Moving that assembly trims the router without changing the public contract entrypoint or the focused backend tests that still lean on router-local wrappers.

### 2026-05-17: App surface-shell branch composition moves behind the presentation module

**By:** Switch
**What:** Extract the full control-surface and display-surface render trees plus their UI-only prop assembly from `frontend/src/app/App.tsx` into `frontend/src/app/surfaceShellPresentation.tsx`, while keeping `App.tsx` as the owner of avatar runtime wiring, backend transport hooks, command publication handling, and the final `surfaceMode` branch selection between display and control. Narrowly update `frontend-shell-split-surface` so it treats `App.tsx` as the selector seam and `surfaceShellPresentation.tsx` as the branch-render owner.
**Why:** After the first presentation helper extraction, the remaining high-value low-risk App weight was still the top-level shell JSX and the presentation-only view-model assembly feeding it. Moving that composition behind the existing presentation module reduces App surface area without widening into `avatarRuntime` behavior or adding a second transport owner.

### 2026-05-17: Default backend router service construction moves behind router composition

**By:** Tank
**What:** Keep `build_api_router()` as the public seam and preserve the router-local `_build_services()` compatibility wrapper, but move the default stub service assembly into `backend/app/api/router_composition.py` behind a dedicated runtime-services helper. Leave route registration, contract snapshot behavior, and the current backend stability tracked inputs unchanged.
**Why:** After route-registration composition moved out of `router.py`, default service construction was the next coherent low-risk slice. Moving that block trims the router without breaking focused tests that patch `_build_services()`, and it avoids speculative stability churn because `backend/app/api/router_composition.py` is already the tracked composition seam.

### 2026-05-17: App surface presentation moves behind a dedicated frontend module

**By:** Switch
**What:** Extract the inline surface panels and UI-only helpers from `frontend/src/app/App.tsx` into `frontend/src/app/surfaceShellPresentation.tsx`, including the surface-mode switcher, speech lifecycle read panel, control summary panel, display status panel, surface href builder, display reply formatting, and speech playback status labeling. Keep `App.tsx` as the owner of avatar runtime wiring, speech lifecycle and session animation transport, command publication handling, and the final display-versus-control branch selection. Add the new presentation module to the tracked inputs for `frontend-shell-split-surface` so the stability harness follows the updated ownership seam.
**Why:** After the transport and playback bridge extractions, the remaining high-value low-risk App surface was presentation composition rather than another state owner move. This module cut removes a large block of JSX and UI-only derivation from the shell while preserving the existing top-level runtime and transport ownership model.

### 2026-05-17: Backend router composition wiring moves behind a dedicated helper

**By:** Tank
**What:** Extract the remaining route-registration composition wiring from `backend/app/api/router.py` into `backend/app/api/router_composition.py`, while keeping `build_api_router()` as the sole composition entrypoint and preserving the current route modules, helper wrappers, route signatures, and response envelopes. Add the new helper to the tracked inputs for `backend-stage1-contracts`, `backend-stage1-payload-surface`, `backend-session-animation-live-delivery`, and `backend-operator-command-surface` so the stability harness follows the new ownership seam.
**Why:** After the individual route clusters moved out of `router.py`, the repeated registration wiring was the next coherent low-risk monolith seam. Moving that composition block reduces router weight without changing runtime behavior, and the narrow tracked-input update keeps the backend stability scenarios aligned with the real ownership boundary instead of reporting a false regression.

### 2026-05-17: Official idle torso slice adds spine retain coverage and tracks the canonical seam

**By:** Switch
**What:** Keep `idle.default` on the existing `official_idle_stability` path and add idle-only local-rotation retain coverage for `Spine` in `frontend/src/avatar/runtime/officialPunchClipPlayback.ts`, leaving the existing `Hips`, `Chest`, and `UpperChest` official-route retain table intact. Update the `frontend-avatar-idle-default-runtime` stability seam to track `frontend/src/avatar/runtime/officialPunchClipPlayback.ts` and source-inspect the canonical official idle path instead of the older inline custom-humanoid matcher.
**Why:** The generated `idle.default` runtime sidecar already carries export-audit local rotation samples for `hips`, `spine`, `chest`, and `upperChest`, so the next honest torso-only slice stays in frontend playback weighting. The narrow local defect was that the torso retain table softened neighboring torso bones while leaving `Spine` unbounded on the official route, which made the torso stack less coherent than the intended pelvis-through-upper-chest read.

### 2026-05-17: App canonical-synthesis playback bridge moves behind a dedicated frontend hook

**By:** Switch
**What:** Extract the App-owned canonical synthesis playback bridge from `frontend/src/app/App.tsx` into `frontend/src/app/useSpeechPlaybackBridge.ts`. Keep the new hook responsible for playback-key deduplication, audio playback, timing-window fallback, speech-reaction viseme handoff, and cleanup of transient playback state, while leaving `App.tsx` as the top-level owner of speech lifecycle selection, runtime wiring, conversation lifecycle intent, and the final display-versus-control shell branching. Narrowly update the affected frontend stability seams so `frontend-shell-split-surface` tracks the new hook file and `frontend-speech-lifecycle-runtime` proves the speech-playback handoff across `App.tsx` plus `useSpeechPlaybackBridge.ts`.
**Why:** After character shell, speech lifecycle transport, and session animation transport moved out of App, the canonical synthesis playback bridge was the next coherent App-owned orchestration slice. The bridge already sat on one local boundary around canonical synthesis playback-key resolution and runtime speech-reaction handoff, so it could move without changing backend transport ownership or widening into `avatarRuntime` behavior.

### 2026-05-17: App session-animation transport state moves behind a dedicated frontend hook

**By:** Switch
**What:** Extract the App-owned session-animation transport cluster from `frontend/src/app/App.tsx` into `frontend/src/app/useSessionAnimationState.ts`. Keep the new hook responsible for snapshot and live delivery state, backend lifecycle-update reconciliation, backend-selected character catch-up, offline fallback messaging, and retry scheduling, while leaving `App.tsx` as the top-level owner of conversation animation lifecycle intent and the final runtime play decision between backend animation commands, dev overrides, and the local idle fallback. Narrowly update `frontend-shell-split-surface` so the extracted hook is the sole session-animation transport owner inside `frontend/src/app`.
**Why:** After the speech lifecycle extraction, the session-animation transport and reconciliation cluster was the next coherent App-owned orchestration slice. That block already sat on one boundary around `/session/animation` consumption plus `PUT /session/lifecycle-state`, so it could move without touching `avatarRuntime` behavior while still shrinking the shell monolith.

### 2026-05-17: Stage 1 read routes extract into a dedicated backend module

**By:** Tank
**What:** Extract `GET /health` and `GET /characters` registration from `backend/app/api/router.py` into `backend/app/api/read_routes.py` while keeping `build_api_router()` as the composition entrypoint, preserving the current response shapes, and adding the new module to the `backend-stage1-contracts` and `backend-stage1-payload-surface` tracked inputs.
**Why:** After session transport, response builders, operator-command publication, and active-character selection moved out of the router, the remaining simple Stage 1 read-route pair was the next coherent seam. Moving it reduces router weight without changing the Stage 1 contract, and the narrow tracked-input update keeps the stability harness aligned with the new ownership boundary instead of reporting a false regression.

### 2026-05-17: Active-character session selection routes extract into a dedicated backend module

**By:** Tank
**What:** Extract `GET` and `PUT /session/active-character` registration from `backend/app/api/router.py` into `backend/app/api/active_character_routes.py` while keeping `build_api_router()` as the composition entrypoint, preserving the current route signatures and response envelopes, and adding the new module to the `backend-stage1-contracts` and `backend-stage1-payload-surface` tracked inputs.
**Why:** After operator-command publication, the active-character selection pair was the next safe Stage 1 router-owned seam. Moving it reduces router weight without widening the current contract, and the matching stability-input update prevents a false Stage 1 regression when the router decorators no longer own that cluster directly.

### 2026-05-17: App speech lifecycle transport state moves behind a dedicated frontend hook

**By:** Switch
**What:** Extract the App-owned speech lifecycle transport cluster from `frontend/src/app/App.tsx` into `frontend/src/app/useSpeechLifecycleState.ts`. Keep the new hook responsible for snapshot and live delivery state, offline fallback messaging, and retry scheduling, while leaving `App.tsx` as the top-level owner of canonical synthesis playback handoff into the avatar runtime, latest-published-command catch-up, display-side character reconciliation, and conversation animation lifecycle updates.
**Why:** After the character-shell extraction, the speech lifecycle transport block was the next coherent App-owned orchestration slice. Moving the transport-state path behind one dedicated hook shrinks the shell monolith without widening into `avatarRuntime` behavior or changing the runtime ownership model.

### 2026-05-17: Operator-command publication routes extract into a dedicated backend module

**By:** Tank
**What:** Extract `/session/operator-command` registration and its turn-publication branching from `backend/app/api/router.py` into `backend/app/api/operator_routes.py` while keeping `router.py` as the composition entrypoint and preserving the existing route signature and response envelope.
**Why:** After session transport and response-builder extraction, operator-command publication was the next safe router-owned seam with focused backend coverage. Moving that cluster reduces router weight without widening the public contract, and the matching stability scenario can stay accurate by tracking the new route module explicitly.

### 2026-05-17: App character-shell state moves behind a dedicated frontend hook

**By:** Switch
**What:** Extract the App-owned character shell state from `frontend/src/app/App.tsx` into `frontend/src/app/useCharacterShellState.ts`. Keep the new hook responsible for catalog load, backend bridge refresh and retry, persisted selected-character storage, cross-tab storage reconciliation, and backend active-character submit handling, while leaving `App.tsx` as the top-level owner of avatar runtime wiring, speech lifecycle consumption, session animation consumption, and backend-driven runtime orchestration.
**Why:** After the dev-display tooling extraction, the character-shell state cluster was the next coherent App seam with a high monolith-reduction payoff. Moving that cluster into a dedicated hook cuts App orchestration weight without widening into avatar runtime or changing the public frontend contracts.

### 2026-05-17: Router response builders extract into a dedicated backend module

**By:** Tank
**What:** Extract the backend router's response-shaping helpers into `backend/app/api/response_builders.py` while keeping `backend/app/api/router.py` as the composition entrypoint and preserving compatibility wrappers for leaked helper names such as `_serialize_dataclass_payload` and `_build_speech_lifecycle_sse_frame`.
**Why:** After session transport extraction, response shaping is the next safe backend monolith seam. Those helpers are pure payload and contract builders already shared across route handlers and snapshot generation, so they can move without changing route signatures or the current HTTP and SSE payload contracts.

### 2026-05-17: Stage 1 backend stability baselines stay projected from the Stage 1 seam

**By:** Tank
**What:** Keep `backend-stage1-contracts` and `backend-stage1-payload-surface` projected only from the intended Stage 1 route and envelope set: `GET /health`, `GET /characters`, and `GET` plus `PUT /session/active-character`, including the invalid active-character rejection payload when present. Keep `build_api_contract_snapshot()` broad and unchanged so newer backend-owned session surfaces stay covered by their own dedicated scenarios, and scope the Stage 1 catalog examples to the tracked manifest ids so local imported characters or temporary assets do not silently widen the Stage 1 baselines.
**Why:** The cleanup pass extracted newer backend session surfaces, and using the full shared snapshot helper output directly let unrelated examples leak into the Stage 1 guards. Projecting only the Stage 1 seam preserves one backend-owned source of truth while keeping the stability meaning aligned with the original provider-agnostic Stage 1 contract.

### 2026-05-17: App dev-display tooling moves behind a dedicated frontend seam

**By:** Switch
**What:** Extract the dev-only display tooling from `frontend/src/app/App.tsx` into `frontend/src/app/devDisplayTools.tsx`. Keep the shared App shell responsible for catalog load, backend sync, selected-character state, and avatar runtime orchestration, but move the dev display override options, display debug panels, punch-comparison formatting, and punch snapshot polling behind one dedicated module and hook.
**Why:** The external review correctly identified `App.tsx` as a frontend monolith risk. The dev-only display tooling was already a self-contained slice with no backend ownership changes, so extracting it now reduces App surface area, removes now-orphaned in-file helper branches, and gives future display-debug work a stable place to land without widening the runtime or backend seams.

### 2026-05-17: Session transport routes extract first from backend router

**By:** Tank
**What:** Treat the session transport seam as the first safe router cleanup slice. Extract `/session/animation`, `/session/lifecycle-state`, and `/session/speech-lifecycle` route registration plus SSE frame construction into `backend/app/api/session_routes.py`, while leaving `backend/app/api/router.py` as the backend composition entrypoint and preserving existing router-local helper names through compatibility wrappers.
**Why:** This is the most transport-heavy part of the backend monolith, it already has focused route coverage, and it reduces future provider and lifecycle changes in `router.py` without widening the public HTTP or SSE contracts.

### 2026-05-17: SSE live routes flush an immediate keepalive frame

**By:** Tank
**What:** Update the backend-owned `/session/animation` and `/session/speech-lifecycle` SSE routes so they emit an immediate SSE comment frame before waiting for new events, and cover that handshake in the backend route test slice.
**Why:** The backend already supported the live routes, but when no new event was pending the stream could sit idle long enough that the browser never completed the EventSource open handshake. A comment-frame keepalive preserves the existing payload and cursor contracts while making the live transport observable immediately.

### 2026-05-17: Idle official-route polish stays in shoulder and upper-arm retain weights

**By:** Switch
**What:** For the current official idle polish pass, keep the existing `official_idle_stability` route and the grounded baseline behavior intact, and make only one local adjustment in `frontend/src/avatar/runtime/officialPunchClipPlayback.ts`: reduce the idle-only local-rotation retain weights for `LeftShoulder`, `RightShoulder`, `LeftUpperArm`, and `RightUpperArm` slightly while leaving chest, upper chest, lower-arm, and hand retain weights unchanged.
**Why:** The current official-route idle already feels stable and grounded, so the smallest falsifiable next step is to soften shoulder and upper-arm carry a little more without flattening torso support or reopening playback routing, source clips, or broader runtime behavior.

### 2026-05-17: Final live display verification found backend bridge still offline

**By:** Mouse
**What:** Live verification on `http://127.0.0.1:5173/display/` showed that the display surface now mounts the VRM and profile switcher correctly, but it is not consuming backend-backed session state. The shell reports `Backend snapshot: Unavailable`, `Backend session: Session unavailable`, `Event count: 0`, `Playback bridge: idle`, and `Backend bridge offline; shell is using the local manifest catalog only.` Direct probes to `http://127.0.0.1:8000/health` and `http://127.0.0.1:5173/api/characters` timed out during this pass, matching the browser-visible offline state. Front and side profile captures still read like a neutral or T-pose with arms extended rather than a materially improved relaxed idle.
**Why:** The current blocker is no longer avatar mount safety or profile framing. The honest next fix target is the live backend or session bridge, because idle-pose quality cannot be meaningfully signed off while the display is falling back to local manifest-only state and still presenting a T-pose-like result.

### 2026-05-15: Punch turn-away is not a global Z-axis reversal

**By:** Switch
**What:** Falsify the frontend-wide `Unity or UniVRM Z is reversed in three.js` hypothesis for the current `gesture.punch.once` path. The existing punch comparison runtime check shows browser-applied key-bone local quaternions matching Unity comparison metadata almost exactly, including `z`. The actual local defect was motion-profile handling in the frontend runtime: `gesture.punch.once` ships a zeroed motion profile intended to disable extra procedural root motion, but the loader previously rejected `speed_multiplier: 0` and fell back to the default idle profile. Fix the runtime by preserving zeroed motion profiles from generated sidecars and decoupling clip playback time from procedural root-motion time so one-shot clips still advance while `yaw`, `bob`, `lean`, and `nod` remain disabled when authored as zero.
**Why:** The punch sidecar already contains correct sampled bone-local comparison rotations, so another Z-sign remap would have been guesswork. Preserving the zeroed authored motion profile removes the remaining nearby path that could rotate the whole avatar away during punch playback without disturbing the verified local bone rotations.

### 2026-05-15: Punch turn-away diagnosis favors missing root or world transform handling over three-side Z inversion

**By:** Mouse
**What:** Treat the current `gesture.punch.once` turn-away symptom as most likely a root or world-orientation issue, not a global Z-axis inversion in frontend local-bone playback. The narrow executable check `frontend-punch-debug-runtime` reports browser key-bone rotations in `vrm_rendered_raw_bone_local_rotation` space and shows chest, shoulders, upper arms, lower arms, and hands matching Unity comparison metadata to float-noise tolerance at the final punch frame. The generated punch runtime asset also carries non-trivial root transform channels (`RootQ.*`, `RootT.*`), but authored frontend source did not reference those channel names.
**Why:** A true frontend Z-sign inversion should have produced signed disagreement in the browser-versus-Unity local-bone comparison for the punch bones. Instead, the local bone rotations aligned while the remaining symptom was still the avatar turning away later in the punch, which is more consistent with missing or mismapped root or world orientation than with another per-bone axis sign problem.

### 2026-05-15: Live display punch still turns the avatar away

**By:** Mouse
**What:** Verify the live `http://127.0.0.1:5174/display/` surface with the dev-only `Force gesture.punch.once` override after reloading the page into a healthy `vrm ready` state. The avatar still turns away from the camera during the one-shot and remains back-facing at the sampled end frame, while the dev punch comparison API reports a final-frame browser-versus-Unity match for the tracked chest, upper chest, shoulders, upper arms, lower arms, and hands.
**Why:** The narrowest honest check was the real display surface plus the existing debug API. That combination shows the problem stayed visible in live presentation even when the exported end-frame local bone rotations matched, so the remaining defect was not explained by the earlier general Z-axis inversion theory and was not cleared by the motion-profile and one-shot timing changes alone.

### 2026-05-14T14:37:00+01:00: Live overlay motion architecture boundary

**By:** Trinity
**What:** Treat live procedural motion as a first-class direction for the VRM runtime, but keep it as a bounded overlay system layered on top of semantic base animation playback rather than replacing the animation contract with raw tracking streams or ad hoc per-bone writes. Split motion into three lanes: base clips resolved by semantic animation ids, procedural or reactive overlay channels that apply normalized additive weights to approved expression or bone groups, and direct tracking input normalized into a high-level face-state or pose-state contract before it reaches avatar playback. Keep imported JSON motion assets and generated DSL sidecars in the base-clip lane, and keep camera or sensor input out of the backend's raw transport surface.
**Why:** The repo already proves a narrow local procedural layer through runtime viseme reactions driven by backend timing metadata, while docs and workstreams prefer semantic ids, backend-owned lifecycle data, optional vision, and normalized face-state over raw device or clip-path coupling. A layered motion architecture preserves interchangeability across characters, keeps live tracking optional, and lets JSON-conversion work continue without forcing every future motion source into the same schema.

### 2026-05-14T14:36:00+01:00: User directive

**By:** Jason Fletcher (via Copilot)
**What:** Keep raw animation source files in git for now until the team is ready to discard them, while continuing to develop the JSON conversion path and exploring live animation overlays from runtime data input. This supersedes the earlier local-import-only raw-asset policy until the team revisits raw-asset storage.
**Why:** User request - captured for team memory.

### 2026-05-14T14:18:00+01:00: Unity animation staging scope and raw asset policy

**By:** Trinity
**What:** Correct the pipeline in the smallest useful slice: keep the Unity exporter focused on staged clip provenance and clip-level metadata, then normalize that JSON into DSL entries and semantic registration before widening the exporter surface. Do not add curve or bone movement payload export yet. Treat `assets/animations/raw/` as a machine-local import area for large Unity source assets and keep those raw `.anim` files out of git. Track the exporter script, JSON sidecars or DSL definitions needed for semantic registration, approved shared-library assets, approved character overrides, and retargeting metadata in git.
**Why:** The current runtime and contract surfaces consume semantic ids, playback intent, and source classification rather than per-bone motion data. Exporting curve payloads now would create a new unconsumed schema surface before the semantic path is proven end to end. The immediate gap is not motion fidelity; it is the missing normalization step from staged Unity metadata into reviewed semantic inventory.

### 2026-05-14T14:15:00+01:00: User directive

**By:** Jason Fletcher (via Copilot)
**What:** Treat `assets/animations/raw/` as a local import location for large raw animation files that should not be stored in git; keep generated JSON and DSL animation artifacts tracked in the repo instead.
**Why:** User request - captured for team memory.

### 2026-05-14T14:00:00+01:00: Default idle clip ingestion boundary

**By:** Trinity
**What:** Treat `assets/animations/raw/idle.anim` as source provenance only until review promotion. If adopted as the baseline shared idle clip, promote an approved copy into `assets/animations/library/shared/` and bind it to the semantic id `idle.default`. Add one minimal DSL or JSON sidecar under `assets/animations/dsl/` to declare that semantic binding plus default playback intent and fallback metadata. Do not add a general conversion helper yet; one raw Unity clip is not enough inventory to justify a pipeline surface.
**Why:** The animation contract requires shared clips to be addressed by semantic id rather than raw path, while the repo currently has no DSL inventory. A single explicit sidecar keeps the semantic binding inspectable without widening the system into an unnecessary conversion workflow.

### 2026-05-14T13:55:00+01:00: User directive

**By:** Jason Fletcher (via Copilot)
**What:** Treat the newly dropped shared animation clip as the default idle animation for the character unless another instruction overrides it.
**Why:** User request - captured for team memory.

### 2026-05-15: Frontend root playback must convert Unity root space before applying authored punch transforms

**By:** Switch
**What:** For the current `gesture.punch.once` investigation, treat authored root transform channels in the generated runtime sidecar as authoritative at the frontend root-update seam in `frontend/src/avatar/runtime/avatarRuntime.ts`. Sample the clip's `rootq_*` and `roott_*` channels relative to the first frame, convert that translation and quaternion data from Unity root space into the frontend avatar space, and compose the result onto the avatar root during base animation playback instead of leaving world-facing to baseline root state plus procedural offsets.
**Why:** Mouse and Switch both verified that the live turn-away symptom was not explained by a general Unity or UniVRM local-bone `z` reversal: the tracked punch chest, shoulders, upper arms, lower arms, and hands already matched Unity comparison data while the live one-shot still turned away later. The controlling remaining defect was ignored authored root/world transform data, so the durable fix belongs in root playback rather than in another per-bone axis remap.

### 2026-05-15: Machine-transition checkpoint uses an additive bone-space exporter experiment

**By:** Scribe
**What:** Checkpoint the repo for Jason's machine transition with a concrete next-session plan in `scripts/animation_tools/unity/RawAnimBatchExporter.cs`: keep the existing muscle-space export path unchanged, add an additive exporter experiment that samples humanoid bone-local transforms from `Animator.GetBoneTransform(HumanBodyBones)` for a minimal comparison set, and scope the first regeneration to `gesture.punch.once` only. Emit explicit comparison metadata between the current muscle-space channels and sampled humanoid-bone-space rotations for upper arms, lower arms, hands, upper legs, lower legs, and feet. Regenerate one clip only, compare its final frame against the dev-only browser override surface before widening to `idle.default`, and if the bone-space result is better, treat the next step as extending that exporter approach to all shared clips so the frontend can simplify its remaining arm-space guesswork. Keep backend animation contracts semantic-only throughout, and keep `.tmp-unity-temp` cache noise out of git commits.
**Why:** The current punch mismatch has been narrowed far enough that another runtime-only axis remap would be guesswork. The honest next discriminator is side-by-side exporter evidence from sampled humanoid bone-local transforms, and Jason needs that follow-up captured in persistent continuity before moving machines.

### 2026-05-15: User-provided punch reference frame becomes the target pose

**By:** Jason Fletcher (via Copilot)
**What:** Use Jason's screenshot of the intended final punch frame as the target pose for the current live `gesture.punch.once` tuning passes on the display surface. Preserve the landed lower-leg correction, lower-arm quaternion hint path, and existing finger behavior while iterating only in frontend runtime weighting.
**Why:** The remaining mismatch had narrowed from missing motion delivery to endpoint fidelity against the intended Unity pose, so a concrete reference frame became the cleanest falsifiable target for the next browser-side tuning passes.

### 2026-05-15: Punch reference-pose alignment stays clip-local in frontend runtime weighting

**By:** Switch
**What:** Use the provided final-frame reference to tune only `gesture.punch.once` in `frontend/src/avatar/runtime/humanoidChannelPlayback.ts`. Keep the lower-leg fix, lower-arm quaternion hints, and existing finger behavior unchanged, reduce shoulder `front_back` carry further, slightly increase hand `down_up` and `in_out`, and strengthen punch-specific arm `front_back` carry so the endpoint reads less shoulder-led and the wrist and hand land closer to the target pose.
**Why:** Live `/display/` validation on the 4175 surface showed the remaining punch mismatch was concentrated in shoulder-led carry and hand alignment, not in lower-body stability or broken hand delivery. A clip-specific runtime pass was the smallest honest way to move the endpoint toward the supplied reference without regressing idle or reopening exporter work.

### 2026-05-15: Remaining punch guard-height gap stays in clip-specific upper-arm carry

**By:** Switch
**What:** Run a second narrow `gesture.punch.once` pass in `frontend/src/avatar/runtime/humanoidChannelPlayback.ts` focused only on the remaining low guard height. Conclude that the residual mismatch is punch-specific upper-arm carry rather than lower-arm quaternion interpretation, then adjust only the punch overrides for `left/right.arm.down_up` and `left/right.arm.front_back` so elbows and forearms travel farther forward and slightly higher while leaving shoulder weights, lower-arm quaternion hints, wrists, hands, legs, and fingers unchanged.
**Why:** After the reference-frame pass, live replay still showed a smaller but visible low-guard mismatch while lower-arm quaternion delivery remained active. The narrowest honest follow-up was punch-only upper-arm carry tuning instead of reopening quaternion interpretation or disturbing the already-stable lower-body and shoulder-flare correction.

### 2026-05-15: Conservative lower-body bindings close the current playback omission

**By:** Switch
**What:** Keep the backend semantic-only `/session/animation` contract, the existing exporter output path, and the dev-only display override unchanged, but treat the current browser defect as lower-body binding coverage in `frontend/src/avatar/runtime/humanoidChannelPlayback.ts`. The generated artifacts for `idle.default` and `gesture.punch.once` already contain real upper-leg, lower-leg, foot, and toe channels, so add conservative humanoid bindings for `left/right.upper.leg.{front_back,in_out,twist.in_out}`, `left/right.lower.leg.{stretch,twist.in_out}`, `left/right.foot.{up_down,twist.in_out}`, and `left/right.toes.up_down}`. Keep `left/right.lower.leg.stretch` interpreted as a delta from `1.0` so the current exporter output is read correctly. Live runtime verification now shows `idle.default` and `gesture.punch.once` targeting upper legs, lower legs, feet, and toes, while the existing arm, wrist, lower-arm, and hand delivery paths remain present.
**Why:** The exporter audit already ruled out a global limb-drop explanation. `gesture.punch.once` carries non-trivial forearm, hand, upper-leg, lower-leg, foot, elbow-flex, and lower-arm quaternion signal, and even `idle.default` still contains limb channels, though its forearm and elbow signal is effectively flat. That makes the previous lower-body omission in the frontend runtime the honest local defect, and leaves the remaining shoulder-heavy arm behavior narrowed to runtime weighting plus weak idle forearm signal rather than a missing end-to-end limb pipeline.

### 2026-05-15: Humanoid export audit rules out a global exporter-drop explanation

**By:** Link
**What:** Record Jason Fletcher's VRM limb-animation issue summary as the current exporter-audit frame: possible causes included wrong skeleton sampling, name mismatches, missing limb tracks, runtime dropping limb bones, or missing source curves. Audit `scripts/animation_tools/unity/RawAnimBatchExporter.cs` and confirm that the current exporter is not sampling VRM-retargeted avatar bones and is not reading per-bone FBX hierarchy transforms; it exports Unity clip bindings plus derived hints. The generated artifacts already retain real limb channels. `gesture.punch.once` disproves a global exporter-drop hypothesis because it carries substantial forearm, hand, upper-leg, lower-leg, foot, elbow-flex, and lower-arm quaternion signal, while `idle.default` still contains the limb channels but with forearm and elbow signal that is effectively flat enough to be a weak visual reference for arm bend. No exporter code change was made in this slice.
**Why:** The cheapest falsifiable exporter check was whether the checked-in generated artifacts already carried non-trivial limb signal. They do. Once the artifacts show real limb motion despite the current exporter staying clip-binding-based and non-retargeted, the stronger current suspect becomes runtime coverage or weighting, not a missing exporter limb path.

### 2026-05-15: User approved the direct browser A/B path

**By:** Jason Fletcher (via Copilot)
**What:** Approve proceeding with the direct browser A/B validation path on the 4174 display surface by adding a dev-only, frontend-local animation override panel in `frontend/src/app/App.tsx` and `frontend/src/styles.css`. The panel should offer `Backend live`, `Force idle.default`, and `Force gesture.punch.once`, and clicking `Force gesture.punch.once` again should replay the punch from the start. Keep the override strictly frontend-only and dev-only so backend animation contracts and lifecycle routing remain unchanged.
**Why:** `gesture.punch.once` already resolves locally in the shared runtime catalog, so the next discriminating check for shoulder, elbow, lower-arm, and wrist delivery is direct browser A/B playback on the existing display surface rather than more export or backend changes.

### 2026-05-15: Dev-only display animation override panel enables direct punch A/B playback

**By:** Switch
**What:** Add a dev-only animation override panel to the display surface in `frontend/src/app/App.tsx` and `frontend/src/styles.css` with `Backend live`, `Force idle.default`, and `Force gesture.punch.once`. Keep the override frontend-only and dev-only, allow `gesture.punch.once` to be replayed by clicking it again, and update the display debug surface so lower-arm quaternion bindings remain visible during playback. Live validation on the 4174 display surface confirmed switching between `idle.default` and `gesture.punch.once` works, and confirmed `gesture.punch.once` activates wrist channels plus left and right lower-arm quaternion bindings with sampled rotations. No additional arm-chain fix was made in this slice because the forced punch pass did not expose one clear local runtime defect beyond the already-known weighting concerns.
**Why:** A minimal display-surface override is the cheapest honest way to A/B the existing backend-driven path against a forced shared reference clip. It proves whether current wrist and lower-arm delivery are already present without widening backend contracts, and it avoids inventing another frontend runtime fix when the forced punch pass does not isolate a single new local defect.

### 2026-05-15: Idle regeneration stability keeps the standard export workflow

**By:** Link
**What:** Jason regenerated `assets/animations/raw/idle.anim` with extra stability-related export settings, then Link re-ran the standard Unity raw-animation export workflow to refresh the generated `idle.default` DSL and runtime artifacts in place without modifying `assets/animations/dsl/shared/animations.json`. When Unity temp-project creation fails in the default user temp path with the package-cache `EPERM` rename error, keep the same workflow and only redirect `TEMP` and `TMP` to a repo-local writable directory for that run.
**Why:** The refreshed `idle.default` artifacts came through the existing workflow and shared animation registration already remained correct. The operational issue is export stability under the temp-project failure mode, not a need to change the export contract or rewrite shared animation registration.

### 2026-05-15: Arm-chain redistribution stays in frontend humanoid playback

**By:** Switch
**What:** Compare the regenerated `idle.default` and `gesture.punch.once` artifacts against current frontend arm binding behavior, treat `gesture.punch.once` as a usable arm and hand reference clip even though its raw-source provenance string is truncated because the source filename contained spaces during export, and keep the correction local to `frontend/src/avatar/runtime/humanoidChannelPlayback.ts` by reducing `left/right.shoulder.front_back` influence and increasing `left/right.arm.twist.in_out` influence while preserving the existing lower-arm quaternion hint path, elbow hint usage, wrist bindings, and finger stretch and spread behavior. Also add `gesture.punch.once` to `frontend/src/avatar/runtime/defaultBaseAnimation.ts` so the shared payload can resolve locally for reference validation without changing backend animation contracts. The frontend build passed after the change.
**Why:** The regenerated `idle.default` and `gesture.punch.once` payloads already export the needed arm-chain signal end to end. The remaining mismatch was runtime weighting that over-favored shoulder hinging and underused upper-arm roll, not missing export, backend transport, or local payload resolution. The current blocker for direct punch A/B playback is UI control surface, because the clip now resolves in the frontend catalog but the current UI still has no manual animation picker.

### 2026-05-15: User approved the next hands step

**By:** Jason Fletcher (via Copilot)
**What:** Approve the next hands slice after conservative finger stretch wiring: verify that the current generated `idle.default`, `listen.loop`, and `speak.loop` runtime payloads carry non-trivial finger spread channels for both hands, then bind those exported spread channels in `frontend/src/avatar/runtime/humanoidChannelPlayback.ts` onto VRM finger-root bones only. Keep the mapping conservative by using thumb metacarpals for thumb spread, proximal finger bones for index, middle, ring, and little spread, and preserving the existing torso, upper-arm, elbow, wrist, lower-arm, and finger stretch behavior.
**Why:** Basic hand connectivity is already present in the current web viewer slice, so the next honest hand step is to let exported spread data reach the avatar without widening into transform hints or unrelated body regions.

### 2026-05-15: Conservative finger spread binding on proximal VRM finger bones

**By:** Switch
**What:** Verified that the generated `idle.default`, `listen.loop`, and `speak.loop` runtime payloads already contain finite, non-trivial spread samples for all five digits on both hands, then bound the exported spread channels in `frontend/src/avatar/runtime/humanoidChannelPlayback.ts` onto VRM finger-root bones only: thumb spread to the thumb metacarpals and index, middle, ring, and little spread to the proximal finger bones. The mapping stayed conservative, preserved all existing torso, upper-arm, elbow, wrist, lower-arm, and finger stretch behavior, the frontend build passed after the change, and live `/display/` verification reported 10 active spread bindings at runtime.
**Why:** Proximal-only spread binding is the smallest honest step that reduces hand stiffness and proves exported spread data is surviving end to end without reopening backend transport, widening the hand rig interpretation, or disturbing already-correct arm and hand playback.

### 2026-05-15: Full humanoid export-to-binding audit requested

**By:** Jason Fletcher (via Copilot)
**What:** Chose option 1 and requested a full end-to-end audit of any remaining missing humanoid bones and connections between the model and the exported animation files before widening behavior further.
**Why:** The current hand and lower-arm work needed a full proof of where motion was being lost so follow-up fixes could stay honest about whether the gap lived in Unity export, backend transport, frontend payload hydration, or runtime bone binding.

### 2026-05-15: Full humanoid export-to-binding audit and conservative finger stretch binding

**By:** Switch
**What:** Record the verified end-to-end result for the current web viewer path: generated runtime sidecars already carry broader humanoid data than the browser currently consumes, including finger stretch and spread, upper-arm twist, lower-body and toe channels, jaw and eye channels, root hints, and hand and foot transform hints. The backend remains semantic-only and resolves animation ids such as `idle.default`, `listen.loop`, and `speak.loop` without transporting raw per-bone channel arrays, while the frontend payload path already preserves exported channels and sampling data. The real bottleneck was runtime binding coverage in `frontend/src/avatar/runtime/humanoidChannelPlayback.ts`, so Switch added conservative finger stretch bindings for both hands across thumb, index, middle, ring, and little finger bones while preserving the existing torso, upper-arm, elbow, wrist, and lower-arm behavior. Live verification reported the new bound finger channels active at runtime.
**Why:** The audit ruled out export loss, backend transport loss, and frontend payload filtering. Finger `*.stretched` channels are already present and map cleanly onto VRM humanoid finger bones, while binding finger spread, hand translation or quaternion hints, upper-arm twist, lower body, jaw, eye, or root channels in this pass would widen behavior beyond the current arms-and-hands task.

### 2026-05-15: Lower-arm and hand audit follow-up

**By:** Switch
**What:** Record the verified end-to-end arm-hand result for the current web viewer path: generated shared runtime sidecars already contain lower-arm quaternion hints plus wrist and finger channels, the backend transports only semantic animation ids such as `idle.default`, `listen.loop`, and `speak.loop`, and the real delivery defect was the missing wrist binding in `frontend/src/avatar/runtime/humanoidChannelPlayback.ts`. Bind `left/right.hand.down_up` and `left/right.hand.in_out` onto `leftHand` and `rightHand` so exported wrist motion reaches the avatar while leaving finger-bone wiring and any further lower-arm fidelity polish as follow-up work.
**Why:** The audit ruled out export loss and backend transport loss. The smallest honest fix was in the frontend runtime binding layer, where wrist channels already present in the local generated runtime payload were not mapped to VRM hand bones at all.

### 2026-05-15: User directive favors quaternion-hint lower-arm fidelity

**By:** Jason Fletcher (via Copilot)
**What:** Choose the longer-term lower-arm transform fidelity path for the current web viewer slice: keep the browser runtime on exporter-composed `left/right.lower_arm.rotation.{x,y,z,w}` quaternion hints when available rather than adding more frontend-only lower-arm heuristics, and leave true avatar-backed bone-local export as a later fidelity step.
**Why:** Switch confirmed the raw Unity humanoid clip still does not expose direct lower-arm bone transform curves, so quaternion hints are the smallest honest next step that improves visible lower-arm motion now without overstating the fidelity of the exported source data.

### 2026-05-15: Exporter-derived lower-arm rotation hint

**By:** Switch
**What:** Derive `left.lower_arm.rotation.{x,y,z,w}` and `right.lower_arm.rotation.{x,y,z,w}` quaternion hint channels in the Unity batch exporter from the existing elbow-flex plus forearm-twist source pair, refresh the shared `idle.default`, `listen.loop`, and `speak.loop` runtime payloads through `C:\Program Files\Unity\Hub\Editor\6000.4.7f1\Editor\Unity.exe`, and make the web humanoid runtime prefer those lower-arm rotation hints over per-axis lower-arm bindings when present.
**Why:** The current raw Unity humanoid clip does not carry direct lower-arm bone transform curves, so fully faithful bone-local playback still requires an avatar-backed export path. In the current narrow slice, combining the available lower-arm muscle signals into explicit quaternion hints moves lower-arm composition into the exporter, preserves the visible elbow and twist improvements, and gives the web path a cleaner seam than continuing to accumulate browser-only lower-arm heuristics.

### 2026-05-15: User directive prefers exporter-side elbow improvement

**By:** Jason Fletcher (via Copilot)
**What:** Prefer the exporter-side improvement path for better lower-arm and elbow shaping in the current web viewer instead of adding more frontend-only elbow heuristics.
**Why:** The source clip already carries usable lower-arm source data, so improving the Unity batch exporter keeps the bend signal data-driven end to end and avoids inventing browser-only motion.

### 2026-05-15: Exporter-derived elbow flex from forearm stretch

**By:** Switch
**What:** Derive explicit `left.elbow.flex` and `right.elbow.flex` channels in the Unity batch exporter from usable `left/right.forearm.stretch` source samples, refresh the generated `idle.default`, `listen.loop`, and `speak.loop` runtime payloads through `C:\Program Files\Unity\Hub\Editor\6000.4.7f1\Editor\Unity.exe`, and bind those elbow-flex channels onto `leftLowerArm` and `rightLowerArm` in the web humanoid playback path while keeping the prior shoulder and forearm twist polish.
**Why:** The current source clip does carry lower-arm source data, but it previously reached the web runtime only as raw forearm stretch floats that did not drive visible elbow shaping. Deriving explicit exporter hints and replaying them through the existing runtime keeps the fix local to exporter plus playback, proves the lower-arm signal survives transport, and leaves the remaining risk on animation fidelity rather than delivery.

### 2026-05-15: User directive keeps backend-owned animation control

**By:** Jason Fletcher (via Copilot)
**What:** Keep Unity secondary for now, continue prioritizing the current web viewer, and prefer backend-owned animation control so default idle and future transitions originate from the backend rather than from per-model frontend defaults.
**Why:** User wants the backend to stay in full control of animation sequencing and transitions so movement can flow cleanly from one semantic animation to the next.

### 2026-05-15: VRM normalized pose playback path

**By:** Switch
**What:** Apply generated humanoid channel playback through `VRMHumanoid.setNormalizedPose()` using the captured normalized pose as the baseline, instead of writing sampled rotations directly onto normalized bone node quaternions.
**Why:** The installed `@pixiv/three-vrm-core` API treats normalized humanoid posing as a pose-object operation relative to the normalized rest pose. Direct quaternion mutation on normalized bone nodes can leave the rendered avatar unchanged even when exported channel data and bindings are present, while `setNormalizedPose()` flows through the supported update path that propagates the pose to the rendered rig.

### 2026-05-15: Relative pose quaternions for normalized playback

**By:** Switch
**What:** Keep `humanoidChannelPlayback` pose-object rotations as per-bone quaternions relative to the normalized rest pose when calling `VRMHumanoid.setNormalizedPose()`.
**Why:** The installed `@pixiv/three-vrm-core` implementation applies each `poseObject.rotation` by loading that quaternion and then multiplying the normalized rest-pose rotation internally. Supplying a baseline-multiplied quaternion in the pose object effectively applies the baseline twice and leaves channel playback aligned to the wrong space.

### 2026-05-15: Generated humanoid channel playback stays data-driven

**By:** Switch
**What:** Use the generated runtime payload as the current baseline playback source by preserving `sampling` plus `channels` in the frontend runtime payload and applying a supported, data-driven subset of exported Unity humanoid muscle channels to normalized VRM humanoid bones each frame.
**Why:** The exported assets already carry real torso, head, shoulder, and arm motion, while the frontend baseline path was only consuming procedural motion-profile offsets. Applying a bounded subset now gets visible authored pose changes through to the viewer without widening into the future layered overlay system.

### 2026-05-15: Arm hang calibration stays local to humanoid playback

**By:** Switch
**What:** Keep the current browser humanoid playback path in `frontend/src/avatar/runtime/humanoidChannelPlayback.ts` and apply the smallest arm-only calibration there first: reduce shoulder `down_up` lift and increase upper-arm `down_up` drop so the exported idle pose settles closer to a natural side hang without changing torso or head mappings.
**Why:** The live viewer and debug snapshot already show the generated humanoid muscle payload is broadly driving the body correctly, but the idle arms still read as raised and too straight. The cheapest falsifiable correction is local scale tuning on the shoulder and upper-arm `down_up` bindings before reopening axis remapping or exporter redesign.

### 2026-05-15: Upper-arm `down_up` sign correction

**By:** Switch
**What:** Flip only the `left.arm.down_up` and `right.arm.down_up` scale signs in `frontend/src/avatar/runtime/humanoidChannelPlayback.ts` while leaving shoulder, torso, and head bindings unchanged.
**Why:** The first arm-only calibration pass reduced shoulder lift and increased upper-arm drop, but live browser verification still showed both arms pushed upward. The observed raised-arm result remained most consistent with the upper-arm `z` rotation sign being inverted for the current VRM normalized pose orientation, so the next committed correction stayed limited to those upper-arm `down_up` signs.

### 2026-05-15: Refresh arm regression traced to upper-arm input offset

**By:** Switch
**What:** Remove the remaining `inputOffset: 1` from `left.arm.down_up` and `right.arm.down_up` in `frontend/src/avatar/runtime/humanoidChannelPlayback.ts`, soften shoulder `down_up` lift slightly, and add a minimal lower-arm twist binding driven by the generated forearm twist channels.
**Why:** Live refresh verification reproduced the raised-arm regression even with the sign-flip edit still present in the loaded debug snapshot, which ruled out a lost code change. The generated idle payload authors upper-arm `down_up` around negative values, so the leftover `+1` input offset re-lifted the idle pose after refresh. The same payload does not expose a useful elbow-flex channel for this clip, making subtle forearm twist the smallest viable elbow-area polish while the remaining higher-fidelity arm shaping stays an exporter-or-payload question.

### 2026-05-15: Session animation live delivery reuses the snapshot payload

**By:** Tank
**What:** Keep `GET /session/animation` authoritative for both polling and live delivery. Standard JSON returns the existing `SessionAnimationSnapshot`, while `Accept: text/event-stream` streams that same snapshot payload over SSE with cursor ids sourced from a scoped in-memory animation update buffer populated by backend lifecycle changes.
**Why:** This preserves one engine-neutral public animation payload shape on the current route instead of widening into a second transport-specific contract or a larger animation event-store slice.

### 2026-05-15: Generated runtime payloads carry motion-profile metadata

**By:** Link
**What:** Keep semantic loop distinction on the existing web runtime payload path by adding optional `motion_profile` metadata to generated runtime JSON sidecars and resolving it through one runtime helper with a backwards-safe fallback.
**Why:** This removes command-id-specific animation branches from the viewer runtime, keeps `listen` and `speak` differentiation data-driven, and supports direct consumption of generated runtime payload data without widening the delivery seam.

### 2026-05-15: Session animation live-delivery stability guard

**By:** Mouse
**What:** Add a dedicated `backend-session-animation-live-delivery` stability scenario that snapshots the real `/session/animation` live-delivery seam by reusing the existing backend route test helper rather than introducing transport-specific test hooks.
**Why:** The backend already owns route tests for `/session/animation` snapshot delivery, SSE progression, cursor resume, and invalid-cursor rejection, so the missing regression seam was a checked-in baseline over that real route behavior.

### 2026-05-15: Frontend consumes `/session/animation` SSE payloads directly

**By:** Switch
**What:** Treat `/session/animation` SSE frames as authoritative `SessionAnimationSnapshot` payloads in the frontend live consumer instead of using them only as a signal to refetch the snapshot route.
**Why:** The backend already serializes the full snapshot into the SSE `data:` field on the same route, so parsing that payload directly removes an unnecessary round trip while preserving the existing normalization path and teardown behavior.

### 2026-05-14T08:57:41.6820932+01:00: User directive

**By:** Jason Fletcher (via Copilot)
**What:** Prefer UniVRM 1.0 as the standard avatar/model system for rigging, compatibility, and sourcing interchangeable character models.
**Why:** User wants the project designed around a standard model pipeline that supports existing community models and new artist-produced assets.

### 2026-05-14T08:57:41.6820932+01:00: Initial architecture planning baseline

**By:** Trinity
**What:** Established UniVRM 1.0 as the baseline character package standard, with manifest-driven swap compatibility, shared animation libraries, and per-character overrides isolated to asset metadata rather than application branching. Also fixed the initial repo split around `frontend/`, `backend/`, `assets/`, `models/`, `scripts/`, `tests/`, and `docs/` so later work can proceed in thin vertical slices.
**Why:** The project's core risk is interface drift between avatar assets, frontend runtime, backend orchestration, and local providers. Locking the character contract and repo boundaries early reduces rework and lets frontend, backend, asset, and test work advance in parallel.

### 2026-05-14T08:57:41.6820932+01:00: 2026 technical blueprint directive

**By:** Jason Fletcher (via Copilot)
**What:** Add the 2026 technical blueprint to the squad context, including the preferred model stack (GPT-SoVITS, Faster-Whisper, LLaMA 3.1 8B Q4, MediaPipe plus CLIP, SQLite plus ChromaDB), the full voice and vision workflows, and the refined development stages.
**Why:** User wants the project blueprint and team context aligned with a more concrete target architecture and model selection baseline.

### 2026-05-14T08:57:41.6820932+01:00: 2026 blueprint baseline and stage reorder

**By:** Trinity
**What:** Adopt GPT-SoVITS latest stable 2026 fork as the default TTS baseline, Faster-Whisper Medium with Small fallback for STT, LLaMA 3.1 8B Q4_K_M as the local LLM baseline, MediaPipe Face Mesh as the realtime tracking baseline, optional CLIP as non-blocking vision enrichment, and SQLite plus ChromaDB or FAISS with `bge-small-en` and `MiniLM-L6-v2` fallback for memory retrieval. Lock the end-to-end workflows as `Mic -> STT -> Memory -> LLM -> TTS -> Avatar` and `Camera -> MediaPipe -> optional CLIP -> backend context -> avatar reactions`, with vision explicitly outside the critical voice path.
**Why:** The older planning docs captured the broad system shape, but they did not pin the refined 2026 local model stack or the explicit delivery sequence needed for the Windows 10/11 and 12 GB NVIDIA target profile.

### 2026-05-14T08:57:41.6820932+01:00: Delivery sequencing clarification

**By:** Trinity
**What:** Re-sequence delivery into Stage 0 contract foundation, then backend skeleton, frontend VRM rendering, STT + TTS integration, local LLM + memory, animation DSL, vision pipeline, character swapping, and optimization + polish. Preserve contract-first review gates even though user-facing character swapping is intentionally hardened later in the build.
**Why:** The explicit stage order reduces integration ambiguity, while the Stage 0 contract gate prevents late-stage character or provider work from reopening frontend-backend seams.

### 2026-05-14T08:57:41.6820932+01:00: Asset intake and generated-animation directive

**By:** Jason Fletcher (via Copilot)
**What:** Support three test VRM character packages with scaffolded manifest metadata when source models lack usable identity fields, and treat AI-authored animation generation plus learned custom animations as a planned capability.
**Why:** User wants immediate asset-drop locations plus a data-driven path to link shared and per-character animations to UniVRM-based models.

### 2026-05-14T08:57:41.6820932+01:00: GitHub publish remote directive

**By:** Jason Fletcher (via Copilot)
**What:** Use `https://github.com/moul4n/NikoF` as the GitHub remote for commits and pushes for this repository.
**Why:** User confirmed the destination repository is empty and ready to receive the current project scaffold.

### 2026-05-14T08:57:41.6820932+01:00: Portable prerequisite acquisition directive

**By:** Jason Fletcher (via Copilot)
**What:** Do not commit local model weights or heavyweight runtime dependencies to GitHub; instead provide bootstrap scripts and documented manual fallback instructions to acquire required prerequisites on a fresh machine. Also keep the project plan, notes, and squad context comprehensive enough that a new PC or developer can resume work cleanly.
**Why:** User wants the repository to stay portable and reproducible while preserving full project continuity across machines and contributors.

### 2026-05-14T08:57:41.6820932+01:00: PowerShell-first stability testing directive

**By:** Jason Fletcher (via Copilot)
**What:** Add a PowerShell-first change and stability testing system, similar in spirit to Pester, so the tester can run regression, change-impact, and input-output stability checks as the project evolves.
**Why:** User wants future changes to be measured against predictable baselines, with tracked input and output behavior rather than ad hoc manual verification.

### 2026-05-14T08:57:41.6820932+01:00: Contract validation scaffold

**By:** Link
**What:** Added a dependency-free PowerShell contract validator for scaffold manifests and local event fixtures, and treated `assets/animations/generated/` as staged content rather than approved shared-library inventory during validation.
**Why:** Phase 0 needs a local contract gate that runs before frontend, backend, VRM import, or provider integrations exist, while still preserving a hard boundary between reviewed shared animations and AI-authored/generated motion.

### 2026-05-14T08:57:41.6820932+01:00: Asset intake documentation anchor points

**By:** Mouse
**What:** Standardized package-root README placeholders for each test character and root-level README placeholders inside the shared, generated, and override animation storage directories so real asset drops and promotion rules are explicit before runtime code lands.
**Why:** The asset tree already existed, but the working contract was too easy to infer incorrectly. Putting the policy at the exact drop locations reduces bad imports, undocumented overrides, and premature promotion of generated motion.

### 2026-05-14T08:57:41.6820932+01:00: PowerShell stability harness baseline policy

**By:** Mouse
**What:** Add a PowerShell-first stability harness under `scripts/testing/` with checked-in JSON baselines in `tests/stability/baselines/`, Git-ignored run artifacts in `tests/stability/artifacts/`, and an explicit `-RefreshBaselines` switch as the only supported way to rewrite expected outputs.
**Why:** The repo already has executable contract and bootstrap seams, so snapshot-based regression checks can start now without adding Pester or other external dependencies.

### 2026-05-14T08:57:41.6820932+01:00: Character package VRM normalization

**By:** Mouse
**What:** Keep each character package's runtime contract fixed at `model.vrm` in the package root. Under the current fallback identity schema, preserve the original imported vendor filename in `metadata/identity.json` as explicit intake provenance in `source_vrm.embedded_identifier` while `source_vrm.file_name` stays aligned to the manifest runtime filename.
**Why:** The manifest and validator contract currently require `source_vrm.file_name` to match `model.vrm`, but intake still needs to retain the original vendor filename for traceability.

### 2026-05-14T08:57:41.6820932+01:00: Initial repository publish target

**By:** Scribe
**What:** Treat `origin` at `https://github.com/moul4n/NikoF.git` and the `main` branch as the canonical first-publish remote and default tracked branch for this repository.
**Why:** The initial scaffold is now published to GitHub and future collaboration should build from the same remote and primary branch instead of reintroducing branch or remote ambiguity.

### 2026-05-14T08:57:41.6820932+01:00: Frontend scaffold stays manifest-first

**By:** Switch
**What:** Frontend placeholder catalog data will only declare character ids and manifest URLs. The catalog loader resolves model, metadata, expression, voice, and animation override URLs from each manifest document, and the avatar shell exposes fixed mount point ids through a small runtime bridge.
**Why:** This keeps Phase 0 and early Phase 1 aligned with the asset contract, avoids hardcoded character file branching in the UI, and lets the real viewer runtime replace the scaffold without changing the selection or loading interfaces.

### 2026-05-14T08:57:41.6820932+01:00: Backend scaffold boundary

**By:** Tank
**What:** Phase 0 backend scaffold uses standard-library dataclasses and service protocols first, with optional FastAPI compatibility in the app shell instead of requiring framework installation up front.
**Why:** This keeps the backend slice dependency-light while preserving stable route, schema, and service seams for later orchestration and provider work.

### 2026-05-14T08:57:41.6820932+01:00: Bootstrap local storage contract

**By:** Tank
**What:** Reserve `NIKOF_LOCAL_ROOT`, `NIKOF_MODELS_ROOT`, `NIKOF_LLM_MODELS_ROOT`, `NIKOF_STT_MODELS_ROOT`, `NIKOF_TTS_MODELS_ROOT`, `NIKOF_EMBEDDINGS_ROOT`, `NIKOF_PROVIDERS_ROOT`, and `NIKOF_CACHE_ROOT` as the canonical local storage contract. Bootstrap may emit machine-local helper files under `.local/bootstrap/`, but heavyweight models and provider payloads still default to `%LOCALAPPDATA%\NikoF`.
**Why:** The docs already require a reproducible fresh-machine flow and Git-ignored local storage roots. Locking one env naming scheme now prevents the backend, bootstrap scripts, and later provider adapters from drifting into incompatible machine setup expectations.

### 2026-05-14T08:57:41.6820932+01:00: Asset packaging and workstream plan

**By:** Trinity
**What:** Fixed the first three avatar intake slots at `assets/characters/test-vrm-01..03/`, with manifest-driven identity scaffolding in `manifest.json` plus `metadata/identity.json`, and separated animation storage into shared library, generated motion, and per-character override roots.
**Why:** The team needs stable asset ids and storage rules before frontend, backend, tests, and asset intake can proceed in parallel without inventing incompatible conventions.

### 2026-05-14T08:57:41.6820932+01:00: Squad execution board

**By:** Trinity
**What:** Added `docs/WORKSTREAMS.md` as the phase-by-phase squad handoff for Trinity, Switch, Tank, Link, and Mouse.
**Why:** The project now has enough contract clarity to start scaffold work immediately, and the board keeps phase ownership explicit.

### 2026-05-14T08:57:41.6820932+01:00: Squad model policy

**By:** Trinity
**What:** Set `claude-haiku-4.5` as the persistent squad default for coordination, logging, and other low-cost routine work, with `claude-sonnet-4.6` pinned for Trinity, Switch, Tank, Link, and Mouse because those roles routinely handle code, test design, integration review, or higher-consequence reasoning. Do not persist Opus-class models in squad config; treat them as explicit, temporary exceptions for rare full-repo review or deep analysis only.
**Why:** This keeps day-to-day work on the best current cost-value mix using latest model families only, while preserving a stronger standard tier for the roles most likely to write code or gate quality. VS Code sessions may not honor per-subagent model overrides, so the intended policy needs to live in squad config and decisions for compatible surfaces and future sessions.

**Reevaluation:** Trinity owns periodic model-fit review and should only change this mapping when repeated reviewer rejections, repeated multi-session quality misses, materially worse latency or cost, or a clearly better latest-family replacement demonstrates a real need.

### 2026-05-14T08:57:41.6820932+01:00: Bootstrap, local storage, and continuity rule

**By:** Trinity
**What:** The repository stores source, contracts, manifests, scripts, and documentation, but not LLM weights, model payloads, provider runtimes, or other heavyweight prerequisites. Bootstrap scripts should acquire prerequisites where licensing and installer behavior allow automation; otherwise the repo must carry explicit manual install fallbacks, expected local storage roots, and validation guidance. Cross-machine continuity is a required deliverable, so checked-in docs plus `.squad/` state must be sufficient for Jason or another developer to resume the project on a fresh Windows machine.
**Why:** The project targets local AI runtimes whose artifacts are too large, machine-specific, or license-constrained to treat as normal source files. Making storage, bootstrap, and continuity explicit now prevents accidental Git bloat and avoids hidden setup knowledge.

### 2026-05-14T08:57:41.6820932+01:00: GPT-5.4 persistent squad model policy

**By:** Trinity
**What:** Set `gpt-5.4-mini` as the persistent squad default for low-cost routine work such as logging, coordination, and other cheap operational tasks, and pin `gpt-5.4` for Trinity, Switch, Tank, Link, and Mouse as the standard core-work model. Keep the broader rule cost-aware and latest-family first, and reserve premium or extreme models for explicit, rare exceptions only. In this environment, the persistent config names exposed to the squad are `gpt-5.4` and `gpt-5.4-mini`, so do not encode literal medium or high SKU labels in squad config.
**Why:** The user wants GPT-5.4 family defaults reflected in persistent squad routing with low routine cost, stronger standard reasoning for the core working roles, and no ambiguity about the actual model identifiers available on this surface.

### 2026-05-14T08:57:41.6820932+01:00: Stage 1 backend contract normalization

**By:** Tank
**What:** Keep the Stage 1 backend surface limited to `GET /health`, `GET /characters`, and `GET` or `PUT /session/active-character`. Character responses expose normalized manifest summaries only, active-character control returns a reusable `session_event` envelope, and scaffold health diagnostics report provider-agnostic storage probes keyed by contract names rather than raw filesystem paths.
**Why:** This keeps raw manifests and machine-local quirks out of route payloads while establishing a transport-ready control contract the frontend and later streaming layer can reuse.

### 2026-05-14T08:57:41.6820932+01:00: Stage 2 default-character VRM bundling

**By:** Switch
**What:** Keep the Stage 2 frontend catalog pinned to the default `test-vrm-01` character for now and satisfy the real-model shell by resolving only the manifest-declared `model.vrm` path through a Vite-imported asset URL.
**Why:** This preserves the manifest-first contract for identity and asset resolution while avoiding premature frontend dependence on backend catalog APIs, repo-root static serving, or multi-character hot-swap behavior before those later slices are unlocked.

### 2026-05-14T08:57:41.6820932+01:00: Stage 1 backend stability normalization

**By:** Mouse
**What:** Stage 1 backend stability snapshots will use the backend-owned `build_api_contract_snapshot()` helper, sandbox `NIKOF_*` local-root environment variables for deterministic health diagnostics, and normalize session-event timestamps to `<generated-at>` before baseline comparison.
**Why:** The locked Stage 1 route payloads now exist in backend code, but raw wall-clock timestamps and machine-local storage roots would cause false diffs unrelated to contract changes.

### 2026-05-14T08:57:41.6820932+01:00: Stage 1 batch contract handoff

**By:** Trinity
**What:** Lock the next Stage 1 batch to four provider-agnostic backend contract surfaces only: `GET /health` expands into a stable diagnostics-lite payload, `GET /characters` stays the manifest-summary list contract, active-character selection remains the only writable session control via `GET` and `PUT /session/active-character`, and normalized session-event payloads are introduced as a backend-owned schema for lifecycle reporting without exposing provider-specific detail. Frontend work remains manifest-first and may load one real default VRM from manifest-derived URLs only, while backend session events, bootstrap/provider remediation detail, live audio streaming, and multi-character UI remain out of scope for this batch. Stability work snapshots only the new health, manifest-summary, and session-selection/session-event contracts and does not baseline animation command behavior, provider diagnostics depth, or any transport intended for later streaming phases.
**Why:** The current scaffold already proves the right seam: the backend router exposes minimal provider-agnostic routes and the frontend catalog resolves runtime asset URLs from manifests only. This batch should deepen that seam without letting Stage 1 broaden into provider integration, transport work, or frontend swap behavior that belongs to later stages.

### 2026-05-14T08:57:41.6820932+01:00: Next batch contract boundary

**By:** Trinity
**What:** Lock the next batch to three narrow seams. Link may define provider-agnostic STT and TTS adapter contracts, baseline profile identifiers, and speech timing metadata only, without invoking Faster-Whisper or GPT-SoVITS yet and without adding live transport events or provider bootstrapping. Tank and Switch may connect the frontend shell to `GET /characters` and `GET` plus `PUT /session/active-character`, but manifest document loading and asset URL resolution stay frontend-local and derived from `character_id` rather than a new backend asset-serving surface. Mouse may extend stability coverage with normalized failure-path and widened-payload checks for Stage 1 backend and bootstrap payloads only; live streaming, deep provider remediation, and runtime-specific failure matrices stay out of scope.
**Why:** The repo already has the right contract seam. Tightening the batch around normalized schemas, current HTTP control routes, and deterministic stability snapshots lets the team advance integration without reopening provider choice, transport design, or asset-serving boundaries too early.

### 2026-05-14T08:57:41.6820932+01:00: Stage 3 speech contract envelope

**By:** Link
**What:** Carry future STT and TTS adapter output in optional normalized `transcription` and `synthesis` objects on the shared session-event contract, and keep timing metadata limited to utterance duration, segment ranges, audio format, and optional phoneme or viseme slots. Publish the baseline profile catalog separately with `stt.faster-whisper.medium-2026`, `stt.faster-whisper.small-2026`, and `tts.gpt-sovits.2026-stable`.
**Why:** This gives later provider adapters a stable contract target without adding provider-specific transport, API routes, or bootstrap behavior in the current slice.

### 2026-05-14T08:57:41.6820932+01:00: Stage 1 frontend-backend character bridge

**By:** Tank
**What:** `GET /characters` returns a catalog envelope with `schema_version`, `active_character_id`, and normalized character summaries, and `GET` plus `PUT /session/active-character` now share one response shape that always includes the current active summary and a normalized `selection` result. Invalid active-character writes return HTTP 400 with `error_code="unknown_character"` while leaving the current active character unchanged.
**Why:** This gives the frontend one stable provider-agnostic contract for summary inventory and active-character control without widening into manifest serving, live transport, or provider diagnostics.

### 2026-05-14T08:57:41.6820932+01:00: Frontend backend-bridge boundary

**By:** Switch
**What:** Keep the frontend manifest catalog authoritative for asset URL resolution and VRM loading, but overlay backend `GET /characters` summaries and `GET` or `PUT /session/active-character` state onto matching local packages by `character_id`. Frontend characters without a local manifest stay unavailable to the runtime even if the backend knows about them.
**Why:** This lets the shell start reading backend-owned summary and session state now without violating the contract lock that keeps manifest loading and asset path resolution frontend-local in this slice.

### 2026-05-14T08:57:41.6820932+01:00: Stage 1 failure baseline scope lock

**By:** Mouse
**What:** Keep the current stability expansion limited to deterministic widened-payload baselines for the backend-owned Stage 1 response envelopes and the generated bootstrap report surface. Include the invalid active-character rejection payload only when it exists in the current backend slice.
**Why:** The backend and bootstrap JSON surfaces are stable enough for no-widening checks, and the invalid selection payload should be tested only from the real backend contract rather than from a tester-invented stub.

### 2026-05-14T08:57:41.6820932+01:00: Stability comparison normalization

**By:** Mouse
**What:** The stability harness now compares JSON scenarios by canonicalized content instead of raw serializer whitespace, and the `bootstrap-prerequisites` snapshot records the declared tooling contract from `bootstrap.targets.json` rather than live tool availability on the local machine.
**Why:** Compare mode should fail on approved contract drift, not on PowerShell JSON formatting differences or transient PATH state such as whether `node` and `npm` happen to be installed on one workstation.

### 2026-05-14: Squad state continuity repair

**By:** Scribe
**What:** Restore the standard append-only squad directories `.squad/log/` and `.squad/orchestration-log/` when they are missing, keep them empty until real session or orchestration entries exist, restore the `.squad/decisions/inbox/` drop-box required for decision writes, and remove accidental tool or patch paste artifacts from agent history files instead of treating them as valid history.
**Why:** The squad conventions and Scribe workflow depend on these paths existing and on history files remaining trustworthy. Restoring the expected structure without fabricating old logs improves continuity for future sessions and prevents malformed content from being read as project memory.

### 2026-05-14: Support-role charter alignment

**By:** Scribe
**What:** Align the support-role charter metadata to the active squad roster by documenting Scribe as the Session Logger and continuity maintainer, and Ralph as the Work Monitor.
**Why:** The roster in `.squad/team.md` already reflects these support roles. Keeping the agent charters consistent with that roster reduces identity drift and prevents future sessions from inheriting inaccurate support-role behavior.

### 2026-05-14: Frontend Stage 1 bridge surface rejection guard

**By:** Mouse
**What:** Add a `frontend-stage1-bridge-surface` scenario to the PowerShell stability suite that snapshots the frontend bridge's declared `/characters` envelope keys, active-character response keys, and rejection-path handoff against the locked backend Stage 1 payload-surface baseline.
**Why:** The backend payload baselines already guard the owned Stage 1 envelope, but the frontend bridge also needs a deterministic seam so catalog-envelope drift or loss of rejection-path alignment fails before UI wiring is treated as done.

### 2026-05-14: Stage 1 frontend rejection rollback uses backend envelope

**By:** Switch
**What:** Keep the Stage 1 active-character `PUT` contract unchanged, but preserve the normalized backend response on rejection so the frontend shell can roll local selection back to `response.active_character.character_id` and surface `selection.message` when the backend rejects a requested character.

### 2026-05-14T10:14:00+01:00: Real control and display entrypoints for the next frontend batch

**By:** Trinity
**What:** Re-scope the next frontend batch to replace the current query-parameter surface split with real `/control` and `/display` entrypoints. Keep `App.tsx` as the only owner of backend sync, active-character confirmation, and live `speech.lifecycle` state, and keep operator or debug affordances out of this batch unless they fit without backend contract changes.
**Why:** The user clarified that the display surface should behave like a directly launchable immersive window with minimal chrome, fullscreen capability, and normal resize behavior. The current local surface toggle proves the ownership boundary, but it does not satisfy that entrypoint requirement.

### 2026-05-14T10:17:00+01:00: Frontend entrypoint split guard prep

**By:** Mouse
**What:** Retarget `frontend-shell-split-surface` to snapshot top-level React entrypoints under `frontend/src/*.tsx` separately from `App.tsx`, and require entrypoints to route through `App` without owning backend sync or `speech.lifecycle` themselves.
**Why:** The real `/control` and `/display` split has not landed yet, so the narrow prep guard should baseline the current blocked one-entrypoint state now and fail future duplicate bridge ownership when Switch adds the new surfaces.
**Why:** The shell was updating local selection optimistically and could drift from backend-confirmed active state after a rejected selection, which breaks the current bridge contract even without widening the API surface.

### 2026-05-14: Frontend Stage 1 rollback assertion matches structured catch path

**By:** Mouse
**What:** Detect rejection rollback in the `frontend-stage1-bridge-surface` stability scenario by matching the structured `ActiveCharacterSyncError` catch path in `App.tsx`, including the intermediate reconciled-character variable and the subsequent `setSelectedCharacterId(...)` call, instead of requiring one inline nested call shape.
**Why:** The frontend still performs the intended rollback to the backend-confirmed active character on rejection, but the earlier assertion only recognized one exact syntax form and produced a false negative baseline.

### 2026-05-14T10:30:00+01:00: Operator command batch scope lock

**By:** Trinity
**What:** Re-scope the next implementation batch around one backend-authoritative operator command seam. The first command batch should stay limited to text-authored flows that fit the current canonical event model: text-question submission that bypasses STT and TTS preview text. Keep active-character selection as the only selection control in scope, and defer model-profile switching plus animation debug triggers such as `wave` until the backend owns dedicated configuration and animation-command envelopes.
**Why:** The current backend already owns canonical session and `speech.lifecycle` envelopes plus a turn-publication seam, but it does not yet own a writable operator-command route. Starting with one backend command path lets the control surface drive the immersive display immediately through canonical state without adding frontend-only wiring or widening unrelated contracts.

### 2026-05-14T10:46:00+01:00: Frontend operator command client ownership guard

**By:** Mouse
**What:** Extract the frontend operator command client from `frontend/src/app/App.tsx` into a control-only component and extend `frontend-shell-split-surface` so it requires one non-`App.tsx` operator-command owner, the backend seam path `/session/operator-command`, and the narrowed `text_question` plus `tts_preview` command types.
**Why:** The shared App shell was still allocating command draft and submit mutation state before the display-mode early return, which let the display surface own write state even though it is supposed to stay read-only.

### 2026-05-14T11:04:00+01:00: User directive

**By:** Jason Fletcher (via Copilot)
**What:** Skip debug controls for now and move them to the todo list instead of the active implementation seam.
**Why:** User wants the immediate queue focused on non-debug product seams first.

### 2026-05-14T11:12:00+01:00: Next implementation batch scope lock

**By:** Trinity
**What:** Re-scope the next implementation batch to real `text_question` execution into a local LLM reply path on the existing backend-owned operator-command seam. Keep the first LLM slice backend-only, preserve the current canonical session plus `speech.lifecycle` envelopes and cursor handoff, and defer frontend expansion, provider-profile switching, animation debug actions, and other operator-control growth.
**Why:** The current code already has backend live `speech.lifecycle` delivery and frontend consumption in place, but `text_question` still only publishes a canonical transcription-style event and a session acceptance event. The narrowest coherent slice that matches the user's chosen product seam is to add one real backend reply path without reopening frontend ownership or debug scope.

### 2026-05-14T08:57:41.6820932+01:00: Local speech adapter execution contract

**By:** Link
**What:** Faster-Whisper and GPT-SoVITS execution stays behind the existing normalized speech service interfaces and resolves only from the bootstrap-managed local roots. Faster-Whisper may run inline when `faster_whisper` is installed in the backend environment, otherwise it falls back to a provider-local Python entrypoint under `NIKOF_PROVIDERS_ROOT/stt/faster-whisper/`. GPT-SoVITS runs through a provider-local Python entrypoint under `NIKOF_PROVIDERS_ROOT/tts/gpt-sovits/`. Provider entrypoints accept one JSON request on stdin and emit one normalized JSON response on stdout.
**Why:** The backend needs real local execution paths without widening API payloads, mutating bootstrap state, or forcing one machine-specific runtime layout beyond the documented local storage contract.

### 2026-05-14T08:57:41.6820932+01:00: Speech degraded-mode baseline policy

**By:** Mouse
**What:** Keep speech stability coverage centered on the backend-owned canonical envelope, but let the degraded real-adapter scenario baseline the actual adapter-shell result for the current branch, including selected provider entrypoints and `unavailable` statuses when local provider payloads are missing.
**Why:** The real adapter shells now express degraded mode through the same envelope shape with different contract values. Forcing stub-ready values in the harness would hide legitimate backend behavior changes and make the baseline less trustworthy.

### 2026-05-14T08:57:41.6820932+01:00: Frontend bridge stability follows the actual bridge owner

**By:** Mouse
**What:** Keep `frontend-stage1-bridge-surface` anchored to the file that actually owns Stage 1 bridge behavior. In the current slice that means source-inspecting `frontend/src/avatar/loaders/backendCharacterFlow.ts` for catalog-envelope consumption and helper-backed rejection rollback, while `App.tsx` only needs to prove it routes structured rejection handling through that helper path.
**Why:** The Stage 1 frontend bridge contract did not change, but the implementation moved out of inline loader and component code into helper functions. The stability seam should fail on contract drift, not on harmless internal extraction.

### 2026-05-14T08:57:41.6820932+01:00: Frontend speech lifecycle snapshot bridge

**By:** Switch
**What:** Bridge the frontend shell to `GET /session/speech-lifecycle` as a read-only snapshot surface only, fetching once after catalog readiness and refreshing after backend-confirmed active-character responses, while keeping manifest loading and VRM asset resolution frontend-local.
**Why:** This surfaces canonical transcription and synthesis lifecycle state in the current shell and keeps it aligned with backend-confirmed session flow without widening into polling, SSE, WebSocket transport, or backend asset serving.

### 2026-05-14T08:57:41.6820932+01:00: Backend event-store shape

**By:** Tank
**What:** Persist canonical `session` and `speech.lifecycle` events in a backend-owned, per-session, per-stream ordered store that reuses the existing envelope fields (`event_id`, `sequence`, `cursor`, `event`). The current `GET /session/speech-lifecycle` surface may accept an optional cursor for incremental reads, but it keeps the same snapshot payload shape and does not introduce transport-specific event bodies.
**Why:** This gives the backend one canonical ordering and cursor source before SSE or WebSocket delivery exists, while preserving the current provider-agnostic contract and avoiding a second event schema.

### 2026-05-14T08:57:41.6820932+01:00: Post-batch queue alignment

**By:** Trinity
**What:** Treat the backend-owned event store, the real Faster-Whisper and GPT-SoVITS execution paths, the frontend speech-lifecycle snapshot bridge, and the current stability slice as landed. Sequence the next queue as backend turn-pipeline publication into the existing ordered event envelope, then live delivery on that same envelope, then frontend live consumption and transport-aware runtime stability expansion without widening payload shapes.
**Why:** `docs/NEXT_STEPS.md` and `docs/WORKSTREAMS.md` had drifted behind the landed batch and were still advertising finished work as upcoming scope.

### 2026-05-14T09:05:00+01:00: Next implementation block boundary

**By:** Trinity
**What:** Lock the next implementation block to backend turn-pipeline publication into the existing canonical `session` and `speech.lifecycle` event store plus publication-scoped stability coverage only. Keep the current `speech.lifecycle` envelope unchanged, queue live delivery as the following batch, and keep Switch's frontend transport work behind that transport slice.
**Why:** The current backend still synthesizes `speech.lifecycle` events from the snapshot read path and does not yet expose an explicit turn orchestration or publication seam. Bundling publication, transport, and frontend live consumption now would cross two unfinished abstraction boundaries at once and make it harder to preserve the canonical envelope.

### 2026-05-14T09:08:00+01:00: Backend turn publication owns canonical speech event creation

**By:** Tank
**What:** Add an explicit backend turn-pipeline publisher that executes the normalized STT and TTS services and appends canonical `session` plus `speech.lifecycle` events in fixed order. Keep `GET /session/speech-lifecycle` as a read-only projection over the existing event store instead of letting the snapshot read path seed events itself.
**Why:** The next batch needs a backend-owned publication seam that can be reused by later delivery work without changing the current speech lifecycle envelope or inventing transport-specific payloads.

### 2026-05-14T09:28:00+01:00: Team decision

**By:** Trinity
**What:** Treat backend turn publication as already landed through the backend-owned ordered store and lock the next batch to backend live delivery plus transport-scoped stability only. Keep frontend live consumption queued for the following slice, and preserve the canonical `speech.lifecycle` event body as the single transport-agnostic envelope reused by snapshot and live delivery.
**Why:** The repo already contains the publication seam in backend services and tests, while the router and frontend still stop at snapshot-only delivery. Splitting live delivery from frontend live consumption keeps the next batch narrow, lets the team stabilize cursor and transport behavior first, and avoids coupling frontend runtime work to a transport surface that is not yet proven.

### 2026-05-14T10:00:00+01:00: Frontend shell split batch

**By:** Trinity
**What:** Lock the next frontend batch to splitting the current `App.tsx` shell into explicit control and display surfaces while keeping character catalog loading, active-character synchronization, and `speech.lifecycle` consumption on the existing App-owned loader path and backend-owned envelope. Use simple in-app surface branching in this batch and do not add a routing dependency yet.
**Why:** The current shell already has one coherent state owner and only two tightly coupled surfaces. Adding router infrastructure now would widen the batch without solving a real navigation problem, while extracting control and display surfaces now will reduce App-level coupling and preserve the current transport and contract boundary.

### 2026-05-14T12:00:00+01:00: Minimal backend-owned memory retrieval slice

**By:** Trinity
**What:** Start memory work behind the existing `POST /session/operator-command` `text_question` branch only. Add a backend-only memory service boundary that persists text-question turns and assistant replies to SQLite and returns ranked retrieval snippets for the same session and active character before LLM generation. Keep the current HTTP route, canonical session plus `speech.lifecycle` envelopes, and frontend reply readout unchanged. Defer vector indexing, embedding adapters, summarization, cross-session affinity, and any UI-visible memory diagnostics until this first durable retrieval seam is proven.
**Why:** The repo now has one working backend-authored reply path. The next smallest shippable step is to make retrieval real without widening into full orchestration or leaking memory concerns into routes, frontend state, or provider adapters.

### 2026-05-14T12:05:00+01:00: Backend memory slice storage and scope

**By:** Tank
**What:** Persist `text_question` exchanges in a SQLite store at the existing local app root under `memory/session-memory.sqlite3`, keep retrieval in the backend route layer rather than the LLM adapter, and scope lexical recall strictly to the current `session_id` plus active `character_id`.
**Why:** This lands a real first memory slice without widening the public transport contract, changing the frontend path, or coupling retrieval policy to the provider adapter.

### 2026-05-14T12:25:00+01:00: Text-question speech and display contract

**By:** Trinity
**What:** Keep `POST /session/operator-command` as the only write seam for `text_question`. For `text_question`, the backend remains the owner of reply generation and should publish `assistant.message` as the canonical reply record on `speech.lifecycle`, while successful backend replies also drive canonical `speech.synthesis` publication from the same backend command path rather than from a frontend follow-up call. The display surface may read backend-confirmed character state plus canonical `speech.lifecycle` events only; it must not read or own operator-command write state directly.
**Why:** The current seam already proves the right boundary: control posts commands, backend authors canonical events, and the display surface is read-only. Extending the same seam to cover spoken assistant replies avoids a second reply transport and keeps display behavior aligned with backend-owned lifecycle events.

### 2026-05-14T12:55:00+01:00: Speech-synthesis playback and viseme contract

**By:** Trinity
**What:** Upgrade backend-owned `speech.synthesis` activity on the existing `speech.lifecycle` envelope so each synthesis record can carry a backend-authored audio reference plus playback-ready timing metadata. Keep `POST /session/operator-command`, `GET /session/speech-lifecycle`, and the live `speech.lifecycle` stream as the only transport surfaces for this slice. Treat viseme and phoneme slots as optional backend-authored timing data aligned to one synthesis utterance; the frontend may consume them from the canonical synthesis event but must not introduce a second playback or lip-sync transport.
**Why:** The current seam already routes reply-owned synthesis through the canonical backend lifecycle stream, but the synthesis contract is still text-first even though timing, phoneme, and viseme metadata already exist. Adding an audio reference on the same contract is the smallest shippable step that enables real playback and makes lip-sync integration possible without moving ownership into the frontend or widening the operator path.

### 2026-05-14T13:25:00+01:00: Frontend-local viseme runtime handoff

**By:** Trinity
**What:** Keep `frontend/src/app/App.tsx` as the sole consumer of backend-authored `speech.synthesis` activity and pass viseme or timing metadata only into a runtime-local speech reaction API. The avatar runtime may schedule local viseme reactions when `synthesis.timing.viseme_slots` is usable and must degrade cleanly to the existing coarse `speak` path when viseme data is absent, malformed, or insufficient. Display status may expose whether playback is viseme-driven or coarse, but full phoneme inference, richer facial animation, new transport ownership, and extra command surfaces remain out of scope.
**Why:** The coarse speaking seam already works on top of the backend-owned lifecycle event. This narrow frontend-only slice improves lip-sync fidelity without widening backend contracts, duplicating synthesis consumption, or treating experimental facial animation as part of the committed scope.

### 2026-05-15: Frontend semantic runtime payload lookup

**By:** Switch
**What:** Build the web runtime's shared semantic payload catalog from generated shared runtime sidecars and resolve `listen.loop` plus `speak.loop` by direct semantic id first. Keep a narrow frontend compatibility fallback to `idle.default` only when those dedicated runtime sidecars are still absent from `assets/animations/generated/shared/`.
**Why:** The runtime should consume backend-owned semantic ids as first-class shared assets instead of treating listen and speak as permanent aliases. The temporary fallback preserves current startup and speech behavior in branches where the dedicated runtime payload files have not landed yet.

### 2026-05-15: Frontend session animation live consumption

**By:** Switch
**What:** Keep frontend session animation consumption on the existing backend-owned `/session/animation` seam. Start from the normalized snapshot consumer, then capability-detect SSE on that same route so both control and display surfaces can follow backend-selected semantic commands without adding a second frontend animation state model.
**Why:** The current frontend already trusts the backend-owned session animation snapshot and lifecycle update response. Reusing that seam for optional live delivery keeps the control/display split intact, lets the display follow backend lifecycle changes when live delivery is available, and preserves the existing snapshot plus local `idle.default` fallback when live delivery or the snapshot read path is unavailable.

### 2026-05-15: Web-first shared semantic payloads for listen and speak

**By:** Link
**What:** Add dedicated staged and generated shared semantic assets for `listen.loop` and `speak.loop`, derived from the existing `idle.default` runtime payload pattern, and resolve those semantic ids as their own repo-backed web payload assets instead of treating them as frontend payload aliases.
**Why:** The web-first runtime needs backend-stable semantic ids to map to real shared payload assets so listen and speak remain distinct conversational states without depending on Unity or viewer-side alias fallback.

## Governance

- All meaningful changes require team consensus
- Document architectural decisions here
- Keep history focused on work, decisions focused on direction
