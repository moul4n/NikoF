# Live Info Tools — Design Proposal (Ambient Context + Tool Routing)

**Status:** Draft for review · **Branch:** `claude/peaceful-brahmagupta-6oz54x` · **Date:** 2026-06-24
**Companion to:** `docs/STREAMING_PERFORMANCE_PLAN.md` (latency budget), `docs/MEMORY_ARCHITECTURE.md` (prompt context), `CLAUDE.md` (local-only ethos, contracts-first)
**Scope of this doc:** design + plan only. No code, contract, or baseline changes land with this file.

---

## 1. Goal & scope

Let NikoF answer questions whose answers are **not in the LLM's weights** — time/date/day, weather,
news, sports, maps/places, general web lookups — *naturally*, without the user learning trigger
words, and **without adding an LLM round-trip to every turn**.

Two mechanisms, deliberately layered:

1. **Ambient context (Tier 0):** a small, compact, always-present block of cheap *local* facts
   (clock, date, day-of-week, configured location, last-known weather) injected at **low priority**
   into the planner prompt every turn. No tool call, no network, no extra latency. Removes the most
   common "live" questions entirely.
2. **Tools (Tier 1+):** genuinely dynamic / unknowable data (live forecast, news, scores, places,
   search) fetched on demand via a backend **tool broker**, selected by the model through a single
   nullable field in the planner contract it already returns.

**In scope:** the routing mechanism, the ambient-context block, the tool-broker boundary, the
local↔network trust boundary, a value/effort-ranked tool roadmap, and the staged delivery plan.

**Out of scope (here):** the concrete fetch code, per-provider API wiring, and the Unity client's
consumption of any new contract (it is a second consumer — keep tool I/O web-agnostic, per
`CLAUDE.md`).

---

## 2. Current flow (verified, with citations)

- The turn is a **single-shot structured planner**, not an agent loop. `run_user_text_turn`
  (`backend/app/services/turns.py:109`) builds one prompt, calls
  `text_generation_service.generate()` / `generate_stream()` (`turns.py:196–227`) with
  `expect_structured_output=True` (`turns.py:182`), and the returned `AssistantMessageContract`
  drives TTS + animation. **The model never gets to say "I need to look something up."**
- The prompt is built by `_build_spoken_reply_prompt` / `_build_lean_reply_prompt`
  (`backend/app/services/turns_prompts.py`). The planner JSON shape is described inline; `reply_text`
  is the **first** field (full planner: `turns_prompts.py:143`; lean: `turns_prompts.py:54`).
- The Ollama adapter posts to **`/api/generate`** (single prompt string), not `/api/chat`, with
  `"stream": False` or NDJSON streaming, and `"format":"json"` when structured
  (`backend/app/services/llm.py:262–273`, `:366–373`). Streaming relies on `reply_text` being the
  first field so `ReplyTextStreamExtractor` can emit prose early (see
  `docs/PHASE1_STREAMING_LLM_TTS_DESIGN.md` §3).
- The authoritative reply contract is `AssistantMessageContract`
  (`backend/app/schemas/session.py:173`): `profile_id, status, text, locale, thinking_summary,
  feeling, voice_tone, animation_cues, memory_writebacks`.
- Memory context is already retrieved per turn via `memory_service.get_prompt_context(query_text=…)`
  (`turns.py:133`) under a token budget (`memory_prompt_token_budget`). **Ambient context is a
  natural sibling of this injection.**
- A "thinking" animation snapshot is already published before generation
  (`_build_llm_thinking_animation_snapshot`, `turns.py:161`). **This is the hook for hiding
  tool-fetch latency behind a "let me check…" beat.**
- Context size is an explicit knob: `_generation_options()` sets `num_ctx` from
  `runtime_tuning.llm_num_ctx` (`llm.py:137–150`). Ambient + tool-schema tokens are charged here.

---

## 3. Design principle: which layer decides

The three goals — **reliable**, **natural (no keywords)**, **few LLM calls** — pull against each
other only if a single layer tries to satisfy all three. Split them:

| Question class | Decided by | LLM calls | Network |
|---|---|---|---|
| Time, date, day, "is it the weekend", configured location, *last-known* weather | **Ambient context** (in prompt) | 1 (unchanged) | none |
| Live forecast, news, scores, places, web search | **Planner field** (`tool_request`) | 2 (only on tool turns) | lookup only |

