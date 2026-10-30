import { describe, it, expect, beforeEach } from 'bun:test';
import { SummaryGenerator } from '../../src/summary-generator.js';
import { ContextRouter } from '../../src/router.js';
import {
  PoolID,
  StateMachineState,
  RetainedItemCategory,
  RETAINED_CONTEXT_PREFIX,
  DEFAULT_CONFIG,
  mergeConfig
} from '../../src/types.js';
import { StateMachine } from '../../src/state-machine.js';

/**
 * Contract §7.2: new retention tests.
 *
 * Deterministic, in-process extraction — no LLM, no I/O. The extractor is a
 * pure function of the pool's messages + config, so every assertion here is
 * reproducible and exact.
 */
describe('Retention extraction (SummaryGenerator.extractRetainedContext)', () => {
  let router: ContextRouter;
  let generator: SummaryGenerator;

  beforeEach(() => {
    router = new ContextRouter();
    generator = new SummaryGenerator(router);
  });

  const seedPlanning = (content: string, id?: string) => {
    router.addMessage(PoolID.PLANNING, {
      role: 'assistant',
      content,
      id
    });
  };

  it('1. positive extraction: 4 categories, exact confidences, first-wins dedup', () => {
    // Line 5 repeats line 1 (same normalized text) → dedup keeps the first.
    seedPlanning(
      [
        'Given the user uploads a CSV, when it exceeds 10 MB, then it is rejected with a 413.',
        'must complete within 30 seconds for 10k rows.',
        'Architecture: SQLite for storage, chosen over Postgres.',
        "Research: Bun's SQLite driver handles concurrent readers without locking.",
        'Given the user uploads a CSV, when it exceeds 10 MB, then it is rejected with a 413.'
      ].join('\n')
    );

    const retained = generator.extractRetainedContext(PoolID.PLANNING, StateMachineState.PLANNING);

    expect(retained.sourcePool).toBe(PoolID.PLANNING);
    expect(retained.fromState).toBe(StateMachineState.PLANNING);
    expect(typeof retained.capturedAt).toBe('number');
    expect(retained.items).toHaveLength(4); // 5 candidate lines, one deduped

    // Priority order: ACCEPTANCE, REQUIREMENT, ARCHITECTURE, RESEARCH.
    expect(retained.items.map((i) => i.category)).toEqual([
      RetainedItemCategory.ACCEPTANCE,
      RetainedItemCategory.REQUIREMENT,
      RetainedItemCategory.ARCHITECTURE,
      RetainedItemCategory.RESEARCH
    ]);
    expect(retained.items.map((i) => i.confidence)).toEqual([0.95, 0.85, 0.9, 0.9]);
    // First-wins dedup: the acceptance item is the line-1 occurrence, not line 5.
    expect(retained.items[0].sourceLine).toBe(1);
    expect(retained.items.map((i) => i.sourceLine)).toEqual([1, 2, 3, 4]);
  });

  it('2. confidence floor drops low-confidence items, keeps high-confidence', () => {
    const gen = new SummaryGenerator(router, mergeConfig({ retention: { confidenceFloor: 0.7 } }));
    seedPlanning(
      [
        'Requirement: the export must complete within 30 seconds for 10k rows.', // 0.9 (anchored)
        'You must handle the edge case where the upload is interrupted mid-stream.' // 0.6 (contains "must")
      ].join('\n')
    );

    const retained = gen.extractRetainedContext(PoolID.PLANNING, StateMachineState.PLANNING);
    expect(retained.items).toHaveLength(1);
    expect(retained.items[0].confidence).toBe(0.9);
    expect(retained.items[0].text).toContain('Requirement:');
  });

  it('3. category filter: only the enabled categories are returned', () => {
    const gen = new SummaryGenerator(router, mergeConfig({ retention: { categories: [RetainedItemCategory.ACCEPTANCE] } }));
    seedPlanning(
      [
        'Given the user uploads a CSV, when it exceeds 10 MB, then it is rejected with a 413.',
        'Architecture: SQLite for storage, chosen over Postgres.'
      ].join('\n')
    );

    const retained = gen.extractRetainedContext(PoolID.PLANNING, StateMachineState.PLANNING);
    expect(retained.items).toHaveLength(1);
    expect(retained.items[0].category).toBe(RetainedItemCategory.ACCEPTANCE);
  });

  it('4. maxItems caps the output, earliest wins within a category', () => {
    const gen = new SummaryGenerator(router, mergeConfig({ retention: { maxItems: 5 } }));
    const lines = Array.from({ length: 12 }, (_, i) => `Requirement ${i}: the service must handle load ${i} correctly`);
    seedPlanning(lines.join('\n'));

    const retained = gen.extractRetainedContext(PoolID.PLANNING, StateMachineState.PLANNING);
    expect(retained.items).toHaveLength(5);
    // All REQUIREMENT → chronological order → the first 5 lines.
    expect(retained.items.map((i) => i.text)).toEqual(
      lines.slice(0, 5).map((l) => l.replace(/\s+/g, ' ').trim())
    );
  });

  it('5. disabled retention: empty items, write adds nothing', () => {
    const gen = new SummaryGenerator(router, mergeConfig({ retention: { enabled: false } }));
    seedPlanning('Given the user uploads a CSV, when it exceeds 10 MB, then it is rejected with a 413.');

    const retained = gen.extractRetainedContext(PoolID.PLANNING, StateMachineState.PLANNING);
    expect(retained.items).toHaveLength(0);

    const written = gen.writeRetainedContextToPool(StateMachineState.CODING, retained);
    expect(written).toBe(false);
    expect(router.getPool(PoolID.EXECUTION)!.messages).toHaveLength(0);
  });

  it('6. empty/missing pool: items [] and no throw', () => {
    // TESTING pool was never seeded on a fresh router.
    const retained = generator.extractRetainedContext(PoolID.TESTING, StateMachineState.DEBUGGING);
    expect(retained.items).toHaveLength(0);
    expect(retained.sourcePool).toBe(PoolID.TESTING);
    expect(retained.fromState).toBe(StateMachineState.DEBUGGING);
  });

  it('7. system-role messages are excluded (no self-extraction)', () => {
    router.addMessage(PoolID.PLANNING, {
      role: 'system',
      content: 'Swapped to Planning Pool. Command: /transition planning'
    });
    const retained = generator.extractRetainedContext(PoolID.PLANNING, StateMachineState.PLANNING);
    expect(retained.items).toHaveLength(0);
  });

  it('8. long lines are truncated to 241 chars ending in …', () => {
    seedPlanning(`Requirement: ${'x'.repeat(300)}`);
    const retained = generator.extractRetainedContext(PoolID.PLANNING, StateMachineState.PLANNING);
    expect(retained.items).toHaveLength(1);
    expect(retained.items[0].text.length).toBe(241);
    expect(retained.items[0].text.endsWith('…')).toBe(true);
  });

  it('9. rendering: one system message with [CATEGORY] lines in priority order', () => {
    seedPlanning(
      [
        "Research: Bun's SQLite driver handles concurrent readers without locking.",
        'Architecture: SQLite for storage, chosen over Postgres.',
        'must complete within 30 seconds for 10k rows.',
        'Given the user uploads a CSV, when it exceeds 10 MB, then it is rejected with a 413.'
      ].join('\n')
    );
    const retained = generator.extractRetainedContext(PoolID.PLANNING, StateMachineState.PLANNING);
    expect(retained.items).toHaveLength(4);

    const written = generator.writeRetainedContextToPool(StateMachineState.CODING, retained);
    expect(written).toBe(true);

    const execution = router.getPool(PoolID.EXECUTION)!;
    expect(execution.messages).toHaveLength(1);
    const msg = execution.messages[0];
    expect(msg.role).toBe('system');
    expect(msg.content.startsWith(`${RETAINED_CONTEXT_PREFIX}Planning Pool:\n`)).toBe(true);

    const lines = msg.content.split('\n');
    expect(lines[1]).toContain('[ACCEPTANCE]');
    expect(lines[2]).toContain('[REQUIREMENT]');
    expect(lines[3]).toContain('[ARCHITECTURE]');
    expect(lines[4]).toContain('[RESEARCH]');
  });

  it('10. determinism: identical inputs produce deep-equal items', () => {
    seedPlanning(
      [
        'Given the user uploads a CSV, when it exceeds 10 MB, then it is rejected with a 413.',
        'Architecture: SQLite for storage, chosen over Postgres.'
      ].join('\n')
    );
    const a = generator.extractRetainedContext(PoolID.PLANNING, StateMachineState.PLANNING);
    const b = generator.extractRetainedContext(PoolID.PLANNING, StateMachineState.PLANNING);
    // capturedAt is wall-clock; compare the deterministic items.
    expect(a.items).toEqual(b.items);
  });
});

