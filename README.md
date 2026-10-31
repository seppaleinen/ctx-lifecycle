# ctx-lifecycle
A middleware extension for OpenCode designed to manage context lifecycles via issue-scoped eviction, swappable domain pools (Global, Planning, Execution, Testing), and asynchronous state offloading.

## What carries over on every transition

On every state transition the 1-sentence header summary (`Swapped to <Pool> Pool. <trigger>`) is still written to the target pool, **and** a `Context retained from <Pool> Pool:` system message now carries structured retained items extracted deterministically from the outgoing pool:

- **`[ACCEPTANCE]`** — acceptance criteria / definition of done
- **`[REQUIREMENT]`** — key requirements with their constraints
- **`[ARCHITECTURE]`** — design/architecture decisions (including rejected options)
- **`[RESEARCH]`** — research findings, evidence, sources

### What is summarized away

The rest of the outgoing pool is evicted after the retained handoff lands in the target pool (configurable via `retention.evictSourcePool`, default `true`). The ordering invariant is always: **header summary → retained block → evict source pool**.

### Retention configuration

| Key | Default | Semantics |
|-----|---------|-----------|
| `retention.enabled` | `true` | Master switch for extraction + write + eviction |
| `retention.categories` | all four | Filter set for extracted items |
| `retention.maxItems` | `10` | Hard cap after priority sort |
| `retention.confidenceFloor` | `0.4` | Drop items with confidence strictly below this floor |
| `retention.evictSourcePool` | `true` | Clear the outgoing pool after the handoff |

```ts
import { mergeConfig } from './src/types.js';
const config = mergeConfig({
  retention: { maxItems: 5, confidenceFloor: 0.7, evictSourcePool: false }
});
```

### Global Pool: LRU Eviction & Project Pool

The Global pool is long-lived and shared across sessions, so it has no
state-transition eviction path. Without a cap it grows without bound — that's
why `globalMaxTokens` exists. Every time the context hook fires, the router
runs `enforceCeiling(PoolID.GLOBAL, config.globalMaxTokens)` and evicts
least-recently-used messages until the pool is back under the ceiling.

A **Project pool** (`PoolID.PROJECT`) rides alongside Global on every state. It
holds project-scoped context — issue notes, pinned requirements, scratch work —
and gets its own ceiling via `pools.project.maxTokens`. Messages flagged
`critical: true` are never evicted, so a pinned requirement survives LRU
trimming. Use the `/new-issue` command to clear the Project pool when starting
a fresh issue.

| Key | Default | Semantics |
|-----|---------|-----------|
| `globalMaxTokens` | `5000` | Hard token ceiling for the Global pool (LRU eviction) |
| `pools.project.maxTokens` | `3000` | Hard token ceiling for the Project pool (LRU eviction) |

```ts
import { mergeConfig } from './src/types.js';
const config = mergeConfig({
  globalMaxTokens: 3000,
  pools: { project: { maxTokens: 2000 } }
});
```

### Worked example retained block

```
Context retained from Planning Pool:
[ACCEPTANCE] Given the user uploads a CSV, when it exceeds 10 MB, then it is rejected with a 413.
[REQUIREMENT] The export must complete within 30 seconds for 10k rows.
[ARCHITECTURE] Decision: SQLite for storage, chosen over Postgres (rejected: ops burden).
[RESEARCH] Finding: Bun's SQLite driver handles concurrent readers without locking.
```
