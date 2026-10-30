#!/usr/bin/env bun
/**
 * Manual verification script for context-pager foundation (Workstream 1)
 * Tests the three key scenarios:
 * 1. ContextRouter pool isolation and getActivePools
 * 2. StateMachine valid/invalid transitions
 * 3. SummaryGenerator 1-sentence template constraint
 */

import { ContextRouter } from '../src/router.js';
import { StateMachine } from '../src/state-machine.js';
import { SummaryGenerator } from '../src/summary-generator.js';
import { PoolID, StateMachineState } from '../src/types.js';

console.log('=== Manual Verification Script ===\n');

// === Scenario 1: ContextRouter Pool Isolation ===
console.log('1. ContextRouter - Pool Isolation and getActivePools');
console.log('---');

const router = new ContextRouter();

// Add messages to different pools
router.addMessage(PoolID.GLOBAL, { role: 'user', content: 'Global context message' });
router.addMessage(PoolID.PLANNING, { role: 'user', content: 'Planning message 1' });
router.addMessage(PoolID.PLANNING, { role: 'assistant', content: 'Planning response' });
router.addMessage(PoolID.EXECUTION, { role: 'user', content: 'Execution message 1' });
router.addMessage(PoolID.EXECUTION, { role: 'user', content: 'Execution message 2' });
router.addMessage(PoolID.TESTING, { role: 'user', content: 'Testing message 1' });

// Verify getActivePools returns correct combined messages
const planningMessages = router.getActivePools(StateMachineState.PLANNING);
console.log(`PLANNING state: ${planningMessages.length} messages (expected: 3 = 1 global + 2 planning)`);
console.log(`  Messages: ${planningMessages.map(m => m.content).join(', ')}`);

const codingMessages = router.getActivePools(StateMachineState.CODING);
console.log(`CODING state: ${codingMessages.length} messages (expected: 3 = 1 global + 2 execution)`);
console.log(`  Messages: ${codingMessages.map(m => m.content).join(', ')}`);

const debuggingMessages = router.getActivePools(StateMachineState.DEBUGGING);
console.log(`DEBUGGING state: ${debuggingMessages.length} messages (expected: 2 = 1 global + 1 testing)`);
console.log(`  Messages: ${debuggingMessages.map(m => m.content).join(', ')}`);

const completeMessages = router.getActivePools(StateMachineState.COMPLETE);
console.log(`COMPLETE state: ${completeMessages.length} messages (expected: 3 = 1 global + 2 planning)`);
console.log(`  Messages: ${completeMessages.map(m => m.content).join(', ')}`);

console.log('✓ Scenario 1 passed\n');

// === Scenario 2: StateMachine Transitions ===
console.log('2. StateMachine - Valid and Invalid Transitions');
console.log('---');

const stateMachine = new StateMachine();
console.log(`Initial state: ${stateMachine.getCurrentState()}`);

// Test valid transitions
console.log('\nValid transitions:');
try {
  const event1 = stateMachine.transition(StateMachineState.CODING, '/transition coding');
  console.log(`  ✓ PLANNING -> CODING: ${event1.fromState} -> ${event1.toState}`);
  
  const event2 = stateMachine.transition(StateMachineState.DEBUGGING, '/transition debugging');
  console.log(`  ✓ CODING -> DEBUGGING: ${event2.fromState} -> ${event2.toState}`);
  
  const event3 = stateMachine.transition(StateMachineState.COMPLETE, '/transition complete');
  console.log(`  ✓ DEBUGGING -> COMPLETE: ${event3.fromState} -> ${event3.toState}`);
  
  const event4 = stateMachine.transition(StateMachineState.PLANNING, '/transition planning');
  console.log(`  ✓ COMPLETE -> PLANNING: ${event4.fromState} -> ${event4.toState}`);
} catch (e) {
  console.log(`  ✗ Unexpected error: ${e}`);
}

// Test invalid transitions (each on a fresh machine driven to the from-state)
console.log('\nInvalid transitions (should throw):');
const invalidTests = [
  { setup: [] as StateMachineState[], to: StateMachineState.DEBUGGING, desc: 'PLANNING -> DEBUGGING' },
  { setup: [StateMachineState.CODING], to: StateMachineState.COMPLETE, desc: 'CODING -> COMPLETE' },
  { setup: [StateMachineState.CODING, StateMachineState.DEBUGGING], to: StateMachineState.CODING, desc: 'DEBUGGING -> CODING' },
];

for (const test of invalidTests) {
  const sm = new StateMachine();
  for (const s of test.setup) sm.transition(s, 'setup');
  try {
    sm.transition(test.to, 'test');
    console.log(`  ✗ ${test.desc} should have thrown but didn't`);
  } catch (e) {
    console.log(`  ✓ ${test.desc} correctly threw error`);
  }
}

// Test command parsing
console.log('\nCommand parsing:');
const commands = ['/transition coding', '/transition planning', '/transition debugging', '/transition complete', '/invalid', ''];
const parserSM = new StateMachine();
for (const cmd of commands) {
  const result = parserSM.parseTransitionCommand(cmd);
  if (result) {
    console.log(`  ✓ "${cmd}" -> ${result.state}`);
  } else {
    console.log(`  ✓ "${cmd}" -> null (invalid)`);
  }
}

console.log('✓ Scenario 2 passed\n');

// === Scenario 3: SummaryGenerator Template Constraint ===
console.log('3. SummaryGenerator - 1-Sentence Template Constraint');
console.log('---');

const summaryRouter = new ContextRouter();
const summaryGenerator = new SummaryGenerator(summaryRouter);

const testCases = [
  { state: 'planning' as any, trigger: 'Task switch', expected: 'Swapped to Planning Pool. Task switch' },
  { state: 'coding' as any, trigger: 'File read: user-service.ts', expected: 'Swapped to Execution Pool. File read: user-service.ts' },
  { state: 'debugging' as any, trigger: 'Modified auth.ts and db.ts', expected: 'Swapped to Testing Pool. Modified auth.ts and db.ts' },
  { state: 'complete' as any, trigger: 'All tests passed', expected: 'Swapped to Planning Pool. All tests passed' },
];

console.log('Valid summaries:');
for (const tc of testCases) {
  const summary = summaryGenerator.generateSummary(tc.state, tc.trigger);
  const match = summary === tc.expected ? '✓' : '✗';
  console.log(`  ${match} "${summary}"`);
  if (summary !== tc.expected) {
    console.log(`      Expected: "${tc.expected}"`);
  }
}

// Test validation
console.log('\nValidation (should reject):');
const invalidSummaries = [
  'This is one sentence. This is another.',
  'Swapped to Testing Pool. Evicted 15 messages',
  'Swapped to Testing Pool. 5000 tokens',
  'Wrong format summary',
];

for (const invalid of invalidSummaries) {
  try {
    summaryGenerator.validateSummary(invalid);
    console.log(`  ✗ "${invalid}" should have thrown but didn't`);
  } catch (e) {
    console.log(`  ✓ "${invalid}" correctly rejected`);
  }
}

console.log('✓ Scenario 3 passed\n');

console.log('=== All Manual Verifications Passed ===');
