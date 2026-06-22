# Memory & Context Architecture — NikoF

**Status:** living design doc · **Started:** 2026-06-22 · **Owner:** backend

How the companion remembers, what reaches the LLM each turn, and the staged plan
to grow it into a stable, tiered memory system that stays fast on a 12 GB box and
keeps the character believable. This doc is the reference for the memory work;
each stage below is independently shippable.

---

## 1. Current state (as built)

### 1.1 Two services, one live

- **`backend/app/services/companion_memory.py` — `SqliteCompanionMemoryService` (LIVE).**
  Backs `persona_core`, `demeanor_state`, `character_profile`, `appearance_versions`,
  and the `memory_entries` table. Wired into every turn from `turns.py`.
- **`backend/app/services/memory.py` — `SqliteSessionMemoryService` (RETIRED, Stage 2).**
  Was a parallel `session-memory.sqlite3` contract with its own token-overlap
  recall, referenced only by a dead test import and the legacy `.squad` notes —
  never by the pipeline. Deleted 2026-06-22; CLAUDE.md forbids parallel contracts.
  `companion_memory.py` is now the single memory contract.

### 1.2 The per-turn loop (live)

1. **Retrieve** — `get_prompt_context()` builds a candidate set:
   *last 64 entries* (recency window) **∪** *all durable facts* (salience ≥ `0.6`
   and not tagged `dialog`, capped 256). Candidates are scored by
   `_score_memory_entries()`: `salience + token_overlap×0.2 + tiny recency tiebreak`.
   Raw dialog turns surface **only** on keyword overlap; durable facts may surface
   on salience alone.
2. **Assemble** — `turns_prompts.py` injects persona, demeanor (mood/energy),
   `[RETRIEVED_MEMORY]`, `[RECENT_BUFFER]` (last 4), and the operator character
   profile. The lean planner drops most of this to save tokens.
3. **Generate** — Ollama `/api/generate`, structured JSON.
4. **Write back** — `turns_memory.py`: every turn's raw user+assistant text is
   stored as a `dialog` entry; durable facts are extracted by a **separate
   off-critical-path LLM call** in a background thread. Salience is estimated by
   keyword heuristics (`estimate_memory_salience`), with life-fact tokens
   (birthday, family, allergy…) floored to durable.

### 1.3 What is already good

The retrieval model is a rough version of the Stanford **Generative Agents**
memory stream (importance × relevance × recency) — the right reference for a
*believable character*, not a Q&A bot. The durable-vs-dialog split, the salience
floor for life facts, and the deliberate "recency only breaks ties so she does
not loop back to the previous topic" decision are sound and regression-tested.

---

## 2. Gaps vs. how LLM memory is normally done

Modern stacks (MemGPT/Letta, Generative Agents, ChatGPT/Claude memory) are a
**tiered hierarchy with active maintenance**. NikoF has the tiers in embryo but
none of the maintenance.

| Capability | Industry norm | NikoF today |
|---|---|---|
| Working memory (verbatim recent turns) | rolling window | partial — last-4 summaries |
| Episodic summarization | roll old turns into summaries | **none** — raw turns kept forever |
| Semantic / long-term facts | embedding (vector) recall | **keyword overlap only** |
| Reflection / consolidation | periodic insight synthesis | **none** |
| Deduplication | merge repeated facts | **none** |
| Decay / forgetting | exponential recency decay + prune | **none** — table grows unbounded |
| Context budgeting | token budget, paging | **none** until Stage 1 |

### 2.1 The critical correctness finding — unmanaged context window

The Ollama payload in `llm.py` sent `model`/`prompt`/`format`/`stream` but
**never set `num_ctx`**, so Ollama applied its small default context
(historically 2048, 4096 in newer builds) regardless of the model's real
capacity. As memory grows, the assembled prompt can **silently overflow and
truncate from the front** — the model stops seeing the earliest instructions with
no error. Fixed in **Stage 1**.

---

## 3. Resource envelope (what we can afford)

From `docs/TTS_ENGINE_BENCHMARK.md` and the resource monitor:

- **GPU: 12 GB.** LLM resident ≈ 5.5 GB (qwen3:4b less). Kokoro on CPU frees
  ~3.5 GB. **~4–6 GB VRAM headroom sits idle** during and between turns.
