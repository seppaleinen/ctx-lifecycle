import { describe, it, expect, beforeEach } from 'bun:test';
import { StateMachineState } from '../../src/types.js';
import { StateMachine } from '../../src/state-machine.js';

describe('StateMachine - Transition Matrix (from PLANNING)', () => {
  let stateMachine: StateMachine;

  beforeEach(() => {
    stateMachine = new StateMachine();
  });

  it('allows PLANNING to CODING', () => {
    expect(stateMachine.canTransition(StateMachineState.CODING)).toBe(true);
  });

  it('allows PLANNING to CODING then CODING to PLANNING', () => {
    stateMachine.transition(StateMachineState.CODING, '/transition coding');
    expect(stateMachine.canTransition(StateMachineState.PLANNING)).toBe(true);
  });

  it('allows PLANNING to CODING then CODING to DEBUGGING', () => {
    stateMachine.transition(StateMachineState.CODING, '/transition coding');
    expect(stateMachine.canTransition(StateMachineState.DEBUGGING)).toBe(true);
  });

  it('allows CODING to DEBUGGING then DEBUGGING to COMPLETE', () => {
    stateMachine.transition(StateMachineState.CODING, '/transition coding');
    stateMachine.transition(StateMachineState.DEBUGGING, '/transition debugging');
    expect(stateMachine.canTransition(StateMachineState.COMPLETE)).toBe(true);
  });

  it('allows COMPLETE to PLANNING via debugging', () => {
    stateMachine.transition(StateMachineState.CODING, '/transition coding');
    stateMachine.transition(StateMachineState.DEBUGGING, '/transition debugging');
    stateMachine.transition(StateMachineState.COMPLETE, '/transition complete');
    expect(stateMachine.canTransition(StateMachineState.PLANNING)).toBe(true);
  });
});

describe('StateMachine - Invalid Transitions', () => {
  let stateMachine: StateMachine;

  beforeEach(() => {
    stateMachine = new StateMachine();
  });

  it('throws on invalid PLANNING to DEBUGGING', () => {
    expect(() => stateMachine.transition(StateMachineState.DEBUGGING, 'test')).toThrow();
  });

  it('throws on invalid CODING to COMPLETE', () => {
    expect(() => stateMachine.transition(StateMachineState.COMPLETE, 'test')).toThrow();
  });
});

describe('StateMachine - parseTransitionCommand', () => {
  let stateMachine: StateMachine;

  beforeEach(() => {
    stateMachine = new StateMachine();
  });

  it('parses /transition coding', () => {
    const result = stateMachine.parseTransitionCommand('/transition coding');
    expect(result).not.toBeNull();
    expect(result?.state).toBe(StateMachineState.CODING);
  });

  it('parses /transition planning', () => {
    const result = stateMachine.parseTransitionCommand('/transition planning');
    expect(result).not.toBeNull();
    expect(result?.state).toBe(StateMachineState.PLANNING);
  });

  it('parses /transition debugging', () => {
    const result = stateMachine.parseTransitionCommand('/transition debugging');
    expect(result).not.toBeNull();
    expect(result?.state).toBe(StateMachineState.DEBUGGING);
  });

  it('parses /transition complete', () => {
    const result = stateMachine.parseTransitionCommand('/transition complete');
    expect(result).not.toBeNull();
    expect(result?.state).toBe(StateMachineState.COMPLETE);
  });

  it('returns null for invalid command', () => {
    const result = stateMachine.parseTransitionCommand('/invalid');
    expect(result).toBeNull();
  });

  it('returns null for empty string', () => {
    const result = stateMachine.parseTransitionCommand('');
    expect(result).toBeNull();
  });
});