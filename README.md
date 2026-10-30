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

### Worked example retained block

```
Context retained from Planning Pool:
[ACCEPTANCE] Given the user uploads a CSV, when it exceeds 10 MB, then it is rejected with a 413.
[REQUIREMENT] The export must complete within 30 seconds for 10k rows.
[ARCHITECTURE] Decision: SQLite for storage, chosen over Postgres (rejected: ops burden).
[RESEARCH] Finding: Bun's SQLite driver handles concurrent readers without locking.
```
