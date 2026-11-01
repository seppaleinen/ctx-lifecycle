import { describe, it, expect, beforeEach } from 'bun:test';
import { PoolID } from '../../src/types.js';
import { MemoryWorker, JobPayload } from '../../src/memory-worker.js';
import type { Summarizer } from '../../src/summarizer.js';
import type { EpisodicMemory } from '../../src/episodic-memory.js';

describe('MemoryWorker', () => {
  let mockSummarizer: Summarizer;
  let mockEpisodicMemory: EpisodicMemory;
  let config: {
    enabled: boolean;
    recallBudgetTokens: number;
    recallTopK: number;
    journal: { archiveBeforeEvict: boolean };
    worker: { llmSummaries: boolean; consolidateEvery: number };
  };

  beforeEach(() => {
    mockSummarizer = {
      summarize: async () => 'Test summary'
    } as unknown as Summarizer;

    mockEpisodicMemory = {
      init: async () => {},
      archive: async () => {},
      prune: async () => ({ archived: 0, purged: 0 }),
      markSuperseded: async () => {},
      close: () => {},
      isInitialized: () => true
    } as unknown as EpisodicMemory;

    config = {
      enabled: true,
      recallBudgetTokens: 1500,
      recallTopK: 8,
      journal: { archiveBeforeEvict: true },
      worker: { llmSummaries: true, consolidateEvery: 40 }
    };
  });

  describe('enqueue', () => {
    it('adds a summarize job to the queue', () => {
      const worker = new MemoryWorker(mockSummarizer, mockEpisodicMemory, config);

      const payload: JobPayload = {
        kind: 'summarize',
        poolId: PoolID.EXECUTION,
        messages: [{ role: 'user', content: 'test' }],
        trigger: 'test-trigger'
      };

      worker.enqueue('summarize', payload);

      expect(worker.getJobCount()).toBe(1);
    });

    it('coalesces duplicate summarize jobs for the same pool', () => {
      const worker = new MemoryWorker(mockSummarizer, mockEpisodicMemory, config);

      const payload1: JobPayload = {
        kind: 'summarize',
        poolId: PoolID.EXECUTION,
        messages: [{ role: 'user', content: 'test1' }],
        trigger: 'trigger1'
      };

      const payload2: JobPayload = {
        kind: 'summarize',
        poolId: PoolID.EXECUTION,
        messages: [{ role: 'user', content: 'test2' }],
        trigger: 'trigger2'
      };

      worker.enqueue('summarize', payload1);
      worker.enqueue('summarize', payload2);

      expect(worker.getJobCount()).toBe(1);
    });

    it('does not enqueue when disabled', () => {
      const disabledWorker = new MemoryWorker(mockSummarizer, mockEpisodicMemory, {
        ...config,
        enabled: false
      });

      const payload: JobPayload = {
        kind: 'summarize',
        poolId: PoolID.EXECUTION,
        messages: [{ role: 'user', content: 'test' }],
        trigger: 'test-trigger'
      };

      disabledWorker.enqueue('summarize', payload);

      expect(disabledWorker.getJobCount()).toBe(0);
    });

    it('can start and stop without errors', async () => {
      const worker = new MemoryWorker(mockSummarizer, mockEpisodicMemory, config);

      await worker.start();
      await worker.stop();

      expect(true).toBe(true);
    });
  });
});