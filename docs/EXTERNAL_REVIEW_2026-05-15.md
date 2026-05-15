# External Consultant Review — NikoF Project

**Date:** 2026-05-15T22:00:00+01:00  
**Reviewer:** External AI Architecture Consultant  
**Scope:** Full project audit — codebase, architecture, animation pipeline, future integration planning  
**Project age at review:** ~1.5 days (created 2026-05-14)

---

## Executive Summary

NikoF is a well-architected local-only anime companion for Windows 10/11. The contract-first approach, UniVRM 1.0 standardization, and provider-agnostic adapter pattern are correct long-term choices. The project has achieved remarkable velocity in establishing stable seams between subsystems.

**Viability Score: 7.5/10** — Viable with clear path to success, but the hardest engineering work (real GPU-bound provider integration) hasn't started yet.

---

## Table of Contents

1. [Project Status](#project-status)
2. [Viability Assessment](#viability-assessment)
3. [Serious Coding Concerns](#serious-coding-concerns)
4. [Animation Pipeline Review](#animation-pipeline-review)
5. [LLM / TTS / STT Integration Planning](#llm--tts--stt-integration-planning)
6. [Lifelike Reactive Mode Concept](#lifelike-reactive-mode-concept)
7. [Prioritized Recommendations](#prioritized-recommendations)
8. [Risk Register](#risk-register)
9. [Squad Effectiveness Notes](#squad-effectiveness-notes)
10. [Guidance for Next Planning Cycle](#guidance-for-next-planning-cycle)

---

## Project Status

### What's Built

| Component | Status | Notes |
|-----------|--------|-------|
| Backend scaffold (FastAPI) | ✅ Functional | Routes, schemas, session, character service |
| Frontend VRM rendering | ✅ Functional | three-vrm loads characters, display/control surfaces |
| Character catalog bridge | ✅ Proven | Backend→frontend character selection works |
| Animation live-delivery (SSE) | ✅ Proven | Session animation snapshots stream to frontend |
| Humanoid bone playback | ✅ Proven | Quaternion rotation on VRM normalized bones |
| Speech lifecycle contracts | ✅ Defined | Schemas complete, transport surface working |
| Operator command flow | ✅ Working | text_question and tts_preview paths |
| Animation DSL schema | ✅ Designed | Staged → candidate → promoted pipeline defined |
| Unity .anim export pipeline | ✅ Working | Raw → metadata sidecar → runtime payload |
| Bootstrap/validation scripts | ✅ Comprehensive | PowerShell stability suite with 20+ scenarios |
| Contract validation | ✅ Automated | JSON schema checks against character manifests |

### What's Stub/Planned

| Component | Status | Blocking? |
|-----------|--------|-----------|
| Faster-Whisper integration | 🔲 Stub only | Stage 3 |
| GPT-SoVITS integration | 🔲 Stub only | Stage 3 |
| LLaMA 3.1 via Ollama | 🔲 Stub (returns canned) | Stage 4 |
| Memory/vector store (SQLite + ChromaDB) | 🔲 Not started | Stage 4 |
| Vision pipeline (MediaPipe + CLIP) | 🔲 Not started | Stage 6 |
| Animation blend/crossfade | 🔲 Not implemented | Stage 5 |
| Procedural micro-animation | 🔲 Not started | Stage 5 |
| Character swapping runtime | 🔲 Partial (catalog exists) | Stage 7 |

---

## Viability Assessment

### Strengths

1. **Contract-first architecture** — Subsystems are cleanly separated by stable interfaces. This means providers can be swapped without cascading changes.

2. **UniVRM 1.0 as a hard standard** — Eliminates character-format chaos. Any VRoid Studio / VRM character can slot in without custom rig work.

3. **Realistic VRAM budget** — LLaMA 3.1 8B Q4_K_M (~5GB) + Faster-Whisper Medium (~2GB) + GPT-SoVITS (~2-3GB) fits in 12GB with room for three.js rendering.

4. **Local-only by design** — No subscription costs, no API dependencies, no privacy concerns. Self-contained on target hardware.

5. **Excellent documentation discipline** — Architecture, implementation plan, animation DSL schema, and 100+ tracked decisions provide strong continuity.

6. **PowerShell stability harness** — Automated regression testing against JSON baselines is a surprisingly mature quality practice for a 1.5-day-old project.

### Weaknesses

1. **No real provider integration yet** — The entire backend returns canned/stub data. The jump from stubs to real GPU inference is the project's biggest risk.

2. **Monolithic code in key files** — `router.py` (~600+ lines) and `App.tsx` (~1600+ lines) will become unmaintainable under real complexity.

3. **No VRAM orchestration strategy** — The architecture assumes concurrent model availability but 12GB requires sequential model loading/unloading.

4. **Single developer dependency** — Squad AI agents produce velocity but architectural drift accumulates without regular human consolidation.

---

## Serious Coding Concerns

### Critical — Fix Before Stage 3

#### 1. Monolithic Router (`backend/app/api/router.py`)

**Problem:** ~600+ lines containing ALL route definitions, ALL service instantiation, ALL response construction, SSE generators, and contract snapshot building.

**Impact:** When real providers arrive (each with async initialization, GPU resource management, error recovery), this file will be impossible to maintain or debug.

**Fix:**
```
backend/app/api/
  router.py          → thin orchestrator, just mounts sub-routers
  routes/
    health.py        → /health endpoint
    characters.py    → /characters, /session/active-character
    session.py       → /session/lifecycle-state, /session/operator-command
    animation.py     → /session/animation (incl. SSE streaming)
    speech.py        → /session/speech-lifecycle (incl. SSE streaming)
  dependencies.py    → FastAPI Depends() providers for shared services
```

#### 2. No Dependency Injection / Singleton Lifecycle

**Problem:** `_build_services()` creates ALL service instances inline with no caching, no lifecycle management, and no GPU resource awareness.

**Impact:** When STT/TTS/LLM services hold GPU memory, creating them per-request will either crash or leak VRAM.

**Fix:** Use FastAPI's `lifespan` context manager for expensive singletons:
```python
@asynccontextmanager
async def lifespan(app: FastAPI):
    # Load models on startup
    stt_service = await load_stt_model()
    tts_service = await load_tts_model()
    app.state.stt = stt_service
    app.state.tts = tts_service
    yield
    # Cleanup on shutdown
    await stt_service.unload()
    await tts_service.unload()
```

#### 3. Frontend Mega-Component (`App.tsx` ~1600 lines)

**Problem:** Single file contains all application state, all WebSocket handling, avatar orchestration, and all UI rendering for both control and display surfaces.

**Impact:** Impossible to test individual features, reason about state flows, or onboard a second developer.

**Fix:**
```
src/
  app/
    App.tsx                          → shell with surface routing only
    surfaces/
      DisplaySurface.tsx             → avatar + animation runtime
      ControlSurface.tsx             → operator panel + character selection
  hooks/
    useSession.ts                    → session state management
    useAnimationStream.ts            → SSE animation consumption
    useSpeechLifecycle.ts            → speech event handling
    useCharacterCatalog.ts           → character loading/selection
  avatar/
    (existing runtime code)
```

### Important — Fix Before Stage 4

#### 4. No Input Validation Beyond Type Checks

**Problem:** Operator command endpoint accepts arbitrary-length text with no limits.

**Impact:** A user (or errant frontend) could send megabytes of text to the LLM, exhausting GPU memory or hanging the system.

**Fix:**
```python
MAX_OPERATOR_TEXT_LENGTH = 4096  # ~1000 tokens

if len(normalized_text) > MAX_OPERATOR_TEXT_LENGTH:
    raise HTTPException(
        status_code=status.HTTP_400_BAD_REQUEST,
        detail=f"Text exceeds maximum length ({MAX_OPERATOR_TEXT_LENGTH} chars).",
    )
```

#### 5. In-Memory Session State

**Problem:** `InMemorySessionService` loses all state on server restart.

**Impact:** Acceptable for Stage 1 but needs a clear migration path to SQLite before Stage 4 (memory/persistence).

**Guidance:** Add a `SessionStore` protocol with `InMemorySessionStore` and `SqliteSessionStore` implementations. Wire the choice through settings.

---

## Animation Pipeline Review

### Architecture Assessment: Strong

The layered approach is correct:

```
Raw Unity .anim source (tracked in Git)
  → Safe metadata sidecar export (Python script)
    → Generated runtime payload (quaternion keyframes per bone)
      → Semantic DSL candidate (JSON with motion profile)
        → Promoted shared library asset (stable semantic ID)
          → Backend resolution (intent → command)
            → Frontend playback (normalized bone pose)
```

The decision to keep **semantic IDs** (`idle.default`, `speak.loop`, `listen.loop`) as the contract boundary — with the backend resolving implementation — is architecturally sound.

### What's Working Well

- Unity batch export pipeline produces deterministic runtime payloads
- Arm-chain redistribution and finger-spread decisions show deep VRM humanoid understanding
- Motion profile metadata (dominant channels, energy bands) enables smart selection
- SSE live-delivery for animation updates is proven end-to-end
- Generated candidates vs promoted assets distinction prevents premature standardization

### What Needs Attention

#### JSON Quaternion Format — Performance Ceiling

**Current:** Per-frame quaternion arrays serialized as JSON text.  
**Problem:** `idle.default` at 30fps × 8.3s = 250 frames × ~20 bones × 4 floats = ~20,000 numbers as JSON strings.  
**Impact:** Fine for 1-2 animations. Breaks with 10+ simultaneous layers or complex gestures.

**Recommendation:** Plan migration to binary format before Stage 5:
- Option A: `.vrma` (VRM Animation format — native three-vrm support)
- Option B: Custom ArrayBuffer with header (compact, fast parse)
- Option C: Keep JSON for authoring, compile to binary for runtime

#### No Crossfade/Blend Implementation

**Current:** Hard state switches between animation clips.  
**Impact:** Character will look robotic — snapping between poses instead of flowing.

**Recommendation:** Implement a simple crossfade system:
```typescript
interface AnimationTransition {
  fromClip: string;
  toClip: string;
  durationMs: number;
  curve: 'linear' | 'ease-in-out';
}

// On state change: blend old pose → new pose over durationMs
// Using SLERP for quaternions (already have the math for bone rotation)
```

#### No Animation State Machine

**Current:** Animation state is driven directly by session lifecycle events.  
**Impact:** No priority system, no interruption handling, no concurrent layer management.

**Recommendation:** Implement a finite state machine:
```
States: Idle, Listening, Thinking, Speaking, Reacting, Emoting
Transitions: [
  Idle → Listening (on: speech.detected, fade: 300ms)
  Listening → Thinking (on: transcription.complete, fade: 200ms)
  Thinking → Speaking (on: tts.started, fade: 150ms)
  Speaking → Idle (on: tts.complete, fade: 500ms)
  Any → Reacting (on: vision.event, priority: high, fade: 200ms)
]
```

#### No Procedural Micro-Animation Layer

**Current:** All motion is keyframed from Unity source clips.  
**Impact:** Character feels "dead" between major state changes.

**Recommendation:** Add a procedural base layer that runs continuously:
```typescript
interface ProceduralLayer {
  breathing: { rate: number; amplitude: number; bones: ['spine', 'chest'] };
  blink: { minInterval: number; maxInterval: number; duration: number };
  sway: { frequency: number; amplitude: number; bones: ['hips'] };
  eyeDrift: { saccadeInterval: number; returnSpeed: number };
}
```
These are simple sine waves and random timers applied to specific bones — no keyframe data needed.

---

## LLM / TTS / STT Integration Planning

### Complete Voice Turn Flow

```
┌─────────────┐     ┌──────────────┐     ┌─────────────┐
│  Frontend   │     │   Backend    │     │  Providers  │
│  (Browser)  │     │  (FastAPI)   │     │  (GPU/CPU)  │
└──────┬──────┘     └──────┬───────┘     └──────┬──────┘
       │                    │                     │
       │ Audio stream ──────►                     │
       │                    │ VAD detects silence  │
       │                    │ ───────────────────► │
       │                    │                     │ Faster-Whisper
       │                    │ ◄─── transcript ─── │ transcribes
       │ ◄── listening ──── │                     │
       │   state event      │                     │
       │                    │ Memory retrieval     │
       │                    │ (SQLite + ChromaDB)  │
       │                    │                     │
       │                    │ Prompt assembly      │
       │                    │ ───────────────────► │
       │                    │                     │ LLaMA 3.1 8B
       │ ◄── thinking ───── │ ◄── stream tokens ─ │ generates
       │   state event      │                     │
       │                    │ First sentence ready │
       │                    │ ───────────────────► │
       │                    │                     │ GPT-SoVITS
       │ ◄── speaking ───── │ ◄── audio + timing─ │ synthesizes
       │   state event      │                     │
       │                    │                     │
       │ ◄── audio chunk ── │                     │
       │ ◄── viseme data ── │                     │
       │ ◄── anim intent ── │                     │
       │                    │                     │
       │ [plays audio]      │                     │
       │ [drives mouth]     │                     │
       │ [triggers gesture] │                     │
       │                    │                     │
       │ ◄── idle state ─── │ (turn complete)     │
       └────────────────────┴─────────────────────┘
```

### Critical Integration Decisions Needed

#### 1. VRAM Orchestration Strategy

**Problem:** 12GB cannot hold STT + LLM + TTS simultaneously in GPU memory.

**Options:**

| Strategy | Latency | Complexity | VRAM Efficiency |
|----------|---------|------------|-----------------|
| A. Sequential load/unload | High (~2-3s per swap) | Low | Perfect — one model at a time |
| B. STT on CPU, LLM+TTS on GPU | Medium | Medium | Good — Whisper CPU is viable |
| C. Shared GPU with offloading | Low | High | Variable — needs careful tuning |
| D. Smaller models (all fit) | Lowest | Lowest | All fit but quality drops |

**Recommendation:** Start with **Option B** — Faster-Whisper runs well on CPU (especially the Small model), freeing GPU for LLM and TTS which benefit most from acceleration. This avoids model-swap latency entirely for the common case.

If CPU STT latency is unacceptable, fall back to **Option A** with preemptive loading (start loading the next model while the current one finishes its work).

#### 2. Voice Activity Detection (VAD)

**Problem:** Faster-Whisper needs complete audio segments. Without VAD, you either transcribe silence or miss speech starts.

**Recommendation:** Use Silero-VAD (tiny ONNX model, <1MB, runs on CPU):
```python
# Detect speech boundaries
vad_model = silero_vad.load()

# Stream audio chunks → VAD → accumulate speech → send to Whisper
async for chunk in audio_stream:
    speech_prob = vad_model(chunk)
    if speech_prob > 0.5:
        buffer.append(chunk)
    elif buffer:  # silence after speech
        transcript = await whisper.transcribe(buffer)
        buffer.clear()
```

#### 3. Streaming LLM Response → Incremental TTS

**Problem:** Waiting for complete LLM response before starting TTS adds 3-5 seconds of latency.

**Recommendation:** Sentence-boundary streaming:
```python
async for token in llm.stream(prompt):
    text_buffer += token
    if is_sentence_boundary(text_buffer):
        # Start TTS on completed sentence immediately
        audio = await tts.synthesize(text_buffer)
        await emit_audio_chunk(audio)
        text_buffer = ""
```

This gives the user audio within ~1-2 seconds of the first completed sentence, while the LLM continues generating.

#### 4. Viseme Generation Strategy

**Problem:** GPT-SoVITS may not produce frame-accurate phoneme/viseme timing.

**Options:**

| Strategy | Quality | Latency | Complexity |
|----------|---------|---------|------------|
| A. Forced alignment (MFA) post-synthesis | High | +500ms | Medium |
| B. Audio amplitude → mouth shapes | Low-Medium | Realtime | Low |
| C. Text-to-phoneme prediction pre-synthesis | Medium | Minimal | Medium |
| D. Hybrid: amplitude live + alignment deferred | Good blend | Minimal | Medium |

**Recommendation:** Start with **Option D** — drive mouth open/close from audio amplitude in real-time (immediate, zero latency), then retroactively apply precise viseme timing from forced alignment if/when available. The user sees immediate mouth movement; quality improves over time.

#### 5. LLM Emotion/Intent Extraction

**Problem:** The animation system needs structured emotion hints from LLM output, but raw text doesn't carry this.

**Recommendation:** Use structured output or post-processing:
```python
# Option A: Structured output (if model supports)
response_schema = {
    "text": "string",
    "emotion": "enum[happy, sad, surprised, neutral, thinking, excited]",
    "gesture_hint": "enum[nod, wave, shrug, point, none]",
    "intensity": "float 0-1"
}

# Option B: Lightweight classifier on response text
emotion = classify_emotion(response_text)  # Tiny model or rule-based
```

---

## Lifelike Reactive Mode Concept

### The Vision

A character that feels *present* — not a static model that occasionally lip-syncs. The goal is the illusion of awareness, attention, and emotional response.

### Layer Architecture for Lifelike Behavior

```
┌─────────────────────────────────────────────────────────┐
│ Layer 5: Gaze Override                                   │
│ (Head + eye bone rotation toward camera/user face)      │
│ Priority: Highest on head/eye bones only                │
├─────────────────────────────────────────────────────────┤
│ Layer 4: Speech-Driven Motion                           │
│ (Viseme mouth shapes + emphasis body sway)              │
│ Priority: High on jaw/mouth, low on body               │
├─────────────────────────────────────────────────────────┤
│ Layer 3: Expression Blend                               │
│ (VRM expression blend shapes from emotion tags)         │
│ Priority: High on face blend shapes                     │
├─────────────────────────────────────────────────────────┤
│ Layer 2: State-Driven Upper Body                        │
│ (Listen lean, speak gestures, think pose)               │
│ Priority: Medium on upper body bones                    │
├─────────────────────────────────────────────────────────┤
│ Layer 1: Authored Base Animation                        │
│ (Looping idle clip, full body, low energy)              │
│ Priority: Base — overridden by higher layers            │
├─────────────────────────────────────────────────────────┤
│ Layer 0: Procedural Base                                │
│ (Breathing sine wave, blink timer, micro weight shift)  │
│ Priority: Lowest — always running, subtly visible       │
└─────────────────────────────────────────────────────────┘
```

### Bone Mask System (Required)

Each layer needs a per-bone influence weight so animations don't fight each other:

```typescript
interface BoneMask {
  [boneName: string]: number; // 0.0 = no influence, 1.0 = full control
}

const SPEECH_MASK: BoneMask = {
  jaw: 1.0,
  // mouth shapes via VRM expressions, not bones
  spine: 0.1,  // subtle body sway with speech
  chest: 0.1,
  upperArm_L: 0.2,  // light gesture emphasis
  upperArm_R: 0.2,
};

const GAZE_MASK: BoneMask = {
  head: 0.8,
  neck: 0.4,
  leftEye: 1.0,
  rightEye: 1.0,
};

const IDLE_MASK: BoneMask = {
  // All bones at 1.0 — but lower priority than above
  hips: 1.0, spine: 1.0, chest: 1.0, /* ... */
};
```

### Procedural Generators (Not Keyframed)

These run as code, not clip data:

```typescript
// Breathing — sine wave on spine/chest rotation
function proceduralBreathing(time: number): Quaternion[] {
  const breathCycle = Math.sin(time * BREATH_RATE) * BREATH_AMPLITUDE;
  return [
    quaternionFromEuler(breathCycle * 0.6, 0, 0),  // spine
    quaternionFromEuler(breathCycle * 0.4, 0, 0),  // chest
  ];
}

// Blink — random interval, fast close + slow open
function proceduralBlink(time: number, lastBlink: number): number {
  if (time - lastBlink > randomRange(2.0, 6.0)) {
    return blinkCurve(time - lastBlink); // returns 0-1 for eye close
  }
  return 0;
}

// Weight shift — very slow sine on hips
function proceduralSway(time: number): Quaternion {
  const sway = Math.sin(time * 0.3) * 0.005; // barely perceptible
  return quaternionFromEuler(0, 0, sway);
}
```

### Reactive Behavior Triggers

| Trigger | Source | Animation Response |
|---------|--------|-------------------|
| User starts speaking | VAD / STT | Transition to listening pose, increase eye contact |
| User pauses mid-sentence | VAD silence < 2s | Small nod, maintain attention |
| LLM generating | Backend event | Thinking pose — slight head tilt, gaze drift |
| TTS playing | Audio stream active | Speaking gestures, mouth driven by audio |
| User emotion detected | MediaPipe face | Mirror or complement expression |
| Long silence | Timer > 15s | Fidget animation, look away briefly, return |
| User returns after absence | Vision / audio resume | Acknowledgment gesture, smile expression |

### Implementation Sequence

1. **Now:** Implement crossfade between existing states (idle→speak→listen)
2. **Stage 5:** Add procedural breathing + blink on Layer 0
3. **Stage 5:** Add bone mask system for layer isolation
4. **Stage 5:** Add simple gaze (head looks at camera center)
5. **Stage 6:** Add MediaPipe face → gaze target (user's actual face position)
6. **Stage 6:** Add reactive expressions (mirror user emotion)
7. **Polish:** Tune timing, weights, and randomization for natural feel

---

## Prioritized Recommendations

### Priority 1 — Structural Fixes (Before Stage 3)

| # | Action | Owner | Impact |
|---|--------|-------|--------|
| 1 | Split `router.py` into per-domain route modules with `Depends()` DI | Tank | Unblocks provider integration |
| 2 | Add FastAPI `lifespan` for service singleton management | Tank | Prevents VRAM leaks |
| 3 | Add input length limits on operator commands | Tank | Security/stability |
| 4 | Document VRAM budget and model loading strategy in `docs/` | Trinity | Unblocks all AI integration |
| 5 | Add Silero-VAD to the STT integration plan | Link | Required for speech detection |

### Priority 2 — Animation System (Stage 5 Prep)

| # | Action | Owner | Impact |
|---|--------|-------|--------|
| 6 | Implement SLERP crossfade between animation states | Switch | Eliminates robotic snapping |
| 7 | Add animation state machine with priority interruption | Switch | Enables complex behavior |
| 8 | Add procedural breathing + blink layer | Switch | Gives character ambient life |
| 9 | Design bone mask / layer weight system | Switch + Trinity | Enables concurrent animation layers |
| 10 | Plan binary animation format migration | Link + Switch | Performance ceiling removal |

### Priority 3 — Integration Architecture (Stage 3-4)

| # | Action | Owner | Impact |
|---|--------|-------|--------|
| 11 | Implement sentence-boundary streaming (LLM → TTS) | Link | Cuts perceived latency by 50%+ |
| 12 | Add amplitude-driven mouth movement (immediate visemes) | Switch + Link | Instant lip-sync without forced alignment |
| 13 | Design model loading lifecycle (which models when) | Tank + Link | Prevents VRAM contention |
| 14 | Add fallback TTS (Piper ONNX) for GPT-SoVITS failures | Link | Resilience |
| 15 | Add structured emotion output from LLM | Link | Feeds expression system |

### Priority 4 — Code Quality (Ongoing)

| # | Action | Owner | Impact |
|---|--------|-------|--------|
| 16 | Decompose `App.tsx` into feature hooks + surface components | Switch | Maintainability |
| 17 | Add session persistence migration path (in-memory → SQLite) | Tank | Required for Stage 4 |
| 18 | Document "happy path" latency budget end-to-end | Trinity | Team alignment on performance targets |
| 19 | Add real integration tests with audio fixtures | Mouse | Validates actual provider behavior |
| 20 | Plan the prompt engineering strategy per-character | Link | Quality of LLM personality |

---

## Risk Register

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| GPT-SoVITS too complex/brittle to maintain | Medium-High | High | Have Piper TTS fallback ready; evaluate Coqui XTTS v2 |
| VRAM contention causes OOM under real load | High | High | Design explicit load/unload choreography NOW |
| End-to-end latency exceeds 5s (feels unresponsive) | Medium | High | Streaming LLM→TTS, amplitude-driven visemes, "thinking" animations |
| Animation system can't blend layers smoothly | Medium | Medium | Invest in bone mask + SLERP crossfade before adding more clips |
| Single developer burnout / velocity drop | Medium | High | Consolidate decisions periodically; don't expand scope before Stage 3 is proven |
| Faster-Whisper Medium doesn't fit alongside LLM+TTS | Low-Medium | Medium | CPU-only Whisper or Small model fallback |
| VRM characters have inconsistent rig quality | Low | Medium | Validation pipeline already exists; keep enforcing it |
| Squad AI drift produces conflicting decisions | Medium | Medium | Human review pass every 2-3 days; prune contradictions |

---

## Squad Effectiveness Notes

### What's Working

- **Decision tracking** — 100+ decisions in 1.5 days with timestamps, rationale, and attribution
- **Contract-first discipline** — The team consistently defines interfaces before implementation
- **Stability harness** — Automated regression testing from day 1 is unusual and valuable
- **Clear ownership** — Trinity/Switch/Tank/Link/Mouse domains are well-delineated

### What Needs Adjustment

- **Scaffolding-to-implementation ratio** — Heavy on contracts and documentation, light on battle-tested runtime code. The next phase should shift toward "prove it works with real data."
- **Decision volume** — 100+ decisions is a lot to maintain as authoritative. Consider archiving older decisions and keeping only the 20-30 most current/relevant in the active file.
- **Consolidation cadence** — Schedule a human review every 2-3 days to:
  - Prune contradictory decisions
  - Identify drift between what's documented and what's built
  - Confirm priorities haven't shifted

---

## Guidance for Next Planning Cycle

### The Single Most Important Next Step

**Get one full voice turn working with real providers.**

Not two. Not all of them. One complete cycle:
1. Real Faster-Whisper (even Small model on CPU) transcribes actual speech
2. Real LLaMA 3.1 8B generates a response with actual inference
3. Real audio comes out (even Piper TTS if GPT-SoVITS isn't ready)
4. The avatar's mouth moves in time with the audio

This single vertical slice will:
- Expose the real latency profile
- Force the VRAM management question
- Prove the contract boundaries hold under real data
- Give you something to demo and iterate on

Everything else — better animations, vision, character swapping, polish — comes after this loop works.

### Suggested Sprint Plan (Next 3-5 Days)

**Sprint Goal:** "A user can speak to the character and hear a real synthesized response with basic lip-sync."

| Day | Focus | Key Deliverable |
|-----|-------|----------------|
| 1 | Router refactor + DI setup | Clean FastAPI service lifecycle |
| 1 | Silero-VAD + audio capture bridge | Frontend can detect speech boundaries |
| 2 | Faster-Whisper Small on CPU | Real transcription from microphone input |
| 2 | Ollama integration (LLaMA 3.1 8B) | Real LLM response from transcript |
| 3 | TTS integration (Piper as safe fallback) | Real audio synthesis from LLM text |
| 3 | Audio playback bridge in frontend | Avatar plays synthesized audio |
| 4 | Amplitude-driven mouth movement | Basic lip-sync from audio waveform |
| 4 | Animation crossfade (idle↔speak↔listen) | Smooth state transitions |
| 5 | End-to-end latency measurement | Documented real performance numbers |
| 5 | GPT-SoVITS attempt (stretch goal) | Higher quality TTS if viable |

### What NOT To Do Next

- ❌ Don't expand the animation DSL schema further until playback proves the current format works
- ❌ Don't add vision/MediaPipe until the voice loop is solid
- ❌ Don't optimize (binary formats, compression) until you know what's slow
- ❌ Don't add more character packages until one character fully works end-to-end
- ❌ Don't build memory/persistence until you have real conversations to persist

### Latency Budget Target

Document and target these numbers:

```
Voice Activity Detection:     ~100ms (silence detection delay)
Audio → Transcription:        ~800ms (Whisper Small on CPU)
Memory Retrieval:             ~100ms (ChromaDB query, deferred to Stage 4)
Prompt Assembly:              ~50ms
LLM First Token:              ~500ms (8B Q4 on GPU)
LLM Full Response:            ~2500ms (streaming, first sentence at ~800ms)
TTS First Audio Chunk:        ~400ms (from first complete sentence)
Audio Delivery to Frontend:   ~50ms

Total user-perceived latency: ~2.0-2.5s (with streaming)
Without streaming:            ~4.5-5.5s (unacceptable)
```

The streaming architecture (sentence-boundary LLM → incremental TTS) is **mandatory**, not optional. Without it, the experience feels broken.

---

## Appendix: Technology Notes

### GPT-SoVITS Operational Concerns

- Requires specific PyTorch version + CUDA toolkit alignment
- Voice cloning needs 3-10 seconds of reference audio per character
- Inference speed varies significantly by GPU generation
- The 2026 fork may have breaking changes from earlier documentation
- **Recommendation:** Keep Piper TTS as a permanent fallback, not just a temporary crutch

### Faster-Whisper CPU vs GPU

- **GPU (Medium model):** ~1.5x realtime, ~2GB VRAM
- **CPU (Small model):** ~3x realtime, 0 VRAM, ~500MB RAM
- **CPU (Medium model):** ~1x realtime (barely acceptable), 0 VRAM, ~1.5GB RAM
- **Recommendation:** Start with CPU Small. Only move to GPU if latency is unacceptable after streaming is implemented.

### LLaMA 3.1 8B Q4_K_M via Ollama

- ~5GB VRAM when loaded
- Ollama handles model lifecycle (loading/unloading)
- Supports streaming token output natively
- Context window: 8K tokens (sufficient for conversation + short memory)
- **Recommendation:** Use Ollama's REST API directly from the backend adapter. Don't embed llama.cpp — Ollama handles the complexity.

### UniVRM 1.0 + three-vrm Animation Constraints

- VRM normalized bone rotations use a T-pose reference
- `setNormalizedPose()` accepts per-bone quaternion rotations
- Blend shapes (expressions) are separate from bone animation
- three-vrm supports `.vrma` (VRM Animation) format natively — future upgrade path
- **Recommendation:** When ready for binary format, `.vrma` is the natural choice over custom formats

---

*End of review. This document should be treated as guidance, not prescription. Adapt recommendations to what you learn from real integration work.*