describe('Retention end-to-end carry-over (contract §7.2 test 11)', () => {
  it('planning pool → execution pool: header + retained block, source evicted, event carries items', () => {
    const router = new ContextRouter();
    const generator = new SummaryGenerator(router);
    const stateMachine = new StateMachine();

    // Seed the planning (source) pool with 3 messages.
    router.addMessage(PoolID.PLANNING, {
      role: 'user',
      content: 'Given the user uploads a CSV, when it exceeds 10 MB, then it is rejected with a 413.'
    });
    router.addMessage(PoolID.PLANNING, {
      role: 'assistant',
      content: 'Requirement: the export must complete within 30 seconds for 10k rows.\nArchitecture: SQLite for storage, chosen over Postgres.'
    });
    router.addMessage(PoolID.PLANNING, {
      role: 'assistant',
      content: 'Research: Bun handles concurrent readers without locking.'
    });

    // 1. Generate the 1-sentence header summary for the target state.
    const summary = generator.generateSummary(StateMachineState.CODING, '/transition coding');
    generator.addSummaryToPool(StateMachineState.CODING, summary);

    // 2. Extract retained context from the outgoing (planning) pool.
    const retained = generator.extractRetainedContext(PoolID.PLANNING, StateMachineState.PLANNING);
    generator.validateRetainedContext(retained);
    expect(retained.items.length).toBeGreaterThan(0);

    // 3. Write the retained block into the target (execution) pool.
    const written = generator.writeRetainedContextToPool(StateMachineState.CODING, retained);
    expect(written).toBe(true);

    // 4. Evict the source pool (additive clearPool, default-on).
    router.clearPool(PoolID.PLANNING);

    // 5. The state machine transition carries the retained items.
    const event = stateMachine.transition(StateMachineState.CODING, '/transition coding', retained);
    expect(event.retained).toBeDefined();
    expect(event.retained!.items).toHaveLength(retained.items.length);

    // Execution pool now holds: header summary + retained block (2 messages).
    const execution = router.getPool(PoolID.EXECUTION)!;
    expect(execution.messages).toHaveLength(2);
    expect(execution.messages[0].content.startsWith('Swapped to Execution Pool.')).toBe(true);
    expect(execution.messages[1].content.startsWith(`${RETAINED_CONTEXT_PREFIX}Planning Pool:\n`)).toBe(true);

    // Planning pool is empty after eviction.
    expect(router.getPool(PoolID.PLANNING)!.messages).toHaveLength(0);
  });

  it('same-pool round-trip (COMPLETE→PLANNING) replaces, does not duplicate, the retained block', () => {
    const router = new ContextRouter();
    const generator = new SummaryGenerator(router);
    const stateMachine = new StateMachine();

    // Drive the state machine to COMPLETE (PLANNING→CODING→DEBUGGING→COMPLETE).
    stateMachine.transition(StateMachineState.CODING, '/transition coding');
    stateMachine.transition(StateMachineState.DEBUGGING, '/transition debugging');
    stateMachine.transition(StateMachineState.COMPLETE, '/transition complete');
    expect(stateMachine.getCurrentState()).toBe(StateMachineState.COMPLETE);

    // Seed the planning pool with retained content, then simulate a prior
    // retained block already present at the tail (as a previous COMPLETE→PLANNING
    // handoff would leave behind).
    router.addMessage(PoolID.PLANNING, {
      role: 'assistant',
      content: 'Given the user uploads a CSV, when it exceeds 10 MB, then it is rejected with a 413.'
    });
    const prior = generator.extractRetainedContext(PoolID.PLANNING, StateMachineState.PLANNING);
    generator.writeRetainedContextToPool(StateMachineState.PLANNING, prior);
    const countBefore = router.getPool(PoolID.PLANNING)!.messages.length;

    // Drive a COMPLETE→PLANNING transition through the same helper logic:
    // extract from the shared planning pool, drop the PRE-EXISTING trailing
    // retained block (dedup guard), write the new one, and never evict
    // (evictSourcePool is guarded by fromPool !== toPool).
    const retained = generator.extractRetainedContext(PoolID.PLANNING, StateMachineState.PLANNING);
    router.popRetainedBlock(PoolID.PLANNING);
    generator.writeRetainedContextToPool(StateMachineState.PLANNING, retained);

    // Same-pool: no eviction — the pool still holds the original messages,
    // the old retained block was replaced, and the new one is at the tail.
    const pool = router.getPool(PoolID.PLANNING)!;
    expect(pool.messages.length).toBe(countBefore);
    expect(pool.messages[pool.messages.length - 1].content.startsWith(RETAINED_CONTEXT_PREFIX)).toBe(true);

    const event = stateMachine.transition(StateMachineState.PLANNING, '/transition planning', retained);
    expect(event.retained).toBeDefined();
  });
});

