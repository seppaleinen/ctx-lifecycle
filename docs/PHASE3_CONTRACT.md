# Phase 3 Implementation Contract

> 🧠 **From Hindsight memory** — Research Brief: context-pager Phase 3 — Built from docs/RESEARCH_BRIEF_PHASE3.md

---

## 1. Module Contracts

### 1.1 `src/persistence.ts` — Pool Persistence Layer

```typescript
/**
 * Persistence module: loads/saves pools to ctx.storage for restart durability.
 */
export class Persistence {
  constructor(private projectId: string, private ctx: PluginContext);

  /**
   * Load persisted pools from ctx.storage.
   * Returns default empty pools if no data or migration needed.
   * Schema version migration: v1 → v2 (adds project pool).
   */
  load(): Promise<PoolSnapshot>;

  /**
   * Save current pool state to ctx.storage.
   * Atomic write semantics via plugin API.
   */
  save(name: string, messages: ContextMessage[]): Promise<void>;

  /**
   * Save all pools atomically. Used on eviction/transition.
   */
  saveAll(pools: Record<PoolID, ContextMessage[]>): Promise<void>;
}

/** Snapshot of pool data for persistence */
export interface PoolSnapshot {
  version: 2;  // SCHEMA_VERSION + 1
  projectId: string;
  updatedAt: number;
  pools: {
    global: ContextMessage[];
    project: ContextMessage[];
    planning: ContextMessage[];
    execution: ContextMessage[];
    testing: ContextMessage[];
  };
}
```

### 1.2 `src/episodic-memory.ts` — Episodic Journal & Recall

```typescript
/**
 * SQLite-backed episodic memory journal.
 * Archive-before-evict writes, recall-on-transition reads.
 */
export class EpisodicMemory {
  private db: Database;

  constructor(filePath: string);

  /**
   * Initialize database with schema (FTS5 always, vec0 if enabled).
   * Write lock: batch inserts in transaction.
   */
  async init(): Promise<void>;

  /**
   * Archive evicted/cleared messages BEFORE removal.
   * reason = 'eviction' | 'clearPool' | 'transition' | 'summary'
   */
  async archive(
    poolId: PoolID,
    messages: ContextMessage[],
    reason: string,
    state?: StateMachineState
  ): Promise<void>;

  /**
   * Recall recent episodes for a state transition.
   * Budget-constrained top-K by recency + FTS5 BM25 score.
   * Returns formatted recall block content.
   */
  async recall(state: StateMachineState, budgetTokens: number): Promise<string>;

  /**
   * Mark episodes as consolidated (superseded by summary).
   * Enables supersession filter in recall.
   */
  async markSuperseded(ids: number[]): Promise<void>;

  /**
   * Prune old cold entries (aging policy).
   */
  async prune(archiveAfterDays: number, purgeAfterDays: number): Promise<PruneResult>;

  /**
   * Get job queue entry for embedding (vector path).
   */
  getPendingEmbedJobs(): Promise<EpisodeMetadata[]>;
}

/** Episode stored in the journal */
export interface Episode {
  id: number;
  ts: number;           // ms
  pool: PoolID;           // source pool
  state: StateMachineState; // state at capture
  role: Role;
  content: string;
  category?: RetainedItemCategory;
  summary_of?: number;    // consolidated-into pointer
  superseded_by?: number;
  access_count: number;
  last_accessed?: number;
  embedding?: number[];   // optional vec0 index
}

export interface PruneResult {
  archived: number;
  purged: number;
}
```

### 1.3 `src/memory-worker.ts` — Background Worker

```typescript
/**
 * In-process async job queue for background summarization/consolidation.
 * Triggered by: transitions, eviction batches, session.idle, startup.
 * Hot path invariant: hooks NEVER await this worker.
 */
export class MemoryWorker {
  private queue: Job[] = [];
  private running: boolean = false;
  private readonly MAX_CONCURRENCY = 1;

  constructor(
    private summarizer: Summarizer,
    private episodicMemory: EpisodicMemory,
    private config: MemoryConfig
  );

  /**
   * Bootstrap from persisted job queue (restart recovery).
   * Returns jobs already in flight.
   */
  async start(): Promise<void>;

  /**
   * Stop worker and drain queue.
   */
  async stop(): Promise<void>;

  /**
   * Schedule a job (coalesces duplicates by kind+pool).
   */
  enqueue(kind: Job['kind'], payload: JobPayload): void;

  /**
   * Get pending job count (for testing).
   */
  getJobCount(): number;
}

export type JobKind = 'summarize' | 'consolidate' | 'embed' | 'calibrate' | 'prune';

export interface Job {
  kind: JobKind;
  payload: JobPayload;
  queuedAt: number;
  attempts: number;
}

export interface JobPayload {
  summarize: { poolId: PoolID; episodeIds: number[] };
  consolidate: { poolId: PoolID; sinceTs: number };
  embed: { episodeIds: number[] };
  calibrate: { providerTokens: number; ourEstimate: number };
  prune: { archiveAfterDays: number; purgeAfterDays: number };
}
```

