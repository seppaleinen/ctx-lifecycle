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

  /** Convenience: clear the Project pool specifically (used by /new-issue). */
  clearProjectPool(): void {
    this.clearPool(PoolID.PROJECT);
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
   * Record an explicit access on a message so its `accessedAt` reflects the
   * most recent use. Used by callers that surface a specific message (e.g.
   * a pinned requirement) to keep it warm in the LRU ordering.
   * No-op when the pool or message is missing.
   */
  touchMessage(poolId: PoolID, messageId: string): void {
    const pool = this.pools.get(poolId);
    if (!pool) {
      return;
    }
    const msg = pool.messages.find((m) => m.id === messageId);
    if (msg) {
      msg.accessedAt = Date.now();
    }
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

    // Partition: critical messages stay, everyone else is a candidate for eviction.
    const keep: ContextMessage[] = [];
    const candidates: ContextMessage[] = [];
    for (const msg of pool.messages) {
      if (msg.critical) {
        keep.push(msg);
      } else {
        candidates.push(msg);
      }
    }

    // LRU order: oldest accessedAt first. `accessedAt` is always set by
    // addMessage(), so this is a total order on the candidate set.
    candidates.sort((a, b) => (a.accessedAt ?? 0) - (b.accessedAt ?? 0));

    const keepTokens = this.estimateTokens(keep);
    let budget = maxTokens - keepTokens;
    const survivors: ContextMessage[] = [];
    for (const msg of candidates) {
      const cost = this.estimateTokens([msg]);
      if (cost <= budget) {
        survivors.push(msg);
        budget -= cost;
      }
      // Once budget is exhausted, remaining candidates are dropped.
    }

    // Preserve original ordering of survivors for stable output. Use object
    // identity (not `id`) so messages without an `id` field are handled
    // correctly — every survivor is a reference pulled from the original
    // `pool.messages` array.
    const survivorSet = new Set(survivors);
    pool.messages = pool.messages.filter((m) => survivorSet.has(m));
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