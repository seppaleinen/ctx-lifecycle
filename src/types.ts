export enum PoolID {
  GLOBAL = 'global',
  PROJECT = 'project',
  PLANNING = 'planning',
  EXECUTION = 'execution',
  TESTING = 'testing'
}

// A context message matching OpenCode's ModelMessage shape
export interface ContextMessage {
  id?: string
  role: 'system' | 'user' | 'assistant'
  content: string
  createdAt?: number
  /** When true, the message is exempt from LRU eviction (e.g. pinned requirements). */
  critical?: boolean
  /** Wall-clock ms of the last explicit or implicit access. Used by LRU eviction. */
  accessedAt?: number
}

// Pool types

export enum StateMachineState {
  PLANNING = 'planning',
  CODING = 'coding',
  DEBUGGING = 'debugging',
  COMPLETE = 'complete'
}

export interface ContextPool {
  id: PoolID;
  messages: ContextMessage[];
}

/** Categories of planning content that must survive a state transition. */
export enum RetainedItemCategory {
  REQUIREMENT = 'requirement',
  ARCHITECTURE = 'architecture',
  RESEARCH = 'research',
  ACCEPTANCE = 'acceptance'
}

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

export interface TransitionEvent {
  fromState: StateMachineState;
  toState: StateMachineState;
  trigger: string;
  timestamp: number;
  /** Present only when the caller captured retained context for this transition. */
  retained?: RetainedContext;
}

export interface PersistedPools {
  version: number;
  projectId: string;
  updatedAt: number;
  pools: {
    global: ContextPool;
    project: ContextPool;
    planning: ContextPool;
    execution: ContextPool;
    testing: ContextPool;
  };
}

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

/** Memory configuration for Phase 3 long-horizon memory */
export interface MemoryConfig {
  enabled: boolean;
  dbPath: string;
  recallBudgetTokens: number;
  recallTopK: number;
  journal: {
    archiveBeforeEvict: boolean;
  };
  worker: {
    llmSummaries: boolean;
    model?: { providerID: string; id: string };
    consolidateEvery: number;
  };
  vector: 'off' | 'auto';
  embeddingModel: string;
  archiveAfterDays: number;
  purgeAfterDays: number;
}

/** Episode row from SQLite */
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

/** Evicted batch for journaling */
export interface EvictedBatch {
  poolId: PoolID;
  state: StateMachineState;
  messages: ContextMessage[];
  retained?: RetainedContext;
  trigger: string;
}

export interface ContextPagerConfig {
  enabled: boolean;
  tokenCeiling: number;
  pools: {
    global: { maxTokens: number };
    project: { maxTokens: number };
    planning: { maxTokens: number };
    execution: { maxTokens: number };
    testing: { maxTokens: number };
  };
  /** Retention settings. Deep-merged over defaults when a partial config is supplied. */
  retention: RetentionConfig;
  /** Phase 3 long-horizon memory configuration */
  memory: MemoryConfig;
}

export const STATE_TO_POOL: Record<string, PoolID> = {
  [StateMachineState.PLANNING]: PoolID.PLANNING,
  [StateMachineState.CODING]: PoolID.EXECUTION,
  [StateMachineState.DEBUGGING]: PoolID.TESTING,
  [StateMachineState.COMPLETE]: PoolID.PLANNING
};

export const SCHEMA_VERSION = 2;

/** Exact prefix of the system message carrying retained items into the target pool. */
export const RETAINED_CONTEXT_PREFIX = 'Context retained from ';

/** Prefix for recall blocks injected on state transitions */
export const RECALL_PREFIX = 'Previously in ';

/** Default XDG data path for memory database */
const XDG_DATA_HOME = process.env.XDG_DATA_HOME;
const HOME = process.env.HOME || '/Users/seppa';
const DEFAULT_MEMORY_DB_PATH: string = XDG_DATA_HOME
  ? `${XDG_DATA_HOME}/opencode/storage/plugin/context-pager/memory.db`
  : `${HOME}/.local/share/opencode/storage/plugin/context-pager/memory.db`;

export const DEFAULT_MEMORY_CONFIG: MemoryConfig = {
  enabled: false,
  dbPath: DEFAULT_MEMORY_DB_PATH,
  recallBudgetTokens: 1500,
  recallTopK: 8,
  journal: {
    archiveBeforeEvict: true
  },
  worker: {
    llmSummaries: true,
    model: undefined,
    consolidateEvery: 40
  },
  vector: 'off',
  embeddingModel: 'Xenova/all-MiniLM-L6-v2',
  archiveAfterDays: 30,
  purgeAfterDays: 90
};