The model decides tool use on **meaning**, never surface keywords. "Will I need a coat later?"
routes to weather; "you're a breath of fresh air" does not.

---

## 4. Tier 0 — Ambient context block

A compact, low-priority block appended to the planner prompt every turn, e.g.:

```
[AMBIENT]   (advisory; only state these if relevant to the user's message)
local_time: Wed 24 Jun 2026 14:30 (Europe/London)
day_type: weekday
location: Brighton, UK
weather_cached: 18°C, light cloud (as of 14:20)
```

Properties:

- **Low priority / advisory.** Phrased so the model *uses it when relevant* and otherwise ignores
  it — it must not derail normal chit-chat or bias every reply toward the weather. Placed after
  persona/memory and before `[CURRENT_INPUT]`, mirroring the existing block ordering in
  `_build_spoken_reply_prompt`.
- **Cheap to produce.** Time/date/day from the system clock + configured timezone. Location from a
  **configured home location** in settings (a desktop has no GPS — see §8 Risk R3). Weather is the
  **last cached** value from the Tier-1 weather tool (may be absent until first fetched; the line is
  simply omitted when unknown).
- **Token-bounded.** A handful of lines, charged against `num_ctx`. Must respect the same discipline
  as `memory_prompt_token_budget`; add an `ambient_context` budget knob rather than letting it grow.
- **Localization.** Format date/time per `locale` (the turn already carries `locale`).

**Effect:** "what day is it", "what time is it", "is it the weekend", "what's it like out (roughly)"
become **zero-tool, zero-latency, and correct** — which native clock tool-calling could not even do
faster. This is the single biggest call-reduction lever.

---

## 5. Tier 1+ — Tool routing via one planner field

### 5.1 The routing field

Extend the planner JSON (and `AssistantMessageContract`) with **one nullable field**:

```jsonc
{
  "reply_text": "…",                 // still FIRST — preserves streaming extractor
  "tool_request": {                  // null on the vast majority of turns
    "name": "weather_forecast",
    "args": { "location": "home", "when": "friday" }
  },
  "feeling": { … }, "animation_cues": [ … ], …
}
```

Turn loop becomes (bounded):

```
generate(planner)                      # call 1 — already paid for today
  ├─ tool_request == null  → speak reply_text          (1 call, unchanged cost)
  └─ tool_request != null  → broker.execute(tool_request)
                             → append [TOOL_RESULT] to prompt
                             → generate(planner)        # call 2, phrases the answer
```

- **Default cost is unchanged on the non-streaming path.** Non-tool turns return `tool_request:
  null` in the *same* generation we already run — no separate router model, no per-turn classifier
  tax. **Caveat:** under Phase-1 streaming this is not strictly free, because call 1 cannot stream to
  TTS when it might turn out to be a tool turn (see §8 R1 and the time-to-speak analysis in §11).
- **Tool turns cost exactly one extra generation + one fetch**, capped by a **hop limit (2–3)** so it
  can never spiral.
- This reuses the existing `expect_structured_output` path. It is preferable to Ollama's native
  `/api/chat` tool-calling *for us* because we are already in structured-JSON mode on `/api/generate`
  and do not want to migrate transports or attach a separate tool-call schema layer (see §7 Decision
  D1).

### 5.2 Making the "I don't know this" judgment reliable on an 8B

The dominant failure on a small model is the **false negative** (confidently inventing a score).
Mitigations, all prompt-level and cheap:

- **Explicit knowledge boundary** in the prompt: "You have no live access to news, sports results,
  or forecasts beyond `[AMBIENT]`. For those, emit a `tool_request` instead of guessing."
- **Small, crisply described, fixed toolset** (5–6 tools). Small models route well over a handful of
  well-named tools and badly over large catalogs.
- **Graceful degrade:** if the broker returns `unavailable` (offline, domain not allowlisted, fetch
  failed), the second generation must speak a natural "I can't reach that right now" — never a
  hallucinated number. The existing `status` machinery on contracts carries this.

The false-positive direction (calling a tool for a metaphor) is rarer and self-correcting: an
irrelevant `[TOOL_RESULT]` is simply not used by the second generation; the hop cap bounds cost.

### 5.3 The tool broker

