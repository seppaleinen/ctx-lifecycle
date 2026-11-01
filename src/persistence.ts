import { PoolID, ContextPool, ContextMessage, PersistedPools, SCHEMA_VERSION } from './types.js';

/**
 * Persistence module: loads/saves pools to ctx.storage for restart durability.
 * Implements the ADR-003 JSON serialization pattern via the plugin's ctx.storage API.
 */
export class Persistence {
  private storageKey: string;
  private projectId: string;

  constructor(projectId: string, private ctx: { get: (key: string) => Promise<unknown>; set: (key: string, value: unknown) => Promise<void> }) {
    this.projectId = projectId;
    this.storageKey = `pools/${projectId}`;
  }

  /**
   * Load persisted pools from ctx.storage.
   * Returns default empty pools if no data or migration needed.
   * Schema version migration: v1 → v2 (adds project pool).
   */
  async load(): Promise<{ [key in PoolID]: ContextPool }> {
    const raw = await this.ctx.get(this.storageKey);
    
    if (!raw || typeof raw !== 'object') {
      return this.emptyPools();
    }

    const data = raw as PersistedPools;
    
    // Version 1 migration: add missing project pool
    if (data.version === 1) {
      const migrated = {
        version: SCHEMA_VERSION,
        projectId: data.projectId,
        updatedAt: data.updatedAt,
        pools: {
          ...data.pools,
          project: { id: PoolID.PROJECT, messages: [] }
        }
      };
      await this.ctx.set(this.storageKey, migrated);
      return this.poolsFromData(migrated);
    }

    // Version 2 - current
    if (data.version === SCHEMA_VERSION) {
      return this.poolsFromData(data);
    }

    // Unknown version - return empty pools
    console.warn(`[persistence] Unknown schema version ${data.version}, returning empty pools`);
    return this.emptyPools();
  }

  /**
   * Save all pools atomically via ctx.storage.
   */
  async saveAll(pools: { [key in PoolID]: ContextPool }): Promise<void> {
    const data: PersistedPools = {
      version: SCHEMA_VERSION,
      projectId: this.projectId,
      updatedAt: Date.now(),
      pools
    };
    await this.ctx.set(this.storageKey, data);
  }

  /**
   * Save a single pool.
   */
  async save(poolId: PoolID, messages: ContextMessage[]): Promise<void> {
    // Load existing, update one pool, save back
    const allPools = await this.load();
    allPools[poolId] = { id: poolId, messages };
    await this.saveAll(allPools);
  }

  /**
   * Get pool metadata for storage.
   */
  async getMetadata(): Promise<{ projectId: string; storageKey: string }> {
    return { projectId: this.projectId, storageKey: this.storageKey };
  }

  private emptyPools(): { [key in PoolID]: ContextPool } {
    const pools: { [key in PoolID]: ContextPool } = {
      [PoolID.GLOBAL]: { id: PoolID.GLOBAL, messages: [] },
      [PoolID.PROJECT]: { id: PoolID.PROJECT, messages: [] },
      [PoolID.PLANNING]: { id: PoolID.PLANNING, messages: [] },
      [PoolID.EXECUTION]: { id: PoolID.EXECUTION, messages: [] },
      [PoolID.TESTING]: { id: PoolID.TESTING, messages: [] }
    };
    return pools;
  }

  private poolsFromData(data: PersistedPools): { [key in PoolID]: ContextPool } {
    return {
      global: { id: PoolID.GLOBAL, messages: data.pools.global?.messages ?? [] },
      project: { id: PoolID.PROJECT, messages: data.pools.project?.messages ?? [] },
      planning: { id: PoolID.PLANNING, messages: data.pools.planning?.messages ?? [] },
      execution: { id: PoolID.EXECUTION, messages: data.pools.execution?.messages ?? [] },
      testing: { id: PoolID.TESTING, messages: data.pools.testing?.messages ?? [] }
    };
  }
}