export const DEFAULT_CONFIG: ContextPagerConfig = {
  enabled: true,
  tokenCeiling: 25000,
  pools: {
    global: { maxTokens: 5000 },
    project: { maxTokens: 3000 },
    planning: { maxTokens: 8000 },
    execution: { maxTokens: 10000 },
    testing: { maxTokens: 5000 }
  },
  retention: {
    enabled: true,
    categories: [
      RetainedItemCategory.REQUIREMENT,
      RetainedItemCategory.ARCHITECTURE,
      RetainedItemCategory.RESEARCH,
      RetainedItemCategory.ACCEPTANCE
    ],
    maxItems: 10,
    confidenceFloor: 0.4,
    evictSourcePool: true
  },
  memory: { ...DEFAULT_MEMORY_CONFIG }
};

/**
 * A user-supplied partial config. The `retention` and `memory` blocks may themselves be partial
 * so callers can tune one knob without respecifying every field; untouched keys fall back to defaults.
 */
export type PartialContextPagerConfig = Partial<Omit<ContextPagerConfig, 'retention' | 'memory'>> & {
  retention?: Partial<RetentionConfig>;
  memory?: Partial<Omit<MemoryConfig, 'dbPath'>> & {
    dbPath?: string;
  };
};

/**
 * Deep-merge a partial user config over a fresh copy of DEFAULT_CONFIG.
 * Returns a fresh object so callers cannot mutate the shared DEFAULT_CONFIG.
 */
const POOL_KEYS = Object.keys(DEFAULT_CONFIG.pools) as (keyof ContextPagerConfig['pools'])[];

export function mergeConfig(user: PartialContextPagerConfig | undefined): ContextPagerConfig {
  // Shallow copy of the top level — every nested object touched below is
  // re-spread into a fresh object, so the shared DEFAULT_CONFIG is never
  // mutated and the deep clone is unnecessary.
  const base: ContextPagerConfig = { ...DEFAULT_CONFIG };
  if (!user) {
    return base;
  }
  if (typeof user.enabled === 'boolean') base.enabled = user.enabled;
  if (typeof user.tokenCeiling === 'number') base.tokenCeiling = user.tokenCeiling;
  if (user.pools) {
    base.pools = { ...base.pools };
    for (const key of POOL_KEYS) {
      base.pools[key] = { ...base.pools[key], ...(user.pools[key] ?? {}) };
    }
  }
  if (user.retention) {
    base.retention = { ...base.retention };
    const r = user.retention;
    // Type-safe merging with validation for retention fields
    if (typeof r.enabled === 'boolean') base.retention.enabled = r.enabled;
    if (
      Array.isArray(r.categories) &&
      r.categories.every((c) => Object.values(RetainedItemCategory).includes(c))
    ) {
      base.retention.categories = r.categories;
    }
    if (typeof r.maxItems === 'number' && r.maxItems >= 1 && r.maxItems <= 1000) {
      base.retention.maxItems = r.maxItems;
    }
    if (typeof r.confidenceFloor === 'number' && r.confidenceFloor >= 0 && r.confidenceFloor <= 1) {
      base.retention.confidenceFloor = r.confidenceFloor;
    }
    if (typeof r.evictSourcePool === 'boolean') base.retention.evictSourcePool = r.evictSourcePool;
  }
  if (user.memory) {
    const m = user.memory;
    base.memory = { ...base.memory };
    if (typeof m.enabled === 'boolean') base.memory.enabled = m.enabled;
    if (typeof m.dbPath === 'string') base.memory.dbPath = m.dbPath;
    if (typeof m.recallBudgetTokens === 'number') base.memory.recallBudgetTokens = m.recallBudgetTokens;
    if (typeof m.recallTopK === 'number') base.memory.recallTopK = m.recallTopK;
    if (m.journal) {
      base.memory.journal = { ...base.memory.journal, ...m.journal };
    }
    if (m.worker) {
      base.memory.worker = { ...base.memory.worker, ...m.worker };
    }
    if (typeof m.vector === 'string' && (m.vector === 'off' || m.vector === 'auto')) {
      base.memory.vector = m.vector;
    }
    if (typeof m.embeddingModel === 'string') base.memory.embeddingModel = m.embeddingModel;
    if (typeof m.archiveAfterDays === 'number') base.memory.archiveAfterDays = m.archiveAfterDays;
    if (typeof m.purgeAfterDays === 'number') base.memory.purgeAfterDays = m.purgeAfterDays;
  }
  return base;
}
