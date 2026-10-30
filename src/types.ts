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

export interface TransitionEvent {
  fromState: StateMachineState;
  toState: StateMachineState;
  trigger: string;
  timestamp: number;
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

export interface ContextPagerConfig {
  enabled: boolean;
  tokenCeiling: number;
  pools: {
    global: { maxTokens: number };
    planning: { maxTokens: number };
    execution: { maxTokens: number };
    testing: { maxTokens: number };
  };
}

export const STATE_TO_POOL: Record<string, PoolID> = {
  [StateMachineState.PLANNING]: PoolID.PLANNING,
  [StateMachineState.CODING]: PoolID.EXECUTION,
  [StateMachineState.DEBUGGING]: PoolID.TESTING,
  [StateMachineState.COMPLETE]: PoolID.PLANNING
};

export const SCHEMA_VERSION = 1;

export const DEFAULT_CONFIG: ContextPagerConfig = {
  enabled: true,
  tokenCeiling: 25000,
  pools: {
    global: { maxTokens: 5000 },
    planning: { maxTokens: 8000 },
    execution: { maxTokens: 10000 },
    testing: { maxTokens: 5000 }
  }
};
