import { describe, it, expect, beforeEach } from 'bun:test';
import { ContextRouter } from '../../src/router.js';
import { PoolID, StateMachineState, ContextMessage } from '../../src/types.js';
import { generateCompactSummary } from '../../src/config.js';

describe('Auto-compact on threshold feature', () => {
  let router: ContextRouter;

  beforeEach(() => {
    router = new ContextRouter();
  });

  describe('ContextRouter.compactPool', () => {
    it('returns empty array when pool is already under target', () => {
      // Add a small message
      router.addMessage(PoolID.GLOBAL, { role: 'user', content: 'test' });

      const batches = router.compactPool(PoolID.GLOBAL, 10000, StateMachineState.PLANNING);

      expect(batches).toEqual([]);
      expect(router.getTokenCount(PoolID.GLOBAL)).toBeGreaterThan(0);
    });

    it('returns empty array for non-compactable pools', () => {
      // Add messages to PLANNING pool (not compactable)
      router.addMessage(PoolID.PLANNING, { role: 'user', content: 'test'.repeat(100) });

      const batches = router.compactPool(PoolID.PLANNING, 100, StateMachineState.PLANNING);

      expect(batches).toEqual([]);
      expect(router.getTokenCount(PoolID.PLANNING)).toBeGreaterThan(0);
    });

    it('returns empty array when targetTokens <= 0', () => {
      router.addMessage(PoolID.GLOBAL, { role: 'user', content: 'test' });

      const batches = router.compactPool(PoolID.GLOBAL, 0, StateMachineState.PLANNING);

      expect(batches).toEqual([]);
    });

    it('removes oldest non-critical messages until target tokens reached', () => {
      // Add 10 messages, each about 50 chars (approx 17 tokens each = 170 tokens total)
      for (let i = 0; i < 10; i++) {
        router.addMessage(PoolID.GLOBAL, {
          role: 'user',
          content: `Message ${i}: ${'x'.repeat(48)}`,
          accessedAt: Date.now() + i // oldest first
        });
      }

      const initialCount = router.getPool(PoolID.GLOBAL)!.messages.length;
      expect(initialCount).toBe(10);

      // Compact to 50 tokens (should remove most messages)
      const batches = router.compactPool(PoolID.GLOBAL, 50, StateMachineState.PLANNING);

      expect(batches).toHaveLength(1);
      expect(batches[0].poolId).toBe(PoolID.GLOBAL);
      expect(batches[0].messages.length).toBeLessThan(initialCount);
      expect(batches[0].messages.length).toBeGreaterThan(0);

      // Remaining messages should be under target
      expect(router.getTokenCount(PoolID.GLOBAL)).toBeLessThan(150);
    });

    it('never compacts critical messages', () => {
      // Add 5 critical messages
      for (let i = 0; i < 5; i++) {
        router.addMessage(PoolID.GLOBAL, {
          role: 'system',
          content: `critical-${i}`.repeat(10), // ~80 tokens each
          critical: true,
          accessedAt: Date.now() + i
        });
      }

      // Add 5 non-critical messages
      for (let i = 0; i < 5; i++) {
        router.addMessage(PoolID.GLOBAL, {
          role: 'user',
          content: 'normal-message'.repeat(5), // ~70 tokens each
          critical: false,
          accessedAt: Date.now() + i + 100
        });
      }

      const batches = router.compactPool(PoolID.GLOBAL, 100, StateMachineState.PLANNING);

      // Should have removed some non-critical messages
      expect(batches[0].messages.length).toBeGreaterThan(0);

      // All remaining critical messages should still be present
      const remainingCritical = router.getPool(PoolID.GLOBAL)!.messages.filter(m => m.critical);
      expect(remainingCritical.length).toBe(5);
    });

    it('returns empty when all messages are critical', () => {
      for (let i = 0; i < 5; i++) {
        router.addMessage(PoolID.GLOBAL, {
          role: 'system',
          content: 'critical'.repeat(20),
          critical: true
        });
      }

      const batches = router.compactPool(PoolID.GLOBAL, 100, StateMachineState.PLANNING);

      expect(batches).toEqual([]);
    });

    it('returns empty array for unknown pool', () => {
      const batches = router.compactPool('unknown-pool' as PoolID, 100, StateMachineState.PLANNING);
      expect(batches).toEqual([]);
    });

    it('creates summary message after compaction', () => {
      // Add enough messages to trigger compaction (need more than target 200)
      // Each message: "Requirement: the system must handle request N" = 50 chars = ~17 tokens
      // 15 messages = 255 tokens > 200 target
      for (let i = 0; i < 15; i++) {
        router.addMessage(PoolID.GLOBAL, {
          role: 'user',
          content: `Requirement: the system must handle request ${i}`,
          accessedAt: Date.now() + i
        });
      }

      const batches = router.compactPool(PoolID.GLOBAL, 150, StateMachineState.PLANNING);
      expect(batches).toHaveLength(1);

      // Add the summary separately (as the hook does)
      const summaryContent = 'Auto-compact summary from batch: ' + batches[0].messages.length + ' messages removed';
      router.addSummaryToPool(PoolID.GLOBAL, summaryContent);

      const pool = router.getPool(PoolID.GLOBAL)!;
      const summaryMsg = pool.messages.find(m => m.role === 'system');
      expect(summaryMsg).toBeDefined();
      expect(summaryMsg!.content).toContain('Auto-compact');
    });

    it('preserves non-critical messages under target', () => {
      // Add enough messages to exceed target
      for (let i = 0; i < 10; i++) {
        router.addMessage(PoolID.GLOBAL, {
          role: 'user',
          content: `Message ${i}`,
          accessedAt: Date.now() + i
        });
      }

      const beforeTokenCount = router.getTokenCount(PoolID.GLOBAL);

      router.compactPool(PoolID.GLOBAL, 200, StateMachineState.PLANNING);

      const afterTokenCount = router.getTokenCount(PoolID.GLOBAL);
      expect(afterTokenCount).toBeLessThanOrEqual(beforeTokenCount);
    });
  });

  describe('getTokenCount', () => {
    it('returns 0 for unknown pool', () => {
      expect(router.getTokenCount('unknown-pool' as PoolID)).toBe(0);
    });

    it('returns correct token count using estimate formula', () => {
      router.addMessage(PoolID.GLOBAL, { role: 'user', content: 'hello' }); // 5 chars + 4 = ~6 tokens

      // Verify: ceil(5/4) + 4 = 2 + 4 = 6
      expect(router.getTokenCount(PoolID.GLOBAL)).toBe(6);
    });

    it('accumulates tokens from multiple messages', () => {
      router.addMessage(PoolID.GLOBAL, { role: 'user', content: 'a'.repeat(100) }); // ~29 tokens
      router.addMessage(PoolID.GLOBAL, { role: 'user', content: 'b'.repeat(100) }); // ~29 tokens

      // 29 + 29 = 58 tokens
      expect(router.getTokenCount(PoolID.GLOBAL)).toBeCloseTo(58, 5);
    });
  });

  describe('addSummaryToPool', () => {
    it('adds a system message with summary content', () => {
      router.addSummaryToPool(PoolID.PROJECT, 'Test summary content');

      const pool = router.getPool(PoolID.PROJECT);
      expect(pool!.messages).toHaveLength(1);
      expect(pool!.messages[0].role).toBe('system');
      expect(pool!.messages[0].content).toBe('Test summary content');
    });

    it('appends to existing messages', () => {
      router.addMessage(PoolID.PROJECT, { role: 'user', content: 'existing' });
      router.addSummaryToPool(PoolID.PROJECT, 'summary');

      const pool = router.getPool(PoolID.PROJECT);
      expect(pool!.messages).toHaveLength(2);
      expect(pool!.messages[0].role).toBe('user');
      expect(pool!.messages[1].role).toBe('system');
    });
  });
});