New backend service `backend/app/services/tools/` (proposed):

- `ToolBroker` — holds a registry of tool adapters; validates `tool_request.name`/`args` against a
  declared JSON schema; executes; returns a typed `ToolResult` (`status`, `summary`, `data`,
  `source`, `fetched_at`).
- Per-capability adapters (`weather.py`, `search.py`, `places.py`, …), each declaring
  name/description/params + `execute()`.
- **Privacy contract:** an adapter sends **only its minimal query** (a city, a league) outbound —
  never transcript, persona, or memory. This is a contract-level guarantee, not a convention (§6).
- **Allowlist + caching + offline-degrade** live in the broker, uniformly, not per adapter.
- If a capability is better served by an existing **MCP server**, the adapter wraps it: the backend
  is the MCP *host/client*, mapping MCP tool schemas → our `tool_request` schema. Ollama is **not**
  an MCP client; MCP is a transport/catalog behind the broker, not a replacement for the routing
  field.

---

## 6. Local ↔ network trust boundary

`CLAUDE.md`: *"No cloud services in the core loop."* This design honors that by drawing the line
precisely:

- **Stays 100% local:** LLM, memory, persona, STT, TTS, avatar, **and all reasoning**. We do **not**
  offload thinking to a cloud AI.
- **The only thing that leaves the machine** is a narrow, typed *data fetch* on an actual tool
  invocation (e.g. `GET forecast for lat/lon`), exactly like a phone weather app. The conversation
  does not leave the box.

Guardrails (broker-enforced):

- **Domain allowlist**, config-driven. Non-allowlisted or offline → `unavailable` → graceful spoken
  degrade.
- **Minimal-egress guarantee:** only the tool's query fields leave; never transcript/persona/memory.
- **Secrets discipline** (`CLAUDE.md`): no API keys in committed files; keyed providers read keys
  from local config/env at runtime, and the repo ships keyless providers by default (§7 D2).
- **Self-hostable search** (e.g. SearXNG) keeps even query text off third-party servers where the
  user wants maximum locality.

---

## 7. Decisions

- **D1 — Route via a planner field on `/api/generate`, not native `/api/chat` tool-calling.** Keeps
  the current transport and structured-output path; zero extra cost on non-tool turns; no separate
  router model. Native tool-calling stays a possible future swap behind the broker if the model is
  upgraded.