- **Latency is LLM-bound** (~0.84 s lean qwen3:4b → ~4.4 s full llama3.2:3b).
  SQLite retrieval is sub-millisecond and not a factor.
- Between turns the LLM is loaded but **idle** (kept hot by `keep_alive`).

That idle, already-warm LLM plus free VRAM is the budget for background
consolidation: its marginal cost is near zero **as long as it never overlaps a
live turn**. Headroom also fits a small embedding model (~100–400 MB) for
semantic recall.

---

## 4. Target architecture — tiered memory

```text
                 ┌─────────────────────────────────────────────┐
   live turn ───▶│  get_prompt_context()  (token-budgeted)      │──▶ planner prompt
                 │  persona ▸ semantic facts ▸ working ▸ episodic│
                 └─────────────────────────────────────────────┘
                          ▲                         │ writeback (async)
                          │                         ▼
   ┌──────────────┬───────────────┬─────────────────┬──────────────┐
   │ Persona/Core │ Semantic (LT) │ Episodic (MT)   │ Working (ST) │
   │ persona_core │ durable facts │ rolled-up turns │ last N turns │
   │ profile      │ +embeddings   │ summaries       │ verbatim     │
   └──────────────┴───────────────┴─────────────────┴──────────────┘
                          ▲
                          │  idle consolidation worker (reflection)
                          │  dedup ▸ rollup ▸ reflect ▸ decay ▸ prune
                          └──────────────────────────────────────────
```

- **Working memory** — a real rolling verbatim window of the last N turns
  (e.g. 6–8), token-budgeted. Replaces the ad-hoc last-4 summaries.
- **Episodic memory** — dialog turns, summarized in batches once they age out of
  the working window; raw turns then prunable.
- **Semantic memory** — durable facts (existing high-salience writebacks),
  deduplicated, with embedding vectors for paraphrase recall.
- **Persona/core** — `persona_core` + `character_profile` (already stable).

Injection is **token-budgeted**, filled highest-priority first
(persona → top semantic facts → working window → episodic summaries) until a
configured budget, then stopped — never a fixed K that can silently bloat.

---

## 5. Background consolidation worker ("reflection")

Modelled on `attention_worker.py` (threaded, status-reporting), gated on idle.