### 1.4 `src/summarizer.ts` — Two-Tier Summarizer (Interface + Impl)

```typescript
/**
 * Summarizer interface for background LLM/deterministic summaries.
 * Two implementations: LlmSummarizer (host model) + DeterministicSummarizer (extractive).
 */
export interface Summarizer {
  /**
   * Summarize evicted messages into a journal episode.
   * Returns summary content (no metadata).
   */
  summarize(messages: EvictedBatch, opts?: SummarizeOptions): Promise<string>;
}

export interface EvictedBatch {
  poolId: PoolID;
  state: StateMachineState;
  messages: ContextMessage[];
  retained?: RetainedContext;
  trigger: string;
}

export interface SummarizeOptions {
  maxInputChars: number;   // ~8000
  maxOutputChars: number;  // ~600
}

/** Deterministic implementation: extend retention extractor + rollup */
export class DeterministicSummarizer {
  summarize(batch: EvictedBatch): Promise<string>;
}

/** LLM implementation: wraps ctx.experimental.generate.text */
export class LlmSummarizer {
  constructor(
    private ctx: PluginContext,
    private config: LlmSummarizerConfig
  );

  summarize(batch: EvictedBatch): Promise<string>;
}

export interface LlmSummarizerConfig {
  enabled: boolean;
  model?: { providerID: string; id: string };
  inputChars: number;
  outputChars: number;
}
```

### 1.5 `src/embedder.ts` — Optional Vector Embedding (Lazy-Loaded)

```typescript
/**
 * Lazy-loaded ONNX embedding pipeline (only when memory.vector = 'auto').
 * Uses Xenova/all-MiniLM-L6-v2 (384-d q8).
 */
export class Embedder {
  private pipeline: EmbedPipeline | null = null;
  private readonly DIM = 384;

  constructor(modelId: string = 'Xenova/all-MiniLM-L6-v2');

  /**
   * Initialize pipeline on first call (background load).
   */
  async init(): Promise<void>;

  /**
   * Embed a batch of texts. Returns flat [N, 384] array.
   */
  async embed(texts: string[]): Promise<Float32Array>;

  /**
   * Get embedding dimension (always 384).
   */
  getDimension(): number;
}
```

---

## 2. Integration Points

### 2.1 `src/types.ts` — Config Schema Addition

```typescript
// New constants
export const RECALL_PREFIX = 'Previously in ';
export const SCHEMA_VERSION = 2;  // Updated from 1

// Memory config block to be deep-merged
export interface MemoryConfig {
  enabled: boolean;           // master switch; false → Phase 2 behavior
  dbPath: string;             // default: <XDG>/opencode/storage/plugin/context-pager/memory.db
  recallBudgetTokens: number; // default 1500
  recallTopK: number;         // default 8
  journal: {
    archiveBeforeEvict: boolean; // default true
  };
  worker: {
    llmSummaries: boolean;       // default true
    model?: { providerID: string; id: string };
    consolidateEvery: number;    // episodes, default 40
  };
  vector: 'off' | 'auto';       // default 'off'
  embeddingModel: string;        // default 'Xenova/all-MiniLM-L6-v2'
  archiveAfterDays: number;    // default 30
  purgeAfterDays: number;      // default 90
}

// Updated ContextPagerConfig
export interface ContextPagerConfig {
  enabled: boolean;
  tokenCeiling: number;
  pools: { ... };            // existing
  retention: RetentionConfig; // existing
  memory: MemoryConfig;      // NEW
}

// New partial type for config merging
export type PartialMemoryConfig = Partial<Omit<MemoryConfig, 'dbPath'>> & {
  dbPath?: string;
};

export type PartialContextPagerConfig = ... & {
  memory?: PartialMemoryConfig;
};
```

### 2.2 `src/router.ts` — Eviction Interception Hook

