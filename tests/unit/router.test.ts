import { describe, it, expect, beforeEach } from 'bun:test';
import { ContextRouter } from '../../src/router.js';
import { PoolID, StateMachineState, ContextMessage } from '../../src/types.js';

describe('ContextRouter', () => {
  let router: ContextRouter;

  beforeEach(() => {
    router = new ContextRouter();
  });

  describe('getActivePools', () => {
    it('returns messages for PLANNING state', () => {
      const messages = router.getActivePools(StateMachineState.PLANNING);
      expect(messages).toBeInstanceOf(Array);
    });

    it('returns messages for CODING state', () => {
      const messages = router.getActivePools(StateMachineState.CODING);
      expect(messages).toBeInstanceOf(Array);
    });

    it('returns messages for DEBUGGING state', () => {
      const messages = router.getActivePools(StateMachineState.DEBUGGING);
      expect(messages).toBeInstanceOf(Array);
    });

    it('returns messages for COMPLETE state', () => {
      const messages = router.getActivePools(StateMachineState.COMPLETE);
      expect(messages).toBeInstanceOf(Array);
    });
  });

  describe('addMessage', () => {
    it('adds a message to the global pool', () => {
      router.addMessage(PoolID.GLOBAL, { role: 'user', content: 'test' });
      const globalMessages = router.getActivePools(StateMachineState.PLANNING);
      expect(globalMessages.length).toBeGreaterThan(0);
    });

    it('adds a message to the planning pool', () => {
      router.addMessage(PoolID.PLANNING, { role: 'user', content: 'plan' });
      const messages = router.getActivePools(StateMachineState.PLANNING);
      expect(messages.length).toBeGreaterThan(0);
    });
  });

  describe('enforceCeiling', () => {
    it('enforceCeiling drops non-critical LRU messages below ceiling', () => {
      // Add messages with increasing accessedAt (oldest first, 100 chars each ≈ 29 tokens)
      for (let i = 0; i < 10; i++) {
        router.addMessage(PoolID.GLOBAL, {
          role: 'user',
          content: 'a'.repeat(100), // ~29 tokens each
          id: `msg-${i}`,
          createdAt: Date.now() + i,
          accessedAt: Date.now() + i
        });
      }

      // Ceiling of 200 tokens should drop messages beyond ~7
      router.enforceCeiling(PoolID.GLOBAL, 200);

      const pool = router.getPool(PoolID.GLOBAL);
      expect(pool).toBeDefined();
      const estimatedTokens = (msg: ContextMessage) => Math.ceil(msg.content.length / 4) + 4;
      const totalTokens = (messages: ContextMessage[]) => messages.reduce((sum, m) => sum + estimatedTokens(m), 0);

      expect(totalTokens(pool!.messages)).toBeLessThanOrEqual(200);
    });

    it('enforceCeiling never evicts critical messages', () => {
      // Add 5 critical messages and 5 non-critical messages
      for (let i = 0; i < 5; i++) {
        router.addMessage(PoolID.GLOBAL, {
          role: 'system',
          content: 'critical-requirement'.repeat(5), // ~30 tokens each
          id: `critical-${i}`,
          critical: true,
          createdAt: Date.now() + i,
          accessedAt: Date.now() + i
        });
      }
      for (let i = 0; i < 5; i++) {
        router.addMessage(PoolID.GLOBAL, {
          role: 'user',
          content: 'normal-message'.repeat(5),
          id: `normal-${i}`,
          critical: false,
          createdAt: Date.now() + i + 100,
          accessedAt: Date.now() + i + 100
        });
      }

      // Enforce ceiling of 100 tokens - should only drop non-critical messages
      router.enforceCeiling(PoolID.GLOBAL, 100);

      const pool = router.getPool(PoolID.GLOBAL);
      expect(pool).toBeDefined();

      // All critical messages should remain
      const criticalCount = pool!.messages.filter((m) => m.critical).length;
      expect(criticalCount).toBe(5);
    });

    it('enforceCeiling is a no-op when pool is already under ceiling', () => {
      for (let i = 0; i < 3; i++) {
        router.addMessage(PoolID.GLOBAL, { role: 'user', content: 'test' });
      }

      const initialCount = router.getPool(PoolID.GLOBAL)!.messages.length;
      router.enforceCeiling(PoolID.GLOBAL, 10000);

      expect(router.getPool(PoolID.GLOBAL)!.messages.length).toBe(initialCount);
    });

    it('enforceCeiling allows all messages when maxTokens <= 0 (no ceiling)', () => {
      for (let i = 0; i < 20; i++) {
        router.addMessage(PoolID.GLOBAL, { role: 'user', content: 'a'.repeat(100) });
      }

      const initialCount = router.getPool(PoolID.GLOBAL)!.messages.length;
      router.enforceCeiling(PoolID.GLOBAL, 0);

      expect(router.getPool(PoolID.GLOBAL)!.messages.length).toBe(initialCount);
    });
  });

  describe('clearPool', () => {
    it('clears the specified pool', () => {
      router.addMessage(PoolID.GLOBAL, { role: 'user', content: 'test-global' });
      router.addMessage(PoolID.PLANNING, { role: 'user', content: 'test-planning' });

      expect(router.getPool(PoolID.GLOBAL)!.messages.length).toBe(1);
      expect(router.getPool(PoolID.PLANNING)!.messages.length).toBe(1);

      router.clearPool(PoolID.GLOBAL);

      expect(router.getPool(PoolID.GLOBAL)!.messages.length).toBe(0);
      expect(router.getPool(PoolID.PLANNING)!.messages.length).toBe(1);
    });

    it('clearProjectPool empties the project pool only', () => {
      router.addMessage(PoolID.GLOBAL, { role: 'user', content: 'global-msg' });
      router.addMessage(PoolID.PROJECT, { role: 'user', content: 'project-msg' });
      router.addMessage(PoolID.PLANNING, { role: 'user', content: 'planning-msg' });

      router.clearPool(PoolID.PROJECT);

      expect(router.getPool(PoolID.GLOBAL)!.messages.length).toBe(1);
      expect(router.getPool(PoolID.PROJECT)!.messages.length).toBe(0);
      expect(router.getPool(PoolID.PLANNING)!.messages.length).toBe(1);
    });

    it('clearPool is a no-op for unknown pool', () => {
      // Should not throw
      router.clearPool('unknown-pool' as PoolID);
    });
  });
});