describe('Retention validation (SummaryGenerator.validateRetainedContext)', () => {
  let generator: SummaryGenerator;

  beforeEach(() => {
    generator = new SummaryGenerator(new ContextRouter());
  });

  const base = () => ({
    sourcePool: PoolID.PLANNING,
    fromState: StateMachineState.PLANNING,
    items: [],
    capturedAt: 0
  });

  it('accepts an empty-but-valid RetainedContext', () => {
    expect(() => generator.validateRetainedContext(base())).not.toThrow();
  });

  it('rejects a non-array items field', () => {
    expect(() => generator.validateRetainedContext({ ...base(), items: 'nope' as never })).toThrow(
      'RetainedContext.items must be an array'
    );
  });

  it('rejects an over-long text field', () => {
    expect(() =>
      generator.validateRetainedContext({
        ...base(),
        items: [{ category: RetainedItemCategory.REQUIREMENT, text: 'x'.repeat(242), confidence: 0.9, sourceMessageId: null, sourceLine: 1 }]
      })
    ).toThrow('RetainedContextItem.text must be a non-empty string of at most 241 chars');
  });

  it('rejects an out-of-range confidence', () => {
    expect(() =>
      generator.validateRetainedContext({
        ...base(),
        items: [{ category: RetainedItemCategory.REQUIREMENT, text: 'ok', confidence: 1.5, sourceMessageId: null, sourceLine: 1 }]
      })
    ).toThrow('RetainedContextItem.confidence must be a number between 0 and 1');
  });

  it('rejects an invalid category', () => {
    expect(() =>
      generator.validateRetainedContext({
        ...base(),
        items: [{ category: 'bogus' as never, text: 'ok', confidence: 0.9, sourceMessageId: null, sourceLine: 1 }]
      })
    ).toThrow('RetainedContextItem.category must be a RetainedItemCategory value');
  });

  it('rejects an invalid sourcePool/fromState/capturedAt', () => {
    expect(() => generator.validateRetainedContext({ ...base(), sourcePool: 'bogus' as never })).toThrow(
      'RetainedContext.<field> has an invalid value'
    );
  });
});

