# CONTRACT — Issue #13: Fix Context Loss Between States

**Status:** Final contract for implementation.
**Scope:** `src/summary-generator.ts`, `src/types.ts`, `src/state-machine.ts`, `src/router.ts` (one additive method), `src/index.ts`, `README.md`, `docs/ctx-lifecycle-explainer.html`, plus new tests.

**Hard constraints honored:**
- 1-sentence summary format (`Swapped to <Pool> Pool. <trigger>`) and `validateSummary()` are **unchanged**. All changes are additive.
- Extraction is deterministic, in-process, regex/heuristic — **no LLM calls, no async, no I/O**.
- TypeScript strict, ESM, `.js` import extensions, `no-explicit-any` eslint rule.
- Existing tests must pass unmodified (verified: no existing assertion is affected — see §7).

**Codebase finding (assumption of record):** the brief says the planning pool "gets summarized and cleared" on Planning→Coding, but **no clear/evict logic exists today** — `ContextRouter` has no clear method and `index.ts` never removes messages. This contract makes the clear explicit, additive, and config-gated (`retention.evictSourcePool`, default `true`), applied **after** retained items are written to the target pool, so the carry-forward is never lost.

---

## 1. New/changed type definitions (`src/types.ts`)

All additive. Existing types unchanged.

### 1.1 `RetainedItemCategory` (new enum)

```ts
/** Categories of planning content that must survive a state transition. */
export enum RetainedItemCategory {
  REQUIREMENT = 'requirement',        // key requirements + their constraints
  ARCHITECTURE = 'architecture',      // design/architecture decisions (incl. rejected options)
  RESEARCH = 'research',              // research findings, evidence, sources
  ACCEPTANCE = 'acceptance'           // acceptance criteria / definition of done
}
```

### 1.2 `RetainedContextItem` (new interface)

```ts
export interface RetainedContextItem {
  /** Which category the deterministic extractor classified the line into. */
  category: RetainedItemCategory;
  /** The original text, trimmed, whitespace-normalized, truncated to 240 chars (+"…" if cut). */
  text: string;
  /** Deterministic 0..1 heuristic confidence. Items below `retention.confidenceFloor` are dropped. */
  confidence: number;
  /** Source message id when available, else null (provenance for debugging only). */
  sourceMessageId: string | null;
  /** 1-based index of the matching line within the source message's content. */
  sourceLine: number;
}
```

### 1.3 `RetainedContext` (new interface)

```ts
export interface RetainedContext {
  /** Pool the items were extracted from (the outgoing pool for that state). */
  sourcePool: PoolID;
  /** State the machine transitioned FROM. */
  fromState: StateMachineState;
  /** Deterministically ordered, capped, deduplicated list (see §3.4). May be empty. */
  items: RetainedContextItem[];
  /** Wall-clock ms of capture (Date.now()). Not used by any heuristic. */
  capturedAt: number;
}
```

### 1.4 `TransitionEvent` (extended — additive optional field)

```ts
export interface TransitionEvent {
  fromState: StateMachineState;
  toState: StateMachineState;
  trigger: string;
  timestamp: number;
  /** Present only when the caller captured retained context for this transition. */
  retained?: RetainedContext;
}
```

### 1.5 `ContextPagerConfig` (extended) + new `RetentionConfig`

```ts
export interface RetentionConfig {
  /** Master switch. When false: no extraction, no retained message written, no eviction. */
  enabled: boolean;
  /** Which categories to keep. Empty array ≡ no categories. Order here is irrelevant. */
  categories: RetainedItemCategory[];
  /** Hard cap on items written per transition (after priority selection). */
  maxItems: number;
  /** Items with confidence strictly below this floor are dropped. */
  confidenceFloor: number;
  /** Clear the outgoing (source) pool after the retained handoff lands in the target pool. */
  evictSourcePool: boolean;
}

export interface ContextPagerConfig {
  enabled: boolean;
  tokenCeiling: number;
  pools: {
    global: { maxTokens: number };
    planning: { maxTokens: number };
    execution: { maxTokens: number };
    testing: { maxTokens: number };
  };
  /** New: retention settings. Deep-merged over defaults when a partial config is supplied. */
  retention: RetentionConfig;
}
```

### 1.6 `DEFAULT_CONFIG` (extended)

`DEFAULT_CONFIG.retention` =

