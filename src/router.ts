import { PoolID, StateMachineState, ContextPool, ContextMessage, STATE_TO_POOL } from './types.js';

export class ContextRouter {
  private pools: Map<PoolID, ContextPool>;

  constructor() {
    this.pools = new Map();
    this.initializePools();
  }

  private initializePools(): void {
    for (const id of Object.values(PoolID)) {
      this.pools.set(id, { id, messages: [] });
    }
  }

  getPool(poolId: PoolID): ContextPool | undefined {
    return this.pools.get(poolId);
  }

  getActivePools(state: StateMachineState): ContextMessage[] {
    const globalPool = this.pools.get(PoolID.GLOBAL);
    if (!globalPool) return [];
    const globalMessages = globalPool.messages;

    const activePoolId = STATE_TO_POOL[state];
    const activePool = this.pools.get(activePoolId);

    if (!activePool) {
      return globalMessages;
    }

    return [...globalMessages, ...activePool.messages];
  }

  addMessage(poolId: PoolID, message: ContextMessage): void {
    const pool = this.pools.get(poolId);
    if (!pool) {
      throw new Error(`Pool ${poolId} not found`);
    }
    pool.messages.push(message);
  }

  /** Removes all messages from a pool. No-op when the pool is unknown. */
  clearPool(poolId: PoolID): void {
    const pool = this.pools.get(poolId);
    if (pool) {
      pool.messages.length = 0;
    }
  }
}