```typescript
// NEW: Emit removed batch for archival
export interface EvictionResult {
  removedMessages: EvictedBatch;
  wasEvicted: boolean;
}

// Modified enforceCeiling returns evicted messages
export interface EvictionEvent {
  poolId: PoolID;
  messages: EvictedBatch[];
}

// NEW: clearPool returns cleared messages
export interface ClearEvent {
  poolId: PoolID;
  messages: EvictedBatch;
}

// Add to ContextRouter:
export class ContextRouter {
  // Returns what was evicted (for journal)
  enforceCeiling(poolId: PoolID, maxTokens: number): EvictedBatch[];
  
  // Returns what was cleared (for journal)
  clearPool(poolId: PoolID): EvictedBatch;
  
  // New: write recall block to pool
  addRecallBlock(poolId: PoolID, content: string): void;
}
```

### 2.3 `src/index.ts` — Worker Bootstrap & Integration

```typescript
// NEW imports
import { Persistence } from './persistence.js';
import { EpisodicMemory } from './episodic-memory.js';
import { MemoryWorker } from './memory-worker.js';
import { DeterministicSummarizer, LlmSummarizer, Summarizer } from './summarizer.js';

export default Plugin.define({
  id: 'context-pager',
  setup: async (ctx) => {
    // Phase 3: Initialize persistence and memory infrastructure
    const enabled = mergeConfig(undefined).memory?.enabled ?? false;
    const projectId = (await ctx.storage.get('metadata'))?.projectId ?? 'default';
    
    const persistence = new Persistence(projectId, ctx.storage);
    const config = mergeConfig(undefined);
    
    // Load persisted pools on startup
    if (enabled) {
      const snapshot = await persistence.load();
      router.initializeFromSnapshot(snapshot);
    }
    
    // Initialize episodic memory (FTS5 always, vec0 optional)
    const dbPath = config.memory?.dbPath ?? getDefaultDbPath();
    const episodicMemory = new EpisodicMemory(dbPath);
    await episodicMemory.init();
    
    // Initialize summarizer (LLM or deterministic)
    const summarizer: Summarizer = config.memory?.worker?.llmSummaries
      ? new LlmSummarizer(ctx, config.memory!.worker!)
      : new DeterministicSummarizer();
    
    // Initialize worker
    const worker = new MemoryWorker(summarizer, episodicMemory, config.memory!);
    await worker.start();
    
    // Register cleanup
    return () => {
      worker.stop();
      episodicMemory.close();
      persistence.saveAll(router getAll pools ...);
    };
    
    // Context hook: add recall block (synchronous, hot path invariant)
    await ctx.session.hook('context', async (event) => {
      if (!enabled) return;
      
      const activeMessages = router.getActivePools(stateMachine!.getCurrentState());
      
      // Re-call router.enforceCeiling to get evicted batch for journal
      const evicted = router.enforceCeiling(...);
      for (const batch of evicted) {
        await episodicMemory.archive(
          batch.poolId,
          batch.messages,
          'eviction',
          stateMachine?.getCurrentState()
        );
        // Schedule background summarization
        worker.enqueue('summarize', { poolId: batch.poolId, episodeIds: [...] });
      }
      
      // Recall on entry (synchronous, FTS5)
      const recall = await episodicMemory.recall(state, config.memory!.recallBudgetTokens);
      if (recall) {
        router.addRecallBlock(activePoolId, recall);
      }
      
      // ... rest of existing logic
    });
    
    // Transition hook: archive source pool before clear
    const applyTransition = (toState: StateMachineState, trigger: string) => {
      const fromPool = STATE_TO_POOL[fromState];
      
      if (config.retention.evictSourcePool) {
        const cleared = router.clearPool(fromPool);
        if (cleared.messages.length > 0) {
          episodicMemory.archive(...);
          worker.enqueue('summarize', ...);
        }
      }
      // ... rest of existing
    };
  }
});
```

### 2.4 Commands to Add in `src/index.ts`

```typescript
// /recall command - view journal entries
editor.add({
  name: 'recall',
  description: 'Query episodic memory for recall blocks',
  execute: async ({ prompt: { text } }) => {
    // Parse: /recall [--pool=poolId] [--limit=N]
    // Return formatted recall candidates
  }
});

// /memory-stats command - observability
editor.add({
  name: 'memory-stats',
  description: 'Show memory subsystem statistics',
  execute: async () => {
    console.debug(`Pools: ${tokenCounts} | Journal: ${rowCount} rows | DB: ${size} bytes`);
  }
});
```

---

## 3. Data Schemas

### 3.1 SQLite Schema (memory.db)