- **D2 — Keyless, low-effort providers first; keyed/Google providers are a later opt-in tier.**
  Aligns with both the user's value/effort priority and the secrets rule. Concretely:
  - Weather/forecast → **Open-Meteo** (free, **no key**, lat/lon).
  - Geocoding/places → **OpenStreetMap / Nominatim** (keyless; respect usage policy) before Google
    Maps/Places (keyed, billed).
  - Web search → **SearXNG (self-host)** or DuckDuckGo-style endpoint before Google Programmable
    Search (keyed, billed, quota'd).
  - News → public RSS/Atom feeds before keyed news APIs.
  Google Maps/Search remain on the roadmap as a **keyed Tier 2** the user can opt into, not the
  default path.
- **D3 — `reply_text` stays the first JSON field.** `tool_request` is added *after* it so the
  Phase-1 streaming extractor's "first field" assumption is preserved (see §8 R1).
- **D4 — Contracts-first.** The `tool_request` field + `ToolResult` are new locked contracts:
  schema + fixtures + stability baselines update in the **same** change that adds them
  (`tests/contracts/schemas/`, `tests/stability/baselines/`). Per `CLAUDE.md`, baseline refresh is an
  intentional act, not a way to green a red suite.

---

## 8. Risks, discrepancies & open questions

- **R1 — Streaming extractor coupling (real).** Phase-1 streaming depends on `reply_text` being the
  first field and emits its characters until the closing quote. Adding `tool_request` is safe *only*
  if (a) it is placed after `reply_text` (D3), and (b) we never want to stream a turn that ends up
  being a tool turn. But a tool turn *shouldn't* stream `reply_text` to TTS at all — the first
  generation's `reply_text` may be empty/placeholder when `tool_request` is set. **Open question:**
  on a tool turn, suppress segment dispatch from call 1 and only stream call 2. Needs a rule in
  `_run_streamed_generation` so we don't speak a placeholder. **This is the trickiest interaction and
  must be designed before coding.**
- **R2 — Two planner prompts.** There are *two* builders: full (`memory_writebacks`, `voice_tone`,
  `thinking_summary`) and **lean** (`_build_lean_reply_prompt`, which drops fields for latency).
  `tool_request` must be added to **both**, and the knowledge-boundary line too, or routing silently
  breaks whenever `llm_lean_planner` is on. Easy to miss.
- **R3 — "Location" has no source on desktop.** No GPS. Location must be a **configured** setting
  (home city / lat-lon). Until set, the ambient `location`/`weather` lines are omitted and
  location-dependent tools must ask the user or fail gracefully. Decide where this config lives
  (settings file vs. character profile vs. a new user-prefs store).
- **R4 — Latency on tool turns.** Worst case ≈ 2× LLM + 1 fetch. Acceptable **only** because (a)
  ambient context removes most "live" turns, (b) TTL caching collapses repeats (weather ~10 min,
  news ~5 min, scores ~30 s), and (c) the fetch hides behind the existing thinking animation +
  a "let me check…" filler utterance. Without the filler this will *feel* like a stall. Budget it
  against `docs/STREAMING_PERFORMANCE_PLAN.md`.
- **R5 — `num_ctx` pressure.** Ambient block + tool schemas + knowledge-boundary text all consume the
  fixed `llm_num_ctx`. On an 8B with a small context this competes with memory. Keep the toolset tiny
  and the ambient block bounded; add an explicit `ambient_context` token budget. Reconsider a cheap
  invisible pre-gate (attach tool schemas only when a turn *might* need them) **only if** telemetry
  shows first-token latency regressing — not on day one (it reintroduces brittleness).
- **R6 — Small-model JSON fragility.** Adding a nested object (`tool_request`) to an already-large
  planner JSON raises malformed-output risk. The existing
  `_normalize_structured_or_safe_fallback` (`llm.py:309`) must treat a malformed/partial
  `tool_request` as "no tool" and fall through to plain reply, never as an error spoken aloud.
- **R7 — Tool-result trust.** Tool output is untrusted external text entering the prompt. Wrap
  `[TOOL_RESULT]` so the model treats it as *data to summarize*, not instructions to follow (prompt-
  injection hygiene), and cap its length.
- **R8 — Nominatim/SearXNG usage policies.** Keyless ≠ unlimited. Nominatim has a usage policy
  (rate limits, attribution); a self-hosted SearXNG avoids third-party quota but adds a sidecar to
  the backend-owned lifecycle (`core/process_supervision.py`). Factor sidecar ownership in if we
  self-host.

---

## 9. Tool roadmap (value × effort)

Prioritized per the user's steer: **high value, low effort, keyless first; complex/keyed/custom-API
later.**

| Tier | Capability | Provider (default) | Key? | Effort | Value | Notes |
|---|---|---|---|---|---|---|
| 0 | Clock / date / day / location (ambient) | system clock + config | no | **XS** | **High** | Not a tool — in prompt. Build first. |
| 0 | Last-known weather (ambient line) | cache from T1 weather | no | XS | High | Appears once T1 weather has run once. |
| 1 | Live / forecast weather | **Open-Meteo** | no | S | High | Proves fetch + allowlist + cache + degrade. |
| 1 | Web search | **SearXNG (self-host)** / DDG | no* | S–M | High | *Self-host = a backend-owned sidecar. |
| 1 | News headlines | public RSS/Atom | no | S | Med-High | Per-topic feed list in config. |
| 2 | Places / geocoding | **OSM/Nominatim** | no | M | Med | Respect usage policy (R8). |
| 2 | Sports scores | public sports API | varies | M | Med | Pick a keyless/free-tier source if possible. |
| 3 | Google Maps / Places | Google | **yes** | M-L | Med | Opt-in keyed tier; better data, billed. |
| 3 | Google Programmable Search | Google | **yes** | M | Med | Opt-in keyed tier; quota'd. |
| 3 | Tides | regional tide API | varies | M | Low-Med | Often regional/keyed — defer. |

---

## 10. Staged delivery (de-risks the contract change)

1. **Stage A — Ambient context only.** Add the `[AMBIENT]` block (time/date/day/location) to both
   planner builders behind a flag. **No new tool, no contract change, no network.** Validates the
   prompt-bloat / `num_ctx` budget and the "advisory, don't derail chit-chat" tuning in isolation.
   > **Status (2026-06-25): landed, disabled by default, control-surface editable.**
   > `app/services/turns_ambient.py` renders an advisory `[AMBIENT]` block (local time, day_type,
   > optional location); injected into both planner builders (`turns_prompts.py`) and wired at the
   > `run_user_text_turn` call site. Config lives in a **durable, control-surface-editable store**
   > (`app/services/ambient_context.py`, persisted to `session/ambient-context.json`) read **live per
   > turn** so a UI change applies without a restart — resolving R3. Seam: `GET`/`PUT
   > /session/ambient-context` (`AmbientContextUpdateRequest`); edited from the **LLM tab → "Time &
   > place awareness" panel** (`ControlSurfaceAmbientContextPanel.tsx` + `loaders/ambientContext.ts`).
   > **Timezone defaults to `Europe/London`** (an empty value falls back to it); `tzdata` is a backend
   > dep so IANA zones resolve on Windows. The `NIKOF_AMBIENT_*` env vars now only **seed** first-run
   > defaults. Block kept intentionally tiny, so no runtime token-budget knob (deviation from R5 —
   > revisit if the toolset grows). Tested in `backend/tests/test_ambient_context.py` +
   > `test_settings_persistence.py`; backend suite, contract gate, and frontend build all green.
1a. **Stage A+ — Ambient weather line (keyless, no LLM tool loop).**
   > **Status (2026-06-25): landed, opt-in (`weather_enabled`), off by default.** A cached
   > current-weather line (`weather: 14°C, light rain (as of 14:22)`) is appended to the `[AMBIENT]`
   > block when weather is enabled. `app/services/weather.py` uses **Open-Meteo** (free, **keyless**):
   > geocodes the **location label**, or — when blank — the **timezone's city** (`Europe/London` →
   > "London"), then fetches current conditions. The refresh runs in a **background daemon thread**, so
   > a stale cache only *schedules* a fetch and weather **never adds turn latency**; it **degrades
   > silently** to no line when offline / not-yet-cached. This is the project's **first outbound
   > network call** — only a lat/lon leaves the machine, never conversation/persona/memory (honors the
   > local-only boundary, §6). Reuses the ambient store (`weather_enabled` flag) + a Weather toggle in
   > the same control panel. It is the precursor the doc described — *not* the Stage B tool loop (no
   > `tool_request`, no second LLM pass, no R1). Tested in `backend/tests/test_weather.py` +
   > `test_ambient_context.py`.
