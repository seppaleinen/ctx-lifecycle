# Research: Context Eviction Alternatives for the context-pager OpenCode V2 Plugin

**Task:** Research context eviction alternatives for Issue #14 — handle pool context that grows too large during planning or implementation phases.

**Date:** November 2, 2026

---

## 1. Current Eviction Audit

### 1.1 What Exists Today (Phase 3 Architecture)

The codebase ships five eviction mechanisms, organized through a tiered approach:

#### 1.1.1 LRU Ceiling Enforcement (`src/router.ts`)

| Method | Trigger | Behavior |
|--------|---------|----------|
| `enforceCeiling(poolId, maxTokens)` | `src/index.ts` context hook (lines 61-62) | Drops oldest non-critical messages via LRU until pool is under `maxTokens` |
| `enforceCeilingWithResult(...)` | Not yet wired, exists for journal integration | Same LRU eviction, but returns evicted batch for archival |

**Key constraints:**
- `critical: true` messages are NEVER evicted (pinned requirements survive)
- Token estimate: `ceil(content.length / 4) + 4` per message (deterministic)
- `maxTokens <= 0` means no ceiling (never evicts)

#### 1.1.2 Archive-Before-Evict (`src/episodic-memory.ts`)

The `EpisodicMemory` class provides lossless eviction:

| Method | Purpose |
|--------|---------|
| `archive(poolId, messages, reason, state?)` | Writes evicted/cleared messages to SQLite `episodes` table BEFORE removal |
| `recall(state, budgetTokens)` | Recalls episodes for state transitions (top-K by recency + BM25) |
| `markSuperseded(ids)` | Marks episodes as consolidated (for vector search) |
| `prune(archiveAfterDays, purgeAfterDays)` | Archives cold entries past threshold, purges very old entries |

**Database schema includes:**
- `episodes` table with FTS5 virtual table for keyword search
- `superseded_by` and `summary_of` columns for consolidation tracking

#### 1.1.3 Pool Clearing (`src/router.ts`, `src/index.ts`)

| Method | Command | Usage |
|--------|---------|-------|
| `clearPool(poolId)` | `/new-issue` command | Empties project pool for fresh issue |
| `clearPoolWithResult(...)` | Not yet wired | Returns cleared messages for journaling |

#### 1.1.4 Background Worker (`src/memory-worker.ts`)

| Job Kind | Trigger | Action |
|----------|---------|--------|
| `summarize` | Transitions, eviction batches, startup | Summarizes evicted messages into journal episode |
| `consolidate` | Periodic | Journal consolidation (not yet implemented) |
| `prune` | Startup / idle | Archives entries past `archiveAfterDays`, purges past `purgeAfterDays` |

#### 1.1.5 Retention on Transition (`src/summary-generator.ts`)

| Method | Purpose |
|--------|---------|
| `extractRetainedContext(sourcePoolId, fromState)` | Deterministic extraction of requirements/decisions/research items |
| `writeRetainedContextToPool(targetState, retained)` | Writes retained block as system message |
| `validateRetainedContext(retained)` | Validates extracted items |

### 1.2 Eviction Triggers

| Event | Pool(s) Affected | Mechanism |
|-------|------------------|-----------|
| `context` hook fires | Global, Project | `enforceCeiling()` |
| `/new-issue` command | Project | `clearPool()` |
| State transition | From pool | `clearPool()` (when `retention.evictSourcePool: true`) |

### 1.3 State-to-Pool Mapping (`src/types.ts:162-166`)

```typescript
STATE_TO_POOL = {
  PLANNING → PLANNING
  CODING → EXECUTION
  DEBUGGING → TESTING
  COMPLETE → PLANNING
}
```

**Critical observation:** COMPLETE and PLANNING both map to PLANNING pool. This creates a "same-pool transition" (COMPLETE→PLANNING) that requires special handling via `popRetainedBlock()` to avoid duplicate retained blocks.

---

## 2. Alternatives Survey

### 2.1 Alternative 1: Compaction Function (In-Place Summarization)