- **Idle signal** — the LLM tracker already records `last_request_epoch`. Trigger
  when `now − last_request_epoch > ~20 s` **and** no turn is in flight (share the
  turn pipeline's lock/flag so consolidation never competes with a live reply).
- **Cheapest-first tasks:**
  1. **Dedup/merge** new durable facts against existing (embedding cosine or an
     LLM "same fact?" check) → keep highest salience, bump `reinforcement_count`.
  2. **Episodic rollup** — summarize a window of raw dialog turns into one
     episodic entry; mark the raw turns prunable.
  3. **Reflection** — ask the idle LLM to synthesize higher-level insights
     weighted by the **character's personality + the user's interaction history**
     (e.g. "User often asks about space late at night; seems to find it calming").
     Store as high-salience semantic memories. This is what makes the companion
     feel like it *knows* the user rather than recalling strings.
  4. **Re-score with decay** — exponential recency decay on episodic salience
     (Generative Agents uses ~`0.99^hours`) so stale chatter sinks while
     reinforced/durable facts stay afloat.
  5. **Prune** — drop episodic entries below a floor once summarized.
- **Personality-weighted prioritization** — feed `persona_core` (core_traits,
  long_term_goals) + `character_profile` into the reflection prompt so importance
  is filtered through *who she is*: a curious character retains curiosities, a
  caretaker retains the user's stresses.
- **Safety rails** — hard wall-clock budget per cycle; abort immediately if a turn
  arrives; idempotent writes; never two cycles at once; **off by default** behind
  an env flag, like the other tuning levers.

---

## 6. Semantic retrieval (quality upgrade)

Add a small embedding model (e.g. `nomic-embed-text` / `bge-small`, ~100–400 MB,
on idle VRAM headroom or CPU) and store a vector per durable fact. Retrieval
becomes `keyword overlap ∪ vector top-K`, so paraphrased recall works without the
user using exact words. The `embeddings` subsystem is already a declared
`ModelSubsystem` literal in `resource_monitor.py`, so the accounting seam exists.

---

## 7. Keeping it fast *and* realistic

- Live turns stay lean: explicit small `num_ctx`, token-budgeted injection, never
  any synchronous consolidation.
- All heavy thinking (summarize, reflect, dedup, embed) runs **off the critical
  path** during idle — the same philosophy already used for async writeback
  extraction in `turns_memory.py`, generalized into a managed worker.
- Realism comes from reflection (insights, not transcripts) + decay (recent-but-
  trivial fades, reinforced-and-meaningful persists) + personality-weighted
  scoring — recall shapes itself around the relationship.

---

## 8. Staged plan

Each stage is independently shippable and reversible. Stages 1–3 need **no new
models or VRAM**.

| Stage | Change | New models? | Risk |
|---|---|---|---|
| **1** | ✅ Explicit `num_ctx`/`num_predict` + token-budgeted memory injection | no | low (correctness) |
| **2** | ✅ Retire dead `memory.py` session-memory service | no | low |
| **3** | ✅ Dedup + episodic rollup in a minimal idle worker | no | medium |
| **4** | Reflection + decay (the realism win) | no | medium |
| **5** | Embedding retrieval (recall quality) | small embed model | medium |

### Stage 1 — context budgeting (correctness; in progress)

- Set `num_ctx` explicitly on the Ollama payload (default 8192) via a runtime
  tuning knob, with an optional `num_predict` cap. Removes the silent front-
  truncation risk and gives an explicit context-size vs KV-cache-VRAM knob.
- Add a **token budget** to `get_prompt_context()` so retrieved memory is trimmed
  by estimated tokens (highest-scored first), not a fixed count — the structural
  mechanism every later stage relies on. Default budget is generous enough not to
  change current behavior; it bounds growth as recall breadth increases.
- Surface the new knobs in `/system/resources` `runtime_tuning`.

Knobs (env): `NIKOF_LLM_NUM_CTX` (default 8192), `NIKOF_LLM_NUM_PREDICT`
(default 0 = use model default), `NIKOF_MEMORY_PROMPT_TOKEN_BUDGET` (default 1024).

### Stage 3 — idle consolidation worker (done)

`backend/app/services/memory_consolidation.py` — a daemon thread, **off by default**,
that runs `run_consolidation_cycle()` only when the LLM has been idle past a
threshold (so no live turn is competing). Per persona, cheapest-first:

- **Dedup** (`consolidate_durable_duplicates`) — durable facts with identical
  normalized text merge into one row: highest-salience kept canonical, duplicates'
  counts folded into `reinforcement_count`, salience lifted to the group max, the
  rest deleted. Raw dialog turns are never merged. No LLM.
- **Episodic rollup** (`select_dialog_rollup_batch` → `store_dialog_rollup`) — once
  enough raw dialog turns have aged past the `keep_recent` verbatim window, the
  oldest batch is summarized by the idle LLM into one `episodic`/`rollup` entry and
  the covered turns are marked `superseded = 1` (excluded from recall, prunable).

Schema: `memory_entries` gains `reinforcement_count` + `superseded` (idempotent
`ALTER TABLE` migration for existing DBs); recall queries exclude `superseded`. The
cycle is a pure function with the summarizer and idle check injected, so it is unit-
tested without a live LLM (`backend/tests/test_memory_consolidation.py`).

Knobs (env): `NIKOF_MEMORY_CONSOLIDATION` (default off),
`NIKOF_MEMORY_CONSOLIDATION_IDLE_SECONDS` (20), `NIKOF_MEMORY_ROLLUP_KEEP_RECENT`
(40), `NIKOF_MEMORY_ROLLUP_MIN_BATCH` (20), `NIKOF_MEMORY_ROLLUP_MAX_BATCH` (40).

Not yet built (Stage 4): salience **decay** and **reflection** (personality-weighted
insight synthesis) — the worker is the natural home for both.

---

## 9. References

- Park et al., *Generative Agents: Interactive Simulacra of Human Behavior* (2023)
  — memory stream (recency·importance·relevance) + reflection. The closest prior
  art to a believable companion and the model for the idle consolidation worker.
- Packer et al., *MemGPT / Letta* (2023) — hierarchical context with paging and
  self-editing memory; the model for token-budgeted tiered injection.
- Ollama `/api/generate` `options.num_ctx` / `num_predict` — context-window and
  generation-length control.
</content>
</invoke>
