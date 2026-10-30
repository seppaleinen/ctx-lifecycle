export enum PoolID {
  GLOBAL = 'global',
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

export interface ContextPagerConfig {
  enabled: boolean;
  tokenCeiling: number;
  pools: {
    global: { maxTokens: number };
    planning: { maxTokens: number };
    execution: { maxTokens: number };
    testing: { maxTokens: number };
  };
  /** Retention settings. Deep-merged over defaults when a partial config is supplied. */
  retention: RetentionConfig;
}

export const STATE_TO_POOL: Record<string, PoolID> = {
  [StateMachineState.PLANNING]: PoolID.PLANNING,
  [StateMachineState.CODING]: PoolID.EXECUTION,
  [StateMachineState.DEBUGGING]: PoolID.TESTING,
  [StateMachineState.COMPLETE]: PoolID.PLANNING
};

export const SCHEMA_VERSION = 1;

/** Exact prefix of the system message carrying retained items into the target pool. */
export const RETAINED_CONTEXT_PREFIX = 'Context retained from ';

export const DEFAULT_CONFIG: ContextPagerConfig = {
  enabled: true,
  tokenCeiling: 25000,
  pools: {
    global: { maxTokens: 5000 },
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
  }
};

/**
 * A user-supplied partial config. The `retention` block may itself be partial
 * so callers can tune one knob (e.g. `confidenceFloor`) without respecifying
 * every field; untouched retention keys fall back to defaults.
 */
export type PartialContextPagerConfig = Partial<Omit<ContextPagerConfig, 'retention'>> & {
  retention?: Partial<RetentionConfig>;
};

/**
 * Deep-merge a partial user config over a fresh copy of DEFAULT_CONFIG.
 * The `retention` block is merged field-by-field; `pools`/`tokenCeiling`
 * fall back wholesale to defaults when absent. Returns a fresh object so
 * callers cannot mutate the shared DEFAULT_CONFIG.
 */
const POOL_KEYS: (keyof ContextPagerConfig['pools'])[] = ['global', 'planning', 'execution', 'testing'];
const RETENTION_KEYS: (keyof RetentionConfig)[] = ['enabled', 'categories', 'maxItems', 'confidenceFloor', 'evictSourcePool'];

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
    for (const key of RETENTION_KEYS) {
      const value = r[key];
      if (typeof value !== 'undefined') {
        (base.retention as unknown as Record<string, unknown>)[key] = value;
      }
    }
  }
  return base;
}