```ts
retention: {
  enabled: true,
  categories: [RetainedItemCategory.REQUIREMENT, RetainedItemCategory.ARCHITECTURE,
               RetainedItemCategory.RESEARCH, RetainedItemCategory.ACCEPTANCE],
  maxItems: 10,
  confidenceFloor: 0.4,
  evictSourcePool: true
}
```

`DEFAULT_CONFIG` is exported **by value, not by reference** — `index.ts` merges user config via a `mergeConfig(user: Partial<ContextPagerConfig> | undefined): ContextPagerConfig` helper (new export in `types.ts`) that starts from a fresh deep copy of `DEFAULT_CONFIG` and merges `retention` field-by-field. Prevents callers from mutating the shared default.

### 1.7 Retained-message marker constants (new exports in `types.ts`)

```ts
/** Exact prefix of the system message carrying retained items into the target pool. */
export const RETAINED_CONTEXT_PREFIX = 'Context retained from ';
/** Marker for the single 1-sentence header message (used by dedup guard, see §4.2 step 4). */
export const SUMMARY_MESSAGE_PREFIX = 'Swapped to ';
```

---

## 2. `SummaryGenerator` changes (`src/summary-generator.ts`)

`generateSummary`, `validateSummary`, `addSummaryToPool` are **byte-for-byte unchanged** in behavior. New constructor param and new public methods:

### 2.1 Constructor

```ts
constructor(router: ContextRouter, config: ContextPagerConfig = DEFAULT_CONFIG)
```

Stores `this.config = config`. Existing call sites in tests pass one arg — the default keeps them green.

### 2.2 New public methods

```ts
/**
 * Deterministic extraction over the messages of `sourcePoolId`.
 * Returns { sourcePool, fromState, items: [] } (never throws) when:
 *  - retention is disabled, or
 *  - the pool is missing/empty, or
 *  - no line matches any enabled category.
 * Pure function of input + config; no LLM, no I/O, no clock except capturedAt.
 */
extractRetainedContext(sourcePoolId: PoolID, fromState: StateMachineState): RetainedContext

/** Structural validation of a RetainedContext (defensive; extraction output always passes). */
validateRetainedContext(retained: RetainedContext): void

/**
 * Appends the retained items to `targetState`'s pool as ONE system message:
 *   content = `${RETAINED_CONTEXT_PREFIX}<SourcePoolName> Pool:\n<rendered items>`
 * Renders nothing (no message added, returns false) when retained.items is empty.
 * Returns true when a message was written.
 */
writeRetainedContextToPool(targetState: StateMachineState, retained: RetainedContext): boolean
```

### 2.3 New private methods (implementation guidance)

```ts
private matchLine(line: string): { category: RetainedItemCategory; confidence: number } | null
private normalize(text: string): string        // collapse \s+ → ' ', trim
private renderRetained(retained: RetainedContext): string
```

---

## 3. Extraction logic specification

### 3.1 Input & line model