**Description:** Summarize N messages into 1 representative message within the same pool, replacing them in-place.

**Implementation sketch:**
- Add `compactPool(poolId, targetTokens)` to `ContextRouter`
- Identify messages to compact (e.g., oldest 50% by LRU)
- Generate summary via LLM or deterministic extractor
- Replace selected messages with single system message

**Pros:**
- Preserves context density without requiring state transition
- No pool switching overhead
- Configurable compaction threshold

**Cons:**
- Requires LLM call (hot path concern) or deterministic summarization
- May lose nuance compared to explicit retention
- Complexity in determining "what to compact"

---

### 2.2 Alternative 2: Optimized Compaction (Vector-Similarity Grouping)

**Description:** Group semantically similar messages before summarizing, to preserve diversity of content.

**Implementation sketch:**
- Use embeddings (sentence-transformers) to cluster messages
- Summarize each cluster separately
- Create consolidated summary with cluster headers

**Pros:**
- Better preservation of key information
- More intelligent than pure LRU
- Complements existing retention extractor

**Cons:**
- High complexity for pool-sized context (typically 1k-10k tokens)
- Requires ONNX/LM deployment overhead
- Evaluation shows limited gains at small scale (see RESEARCH_BRIEF_PHASE3.md §6)

---

### 2.3 Alternative 3: Same-State Pool Transition

**Description:** When a pool grows too large, transition to a fresh pool of the same type (e.g., PLANNING → PLANNING with new Planning pool).

**Implementation sketch:**
- Detect pool > X% of ceiling
- Call `applyTransition(currentState, "pool growth")` 
- Old pool messages journaled; new pool starts empty
- Retained items migrated via existing extraction

**Pros:**
- Leverages existing transition machinery
- Lossless via journaling
- Natural fit with state machine architecture

**Cons:**
- Changes "context" visible to model (pool identity changes)
- May trigger unnecessary state log entries
- Need to distinguish intentional transition from automatic compaction

---

### 2.4 Alternative 4: Token-Aware Sliding Window

**Description:** Maintain only the last N tokens plus retained context, discarding older non-critical messages.

**Implementation sketch:**
- Track token count per message
- When pool exceeds ceiling, drop oldest messages until under N tokens
- Always preserve `critical` messages and retained block

**Pros:**
- Simple, deterministic
- Predictable memory usage
- No LLM required

**Cons:**
- Already largely covered by existing `enforceCeiling`
- No semantic understanding of what to preserve
- May discard useful older context too aggressively

---

### 2.5 Alternative 5: User-Triggered Compaction

**Description:** Add a `/compact` command that lets users manually trigger compaction.

**Implementation sketch:**
- Register `/compact` command
- Show current pool sizes
- Execute compaction with user confirmation
- Report results

**Pros:**
- User has control over when eviction happens
- Explicit, no surprises
- Can be combined with other strategies

**Cons:**
- Relies on user action (may not happen)
- Interrupts workflow
- Doesn't solve auto-scaling pools

---

### 2.6 Alternative 6: Auto-Compact on Threshold

**Description:** When a pool reaches X% of ceiling, trigger compaction (summarization) instead of waiting for hard eviction.

**Implementation sketch:**
- Add `config.pools.{id}.compactAt` (default 75%)
- Check during `context` hook
- If pool.size > compactAt but < maxTokens, schedule compaction
- Replace oldest N messages with summary

**Pros:**
- Proactive, not reactive
- Avoids abrupt eviction
- Configurable threshold

**Cons:**
- More complex state tracking needed
- May trigger during critical moments
- Risk of compaction thrashing

---

## 3. Gap Analysis vs. Shipped Phase 3 Mechanisms

| Alternative | Covered by Existing | Gap |
|-------------|---------------------|-----|
| **Compaction function** | Partial (summarize job exists) | No in-place pool compaction; eviction only happens on state transition or hard ceiling |
| **Optimized compaction** | No | Significant gap; current summarizer is extractive, not comparative |
| **Same-state pool transition** | Partial (transition helper exists) | No automatic triggering; no same-state compaction mode |
| **Token-aware sliding window** | Yes (`enforceCeiling`) | Gap closed |
| **User-triggered compaction** | No | New feature needed |
| **Auto-compact on threshold** | No | New feature needed |

