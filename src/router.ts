import { PoolID, StateMachineState, ContextPool, ContextMessage, STATE_TO_POOL, RETAINED_CONTEXT_PREFIX } from './types.js';

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

  /**
   * Remove the last message from a pool. Returns the removed message, or
   * `undefined` when the pool is missing or already empty. Used by the
   * same-pool dedup guard so the router owns its own message list instead of
   * letting callers reach into `pool.messages` directly.
   */
  popMessage(poolId: PoolID): ContextMessage | undefined {
    const pool = this.pools.get(poolId);
    if (!pool || pool.messages.length === 0) {
      return undefined;
    }
    return pool.messages.pop();
  }

  /**
   * Drop any trailing retained-context block from a pool (i.e. the last
   * message whose content starts with the retained-block prefix). Returns
   * whether a block was removed. Used by the same-pool dedup guard so a
   * round-trip through the same pool replaces, rather than duplicates, the
   * previous handoff.
   */
  popRetainedBlock(poolId: PoolID): boolean {
    const pool = this.pools.get(poolId);
    if (!pool || pool.messages.length === 0) {
      return false;
    }
    const last = pool.messages[pool.messages.length - 1];
    if (last && last.content.startsWith(RETAINED_CONTEXT_PREFIX)) {
      pool.messages.pop();
      return true;
    }
    return false;
  }
}