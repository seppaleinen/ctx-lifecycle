import { describe, it, expect, beforeEach } from 'bun:test';
import { PoolID, StateMachineState } from '../../src/types.js';
import { DeterministicSummarizer, LlmSummarizer } from '../../src/summarizer.js';

describe('Summarizer', () => {
  describe('DeterministicSummarizer', () => {
    let summarizer: DeterministicSummarizer;

    beforeEach(() => {
      summarizer = new DeterministicSummarizer();
    });

    it('produces a summary for evicted messages', async () => {
      const batch = {
        poolId: PoolID.EXECUTION,
        state: StateMachineState.CODING,
        messages: [
          { role: 'user' as const, content: 'Test requirement: the system must handle requests' },
          { role: 'assistant' as const, content: 'We decided to use Redis for caching' }
        ],
        trigger: 'Test command detected: pytest tests/'
      };

      const summary = await summarizer.summarize(batch);

      expect(summary).toContain('Evicted from Execution Pool');
      expect(summary).toContain('Test command detected');
    });

    it('truncates output to max chars', async () => {
      const longMessages = Array(100).fill(null).map(() => ({
        role: 'user' as const,
        content: 'A'.repeat(1000)
      }));

      const batch = {
        poolId: PoolID.PLANNING,
        state: StateMachineState.PLANNING,
        messages: longMessages,
        trigger: 'test'
      };

      const summary = await summarizer.summarize(batch, { maxInputChars: 8000, maxOutputChars: 600 });

      expect(summary.length).toBeLessThanOrEqual(603);
    });

    it('handles empty messages', async () => {
      const batch = {
        poolId: PoolID.GLOBAL,
        state: StateMachineState.PLANNING,
        messages: [],
        trigger: 'test'
      };

      const summary = await summarizer.summarize(batch);

      expect(summary).toBeTruthy();
    });

    it('extracts items with category patterns', async () => {
      const batch = {
        poolId: PoolID.PLANNING,
        state: StateMachineState.PLANNING,
        messages: [
          { role: 'user' as const, content: 'Requirement: the API must return JSON' },
          { role: 'user' as const, content: 'Research finding: PostgreSQL has better JSONB support than MySQL' },
          { role: 'user' as const, content: 'Acceptance criteria: Given a request, when the endpoint is called, then JSON is returned' }
        ],
        trigger: 'test'
      };

      const summary = await summarizer.summarize(batch);

      expect(summary).toContain('Requirement');
      expect(summary).toContain('Research');
      expect(summary).toContain('Acceptance');
    });
  });

  describe('LlmSummarizer', () => {
    it('calls ctx.experimental.generate.text', async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const mockCtx: any = {
        experimental: {
          generate: {
            text: async (_opts: { model?: { providerID: string; id: string }; prompt: string }) => ({
              text: 'LLM summary result'
            })
          }
        }
      };

      const summarizer = new LlmSummarizer(mockCtx, {
        enabled: true,
        model: { providerID: 'openai', id: 'gpt-4o-mini' },
        inputChars: 8000,
        outputChars: 600
      });

      const batch = {
        poolId: PoolID.PLANNING,
        state: StateMachineState.PLANNING,
        messages: [{ role: 'user' as const, content: 'Test message' }],
        trigger: 'test'
      };

      const summary = await summarizer.summarize(batch);

      expect(summary).toBe('LLM summary result');
    });

    it('falls back to deterministic on error', async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const mockCtx: any = {
        experimental: {
          generate: {
            text: async () => { throw new Error('API error'); }
          }
        }
      };

      const summarizer = new LlmSummarizer(mockCtx, {
        enabled: true,
        model: undefined,
        inputChars: 8000,
        outputChars: 600
      });

      const batch = {
        poolId: PoolID.PLANNING,
        state: StateMachineState.PLANNING,
        messages: [{ role: 'user' as const, content: 'Test message' }],
        trigger: 'test'
      };

      const summary = await summarizer.summarize(batch);

      // Falls back to deterministic, should still produce output
      expect(summary).toBeTruthy();
    });
  });
});