- Input: `router.getPool(sourcePoolId)?.messages ?? []` (the brief's "planning-pool messages", generalized to the outgoing pool of any transition).
- Messages are processed in array order (chronological). Each message's `content` is split on `\n`.
- **Lines starting with `-`, `*`, or `•` (after trim) are "bullet lines"** and are candidates regardless of length.
- **Non-bullet lines** are candidates only if `normalized.length >= 30` (filters headings, short replies, "OK").
- Each candidate line yields **at most one** item. Lines are classified in category priority order: `ACCEPTANCE → REQUIREMENT → ARCHITECTURE → RESEARCH`; the first matching category wins.
- `system`-role messages are **excluded** (they are plugin-generated: transition summaries, prior retained blocks — this is the dedup guard's second line of defense).

### 3.2 Category pattern table

All patterns case-insensitive. `<line>` means the trimmed line (for non-bullets) or the text after the bullet marker (for bullets). "Starts-with" patterns require the anchor at the start of that effective text; "contains" patterns may match anywhere in the line.

| # | Category | Pattern | Kind | Confidence |
|---|----------|---------|------|-----------|
| 1 | ACCEPTANCE | `^(given\s+.+\s+when\s+.+\s+then\b)` | starts-with | 0.95 |
| 2 | ACCEPTANCE | `^(acceptance\s+criteria\|definition\s+of\s+done\|done\s+when)(?:\s*[—:–-])?` | starts-with | 0.9 |
| 3 | REQUIREMENT | `^(requirement\|req\.?)(?:\s*[#-]?\s*\w+)?:` | starts-with | 0.9 |
| 4 | REQUIREMENT | `^(must\|shall\|needs?\s+to\|non-functional\s+requirement\|nfr\b)(?:\s*[—:–-])?` | starts-with | 0.85 |
| 5 | REQUIREMENT | `\b(must\|shall)\b` (not matched by 1–4) | contains | 0.6 |
| 6 | ARCHITECTURE | `^(architecture\|arch\|design)(\s+decision)?[:\-—]` | starts-with | 0.9 |
| 7 | ARCHITECTURE | `^decision[:\-—]\s*` | starts-with | 0.9 |
| 8 | ARCHITECTURE | `^(adr[-\s]?\w*\s*)?decision:` | starts-with | 0.9 |
| 9 | ARCHITECTURE | `\b(we\s+(decided\|chose\|selected\|rejected)\|decided\s+to\|chosen\s+over)\b` | contains | 0.8 |
| 10 | RESEARCH | `^(research\|finding)(\s+finding)?[:\-—]\s*` | starts-with | 0.9 |
| 11 | RESEARCH | `\b(we\s+(found\|discovered)\|according\s+to\|per\s+[A-Z]\w+\b\|source[:\-])\b` | contains | 0.7 |
| 12 | RESEARCH | `^based\s+on\b` | starts-with | 0.6 |

Notes:
- `RetainedContextItem.confidence` is exactly the table value of the matching row — fully deterministic, same input → same output.
- "Rejected option" lines (row 9) are intentionally captured as ARCHITECTURE — a rejected decision is as valuable to the coding phase as an accepted one.
- The patterns above were verified against every system-generated string in the existing test suite (`Swapped to … Pool. …`, `Test command detected: …`, `Command: /transition …`): **zero matches**, so no retained items are ever extracted from plugin-generated content.

### 3.3 Item construction

For each matching line:
1. `text` = effective text (after bullet marker), `normalize()`d, truncated to **240 chars** (cut at 239 + `…` only when truncation occurs).
2. `sourceMessageId` = `message.id ?? null`; `sourceLine` = 1-based line number within the message content.
3. Items with `confidence < config.retention.confidenceFloor` are dropped.
4. Items whose category is not in `config.retention.categories` are dropped.
5. **Dedup:** key = `normalize(text)`; keep first occurrence (earliest message, earliest line).

### 3.4 Cap, ordering, and selection

After dedup:
1. Stable-sort by (category priority `ACCEPTANCE=0, REQUIREMENT=1, ARCHITECTURE=2, RESEARCH=3`, then `sourceMessageId` array index, then `sourceLine`) — i.e., priority categories first, original chronology within a category.
2. Slice to `config.retention.maxItems`.
3. The **final** `items` array in `RetainedContext` preserves the order from step 1 (which is also the render order).

### 3.5 Rendering (`writeRetainedContextToPool`)

Message written to the target pool:

```
role: 'system'
content:
  Context retained from Planning Pool:
  [ACCEPTANCE] Given the user uploads a CSV, when it exceeds 10 MB, then it is rejected with a 413.
  [REQUIREMENT] The export must complete within 30 seconds for 10k rows.
  [ARCHITECTURE] Decision: SQLite for storage, chosen over Postgres (rejected: ops burden).
  [RESEARCH] Finding: Bun's SQLite driver handles concurrent readers without locking.
createdAt: Date.now()
```

Rules: one line per item, `[CATEGORY] text` with category = enum value uppercased; category groups in priority order (ACCEPTANCE, REQUIREMENT, ARCHITECTURE, RESEARCH); no other text. The first line always starts with `RETAINED_CONTEXT_PREFIX` + capitalized pool name + ` Pool:`.

### 3.6 `validateRetainedContext` rules (throws `Error` with the exact message)

- `items` must be an Array → `'RetainedContext.items must be an array'`
- each item: non-empty `text` string, `text.length <= 241` → `'RetainedContextItem.text must be a non-empty string of at most 241 chars'`
- each item: `typeof confidence === 'number'` and `0 <= confidence <= 1` → `'RetainedContextItem.confidence must be a number between 0 and 1'`
- each item: `category` is a `RetainedItemCategory` value → `'RetainedContextItem.category must be a RetainedItemCategory value'`
- `sourcePool` is a `PoolID` value; `fromState` is a `StateMachineState` value; `capturedAt` is a number → `'RetainedContext.<field> has an invalid value'`

---

## 4. `index.ts` wiring delta

### 4.1 Setup (once)

```ts
const router = new ContextRouter();
const config = mergeConfig(undefined);              // extensible: read plugin options if/when the SDK exposes them
const summaryGenerator = new SummaryGenerator(router, config);
stateMachine = new StateMachine();
```

### 4.2 New transition helper (replaces the duplicated 3-line block in both hook sites)

```ts
const applyTransition = (toState: StateMachineState, trigger: string): void => {
  const fromState = stateMachine!.getCurrentState();
  const summary = summaryGenerator.generateSummary(toState, trigger);
  summaryGenerator.addSummaryToPool(toState, summary);

  // Retention (additive; all of this is skipped when config.retention.enabled === false)
  if (config.retention.enabled) {
    const fromPool = STATE_TO_POOL[fromState] as PoolID;
    const toPool   = STATE_TO_POOL[toState]   as PoolID;
    const retained = summaryGenerator.extractRetainedContext(fromPool, fromState);
    summaryGenerator.validateRetainedContext(retained);
    if (summaryGenerator.writeRetainedContextToPool(toState, retained)) {
      // Dedup guard: if the source pool is the SAME as the target pool (e.g. COMPLETE→PLANNING
      // both map to the planning pool) and it already ends with the retained block, drop it so
      // a round-trip doesn't accumulate duplicates.
      const pool = router.getPool(toPool)!;
      const last = pool.messages[pool.messages.length - 1];
      if (fromPool === toPool && last && last.content.startsWith(RETAINED_CONTEXT_PREFIX)) {
        pool.messages.pop();
      }
    }
    if (config.retention.evictSourcePool && fromPool !== toPool) {
      router.clearPool(fromPool);   // clears AFTER the handoff landed — order is mandatory
    }
    const transitionEvent = stateMachine!.transition(toState, trigger, retained.items.length > 0 ? retained : undefined);
    console.debug(`[context-pager] Transition: ${fromState} -> ${toState} (${trigger})` +
      (retained.items.length > 0 ? ` [retained ${retained.items.length} items]` : ''));
  } else {
    stateMachine!.transition(toState, trigger);
    console.debug(`[context-pager] Transition: ${fromState} -> ${toState} (${trigger})`);
  }
};
```

> **Ordering invariant:** header summary → retained items → source-pool clear. Clearing before the write would lose items when `fromPool === toPool`; clearing after extraction is always safe.

### 4.3 Call sites

- `ctx.command.transform` (the `/transition` command): body becomes `try { applyTransition(parsed.state, parsed.trigger) } catch (error) { console.error('Transition failed:', error); }`.
- `ctx.tool.hook('execute.before')` (test-command auto-transition to DEBUGGING): body becomes `try { applyTransition(StateMachineState.DEBUGGING, trigger) } catch (e) { console.error('Auto-transition failed', e); }` — inside the existing `isTestCommand && state === CODING` guard.

The `context` session hook is unchanged.

### 4.4 `ContextRouter.clearPool` (new additive method, `src/router.ts`)

```ts
/** Removes all messages from a pool. No-op when the pool is unknown. */
clearPool(poolId: PoolID): void {
  const pool = this.pools.get(poolId);
  if (pool) {
    pool.messages.length = 0;
  }
}
```

No other router change. (In-place length reset keeps the same `ContextPool` object references live.)

---

## 5. `StateMachine` changes (`src/state-machine.ts`)

Signature change (additive — existing 2-arg callers still work):

```ts
transition(targetState: StateMachineState, trigger: string, retained?: RetainedContext): TransitionEvent
```

Behavior:
1. Validation and `this.currentState` update unchanged.
2. The returned `TransitionEvent` sets `retained` **only** when the argument is provided: `retained ? { fromState, toState, trigger, timestamp, retained } : { fromState, toState, trigger, timestamp }`. The event object without retention is structurally identical to today's (key absent, not `undefined` — matters for `JSON.stringify` consumers).
3. `TransitionEvent` import updated to include the new type; no other change.

---

## 6. Config defaults (summary)

| Key | Default | Semantics |
|-----|---------|-----------|
| `retention.enabled` | `true` | Master switch for extraction + write + eviction |
| `retention.categories` | all four | Filter set for `matchLine` results |
| `retention.maxItems` | `10` | Cap after priority sort |
| `retention.confidenceFloor` | `0.4` | Drop items with `confidence < floor` |
| `retention.evictSourcePool` | `true` | Clear outgoing pool after handoff (the brief's "cleared" behavior, made explicit) |

`mergeConfig` deep-merges only the `retention` block over defaults; `pools`/`tokenCeiling` merge shallowly or fall back wholesale to defaults (implementation detail, either acceptable).

---

## 7. Integration verification criteria

### 7.1 Existing tests (must pass unmodified)

- `tests/unit/summary.test.ts` — `generateSummary` strings, `validateSummary` rejections: untouched code path. ✅
- `tests/unit/state-machine.test.ts` — 2-arg `transition` still valid. ✅
- `tests/integration/hooks.test.ts` — key checks: (a) auto-transition log line `coding -> debugging` + trigger still logged; (b) after that transition, TESTING pool has exactly **1** message — holds because CODING→DEBUGGING extraction reads the execution pool, which in that test contains only the 1-sentence system summary (excluded: system role). (c) After DEBUGGING→COMPLETE, PLANNING pool has exactly 1 message — holds: testing pool holds only a system summary. (d) Debug-log call-count assertions (`toHaveBeenCalledTimes(1)` etc.) — the new retained-count suffix is appended to the **same** log string, and no extra log calls are added. ✅

### 7.2 New tests to add (contracted behavior)

`tests/unit/retention.test.ts` (new file):
1. **Extraction positive:** seed planning pool with one `assistant` message containing 4 lines (one per category, matching the §3.2 examples) → `extractRetainedContext(PLANNING, PLANNING)` returns exactly 4 items with the exact confidences (0.95/0.85/0.9/0.9… per the matched row), correct categories, `sourceLine` 1..4, dedup key first-wins on a repeated line.
2. **Confidence floor:** with `confidenceFloor: 0.7`, a `must`-contains line (0.6) is dropped while an anchored `Requirement:` line (0.9) survives.
3. **Category filter:** `categories: [ACCEPTANCE]` → only acceptance items returned.
4. **Max items:** 12 requirement lines, `maxItems: 5` → 5 items, first 5 chronologically after priority sort.
5. **Disabled:** `retention.enabled: false` → empty items, and `writeRetainedContextToPool` adds nothing.
6. **Empty/missing pool:** fresh router, `extractRetainedContext(TESTING, DEBUGGING)` → `items: []`, no throw.
7. **system-role exclusion:** a pool whose only message is a `Swapped to …` system message → no items.
8. **Truncation:** 300-char requirement line → `text.length === 241` ending in `…`.
9. **Rendering:** `writeRetainedContextToPool(CODING, retained)` → execution pool gains one `system` message whose content starts with `Context retained from Planning Pool:\n` and contains one `[CATEGORY]` line per item in priority order.
10. **Determinism:** two calls with identical inputs → deep-equal `items`.

`tests/integration/hooks.test.ts` (append, keep existing order/state flow — add after the last test by continuing the state machine from COMPLETE):
11. **End-to-end carry-over:** seed the planning pool via the router (accessible through a new test seam: `applyTransition` isn't exported, so drive it through the real hooks — the cleanest seam is adding the retained items to the planning pool by having the context hook's pool observable: **implementation note** — the integration test should instead seed the planning pool by re-importing is NOT possible (module singleton). Use the existing pattern: run `setup` against a fresh instrumented ctx is also a singleton problem. **Chosen seam:** add the e2e assertions in `tests/unit` using the real `SummaryGenerator` + real `ContextRouter` + real `StateMachine.transition(..., retained)` — the wiring in `index.ts` is covered by the existing integration test for the unchanged parts. This keeps the module-singleton problem out of scope.)
    Assert: planning pool with 3 seed messages → transition PLANNING→CODING with `extractRetainedContext` + `writeRetainedContextToPool` + `clearPool` → execution pool has header + retained message, planning pool is empty, `transitionEvent.retained.items.length === 3`.

### 7.3 Manual / runtime acceptance

- `bun run verify` (typecheck + lint + tests + build) passes.
- With a real planning conversation containing the §3.2 example lines, after `/transition coding` the coding context (via the `context` hook) contains: the 1-sentence header, the `Context retained from Planning Pool:` block, and **not** the raw planning messages (evicted).
- `/transition planning` from coding (round-trip) does not duplicate a retained block in the planning pool (same-pool dedup guard, §4.2).

### 7.4 Edge cases (must be verified by tests or code review)

| # | Edge case | Required behavior |
|---|-----------|-------------------|
| E1 | Source pool empty | `items: []`, no retained message, no crash, source pool untouched |
| E2 | `retention.enabled: false` | Behavior identical to pre-feature code (header summary only), no eviction |
| E3 | `fromPool === toPool` (COMPLETE→PLANNING) | Retained items written, then same-pool dedup guard drops the block if the pool already ended with it; `evictSourcePool` must NOT clear the shared pool (guarded by `fromPool !== toPool`) |
| E4 | All candidate lines below `confidenceFloor` | `items: []`, no retained message |
| E5 | More than `maxItems` matches | Priority-ordered cap, earliest items win within a category |
| E6 | Duplicate lines across messages | First occurrence kept (dedup on normalized text) |
| E7 | Non-ASCII / multiline content | Split on `\n`, normalize whitespace; no regex catastrophic backtracking (all patterns are linear) |
| E8 | `message.id` absent | `sourceMessageId: null` |
| E9 | Trigger text containing `: ` etc. | `generateSummary` + `validateSummary` unchanged — trigger handling is not touched |

---

## 8. Documentation delta

### 8.1 `README.md`

Add section after the intro:

- **What carries over:** on every state transition the 1-sentence header summary is still written to the target pool, **and** a `Context retained from <Pool> Pool:` system message now carries structured retained items (acceptance criteria, requirements+constraints, architecture decisions, research findings) extracted deterministically from the outgoing pool.
- **What is summarized away:** the rest of the outgoing pool is evicted after the handoff (configurable).
- **Config table:** the 5 `retention.*` keys with defaults (§6) and one worked example of a retained block.

### 8.2 `docs/ctx-lifecycle-explainer.html`

In the "🔄 The Flow" graphic-container (section "How It Works"), insert a new `flow-step` between step 2 (Planning Phase) and the arrow to step 3, styled with the existing `.flow-step` classes:

- **Title:** `📦 Context Handoff (retention)`
- **Description:** `1-sentence summary header + structured items carry over; raw pool is evicted.`

Below it, add a **two-column graphic** (reusing `.two-column`, `.pool-box`, `.graphic-container`):

- **Left box — "✅ What carries over"** (border-left green `var(--secondary)`):
  - 1-sentence header summary (`Swapped to … Pool. …`)
  - `[ACCEPTANCE]` items
  - `[REQUIREMENT]` items (with constraints)
  - `[ARCHITECTURE]` decisions (incl. rejected options)
  - `[RESEARCH]` findings
- **Right box — "🗑️ What is summarized away"** (border-left `#ef4444`):
  - Raw planning/execution conversation lines
  - Chatter, corrections, superseded drafts
  - (note line: "only if `retention.evictSourcePool` is on")

Also update the Planning pool-box description from `Research & design (summarized then deleted)` to `Research & design (key items retained, rest summarized then deleted)`. Update the `summary-generator.ts` feature-card blurb to mention retained-context extraction. No new CSS classes may be required — use inline styles consistent with the file if needed.

---

## 9. Assumptions of record

1. **Eviction is new code** (see codebase finding at top). Default-on per the brief's description of current behavior.
2. **Extraction generalizes to every transition** (any fromPool), not just Planning→Coding — same code path, and it's what makes CODING→PLANNING round-trips safe (E3).
3. **Plugin config injection:** the OpenCode plugin SDK in this repo exposes no options API today, so `mergeConfig(undefined)` is used; the `retention` block is shaped to be dropped into a future `options` object without redesign.
4. **No `PersistedPools` schema change** (`SCHEMA_VERSION` stays 1) — retained items live as ordinary pool messages and are persisted with them.
5. Retained-message text is trusted as data (no HTML/markdown injection surface — plain text in a system message), so no escaping requirement.
