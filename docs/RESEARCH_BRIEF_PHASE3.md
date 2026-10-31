# Research Brief: context-pager Phase 3 — Background Summarization, Vector DB, Episodic Memory, Compaction

**Task:** Research Phase 3 of the context-pager OpenCode V2 plugin (issue #1 §7.3) and produce an actionable implementation brief
**Domain:** dev (OpenCode V2 plugin development, Bun/TypeScript)
**Issue:** [seppaleinen/ctx-lifecycle#1 §7.3](https://github.com/seppaleinen/ctx-lifecycle/issues/1)
**Date:** November 1, 2026
**Author:** Researcher (subagent)

---

## 1. EXECUTIVE SUMMARY

Phase 3 adds long-horizon memory and background intelligence to the Phase 1/2 context-pager: a background summarization worker, optional local vector search, episodic memory for context that has already left a pool, compaction strategies for old pools, and performance work.

After reading the codebase, the ADRs, and researching current (2026) OpenCode V2 plugin APIs and agent-memory literature, the central recommendation is:

> **Build the episodic journal and archive-before-eviction first. It is pure TypeScript + `bun:sqlite`, needs no model calls, makes the existing LRU/clearPool eviction lossless, and is the foundation the summarizer, compactor, and (optional) vector index all plug into.**

Key findings that shape the plan:

1. **OpenCode V2 already exposes everything a background worker needs in-process**: `ctx.experimental.generate.text()` (side-effect-free LLM calls), `ctx.event.subscribe()` (including `session.idle`), `ctx.storage` (durable JSON, plugin-scoped), and `ctx.session.hook("compaction")` / `ctx.session.compact()`. The plugin runs inside the OpenCode server, so a promise-based in-process job queue is the right "worker" — no separate process, no child sessions.
2. **`bun:sqlite` is built into Bun** and already supports FTS5 (keyword search, no extension). `sqlite-vec` works on `bun:sqlite` but is pre-v1, and on macOS you must point `Database.setCustomSQLite()` at a brew `libsqlite3` because the system-bundled SQLite refuses extensions. Vector search is therefore **optional, default OFF, with FTS5 as the always-available fallback** (per user decision).
3. **The deterministic retention extractor (Phase 2) stays as the always-on base layer.** LLM summarization is an *enrichment* tier behind an adapter interface, using the host model via `ctx.experimental.generate.text()` (per user decision). This preserves the project's deterministic-testability invariant.
4. **Pools were never wired to persistence.** ADR-003 chose `ctx.storage` JSON under `pools/<project-id>`, but `src/` contains no persistence module and no `ctx.storage` calls. Episodic memory *is* persistence — Phase 3 must land pool persistence as a prerequisite.
5. **Token-level prompt compression (LLMLingua et al.) is rejected for the hot path.** 2026 evaluation work shows its end-to-end gains only exist in a narrow operating window, and the small-LM perplexity pass is heavy for a corpus that totals ≤ ~31k tokens. Our compaction is *extractive* (retention + journal + consolidation), which fits the scale.

**Build order (detail in §8):** ① pool persistence → ② episodic journal + archive-before-eviction + FTS5 recall → ③ background worker + LLM summarization → ④ compaction policy → ⑤ optional vector search → ⑥ performance (measure-first, woven throughout).

---

## 2. REFINED REQUIREMENTS

### 2.1 Objective

Extend context-pager so that context **leaves pools without being destroyed**: evicted and cleared content is journaled for recall, old pools are compacted by background consolidation, and an optional local semantic index improves recall quality.

### 2.2 Scope

| # | Task (issue §7.3) | Decision locked in this brief |
|---|---|---|
| P3.1 | Background summarization worker | In-process async job queue inside the plugin; LLM tier via `ctx.experimental.generate.text()` (host model, configurable); deterministic extractor remains the base tier |
| P3.2 | Vector DB integration (optional, local-only) | `bun:sqlite` + `sqlite-vec`, **default OFF** behind a config flag; FTS5 (built-in) is the default retrieval engine |
| P3.3 | Episodic memory for long-term context | Append-only SQLite journal (`episodes`), written *before* any eviction/clear (archive-before-evict); recall block injected on state transitions within a fixed token budget |
| P3.4 | Compaction strategies for old pools | Tiered: LRU (existing) → archive-before-evict (new) → background consolidation (journal rollup) → cold archive (age + never-recalled pruning) |
| P3.5 | Performance optimization | Measure-first; hot path (`context` hook) stays synchronous and O(active messages); all heavy work is async off-path |

### 2.3 Non-goals

- Multi-project/shared memory, sync, or any network service (local-only).
- Host-side compaction replacement: we *cooperate* with OpenCode's native compaction (can observe it via the `compaction` hook) but do not take over OpenCode's own session transcript — we manage our pool context only.
- Procedural memory / skill learning (out of scope for issue §7.3; noted in §9 as a future direction).

### 2.4 Definition of Done

- [ ] Pools persist across restarts via `ctx.storage` (ADR-003 schema, project-scoped)
- [ ] LRU eviction and `clearPool` write the removed messages to the episodic journal before removal (lossless eviction, verified by test)
- [ ] On state transition, a "Previously in X Pool:" recall block is injected within a fixed token budget (top-K by recency+keyword relevance)
- [ ] Background worker runs consolidation jobs off the hot path (triggered by transition / eviction volume / `session.idle`), with LLM summaries when enabled and deterministic fallback when not
- [ ] `memory.enabled` / `memory.vector` config flags; everything degrades gracefully to Phase 2 behavior when disabled
- [ ] All Phase 1/2 tests still green; new modules have `bun:test` unit tests with no real model calls (injectable summarizer)

---

## 3. CODEBASE STATE (verified against `main` @ ac3c175)

### 3.1 What exists

| File | Role | Phase 3 relevance |
|---|---|---|
| `src/index.ts` | `Plugin.define({ id: 'context-pager', setup })`; hooks: `session.hook('context')` (ceiling enforcement + `getActivePools` → `event.messages`), `tool.hook('execute.before')` (bash test detection → auto-transition), `command.transform` (`/transition`, `/new-issue`) | Worker bootstrap, journal hooks, new commands (`/recall`, config reload) |
| `src/router.ts` | `ContextRouter`: 5 pools (`GLOBAL, PROJECT, PLANNING, EXECUTION, TESTING`), `getActivePools(state)` = Global + Project + state-mapped pool, `addMessage` (defaults `critical=false`, `accessedAt`), `clearPool`, `popMessage`, `popRetainedBlock`, `enforceCeiling` (LRU, critical-pinned), `estimateTokens` = `ceil(len/4) + 4`/message | `enforceCeiling` and `clearPool` are the **eviction choke points** — the journal intercepts here |
| `src/state-machine.ts` | 4 states, 6-transition matrix, `parseTransitionCommand` | Transition events feed the journal + worker triggers |
| `src/summary-generator.ts` | 1-sentence hand-off summary (`Swapped to X Pool. trigger`, validated: no "evicted"/"tokens"), deterministic 4-category retention extractor (ACCEPTANCE/REQUIREMENT/ARCHITECTURE/RESEARCH), `RETAINED_CONTEXT_PREFIX = 'Context retained from '` | Base tier for summarization; the retention *output* is the highest-value seed for the journal |
| `src/types.ts` | `PoolID`, `StateMachineState`, `ContextMessage {role, content, createdAt?, critical?, accessedAt?}`, `ContextPool {id, messages}`, `RetainedContext*`, `TransitionEvent`, `PersistedPools` (v1, project-scoped), `DEFAULT_CONFIG`, `mergeConfig` (POOLS_KEYS-driven deep merge) | `PersistedPools` **already designed but unused** — ADR-003's schema, ready to implement |

### 3.2 What is missing (gaps Phase 3 fills)

1. **No persistence anywhere.** `PersistedPools` is defined in `types.ts` but no module reads/writes it; there are zero `ctx.storage` calls in `src/`. Pools are lost on process exit. ADR-003 (accepted) specifies: JSON via `ctx.storage`, key `pools/<project-id>`, path `~/.local/share/opencode/storage/plugin/context-pager/`.
2. **Eviction is destructive.** `enforceCeiling` splices messages out; `clearPool` empties arrays. Nothing survives — Phase 2 retention only saves what the regex extractor matches (≤ `maxItems` lines per transition).
3. **No background work.** Everything is synchronous inside hooks. (Correctly so — V2 `context` hook mutations are not awaited; see §4.1.1.)
4. **No retrieval path for old content.** Once evicted, context is gone.

### 3.3 Conventions to keep (from code + ADRs + repo memory)

- Deterministic, side-effect-free core logic; pure functions of pool + config (the retention tests are exact-value assertions).
- `bun:test` under `tests/unit` + `tests/integration`; no external services in tests.
- One class per kebab-case file; `ALL_CAPS` constants; `mergeConfig` deep-merge with validated partials.
- YAGNI culture (ADR-006): every added API surface must have a consumer.
- `console.debug` for observability; no new deps without a strong reason.

---

## 4. WEB FINDINGS

### 4.1 Background summarization — what OpenCode V2 actually gives a plugin

#### 4.1.1 Host APIs (official V2 server-plugin docs, verified 2026-11)

- **`ctx.experimental.generate.text({ model, prompt })`** — "Generate with a selected model without creating a session, invoking tools, or adding to session history. These APIs may change." (`ctx.generate.text` is the deprecated predecessor.) This is the side-effect-free LLM primitive for the worker.
- **`ctx.session.generate({ sessionID, prompt })` → `{ text }`** — transient generation tied to a session (resolves the session's model; no model override).
- **`ctx.event.subscribe({ types: [...] })`** — public event stream; third-party plugins use `session.idle`, `session.step.ended`, `session.compacted` to schedule idle work.
- **`ctx.storage`** — durable plugin-scoped JSON: `get/set/remove` + `scan({ prefix, cursor })`.
- **`ctx.session.hook("compaction", async (event) => { event.result = { summary } })`** — lets a plugin supply (or intercept) the checkpoint summary; **`ctx.session.compact({ sessionID })`** requests native compaction.
- **`setup(ctx)` may return a cleanup function** and plugins can hold timers (`setInterval` is in the official docs example) — an in-process background loop is a supported pattern.
- **V2 hook caveat** (opencode-deep-memory, corroborated by docs): V2 does not await async mutations in `context` hooks — "async mutations are lost". All Phase 3 work must therefore be *scheduled* from hooks, never *awaited* in them.
- No first-class `ctx.llm.generate` exists yet (feature request anomalyco/opencode#13884, open) — `ctx.experimental.generate.text` is the current path; wrap it behind an adapter so a stable API can be swapped in later.

#### 4.1.2 Worker patterns from existing OpenCode plugins

`opencode-background-agents`, `opencode-drawer-agents`, and `opencode-workspace` converge on one shape: **fire a detached job, return an id, persist the result to disk (markdown/JSON), notify on completion, retrieve by id; restart recovery re-adopts persisted state.** `opencode-deep-memory` (v1+v2 dual-entry memory plugin) adds two directly applicable ideas:

- **Warm-cache handoff:** async results are persisted and applied synchronously on the *next* turn, keeping the hot path synchronous.
- **Idle-triggered consolidation:** consolidation runs when the session is idle (+N lines since last run), mtime-race-safe.

For context-pager the worker is simpler (no user-facing task API needed): an in-process **job queue** (array + `setImmediate`/microtask pump, max concurrency 1, coalescing per job kind) fed by hooks and `session.idle`.

#### 4.1.3 Token-counting reality (affects all Phase 3 budgets)

- OpenCode carries **provider-reported** tokens on assistant messages: `tokens.{input, output, reasoning, cache.read, cache.write}` (and `tokens.total` in newer versions). Plugins can read these via `ctx.session.context({ sessionID })` asynchronously.
- The host's private context-size estimate is **not** exposed to plugins (anomalyco/opencode#57216, open). Third-party plugins (e.g. context-indicator) use a unicode-aware heuristic (ASCII ≈ 4, CJK ≈ 1.5, Cyrillic ≈ 2.5 chars/token).
- **Decision:** keep `ceil(len/4)+4` for the hot-path eviction estimate (deterministic, stable, already tested). Add an optional async **calibration** job: after a model response, compare provider-reported input tokens against our estimate of the same message set and store a drift factor used only for budget *planning* (journal/recall budgets), never for eviction ordering. Do not block on #57216.

### 4.2 Vector DB options (local-only)

| Option | Bun fit | Status | Notes |
|---|---|---|---|
| **`sqlite-vec`** (asg017) | `npm i sqlite-vec`; `sqliteVec.load(db)` works with `bun:sqlite`, `node:sqlite`, `better-sqlite3` | Pre-v1 (v0.1.x) but very active (2026: ANN/IVF/rescore) | Pure-SQL `vec0` virtual tables, KNN via `WHERE embedding MATCH ? ORDER BY distance LIMIT k`. **macOS gotcha:** system SQLite refuses extensions → `Database.setCustomSQLite("/usr/local/opt/sqlite3/lib/libsqlite3.dylib")`. Bun issue #26736 (built-in vector support) is open — not available today |
| `sqlite-vss` | works | **Unmaintained**; explicitly superseded by sqlite-vec | Not recommended |
| Lancedb / Qdrant / Chroma (Rust servers or native libs) | poor/none for this project | active | Server or heavy-native; violates local-only-in-plugin + minimal-deps culture |
| In-memory JS index (brute-force cosine) | trivial | — | Fine for < ~5k vectors, but re-scans per query and dies on restart without re-embedding everything |
| **FTS5** (built into `bun:sqlite`) | **zero-dependency** | stable | BM25 keyword ranking; no extension; the right *default* engine at our corpus scale |

**Verdict (matches user decision):** SQLite file at `~/.local/share/opencode/storage/plugin/context-pager/memory.db` (same XDG root as ADR-003 storage), WAL mode. **FTS5 on by default**; `memory.vector: "off" | "auto"` where `auto` tries to load `sqlite-vec` (+ macOS `setCustomSQLite` fallback) and degrades to FTS5 with a warning.

### 4.3 Local embeddings (only needed when `memory.vector` is on)

- **`@huggingface/transformers` (transformers.js v3/v4)** runs ONNX models in Bun: `pipeline("feature-extraction", model, { device: "cpu", dtype: "q8" })`.
- Recommended default for dev-tool RAG: **`Xenova/all-MiniLM-L6-v2`** — 384-dim, ~23 MB quantized (q8), milliseconds per sentence on laptop CPU. `mean` pooling + `normalize: true`; batch API returns one flat `[N, 384]` tensor.
- Model downloads to `~/.cache/huggingface/hub` on first use (~23 MB); lazy-load in background on first `embed` job, never on the hot path.
- Consistency caveat: wasm/webgpu/cpu backends historically produced slightly different embeddings (transformers.js #1046; fixed in v4, #1382). **Pin `device: "cpu"`** and the vec0 table dimension (384) in one place.

### 4.4 Episodic memory — design patterns from the literature

Consensus across the 2024–2026 agent-memory literature (Generative Agents; "Memory Architecture for Long-Horizon Agents"; "A Survey of Agent Memory"; RoboSathi; memorize; cell-mem; deep-memory) on what "episodic memory" means for a coding agent:

1. **Append-only, chronologically ordered journal** of what happened (tool output, decisions, test results), each entry timestamped, optionally with an importance/salience score and (optionally) an embedding. Temporal order *is* the index dimension.
2. **Four memory types, different stores**: working (context window = our pools), episodic (the journal), semantic (durable facts = our retained-context items / Project pool), procedural (skills — out of scope).
3. **Write-time, not read-time, consolidation**: the expensive distillation (episodes → summary) runs in a background job, *never* inside retrieval, so the read path stays fast.
4. **Retrieval blends recency AND relevance** — e.g. `score = α·similarity + β·recency + γ·BM25` — plus a hard **supersession filter** (`is_valid` / `superseded_by`) because pure similarity recall returns stale-but-similar matches.
5. **Fixed retrieval budget**: candidates that don't fit the budget are not deleted, they just lose that session's ranking.
6. **Aging**: low-salience entries older than N days → cold storage (archive, rescuable) or prune.
7. **Practical capture rule** (memorize): capture continuously, consolidate at session boundaries, retrieve at session start / state change; extraction priority: LLM endpoint → CLI → **rule-based fallback** (our deterministic extractor is exactly this third rung).

**Mapping to context-pager** — this is a near-perfect fit, and the mapping is cheap because the pieces already exist:

| Memory type | context-pager object |
|---|---|
| Working | the 5 pools (unchanged) |
| Episodic | **new** SQLite `episodes` journal, fed by *every* destructive pool operation |
| Semantic | retained-context blocks (Phase 2) + `critical` messages (ADR-007) — unchanged, but journal entries can be *promoted* into them by consolidation |
| Procedural | out of scope |

### 4.5 Compaction strategies — what the literature offers, and what we reject

| Strategy | What it does | Verdict for context-pager |
|---|---|---|
| **Extractive retention** (we already have it) | Keep pattern-matched lines on transition | **Keep** — base tier, deterministic, free |
| **Archive-before-evict** | Journal anything about to be LRU-evicted or pool-cleared | **Adopt** — makes eviction lossless; the core Phase 3 move (§6.4) |
| **Background consolidation / rollup** | Background job merges N old journal entries into 1 distilled summary (LLM or deterministic); original entries marked consolidated | **Adopt** — write-time consolidation per §4.4.3 |
| **Cold archive + aging** | Entries older than X days and never recalled → collapsed to summary-only (content kept in a compressed archive blob) | **Adopt** (configurable, rescuable) |
| LLMLingua / LLMLingua-2 / LongLLMLingua | Perplexity/token-classifier prompt compression, 3–20× | **Reject for hot path** — 2026 large-scale eval (arXiv:2604.02985) finds end-to-end latency wins only in a narrow window (unoptimized serving + high ratio + short outputs); requires a second small LM; our corpus (≤ ~31k tokens, structured) doesn't justify it. Revisit only if pool ceilings must shrink 3×+ |
| Selective-Context (drop low-self-information units) | Perplexity-based sentence pruning | Reject — same dependency/cost profile, less fit |
| Reordering for "lost in the middle" (LongLLMLingua doc reorder; PAACE plan-aware placement) | Re-order context for position bias | **Adopt the cheap part**: `getActivePools` ordering (Global → Project → active) plus recall block placement — put the *newest recall* adjacent to the tail, not at the head. No algorithm needed |
| Native OpenCode compaction | Host summarizes the session transcript at `ctx.session.compact()` / `compaction` hook | **Cooperate, don't replace**: optionally register a `compaction` hook that *adds* a pointer to our journal for anything about to be summarized away (cheap insurance; the host summarizes OpenCode's transcript, not our pools) |

### 4.6 What people do in OpenCode plugins (prior art inventory)

- **`opencode-memory`** — plugin-owned SQLite under `~/.local/share/opencode/` (precedent for our `memory.db` location).
- **`opencode-deep-memory`** — BM25-indexed memory file, SHA-256 "CCR" store so compressed-away originals are recoverable, subagent summarization, idle-triggered consolidation, v2 warm-cache handoff.
- **`opencode-context-indicator`** — reads provider tokens from assistant messages; unicode-aware estimates; mirrors the host compaction ceiling formula (`window − max(15%, 16k)`).
- **`opencode-background-agents` / `drawer-agents`** — the background-job lifecycle shape (persist → notify → retrieve by id → restart re-adoption).

---

## 5. RECOMMENDED ARCHITECTURE

```
                       ┌───────────────────────────── OpenCode server (plugin in-process) ─────────────────────────────┐
                       │                                                                                                 │
  context hook ──────▶│  ContextRouter (5 pools)                                                                          │
  (sync, hot path)    │     │  enforceCeiling / clearPool  ─────────┐                                                    │
  tool hook           │     │  getActivePools                       │ destructive ops                                    │
  commands            │     ▼                                       ▼                                                    │
                       │  StateMachine ──(TransitionEvent)──▶  JournalIntercept (archive-before-evict)                   │
                       │     │                                    │                                                     │
                       │     └──(schedule)──────────┐             ▼                                                     │
                       │                            │     ┌──────────────────────────────────────────────┐               │
                       │                            │     │ memory.db  (bun:sqlite, WAL, XDG path)        │               │
                       │                            │     │  episodes(ts, pool, state, role, content,     │               │
                       │                            ▼     │          category, embedding?, superseded_by, │               │
                       │   ┌──────────────┐   ┌────────┐  │          access_count, last_accessed)         │               │
                       │   │ Background   │   │ Recall │  │  episodes_fts (FTS5, always)                  │               │
                       │   │ Worker (async│◀──┤ (sync, │◀─│  vec0 (sqlite-vec, if memory.vector=auto)    │               │
                       │   │ job queue,   │   │ budget │  │  job_queue (persisted work)                  │               │
                       │   │ max conc. 1) │   │ ≤1.5k) │  └──────────────────────────────────────────────┘               │
                       │   └──┬───────┬───┘   └────────┘  └─────────────────────────────────────────────────────────────────┘
                       │      │       │
                       │      ▼       ▼
                       │  LLM tier              deterministic tier
                       │  ctx.experimental.     retention extractor + extractive rollup
                       │  generate.text()       (always works, zero cost)
                       │  (adapter iface)
                       └───────────────────────────────────────────────────────────────────────────────────────────────────┘
```

### 5.1 New modules (kebab-case, one class each, per convention)

| Module | Responsibility |
|---|---|
| `src/persistence.ts` | ADR-003 implementation: load/save `PersistedPools` via `ctx.storage` (JSON, `pools/<project-id>`, atomic write semantics from the API; schema-version migration hook). Also used for worker job-queue persistence (`jobs/<project-id>`) |
| `src/episodic-memory.ts` | `EpisodicMemory` class: owns `memory.db`; `archive(poolId, messages, reason)`, `recall(state, budgetTokens)`, `markSuperseded(ids)`, `prune(policy)`; FTS5 queries; optional vec0; injectable for tests |
| `src/memory-worker.ts` | `MemoryWorker`: job queue (`{ kind: 'summarize' | 'consolidate' | 'embed' | 'calibrate' | 'prune' }`), coalescing, max concurrency 1, `start(ctx)` / `stop()` from plugin `setup` cleanup; triggers: transition events, eviction batches > threshold, `session.idle`, startup (re-adopt queue) |
| `src/summarizer.ts` | `Summarizer` interface + two impls: `DeterministicSummarizer` (wraps/extends the retention extractor + extractive rollup) and `LlmSummarizer` (wraps `ctx.experimental.generate.text` behind an adapter; input capped ~8k chars, output ~600 chars; model from `ctx.options` or the session's model) |
| `src/embedder.ts` (only if vector enabled) | Lazy `@huggingface/transformers` pipeline, `device: "cpu"`, q8, 384-dim, batch embed; loads on first `embed` job |

### 5.2 Data flow — lossless eviction

1. `enforceCeiling`/`clearPool` currently splice messages out. Rework so the **router emits** the removed batch (router owns its list, per the existing `popMessage`/`popRetainedBlock` pattern — no caller reaches into `pool.messages`).
2. The intercept layer calls `episodicMemory.archive(poolId, removed, reason)` **synchronously** (SQLite writes are fast; a batch of ~100 short messages is sub-millisecond). If `memory.db` is unavailable (corrupt/locked), log and proceed — eviction must never fail because memory is down.
3. Transition events + retained-context blocks are also journaled (they are the highest-salience episodes: `category` column = the retention category).
4. On every transition into a state, `recall(state, budget)` runs **synchronously** in the `context` hook path (FTS5 top-K ≈ microseconds) and, if results exist, one system message is appended to the active pool: `Previously in <Pool> Pool:\n…` (new `RECALL_PREFIX` constant, mirroring `RETAINED_CONTEXT_PREFIX`). The recall block is **skipped** by the retention extractor (system role already skipped) — no self-reinjection loop.

### 5.3 Worker job kinds

| Kind | Trigger | Work | Tier |
|---|---|---|---|
| `summarize` | eviction batch ≥ N messages, or transition from a state whose pool was cleared | Distill the archived batch into one summary episode (structured: goal / decisions / failures / open items) | LLM → deterministic fallback |
| `consolidate` | `session.idle` + episodes since last run ≥ M | Roll up M old episodes (same pool, consecutive) into 1 summary; mark originals `consolidated`; promote recurring retained-pattern items to Project/Global `critical` messages (semantic promotion) | LLM → deterministic |
| `embed` | any `archive` while vector enabled | Batch-embed new episodes (debounced) | local model |
| `calibrate` | after each provider response (async read of `ctx.session.context`) | Store token-estimate drift factor for budget planning | none |
| `prune` | startup + idle | Cold-archive entries older than `memory.archiveAfterDays` with `access_count = 0`; purge entries older than `memory.purgeAfterDays` (configurable, rescuable until purge) | deterministic |

Job queue state (pending jobs) persists via `ctx.storage` (`jobs/<project-id>`) so a crash mid-session doesn't lose work — same restart-re-adoption pattern as the background-agent plugins.

### 5.4 Config additions (extend `ContextPagerConfig` via existing `mergeConfig` pattern)

```ts
memory: {
  enabled: boolean;        // master switch; false ≡ Phase 2 behavior (default true once shipped)
  dbPath: string;          // default: <XDG>/opencode/storage/plugin/context-pager/memory.db
  recallBudgetTokens: number;  // default 1500
  recallTopK: number;      // default 8
  journal: { archiveBeforeEvict: boolean /* true */ };
  worker: {
    llmSummaries: boolean;   // default true (user decision: host model)
    model?: { providerID: string; id: string };  // override; default = session model
    consolidateEvery: number;  // episodes, default 40
  };
  vector: "off" | "auto";   // default "off" (user decision)
  embeddingModel: string;   // default Xenova/all-MiniLM-L6-v2 (384-d)
  archiveAfterDays: number; // default 30
  purgeAfterDays: number;   // default 90
}
```

`memory.enabled = false` must byte-for-byte reproduce Phase 2 behavior (test: run the existing retention suite with the flag off).

---

## 6. PER-TASK RECOMMENDATIONS & TRADE-OFFS

### 6.1 Background summarization worker

**Recommendation:** in-process job queue (§5.3) + two-tier summarizer (deterministic base, LLM enrichment via `ctx.experimental.generate.text`).

| Alternative considered | Why not |
|---|---|
| Child/worker OpenCode sessions (background-agent pattern) | Heavier than needed: full agent loop, transcript, notification machinery. We need *a function call that returns text*, which `ctx.experimental.generate.text` is exactly. Adopt their *persistence/re-adoption* pattern, not their session machinery |
| `ctx.session.generate` on the live session | Resolves the session's model but is session-bound; `experimental.generate.text` takes an explicit model ref (cheaper-model override) and is session-free |
| Local LLM (ONNX LLM in-process) | 10s–100s of MB model + load time + quality ceiling; host model is already authenticated and configurable — rejected (user decision) |
| Timer-only (no event triggers) | Summaries must follow evictions; events are the correct trigger, `session.idle` is the correct *idle* trigger |

**Cost control:** LLM tier only for (a) eviction batches ≥ threshold and (b) idle consolidation; input capped ~8k chars, output ~600; coalescing means ≤ 1 LLM call in flight. Deterministic tier covers everything else and every failure mode (API down, model unavailable, user disabled LLM).

### 6.2 Vector DB (optional, local-only)

**Recommendation:** `bun:sqlite` + FTS5 (default) + `sqlite-vec` behind `memory.vector: "auto"` (default `off`). 384-dim all-MiniLM-L6-v2 q8 for embeddings.

Honest sizing note: at this corpus scale (pools ≤ ~31k tokens; a heavy session ≈ a few hundred journal entries), **FTS5 is likely "good enough" and the vector layer's value is marginal for the first year.** It is kept in scope because (a) issue §7.3 asks for it, (b) it degrades cleanly, and (c) it is what unlocks *semantic* recall of paraphrased decisions later. Building it last (phase 5) means if the data shows FTS5 recall quality is sufficient, we can descoping it with one flag — exactly the "optional" the spec intends.

macOS handling: try `loadExtension` → on failure, `Database.setCustomSQLite` with brew paths (documented in README; CI check: warn-don't-fail).

### 6.3 Episodic memory

**Recommendation:** SQLite append-only `episodes` table + FTS5, written by archive-before-evict, read by a budgeted `recall()` on transition. Schema:

```sql
CREATE TABLE episodes (
  id            INTEGER PRIMARY KEY,
  ts            INTEGER NOT NULL,      -- ms
  pool          TEXT NOT NULL,         -- PoolID
  state         TEXT NOT NULL,         -- StateMachineState at capture
  role          TEXT NOT NULL,
  content       TEXT NOT NULL,
  category      TEXT,                  -- RetainedItemCategory when known
  summary_of    INTEGER,               -- consolidated-into pointer (self-foreign)
  superseded_by INTEGER,
  access_count  INTEGER NOT NULL DEFAULT 0,
  last_accessed INTEGER
);
CREATE VIRTUAL TABLE episodes_fts USING fts5(content, content='episodes', content_rowid='id');
-- only when vector enabled:
CREATE VIRTUAL TABLE episode_vec USING vec0(embedding float[384]);
```

Retrieval score (no-vector path): `score = β·recency_decay(ts) + γ·bm25_rank`, with a hard filter `summary_of IS NULL AND superseded_by IS NULL`. This is the literature's recency+relevance+supersession blend (§4.4.4), with α=0 until vectors exist.

**Why "Previously in X Pool:" as a system message in the active pool** rather than a new hook: it reuses the exact mechanism of Phase 2 retention blocks (prefix constants, extractor skip-rules, same-pool dedup via `popRetainedBlock`-style guard), so it inherits all existing test coverage patterns and the 1-message shape the model already understands.

### 6.4 Compaction strategies for old pools

Tiered, all deterministic by default:

1. **T1 — LRU ceiling** (existing, unchanged): hot-path, O(n) scan.
2. **T2 — Archive-before-evict** (new): the journal *is* the compaction safety net. T1's role changes from "destroy" to "evict with a receipt".
3. **T3 — Background consolidation**: idle-triggered rollups shrink journal growth ~10× (M entries → 1 summary). LLM summaries when enabled; deterministic extractive rollup (first line of each episode + all `category`-tagged lines) otherwise.
4. **T4 — Cold archive / aging**: never-recalled, old → content moved out of `content` into a compressed archive blob (or a `cold` table) after `archiveAfterDays`; purge after `purgeAfterDays`. Rescuable until purge.
5. **T5 (optional, later)** — semantic promotion: consolidation detects a fact that has recurred ≥ 3× across episodes → propose it as a `critical` message in Project/Global (the ADR-007 pinning mechanism). This is the "episodic → semantic" graduation the literature calls the hardest step; ship it as a *suggestion* in logs/`/recall` output before automating.

Explicitly **not** doing token-level compression (LLMLingua) — see §4.5.

### 6.5 Performance

- **Hot path invariant (must hold, and be test-asserted):** the `context` hook does exactly what it does today plus ≤ 2 SQLite reads (recall) + 1 write (if a recall block is appended). Target: < 1 ms added on laptop. All worker work is `setImmediate`-scheduled; hooks never `await` Phase 3 work.
- SQLite: WAL mode, `PRAGMA synchronous=NORMAL`, batched inserts in a transaction per eviction batch, prepared statements.
- Embeddings: batched, debounced, lazy model load, never on the hot path.
- Token budget: keep `/4` estimate for eviction (deterministic + tested); add async drift calibration for *planning* budgets only.
- Measure-first rule for "performance optimization" (task 5): instrument (`console.debug` timings + a `/memory-stats` command reporting pool tokens, journal row count, db size, last job durations) **before** optimizing. No speculative caching/optimization (ADR-006 culture).
- Memory: pool + journal are small by design (journal is pruned); no unbounded in-memory caches. The worker keeps at most one summary draft in flight.

---

## 7. WHAT WE BUILD FIRST AND WHY

1. **P3.0 Pool persistence (`persistence.ts`).** Everything downstream assumes durable state; ADR-003 already decided the design; it's ~150 lines + tests and unblocks restart-recovery for the worker too. *(~1 day)*
2. **P3.3a Episodic journal + archive-before-evict (FTS5 only).** Highest value-per-line in Phase 3: immediately makes LRU + `clearPool` + `/new-issue` lossless, needs zero model calls, zero native extensions, and its tests are deterministic. This is also the *risk-reduction* move — every later feature can be A/B'd against it. *(~2–3 days)*
3. **P3.1 Background worker + two-tier summarization.** With the journal in place, the worker has a job: summarize/consolidate. The LLM tier is the only new external dependency (host model), wrapped in an adapter with deterministic fallback. *(~2–3 days)*
4. **P3.4 Compaction policy (T3–T5).** Consolidation scheduling, aging, cold archive. Pure policy code over existing tables. *(~2 days)*
5. **P3.2 Vector layer (flag-off).** Last, because it's the most platform-fragile (macOS extension loading) and least certain at current corpus scale. FTS5 recall is already shipping, so this phase is additive and fully deferrable. *(~2 days + platform matrix testing)*
6. **P3.5 Performance.** Woven in: instrumentation lands with step 2; any optimization is justified by its numbers. *(ongoing)*

Rationale for the order: each step ships user-visible value independently, each keeps the Phase 2 invariants (deterministic defaults, `bun test` green, no new deps on the default path), and the two most uncertain external dependencies (host `experimental.generate` API, `sqlite-vec` on macOS) land **last**, behind adapters/flags — so their failure modes degrade to "feature off", never to "plugin broken".

---

## 8. TEST STRATEGY (matches `bun:test` + deterministic conventions)

- **Journal/FTS5:** real `bun:sqlite` in `:memory:` (or temp file for WAL tests); exact-count assertions on `archive()`; recall ordering with a **faked clock** (inject `now`); supersession filters; FTS5 ranking determinism.
- **Worker:** inject a fake `Summarizer` (records calls) and fake clock; assert job coalescing, max concurrency 1, crash re-adoption (write queue → drop worker → new worker drains).
- **LlmSummarizer adapter:** mock `ctx.experimental.generate.text`; assert input caps, fallback on throw/timeout to deterministic tier, model-override wiring. **No real model calls in CI.**
- **Flags:** `memory.enabled=false` → full existing suite unchanged + assertion that no `memory.db` is created. `memory.vector="auto"` with extension unloadable → warns, FTS5 path works.
- **Integration:** extend `tests/integration/hooks.test.ts` pattern: run a transition → assert journal row + recall block shape (`RECALL_PREFIX`), assert retention extractor ignores recall blocks (no loop).
- **Perf guard:** a unit test asserting `context` hook added latency stays under a coarse budget (e.g., 5 ms) on a seeded 30-message pool — catches accidental O(n²) / sync-LLM regressions.

---

## 9. RISKS & UNKNOWNS

| # | Risk / Unknown | Likelihood | Impact | Mitigation |
|---|---|---|---|---|
| R1 | `ctx.experimental.generate.text` is explicitly "may change"; no `ctx.llm.generate` yet (#13884 open) | Med | Med | Adapter interface (`Summarizer`); deterministic fallback; pin `@opencode/plugin` version; track the issue |
| R2 | `sqlite-vec` pre-v1; macOS extension loading is environment-dependent (brew paths) | Med | Low (flag-off) | `memory.vector` default `off`; `auto` degrades to FTS5 + warning; document setup; keep dimension/config in one place |
| R3 | Embedding model download (~23 MB) on first use; backend-consistency history (wasm vs cpu) | Low | Low | Pin `device: "cpu"`, q8, 384-dim in one constant; lazy load; document offline behavior |
| R4 | V2 hook semantics: `context` hook mutations are not awaited; worker writes racing pool reads | Med | Med | All worker→pool writes go through router methods; journal is the only async store touched from hooks (sync SQLite write); integration test for transition+recall ordering |
| R5 | Token estimate (`/4`) diverges from provider tokens; host estimate not exposed (#57216) | High | Low | Known/accepted (Phase 1 unknowns list); async calibration job for planning budgets only; never for eviction ordering |
| R6 | Journal growth unbounded on pathological sessions (e.g., 10k bash test runs) | Med | Low | Per-batch archive caps + `prune` job + `/new-issue` also archives-then-clears Project pool (already journaled); db size in `/memory-stats` |
| R7 | Content sent to the host model for summarization = user's code/prompts leave the machine | High (by design) | Med | Document in README; `memory.worker.llmSummaries` off switch; pre-LLM redaction hook (ADR-003 flagged pre-storage redaction as future work — the worker is the natural place to finally do it; add a `redact()` step in the job pipeline) |
| R8 | `PersistedPools` schema (v1) lacks the Project pool field (memory notes it was deferred — "Postponed until persistence support exists", W6) | High (fact) | Low | Implement persistence at schema v2 with `project: ContextPool` now that the pool exists; migration path from v1 = treat missing project as `[]` (already the loader behavior per conventions page) |
| R9 | Recall block + retention block + hand-off summary stacking exceeds budget in a long round-trip (COMPLETE→PLANNING cycles) | Med | Med | Single combined budget (`recallBudgetTokens`) covering both blocks; same-pool replace-guard extended to recall blocks; budget is a *drop-candidates*, never *delete* (literature rule §4.4.5) |
| R10 | Other plugins also rewrite `event.messages` (known Phase 1 risk, unchanged) | Low | Med | Unchanged; unique plugin id; document load-order sensitivity |

**Open questions (do not block phase 1–2 of the plan):**
1. Does `ctx.storage` set have a size ceiling we should care about for `PersistedPools` JSON (pools ≤ ~1 MB expected — ADR-003 assumed so)? Verify empirically in P3.0.
2. Exact shape of `event.result` for the `compaction` hook (we may want to append a journal pointer when the host compacts) — read from `@opencode/plugin` types during P3.3 implementation.
3. Whether `session.idle` arrives reliably for sessions that go idle via tool-driven continuations — verify in P3.1 integration testing; fallback trigger = timer after last hook fire.

---

## 10. REFERENCE SCHEMA & API SUMMARY (for the implementation lead)

- **New deps (default path):** none. `bun:sqlite` is built in. `sqlite-vec` (optional, vector flag) and `@huggingface/transformers` (optional, vector flag) — both lazy-imported only when the flag is on, so default installs stay dependency-free.
- **New files:** `src/persistence.ts`, `src/episodic-memory.ts`, `src/memory-worker.ts`, `src/summarizer.ts`, `src/embedder.ts` (flag-gated) + `tests/unit/{persistence,episodic-memory,memory-worker,summarizer}.test.ts` + extended `tests/integration/hooks.test.ts`.
- **Touch points in existing files:** `router.ts` (emit removed batches instead of silent splice; add `popRetainedBlock`-style guard for recall blocks), `index.ts` (bootstrap worker + `MemoryWorker.start/stop` in `setup` cleanup, recall injection in `context` hook, `/recall` + `/memory-stats` commands), `types.ts` (`memory` config block, `RECALL_PREFIX`, schema v2).
- **Preserved invariants:** deterministic default behavior; `context` hook synchronous; no `as any` (ESLint 10 flat config); 1-message shape for injected blocks; `critical` messages never evicted (ADR-007); single config source of truth in `DEFAULT_CONFIG`.

---

**File Path:** `docs/RESEARCH_BRIEF_PHASE3.md`
**Status:** Ready for pipeline lead handoff
**Next Owner:** dev-team-lead (P3.0 persistence → P3.3a journal → P3.1 worker) — single workstream, no infra/cluster impact (pure local plugin)
