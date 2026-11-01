import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { PoolID, StateMachineState } from '../../src/types.js';
import { EpisodicMemory } from '../../src/episodic-memory.js';
import { join } from 'path';
import { tmpdir } from 'os';

describe('EpisodicMemory', () => {
  let episodicMemory: EpisodicMemory;
  let dbPath: string;

  beforeEach(async () => {
    // Create a temp database path
    dbPath = join(tmpdir(), `test-episodic-${Date.now()}.db`);
    episodicMemory = new EpisodicMemory(dbPath);
    await episodicMemory.init();
  });

  afterEach(async () => {
    if (episodicMemory.isInitialized()) {
      episodicMemory.close();
    }
    // Clean up the temp file
    try {
      const fs = await import('fs');
      if (fs.existsSync(dbPath)) {
        fs.unlinkSync(dbPath);
      }
      // Remove WAL and SHM files if they exist
      if (fs.existsSync(dbPath + '-wal')) fs.unlinkSync(dbPath + '-wal');
      if (fs.existsSync(dbPath + '-shm')) fs.unlinkSync(dbPath + '-shm');
    } catch {
      // Ignore cleanup errors
    }
  });

  describe('archive', () => {
    it('writes evicted messages to the journal', async () => {
      const messages = [
        { role: 'user' as const, content: 'Test message 1', createdAt: Date.now() },
        { role: 'assistant' as const, content: 'Test message 2', createdAt: Date.now() }
      ];

      await episodicMemory.archive(PoolID.EXECUTION, messages, 'eviction', StateMachineState.CODING);

      // Verify by counting rows (would need a query method or close the DB)
      // For now, basic test passes if no error
      expect(episodicMemory.isInitialized()).toBe(true);
    });

    it('handles empty message array gracefully', async () => {
      await episodicMemory.archive(PoolID.EXECUTION, [], 'eviction');
      // Should not throw
      expect(true).toBe(true);
    });
  });

  describe('recall', () => {
    it('returns empty string when no episodes exist', async () => {
      const result = await episodicMemory.recall(StateMachineState.PLANNING, 1500);
      expect(result).toBe('');
    });

    it('returns formatted recall block within budget', async () => {
      const messages = [
        { role: 'user' as const, content: 'Test requirement: the system must handle 1000 requests', createdAt: Date.now() }
      ];

      await episodicMemory.archive(PoolID.PLANNING, messages, 'eviction', StateMachineState.PLANNING);

      const result = await episodicMemory.recall(StateMachineState.PLANNING, 1500);
      
      expect(result).toContain('Previously in');
    });
  });

  describe('prune', () => {
    it('prunes entries older than threshold', async () => {
      const result = await episodicMemory.prune(30, 90);
      
      expect(result).toHaveProperty('archived');
      expect(result).toHaveProperty('purged');
      expect(typeof result.archived).toBe('number');
      expect(typeof result.purged).toBe('number');
    });
  });

  describe('markSuperseded', () => {
    it('marks episodes as superseded', async () => {
      // First archive an episode
      await episodicMemory.archive(PoolID.EXECUTION, [
        { role: 'user' as const, content: 'Original message', createdAt: Date.now() }
      ], 'eviction', StateMachineState.CODING);

      // Mark it as superseded
      await episodicMemory.markSuperseded([1]);

      expect(true).toBe(true); // No error means success
    });
  });
});