2. **Stage B — `tool_request` contract + broker skeleton + ONE keyless tool (Open-Meteo *forecast*).**
   Lands the locked contract (schema + fixtures + baselines, D4), the bounded turn loop with hop cap,
   caching, allowlist, offline-degrade, and the thinking-animation/filler. Resolves R1 (streaming
   suppression on tool turns) here. (Current *ambient* weather already lands in Stage A+ above; Stage B
   adds on-demand **forecasts** / "will it rain Friday" via the LLM-routed tool.)
3. **Stage C — Generalize the broker; add keyless search + news.** Optionally self-host SearXNG as a
   backend-owned sidecar.
4. **Stage D — Keyed Tier (opt-in): Google Maps/Search, sports, tides.** Behind config-supplied keys,
   off by default, secrets read at runtime only.

Each stage is independently shippable and flag-gated; the ambient win (Stage A) lands value before
any tool exists.

---

## 11. Performance & time-to-speak (the filler mechanism)

> Numbers below are **order-of-magnitude estimates** for an 8B Q4 model on a ~12 GB VRAM box, **not
> measured on this machine.** The turn pipeline already records `llm_ms`, `tts_ms`, and `memory_ms`
> per turn via `get_turn_telemetry()` (`turns.py:445`), so Stage A should replace every estimate here
> with measured truth *before* committing to the Stage B loop. **Measure first.**

### 11.1 Three turn shapes

