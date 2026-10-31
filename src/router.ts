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

  /**
   * Return the messages that should be active for `state`: Global pool +
   * Project pool + the state-mapped pool. Project-scoped context (e.g. issue
   * notes, pinned requirements) rides alongside Global on every state.
   */
  getActivePools(state: StateMachineState): ContextMessage[] {
    const globalPool = this.pools.get(PoolID.GLOBAL);
    const projectPool = this.pools.get(PoolID.PROJECT);

    const globalMessages = globalPool?.messages ?? [];
    const projectMessages = projectPool?.messages ?? [];

    const activePoolId = STATE_TO_POOL[state];
    const activePool = this.pools.get(activePoolId);
    const activeMessages = activePool?.messages ?? [];

    return [...globalMessages, ...projectMessages, ...activeMessages];
  }

  addMessage(poolId: PoolID, message: ContextMessage): void {
    const pool = this.pools.get(poolId);
    if (!pool) {
      throw new Error(`Pool ${poolId} not found`);
    }
    const now = Date.now();
    // Defensive defaults so callers can pass a bare { role, content }.
    if (message.critical === undefined) {
      message.critical = false;
    }
    if (message.accessedAt === undefined) {
      message.accessedAt = typeof message.createdAt === 'number' ? message.createdAt : now;
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

  /**
   * Enforce a hard token ceiling on a pool using LRU eviction.
   *
   * - `critical` messages are NEVER evicted (pinned requirements survive).
   * - Eviction order is ascending `accessedAt` (least-recently-used first).
   * - When the pool is already within the ceiling, this is a no-op.
   * - `maxTokens <= 0` is treated as "no ceiling" (no eviction).
   * - The estimate is a cheap deterministic heuristic: `content.length / 4 + 4`
   *   per message (4 chars ≈ 1 token + 4 overhead for role/id metadata).
   */
  enforceCeiling(poolId: PoolID, maxTokens: number): void {
    const pool = this.pools.get(poolId);
    if (!pool || maxTokens <= 0) {
      return;
    }

    const current = this.estimateTokens(pool.messages);
    if (current <= maxTokens) {
      return;
    }

    // Simple LRU loop: drop oldest non-critical messages until under ceiling.
    // Critical messages are skipped (never evicted).
    while (pool.messages.length > 0 && this.estimateTokens(pool.messages) > maxTokens) {
      // Find the least recently used message that is NOT critical.
      let lruIdx = -1;
      let lruAccessedAt = Infinity;
      for (let i = 0; i < pool.messages.length; i++) {
        const msg = pool.messages[i];
        if (!msg.critical) {
          const accessedAt = msg.accessedAt ?? 0;
          if (accessedAt < lruAccessedAt) {
            lruAccessedAt = accessedAt;
            lruIdx = i;
          }
        }
      }
      // If all messages are critical, we can't evict anything; stop.
      if (lruIdx === -1) {
        break;
      }
      // Remove the LRU non-critical message.
      pool.messages.splice(lruIdx, 1);
    }
  }

  /**
   * Cheap deterministic token estimate for a set of messages.
   * Per message: `content.length / 4 + 4` (4 chars ≈ 1 token, +4 overhead).
   */
  private estimateTokens(messages: ContextMessage[]): number {
    let total = 0;
    for (const m of messages) {
      total += Math.ceil(m.content.length / 4) + 4;
    }
    return total;
  }
}