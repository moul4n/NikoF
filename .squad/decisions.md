# Squad Decisions

## Active Decisions

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

### 2026-05-15: User directive

**By:** Jason Fletcher (via Copilot)
**What:** Choose the longer-term lower-arm transform fidelity path for the current web viewer slice: keep the browser runtime on exporter-composed `left/right.lower_arm.rotation.{x,y,z,w}` quaternion hints when available rather than adding more frontend-only lower-arm heuristics, and leave true avatar-backed bone-local export as a later fidelity step.
**Why:** Switch confirmed the raw Unity humanoid clip still does not expose direct lower-arm bone transform curves, so quaternion hints are the smallest honest next step that improves visible lower-arm motion now without overstating the fidelity of the exported source data.

### 2026-05-15: Exporter-derived lower-arm rotation hint

**By:** Switch
**What:** Derive `left.lower_arm.rotation.{x,y,z,w}` and `right.lower_arm.rotation.{x,y,z,w}` quaternion hint channels in the Unity batch exporter from the existing elbow-flex plus forearm-twist source pair, refresh the shared `idle.default`, `listen.loop`, and `speak.loop` runtime payloads through `C:\Program Files\Unity\Hub\Editor\6000.4.7f1\Editor\Unity.exe`, and make the web humanoid runtime prefer those lower-arm rotation hints over per-axis lower-arm bindings when present.
**Why:** The current raw Unity humanoid clip does not carry direct lower-arm bone transform curves, so fully faithful bone-local playback still requires an avatar-backed export path. In the current narrow slice, combining the available lower-arm muscle signals into explicit quaternion hints moves lower-arm composition into the exporter, preserves the visible elbow and twist improvements, and gives the web path a cleaner seam than continuing to accumulate browser-only lower-arm heuristics.

### 2026-05-15: User directive

**By:** Jason Fletcher (via Copilot)
**What:** Prefer the exporter-side improvement path for better lower-arm and elbow shaping in the current web viewer instead of adding more frontend-only elbow heuristics.
**Why:** The source clip already carries usable lower-arm source data, so improving the Unity batch exporter keeps the bend signal data-driven end to end and avoids inventing browser-only motion.

### 2026-05-15: Exporter-derived elbow flex from forearm stretch

**By:** Switch
**What:** Derive explicit `left.elbow.flex` and `right.elbow.flex` channels in the Unity batch exporter from usable `left/right.forearm.stretch` source samples, refresh the generated `idle.default`, `listen.loop`, and `speak.loop` runtime payloads through `C:\Program Files\Unity\Hub\Editor\6000.4.7f1\Editor\Unity.exe`, and bind those elbow-flex channels onto `leftLowerArm` and `rightLowerArm` in the web humanoid playback path while keeping the prior shoulder and forearm twist polish.
**Why:** The current source clip does carry lower-arm source data, but it previously reached the web runtime only as raw forearm stretch floats that did not drive visible elbow shaping. Deriving explicit exporter hints and replaying them through the existing runtime keeps the fix local to exporter plus playback, proves the lower-arm signal survives transport, and leaves the remaining risk on animation fidelity rather than delivery.

### 2026-05-15: User directive

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