- **Normal / ambient turn** (chat, "what time is it", "is it the weekend", "roughly what's it
  like out"): identical to today — one LLM pass, streams to TTS as now. **Zero added latency.** The
  `[AMBIENT]` block only makes the answer *correct* instead of hallucinated.
- **Tool turn, naïve** ("forecast Friday", "latest score"): pays a **full second LLM pass + a network
  fetch** not paid today, and per R1 loses first-pass streaming. Without mitigation this feels like a
  2–5 s stall before *any* audio.
- **Tool turn, with filler** (the design): call 1 returns a **spoken filler** as its `reply_text`
  *together with* the `tool_request`, so first audio lands on time and the fetch + second pass happen
  *under* the filler audio.

### 11.2 The filler mechanism (load-bearing)

```
LLM call 1 → speak reply_text = "Let me check Friday's forecast…"   (TTS starts now)
           ↳ in parallel: broker.fetch → LLM call 2 → speak the real answer
```

- Time-to-**first**-audio on a tool turn ≈ a normal turn, because the filler *is* a normal short
  reply. The user perceives "she acknowledged, then answered," not "she froze."
- The existing **thinking-animation** publish (`_build_llm_thinking_animation_snapshot`,
  `turns.py:161`) covers the visual seam during the fetch.
- Filler can be sourced two ways: (a) the model emits it as call-1 `reply_text` alongside
  `tool_request` (most natural, context-aware: "ooh, Friday — one sec"), or (b) a backend canned
  line if call 1 returns an empty `reply_text` (deterministic fallback). Both cost the same; prefer
  (a), fall back to (b).
- **Interaction with R1/R3 (status gating):** call 1 on a tool turn must speak the filler but **not**
  trigger answer synthesis as if the turn were complete — this is why a `tool_pending`-style status
  is needed so the pipeline treats call-1 output as filler-only, not the final utterance.

### 11.3 Rough budget

| Metric | Normal turn (today) | Tool turn, naïve | Tool turn, **with filler** |
|---|---|---|---|
| Time-to-**first** audio | ~1–3 s | ~3–7 s (stall) | **~1–3 s** (filler) |
| Time-to-**real-answer** audio | ~1–3 s | ~3–7 s | ~3–6 s (under filler) |
| Added LLM passes | 0 | +1 | +1 |
| Added network | none | 1 fetch (weather ~0.1–0.5 s; search ~0.3–2 s) | same |

The load-bearing row is **time-to-first audio holding at ~1–3 s with the filler** — that is the
difference between "natural companion" and "laggy bot." The real answer still arrives a couple
seconds later, but behind audio, so it does not read as latency.

### 11.4 What actually moves these numbers

- **Cold model load dominates everything.** `CLAUDE.md` flags lazy-load on first use; a cold tool
  turn can add *seconds*. A warmup / keep-alive is worth more than any micro-optimization here.
- **Caching** (TTL: weather ~10 min, news ~5 min, scores ~30 s) collapses a repeat ask back to a
  single-pass Case-1 turn.
- **Ambient block + tool schemas** add prompt tokens to *every* turn, nudging first-token latency up
  slightly even on normal turns — keep the toolset tiny and the ambient block budgeted (R5).
- **Filler quality** is the whole perceived-latency game; a context-aware filler beats a canned one
  at the same cost.

### 11.5 Recommendation

Build **Stage A (ambient) first**, turn on the existing turn telemetry, and read the *actual*
`llm_ms` / `tts_ms` off the target box. That yields a real filler-budget number before committing to
the Stage B tool loop — no guessing about whether the filler comfortably covers the fetch + second
pass.

## 12. Summary

- **Routing is free on the common path (non-streaming):** one nullable `tool_request` field rides the
  planner JSON we already generate. No router model, no per-turn tax, no keywords — the model decides
  on meaning. Under streaming there is a real interaction (R1) addressed by the filler design (§11).
- **Tool turns cost +1 LLM pass + a fetch (~2–5 s to the real answer), but the filler keeps
  time-to-first-audio at ~1–3 s** so they feel conversational, not laggy (§11). Cold model load, not
  the fetch, is the biggest real latency risk — warm the model.
- **Ambient context removes most "live" questions** before they can become tool calls, and answers
  them correctly with zero latency.
- **Only typed data fetches leave the machine**, never the conversation — the local-only ethos holds.
- **Keyless, high-value, low-effort tools first** (Open-Meteo, RSS, SearXNG/OSM); Google/keyed
  providers are a later opt-in tier.
- **Biggest design risk is the streaming/tool-turn interaction (R1)** and remembering **both** planner
  builders (R2); both are called out for Stage B.