### 3.1 What's Missing

1. **In-pool compaction without state transition** — The current architecture only compacts via:
   - State transitions (which clear the source pool)
   - Hard eviction when ceiling is exceeded
   
   There's no mechanism for "this pool is too big, condense it" without changing state.

2. **Threshold-triggered compaction** — No proactive measure when pools approach ceiling.

3. **User control** — No `/compact` command for manual intervention.

4. **Same-state transition for compaction** — The infrastructure exists but auto-triggering doesn't.

---

## 4. Recommendations

### 4.1 Primary Recommendation: Auto-Compact on Threshold (Alternative 6)

**Rationale:**
- Works within existing deterministic defaults (configurable, no model required until summary)
- Stays off the hot path (schedules background job, doesn't await in hook)
- Integrates with existing archive-before-evict via scheduler
- Fully configurable via `config.pools.{id}.compactAt`

**Implementation approach:**
1. Add to config:
   ```typescript
   pools: {
     planning: { maxTokens: 8000, compactAt: 6000 }
     // etc.
   }
   ```

2. In `context` hook, after `enforceCeiling`:
   ```typescript
   const current = estimateTokens(pool.messages);
   if (current > config.pools[id].compactAt!) {
     router.enqueueCompact(poolId, config.pools[id].maxTokens!);
   }
   ```

3. `enqueueCompact`:
   - Identify messages to compact (oldest N until target tokens)
   - Archive them via `episodicMemory.archive()`
   - Schedule `summarize` job
   - Replace with summary message

4. The summary job runs in background, preserving determinism via fallback to `DeterministicSummarizer`.

### 4.2 Secondary Recommendation: Same-State Pool Transition (Alternative 3)

**For scenarios where auto-compact isn't sufficient:**

The existing infrastructure supports same-pool transitions via:
- `applyTransition(currentState, "pool growth")`
- `popRetainedBlock()` guard for dedup

This is a natural fit for "reset this pool and start fresh" scenarios, leveraging the already-built journal + retention machinery.

### 4.3 Rejected / Less Suitable

- **Optimized compaction (vector similarity):** Overkill for pool sizes; the extractive retention approach already captures key information. Per Phase 3 contract §6: "token-level prompt compression... rejected for the hot path."

- **User-triggered compaction:** Would require user discipline; auto-compact is more reliable. Can be added as a convenience command alongside auto-compact.

- **Token-aware sliding window:** Already implemented via `enforceCeiling`; no additional value.

---

## 5. Implementation Path

1. **Config extension:** Add `compactAt` to each pool's config in `types.ts`
2. **Router method:** Add `compactPool(poolId, targetTokens)` returning `Promise<EvictedBatch[]>`
3. **Hook integration:** Add auto-compact check in `context` hook (non-blocking, fire-and-forget)
4. **Journal integration:** Archive before removal, schedule summarize job
5. **Observability:** Add `/memory-stats` command showing pool sizes + compact status

---

## 6. Open Questions (For User Clarification)

1. Should compaction be **synchronous** (affecting the current request) or **asynchronous** (background job with eventual consistency)?

2. Should the plugin **auto-trigger state transitions** for compaction (logging "planning → planning"), or should it be **silent** (internal pool reset without state change)?

3. Is there a preference for **threshold-based** compaction (e.g., 80% of ceiling) vs. **event-based** (user commands, specific triggers)?

---

## 7. Conclusion

The primary gap in current eviction mechanisms is the absence of **in-pool compaction without state transition**. The recommended approach is **auto-compact on threshold**, which:
- Triggers when a pool reaches a configurable percentage of its ceiling
- Archives evicted content losslessly
- Summarizes in the background
- Preserves the deterministic-testability invariant
- Integrates cleanly with existing journal infrastructure