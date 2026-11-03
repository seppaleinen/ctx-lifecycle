# OpenCode Native Compaction vs ctx-lifecycle Pool Compaction

**Date:** November 3, 2026
**Source:** Analysis of OpenCode V2 source (`packages/opencode/src/session/compaction.ts`, `overflow.ts`) and ctx-lifecycle implementation

---

## The mental model contrast

| Aspect | OpenCode (native) | ctx-lifecycle |
|---|---|---|
| **Unit managed** | One flat session history | 5 isolated pools (Global, Project, Planning, Execution, Testing) |
| **Purpose** | Keep the model's context window under the limit | Manage injected per-state memory budgets |
| **Architecture** | Session-centric | Pool-centric |

---

## Gap analysis: 4 areas where our approaches differ

### Gap 1: Trigger scope & threshold

| | OpenCode | ctx-lifecycle |
|---|---|---|
| **Threshold** | 85% (15% buffer, min 16k) | **75%** (`compactAt`, configurable) |
| **What triggers it** | The *entire session* approaching the *model's context window* | Each *individual pool* approaching its *own `maxTokens`* |
| **Measurement** | **Real** provider-reported usage tokens | **Estimated** (`ceil(chars/4)+4` per message) |

**Implication:** OpenCode triggers much later relative to its window because it doesn't know the exact window until the provider says. We trigger earlier, relative to our known pool budget, using a deterministic measurement that can undershoot for non-English or structured content.

### Gap 2: Summarizer design

| | OpenCode | ctx-lifecycle |
|---|---|---|
| **Default strategy** | The **model itself** writes a structured summary | **Deterministic by default** via regex pattern-matching |
| **Structure** | Fixed template (`Goal / Constraints / Progress / Decisions / Next / Context / Files`) | Plain text with labeled lines (`[Requirement]`, `[Architecture]`, `[Acceptance]`) |
| **Iteration** | **Anchored**: previous summary + delta is passed back, updated | **Per-batch**: each compaction produces a fresh summary |
| **Optional** | `agents.compaction.model` for a dedicated summary model | LLM via `ctx.experimental.generate.text()` in the worker |

**Implication:** Our deterministic path works with zero model calls. If we *do* call the model, summaries won't converge/freeze over time like OpenCode's anchored approach.

### Gap 3: "Lossless" archival

| | OpenCode | ctx-lifecycle |
|---|---|---|
| **Before removing messages** | Messages are hidden from the model but stay in the session DB | **Archived to SQLite `episodes` table** (FTS5) |
| **Recall mechanism** | None (you'd need to construct an API call) | `recallBudgetTokens(poolID, topK)` returns archived episodes |
| **What's kept verbatim** | Recent tail (~15k tokens) beside summary | Critical/pinned messages identified by `critical: true` flag |

**Implication:** OpenCode assumes you'll never need to recall old turns; they're just hidden. We assume you might need them back later, so we index them in a queryable table.

### Gap 4: Secondary space reclamation

| | OpenCode | ctx-lifecycle |
|---|---|---|
| **Mechanism** | **Tool-output pruning**: walk backwards, blank out old tool call outputs (not the calls themselves) | None |
| **When it applies** | After the first 40k tokens (`PRUNE_PROTECT`) | N/A |
| **What it frees** | Tool output (often the largest context chunk) | N/A |

**Implication:** If our pools ever accumulate large tool/file content, we're less efficient than OpenCode at reclaiming space without summarization.

---

## Design tradeoffs & rationale

Our approach is purpose-built for an *injected plugin*, not direct session management:

1. **No overflow recovery needed.** We enforce `maxTokens` *proactively* in the `context` hook before the request hits the model. OpenCode needs overflow recovery because it's on the request path.
2. **Deterministic defaults.** Pools can't trigger summarization if their LLM is unavailable. Our `generateCompactSummary` uses regex extraction — a cheap, reliable fallback.
3. **Pool isolation.** Each pool has its own `maxTokens`/`compactAt`. OpenCode has one global session budget.
4. **Archive-before-evict.** Our core insight from Phase 3: losslessly journal to SQLite *before* removal enables `episodicMemory.recall()` elsewhere. OpenCode's hidden messages require a full API call to retrieve.

---

## Investigation issues to create

The following GitHub issues track deeper analysis of each gap:

1. `[[issue:GR-001]]` Tool-output pruning strategy for ctx-lifecycle pools — Should we add an equivalent to OpenCode's tool-pruning for pools that accumulate large injected content?
2. `[[issue:GR-002]]` Token estimation accuracy — How often does `chars/4+4` undershoot for typical pool content (code, non-English, emoji)? Consider a more precise estimator.
3. `[[issue:GR-003]]` Anchored vs batch summarization — Should ctx-lifecycle adopt an anchored approach (pass previous summaries to merge) for better long-term coherence in Global pools?
4. `[[issue:GR-004]]` Overflow detection for pool budgets — While unlikely on hot path, should we add a safety-net check if pool token estimate diverges from reality?

---

## References

- OpenCode source: `packages/opencode/src/session/compaction.ts` (v2.2.5)
- OpenCode docs: https://opencode.ai/v2/docs/compaction
- Issue #15: Auto-compact on threshold implementation
- docs/CONTEXT-EVICTION-ALTERNATIVES.md (issue #14 research)