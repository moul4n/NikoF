# Stabilization Worklist

Source: full-system evaluation 2026-06-10 (four audits: backend pipeline, frontend/animation, orchestration scripts, repo hygiene/Unity readiness).
Goal: move from early-ideas dev to a stable, testable system; clean up dev tooling; prepare for the Unity 3D character frontend.

Status legend: `[ ]` open · `[x]` done · `[~]` in progress · `[-]` dropped/superseded

---

## Phase 1 — Lifecycle stabilization (startup / stop / restart reliability)

Root causes identified: two competing control layers (PowerShell dashboard vs backend sidecar managers), restart with no stop→dead→start barrier, port-only service identity, `/health` reporting ready before subsystems are, and several backend worker races.

### 1A. Ops dashboard (`scripts/bootstrap/app-manager.ps1`)

- [ ] **Restart barrier** — `Invoke-ComponentAction` restart calls `Stop-X` then `Start-X` immediately (≈ lines 398–431). Insert wait: poll until the old PID is dead AND the port is free (with timeout) before starting.
- [ ] **Post-start bind wait** — `Start-Frontend`/`Start-Backend` return as soon as the process spawns. Poll until the port is actually listening (or health endpoint answers) before reporting success, so the dashboard never shows green for a process that failed to bind.
- [ ] **Process identity validation** — `Get-ListeningProcessInfo` (≈ lines 49–71) accepts any PID on the port. Validate process name (node/python/ollama) before reporting "running" or killing. Prevents phantom-green status and killing unrelated processes.
- [ ] **Graceful-stop ordering for backend** — Stop currently `taskkill /T /F`s the backend, so sidecar managers never shut their children down. Try a graceful shutdown request first (backend shutdown endpoint or CTRL_BREAK), fall back to tree-kill after timeout.
- [ ] **Status refresh robustness** — `Build-ManagerStatus` (≈ lines 267–382) makes 5–6 sequential HTTP calls with 2s timeouts; one slow call → stale inconsistent snapshot. Parallelize or tolerate partials explicitly; mark unknown vs down distinctly.
- [ ] **Single LLM control path** — restart logic has dual paths (backend API when healthy, direct port-kill otherwise; ≈ lines 410–420). Direct path should be clearly last-resort and re-sync backend state afterwards (or be removed once backend owns Ollama fully).

### 1B. Backend worker/manager races

- [ ] **TTS worker queue/loop mismatch** — `tts_worker.py`: queue created in `__init__`, loop in `start()`; `enqueue()` before `start()` breaks. Bind queue creation to start, or guard enqueue.
- [ ] **TTS shutdown sentinel race** — `stop()` uses `put_nowait(None)`; silently fails when queue full → worker loop never exits. Drain/flush then signal reliably.
- [ ] **STT dispatch executor double-create** — `stt_worker.py` `_ensure_dispatch_executor()` can create two ThreadPoolExecutors under concurrency. Create-once under lock.
- [ ] **Silent except blocks in sidecar managers** — `stt_server.py` / `tts_server.py` / `llm.py` have broad `except ...: pass` paths around shutdown/reclaim. Add warning-level logging with context everywhere a failure is swallowed.
- [ ] **Singleton swap leaks old sidecars** — module-level manager singletons (stt/tts worker, llm manager) swap instances when `app_paths` changes without stopping the old instance. Stop old instance before swap.
- [ ] **`/health` readiness reporting** — health returns 200 when HTTP is up, before sidecars/workers are ready. Add per-subsystem readiness (stt/tts/llm/event-store) so the dashboard and clients can show real state.
- [ ] **Process-tree termination completeness** — `process_supervision.py` `terminate_process_tree()`: verify children are recursively reaped (psutil children) on Windows; today only the top PID is signalled on the non-taskkill path.
- [ ] **Port-only `is_running` in sidecar managers** — same identity problem as the dashboard: `find_listening_pid()` match ≠ our process. Track owned PID and verify it.

### 1C. Restart-survivability

- [ ] **Durable session event store** — `services/session.py` `InMemorySessionEventStore` loses all events on backend restart; frontend cursors invalidate mid-session. Replace with SQLite-backed store (SQLite already in the stack for memory).
- [ ] **Frontend reconnect backoff** — fixed 3000ms retry, no exponential backoff/jitter (`useCharacterShellState.ts`); clients hammer a recovering backend. Add backoff with jitter.
- [ ] **Single launch path** — retire `run-dev-stack.ps1` + `stop-dev-stack.ps1` (or fold their supervisor mode into app-manager). Two launchers managing the same ports causes ownership ambiguity.

### 1D. Lifecycle test gate