describe('Config merge (mergeConfig)', () => {
  it('returns a fresh copy of defaults and never mutates DEFAULT_CONFIG', () => {
    const merged = mergeConfig({ retention: { confidenceFloor: 0.8 } });
    expect(merged).not.toBe(DEFAULT_CONFIG);
    expect(merged.retention).not.toBe(DEFAULT_CONFIG.retention);
    expect(merged.retention.confidenceFloor).toBe(0.8);
    // Untouched retention fields fall back to defaults.
    expect(merged.retention.enabled).toBe(DEFAULT_CONFIG.retention.enabled);
    expect(merged.retention.maxItems).toBe(DEFAULT_CONFIG.retention.maxItems);
    // The shared default is unmutated.
    expect(DEFAULT_CONFIG.retention.confidenceFloor).toBe(0.4);
  });

  it('retention block deep-merges field by field', () => {
    const merged = mergeConfig({
      retention: {
        enabled: false,
        categories: [RetainedItemCategory.RESEARCH],
        maxItems: 3,
        confidenceFloor: 0.9,
        evictSourcePool: false
      }
    });
    expect(merged.retention).toEqual({
      enabled: false,
      categories: [RetainedItemCategory.RESEARCH],
      maxItems: 3,
      confidenceFloor: 0.9,
      evictSourcePool: false
    });
  });
});