```sql
-- Main episodes table (append-only)
CREATE TABLE episodes (
  id            INTEGER PRIMARY KEY,
  ts            INTEGER NOT NULL,            -- ms timestamp
  pool          TEXT NOT NULL,               -- PoolID enum
  state         TEXT NOT NULL,               -- StateMachineState enum
  role          TEXT NOT NULL,               -- Role enum
  content       TEXT NOT NULL,
  category      TEXT,                        -- RetainedItemCategory or NULL
  summary_of    INTEGER,                     -- FK to id (consolidated-into)
  superseded_by INTEGER,                     -- FK to id
  access_count  INTEGER NOT NULL DEFAULT 0,
  last_accessed INTEGER,
  embedding     BLOB                         -- Only when vector enabled
);

-- FTS5 index for BM25 keyword search (always on)
CREATE VIRTUAL TABLE episodes_fts USING fts5(
  content, content='episodes', content_rowid='id'
);

-- Optional vec0 table for vector search
CREATE VIRTUAL TABLE episode_vec USING vec0(
  embedding float[384]
);

-- Job queue persistence (for restart recovery)
CREATE TABLE job_queue (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  kind        TEXT NOT NULL,                    -- 'summarize' | 'consolidate' | ...
  payload     TEXT NOT NULL,                    -- JSON
  queuedAt    INTEGER NOT NULL,
  attempts    INTEGER NOT NULL DEFAULT 1
);
```

### 3.2 TypeScript Data Types

```typescript
// Enhanced Episode with optional embedding
export interface EpisodeRow {
  id: number;
  ts: number;
  pool: PoolID;
  state: StateMachineState;
  role: 'system' | 'user' | 'assistant';
  content: string;
  category: RetainedItemCategory | null;
  summary_of: number | null;
  superseded_by: number | null;
  access_count: number;
  last_accessed: number | null;
}

// Vector search result
export interface VectorResult {
  rowid: number;
  distance: number;
  content: string;
}

// Job queue item
export interface JobQueueItem {
  id: number;
  kind: JobKind;
  payload: string;  // JSON string
  queuedAt: number;
  attempts: number;
}

// Schema version marker (for migration)
export const SCHEMA_VERSION = 2;
```

---

## 4. Config Schema

```typescript
// Full memory config block (to add to types.ts)
export const DEFAULT_MEMORY_CONFIG: MemoryConfig = {
  enabled: false,           // Master switch: Phase 2 behavior when false
  dbPath: getDefaultDbPath(), // XDG path: ~/.local/share/opencode/storage/plugin/context-pager/memory.db
  recallBudgetTokens: 1500, // Token budget for recall block injection
  recallTopK: 8,            // Max episodes to consider
  journal: {
    archiveBeforeEvict: true  // Archive-before-evict enabled by default
  },
  worker: {
    llmSummaries: true,     // Use host model for summaries when available
    model: undefined,       // Override model (default: session model)
    consolidateEvery: 40    // Consolidate after N episodes
  },
  vector: 'off',            // 'off' or 'auto' - vector search disabled by default
  embeddingModel: 'Xenova/all-MiniLM-L6-v2',
  archiveAfterDays: 30,     // Age threshold for cold archive
  purgeAfterDays: 90        // Age threshold for permanent purge
} as const;

// Default DB path helper
function getDefaultDbPath(): string {
  return path.join(
    process.env.XDG_DATA_HOME ?? 
    path.join(os.homedir(), '.local/share'),
    'opencode',
    'storage',
    'plugin',
    'context-pager',
    'memory.db'
  );
}

// mergeConfig must be extended to deep-merge the memory block
const MEMORY_CONFIG_KEYS = [...]; // all MemoryConfig keys

export function mergeConfig(user: PartialContextPagerConfig | undefined): ContextPagerConfig {
  // ... existing merge logic ...
  
  // NEW: Deep merge memory config
  if (user.memory) {
    base.memory = { ...DEFAULT_MEMORY_CONFIG, ...user.memory };
    // Handle nested objects
    if (user.memory.journal) base.memory.journal = { ...base.memory.journal, ...user.memory.journal };
    if (user.memory.worker) base.memory.worker = { ...base.memory.worker, ...user.memory.worker };
  }
  
  return base;
}
```

---

## 5. Test Strategy

### 5.1 `persistence.test.ts` — Unit Tests