- [ ] **Sidecar lifecycle integration tests** — automated start → health → stop → assert-no-orphans; restart under load; kill-sidecar → assert recovery. The existing snapshot harness covers contracts, not lifecycle — this is the missing gate for the testing phase. (Note: `backend/tests/` already has `test_stt_sidecar_runtime.py`, `test_tts_sidecar_runtime.py`, `test_llm_sidecar_manager.py` — extend rather than create from scratch.)
- [ ] **Make the unit test suite hermetic** *(discovered 2026-06-10)* — on a machine with providers installed, `python -m unittest discover` spawns the REAL GPT-SoVITS sidecar (loads the model into VRAM) and hangs/conflicts with live state. Tests must force an isolated `NIKOF_LOCAL_ROOT` (temp dir) in setUp/shared harness so sidecar managers always resolve to "not configured". Interim workaround: run with `NIKOF_LOCAL_ROOT=<empty tmp dir>`.
- [ ] **Machine-dependent health test** *(discovered 2026-06-10)* — `test_health_payload_projects_frontend_safe_prerequisite_lanes` fails on machines where Ollama is installed (the `provider-ollama` blocker it expects is absent). Prerequisite detection probes machine PATH; the test needs env isolation.
- [ ] **`_clamp_intensity(None)` TypeError** *(discovered 2026-06-10, pre-existing)* — `backend/app/services/animation.py:117` crashes when `turns.py:248` passes an intent with `intensity=None`. Surfaced by the structured-turn-flow tests. Guard for None (treat as default intensity).

---

## Phase 2 — Latency / pipeline streamlining

The pipeline is serial and fully buffered: STT poll (350ms) → full LLM completion (`stream: False`) → full TTS synthesis → WAV on disk → full-file download in browser → playback. Models lazy-load on first request (5–30s first-turn spike, re-paid after every restart).

- [ ] **Warmup on startup** — preload STT + TTS models and issue a tiny Ollama generation when the backend starts (or `/warmup` endpoint the dashboard calls after start). Biggest single fix for "slow after restart".
- [ ] **Stream LLM → sentence-chunked TTS** — enable Ollama streaming, split on sentence boundaries, enqueue each sentence to the TTS worker as it lands. Avatar starts speaking after the first sentence instead of the full reply. The queue-based TTS worker is already shaped for this. Defines the audio-chunk contract Unity will need.
- [ ] **Early/streamed audio playback in frontend** — today `useSpeechPlaybackBridge` downloads the full audio file before play. With chunked synthesis, play chunk 1 while later chunks synthesize.
- [ ] **Replace STT 350ms poll** — push events from the STT sidecar (or drop interval to ~100ms as interim).
- [ ] **Replace frontend 500ms session-animation poll** (`sessionAnimation.ts`) with the existing SSE pattern.
- [ ] **Config caching** — `_read_runtime_config()` re-reads runtime.json on every TTS synthesis (`speech.py` ≈ 1338); cache with stat()-based invalidation. Same for provider entrypoint resolution and voice-profile normalization.
- [ ] **Resource monitor GPU poll caching** — nvidia-smi/torch query on every status check; add ~2s TTL.
- [ ] **Exponential backoff in sidecar startup polling** — fixed 0.5–1.0s sleeps with 60s deadlines; also early-exit when the spawned process dies during startup instead of polling out the full deadline.

---

## Phase 3 — Structure cleanup (break up monoliths, remove early-dev tooling)

### 3A. Backend module breakup

- [ ] **Split `services/speech.py` (~1,700 lines)** into:
  - `speech_contracts.py` — schemas/payload contracts
  - `speech_adapters.py` — Faster-Whisper + GPT-SoVITS adapters
  - `speech_services.py` — registries/factories
  - `speech_lifecycle.py` — lifecycle polling + event delivery
- [ ] **Extract stub services out of production wiring** — `StubSpeechTranscriptionService`, `StubSpeechSynthesisService`, `StubSpeechLifecycleSnapshotService` (speech.py), `StubTextGenerationService` (llm.py) sit in prod paths with no flag. Move behind explicit test/dev configuration.
- [ ] **Deduplicate sidecar manager logic** — health-check, reclaim-orphan, and port-conflict code is copy-pasted across `stt_server.py` / `tts_server.py` / `llm.py` with inconsistent error handling. Extract a shared `SidecarManager` base in `process_supervision.py` or new module.
- [ ] **Deduplicate cursor parsing** — `speech.py` `_parse_cursor_sequence()` duplicates `session.py` logic; keep one.
- [ ] **Config schema** — scattered magic keys (`"entrypoint"`, `"server_script"`, `"python_executable"`) → typed config dataclass.

### 3B. Frontend module breakup