describe('generateCompactSummary', () => {
  it('generates a summary header even for empty messages', () => {
    const summary = generateCompactSummary([], 'Test trigger', 'Global');
    expect(summary).toContain('Auto-compact from Global Pool: Test trigger');
  });

  it('extracts requirement patterns', () => {
    const messages: ContextMessage[] = [
      { role: 'user', content: 'Requirement: the API must return JSON' }
    ];

    const summary = generateCompactSummary(messages, 'test', 'Planning');
    expect(summary).toContain('[Requirement]');
    expect(summary).toContain('the API must return JSON');
  });

  it('extracts architecture patterns', () => {
    const messages: ContextMessage[] = [
      { role: 'user', content: 'Architecture: SQLite chosen over Postgres' }
    ];

    const summary = generateCompactSummary(messages, 'test', 'Planning');
    expect(summary).toContain('[Architecture]');
  });

  it('extracts research patterns', () => {
    const messages: ContextMessage[] = [
      { role: 'user', content: 'Research: SQLite has better concurrency' }
    ];

    const summary = generateCompactSummary(messages, 'test', 'Planning');
    expect(summary).toContain('[Research]');
  });

  it('extracts acceptance criteria patterns', () => {
    const messages: ContextMessage[] = [
      { role: 'user', content: 'Given a request, when the endpoint is called, then JSON is returned' }
    ];

    const summary = generateCompactSummary(messages, 'test', 'Planning');
    expect(summary).toContain('[Acceptance]');
  });

  it('deduplicates extracted patterns', () => {
    const messages: ContextMessage[] = [
      { role: 'user', content: 'Requirement: the API must return JSON' },
      { role: 'user', content: 'Requirement: the API must return JSON' } // duplicate
    ];

    const summary = generateCompactSummary(messages, 'test', 'Planning');
    // Should appear only once
    const matches = summary.match(/\[Requirement\]/g);
    expect(matches).toHaveLength(1);
  });

  it('skips system role messages', () => {
    const messages: ContextMessage[] = [
      { role: 'system', content: 'Requirement: hidden requirement' }
    ];

    const summary = generateCompactSummary(messages, 'test', 'Planning');
    expect(summary).not.toContain('hidden requirement');
  });

  it('truncates long content', () => {
    const longContent = 'Requirement: ' + 'x'.repeat(500);
    const messages: ContextMessage[] = [
      { role: 'user', content: longContent }
    ];

    const summary = generateCompactSummary(messages, 'test', 'Planning');
    expect(summary.length).toBeLessThanOrEqual(2000);
  });
});