| Test Case | Expected Behavior |
|-----------|-------------------|
| `load() returns empty pools when no data` | Fresh install scenario |
| `save() persists and load() retrieves` | Round-trip persistence |
| `saveAll() atomicity across pools` | Concurrent updates don't corrupt |
| `migration: v1 schema loads and converts` | Backward compatibility |

### 5.2 `episodic-memory.test.ts` — Unit Tests

| Test Case | Expected Behavior |
|-----------|-------------------|
| `archive() writes to episodes table` | Append-only journal |
| `archive() writes to FTS5 synchronously` | Full-text index updated |
| `recall() returns formatted block within budget` | Token budget respected |
| `recall() filters consolidated/superceded` | No stale content returned |
| `recall() ranks by recency + BM25` | Most relevant first |
| `prune() moves old entries to cold storage` | Aging policy enforced |
| `getPendingEmbedJobs() returns unembeded episodes` | Vector path ready |

### 5.3 `memory-worker.test.ts` — Unit Tests

| Test Case | Expected Behavior |
|-----------|-------------------|
| `enqueue() schedules summarize job` | Job queued |
| `worker coalesces duplicate jobs` | Same kind+pool → single job |
| `maxConcurrency=1 enforced` | Jobs processed sequentially |
| `start() drains persisted queue on restart` | Crash recovery |
| `summarize uses LlmSummarizer when enabled` | LLM tier active |
| `summarize falls back to deterministic` | Deterministic tier fallback |

### 5.4 `summarizer.test.ts` — Unit Tests

| Test Case | Expected Behavior |
|-----------|-------------------|
| `DeterministicSummarizer.summarize() extracts retention items` | Extractive summary |
| `DeterministicSummarizer.summarize() wraps long batches` | Chunking for >8k chars |
| `LlmSummarizer calls ctx.experimental.generate.text()` | Host model used |
| `LlmSummarizer caps input/output` | Token limits respected |
| `LlmSummarizer fallback on error` | Deterministic fallback |
| `memory.enabled=false skips all Phase 3 work` | Phase 2 behavior preserved |

### 5.5 `embedder.test.ts` — Unit Tests (vector flag ON)

| Test Case | Expected Behavior |
|-----------|-------------------|
| `init() loads pipeline lazily` | Model not loaded until first call |
| `embed() returns Float32Array with dim=384` | Correct shape |
| `embed() batches multiple texts` | Correct tensor shape |
| `device: 'cpu' pinned in config` | Deterministic embedding |

### 5.6 Integration Test: Eviction Flow

```typescript
// tests/integration/eviction-flow.test.ts
it('enforceCeiling archives evicted messages to journal', async () => {
  // 1. Seed pool near ceiling
  // 2. Call enforceCeiling with lower max
  // 3. Assert: messages removed from pool
  // 4. Assert: journal has episodes with archived content
  // 5. Assert: /recall shows archived content
});
```

### 5.7 Integration Test: State Transition Recall

```typescript
it('transition injects recall block within token budget', async () => {
  // 1. Seed journal with episodes
  // 2. Trigger transition (PLANNING → CODING)
  // 3. Assert: recall block injected as system message
  // 4. Assert: retention extractor skips system role (no loop)
});
```

### 5.8 Regression Tests: Phase 2 Green

```typescript
// With memory.enabled=false:
// - All 67 existing tests pass unchanged
// - No memory.db file created
// - No worker initialized
// - No journal entries written
```

### 5.9 Performance Guard Test

```typescript
it('context hook latency under 5ms for 30-message pool', async () => {
  // Seed pools with 30 messages
  // Time context hook execution
  // Expect: < 5ms
});
```

---

## 6. Build Order Implementation Map

| Phase | Module | Key Interfaces | Tests |
|-------|--------|----------------|-------|
| ① | `persistence.ts` | `Persistence.load()`, `Persistence.saveAll()` | `persistence.test.ts` |
| ② | `episodic-memory.ts` | `EpisodicMemory.archive()`, `recall()` | `episodic-memory.test.ts` + integration |
| ③ | `memory-worker.ts`, `summarizer.ts` | `MemoryWorker.enqueue()`, `Summarizer` | `memory-worker.test.ts`, `summarizer.test.ts` |
| ④ | (policy in `index.ts`) | Worker triggers | integration tests |
| ⑤ | `embedder.ts` (lazy) | `Embedder.embed()` | `embedder.test.ts` |
| ⑥ | (instrumentation) | `/memory-stats` command | performance tests |

---

## 7. TRACE

TRACE: dev-team-lead → dev-architect → [this contract returned]

STATUS: [SUCCESS]