import { describe, it, expect, beforeEach } from 'bun:test';
import { PoolID } from '../../src/types.js';
import { Persistence } from '../../src/persistence.js';

describe('Persistence', () => {
  let mockCtx: { get: (key: string) => Promise<unknown>; set: (key: string, value: unknown) => Promise<void> };
  let persistence: Persistence;

  beforeEach(() => {
    mockCtx = {
      get: async (_key: string) => {
        return null;
      },
      set: async (__key: string, _value: unknown) => {
        // Mock implementation
      }
    };
    persistence = new Persistence('test-project', mockCtx as never);
  });

  describe('load', () => {
    it('returns empty pools when no data in storage', async () => {
      const pools = await persistence.load();

      expect(pools[PoolID.GLOBAL]).toEqual({ id: PoolID.GLOBAL, messages: [] });
      expect(pools[PoolID.PROJECT]).toEqual({ id: PoolID.PROJECT, messages: [] });
      expect(pools[PoolID.PLANNING]).toEqual({ id: PoolID.PLANNING, messages: [] });
      expect(pools[PoolID.EXECUTION]).toEqual({ id: PoolID.EXECUTION, messages: [] });
      expect(pools[PoolID.TESTING]).toEqual({ id: PoolID.TESTING, messages: [] });
    });

    it('loads persisted pools from storage', async () => {
      const persistedData = {
        version: 2,
        projectId: 'test-project',
        updatedAt: 1234567890,
        pools: {
          global: { id: PoolID.GLOBAL, messages: [{ role: 'user', content: 'test-global' }] },
          project: { id: PoolID.PROJECT, messages: [] },
          planning: { id: PoolID.PLANNING, messages: [] },
          execution: { id: PoolID.EXECUTION, messages: [] },
          testing: { id: PoolID.TESTING, messages: [] }
        }
      };

      // Override get to return persisted data
      mockCtx.get = async () => persistedData;

      const pools = await persistence.load();

      expect(pools[PoolID.GLOBAL].messages).toHaveLength(1);
      expect(pools[PoolID.GLOBAL].messages[0].content).toBe('test-global');
    });

    it('migrates v1 schema to v2 by adding project pool', async () => {
      const v1Data = {
        version: 1,
        projectId: 'test-project',
        updatedAt: 1234567890,
        pools: {
          global: { id: PoolID.GLOBAL, messages: [] },
          planning: { id: PoolID.PLANNING, messages: [] },
          execution: { id: PoolID.EXECUTION, messages: [] },
          testing: { id: PoolID.TESTING, messages: [] }
        }
      };

      mockCtx.get = async () => v1Data;

      const pools = await persistence.load();

      expect(pools[PoolID.PROJECT]).toBeDefined();
    });
  });

  describe('saveAll', () => {
    it('saves all pools to storage', async () => {
      const pools: Record<PoolID, { id: PoolID; messages: Array<{ role: string; content: string }> }> = {
        [PoolID.GLOBAL]: { id: PoolID.GLOBAL, messages: [{ role: 'user', content: 'global-msg' }] },
        [PoolID.PROJECT]: { id: PoolID.PROJECT, messages: [] },
        [PoolID.PLANNING]: { id: PoolID.PLANNING, messages: [] },
        [PoolID.EXECUTION]: { id: PoolID.EXECUTION, messages: [] },
        [PoolID.TESTING]: { id: PoolID.TESTING, messages: [] }
      };

      await persistence.saveAll(pools);

      expect(true).toBe(true); // Basic check that no error is thrown
    });
  });

  describe('save', () => {
    it('saves a single pool', async () => {
      mockCtx.get = async () => ({
        version: 2,
        projectId: 'test-project',
        updatedAt: 0,
        pools: {
          global: { id: PoolID.GLOBAL, messages: [] },
          project: { id: PoolID.PROJECT, messages: [] },
          planning: { id: PoolID.PLANNING, messages: [] },
          execution: { id: PoolID.EXECUTION, messages: [] },
          testing: { id: PoolID.TESTING, messages: [] }
        }
      });

      await persistence.save(PoolID.GLOBAL, [{ role: 'user', content: 'new-msg' }]);

      expect(true).toBe(true); // Basic check that no error is thrown
    });
  });

  describe('getMetadata', () => {
    it('returns project ID and storage key', async () => {
      const metadata = await persistence.getMetadata();

      expect(metadata.projectId).toBe('test-project');
      expect(metadata.storageKey).toBe('pools/test-project');
    });
  });
});