- [ ] **Split `src/avatarRuntime.ts` (~3,300 lines)** into renderer/scene management, animation playback orchestration (mixer/official/VRMA routes), speech-reaction/lip-sync, and debug API modules. Do AFTER the Phase-1-adjacent animation bug fixes below so fixes land in small diffs.
- [ ] **Animation switch race** — async VRMA/official load completion can overwrite a newer selection (avatarRuntime.ts ≈ 2452–2716). Add generation counter/version guard checked on async completion.
- [ ] **Abort in-flight loads on character switch** — no AbortController; old animation loads can apply to the new avatar (≈ 2653–2695).
- [ ] **Lip-sync on audio clock** — viseme timing advances by rAF delta; drifts on frame drops. Sync to `audio.currentTime` (≈ 2164, 2800–2850).
- [ ] **Unbounded VRMA clip cache** — `vrmaPlayback.ts` `activeClips`/`loadedAnimations` never evict; add eviction on character switch.
- [ ] **Audio element listener cleanup** — `useSpeechPlaybackBridge.ts` can accumulate listeners across audio elements.
- [ ] **Swallowed promise rejections** — `useCharacterShellState.ts` (≈ 141) and `useSessionAnimationState.ts` (≈ 99–129) sync errors vanish silently; log + surface to state.
- [ ] **Deduplicate `buildBackendApiUrl()`** (4 copies) and character-ID resolution (3 copies) into shared utils; introduce a consistent backend-error class.
- [ ] **Decide legacy playback paths** — mixer fallback and offline-idle fallback: keep (documented) or remove.

### 3C. Scripts & repo

- [ ] **Consolidate launchers** — covered in 1C; after that, `scripts/bootstrap/` should contain one orchestration entry (app-manager) + bootstrap/install only.
- [ ] **Delete `.copilot-tmp-playwright.cjs`** (root one-off).
- [ ] **Archive `.squad/` + `.copilot/`** — legacy Copilot multi-agent state; relevant knowledge imported into CLAUDE.md. Keep for history or move to an `archive/` branch; do not extend.
- [ ] **Console noise** — frontend `console.warn` spam in prod paths → gate behind dev flag or a small logger.

---

## Phase 4 — Testing phase gate

- [ ] Lifecycle integration suite green (1D) and wired into `Invoke-StabilitySuite.ps1`.
- [ ] Backend unittest suite green and run in CI/pre-commit (`python -m unittest discover -s backend/tests -t backend`).
- [ ] Stability baselines re-validated after Phase 1–3 changes (intentional `-RefreshBaselines` with review).
- [ ] TTS soak (`Invoke-TtsSoak.ps1`) re-run post-streaming changes; update README guidance on the request-counter lag if fixed.
- [ ] Add frontend unit tests for the speech playback bridge seams (jsdom is already a devDependency).

---

## Phase 5 — Unity 3D frontend preparation

Already in place: Unity 6 LTS skeleton (6000.4.7f1), 4 character packages (maria + 3 test slots) with VRM/manifest/expressions/voice, 740 animation DSL JSONs, exporter tooling (`RawAnimBatchExporter.cs`, `VrmaExporter.cs`). Missing: all runtime C#.

- [ ] **Versioned realtime client contract** — one channel (WebSocket or SSE+HTTP) carrying session events, animation events, viseme timing, audio chunk references — consumed identically by web UI and Unity. Build on `tests/contracts/schemas/`. The current web seam (SSE + polling + localStorage cross-window sync) is web-specific and must not be what Unity binds to.
- [ ] **Audio delivery contract for Unity** — chunked audio references + viseme timing (falls out of Phase 2 streaming work).
- [ ] **Mic/text input path from Unity** — backend already accepts operator commands; define the equivalent input contract for a non-browser client.
- [ ] **Unity runtime C#** — character load (UniVRM), animation event subscription + DSL playback, viseme lip-sync from backend timing, audio playback. Mirror the character-catalog pattern from the TS frontend.
- [ ] **Decide `assets/` vs `Assets/`** — Unity expects capitalized `Assets/`; current lowercase `assets/` relies on normalization in `CharacterMetaGenerator.cs`. Confirm this holds for a real Unity editor workflow or rename.

---

## Deferred / nice-to-have

- [ ] Process group/job-object based child management on Windows (vs taskkill trees).
- [ ] Request deduplication in frontend (double-click refresh → two API calls).
- [ ] Error boundary around avatar stage mount.
- [ ] Remove unused `com.unity.multiplayer.center` package from Unity manifest.
- [ ] `ResourceMonitorPanel` / `ControlSurfaceOperatorCommandPanel` — confirm usage or remove.
