import { describe, it, expect, beforeEach } from 'bun:test';
import { ContextRouter } from '../../src/router.js';
import { PoolID, StateMachineState } from '../../src/types.js';

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
});