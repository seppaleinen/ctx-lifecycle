import { describe, it, expect, beforeEach } from 'bun:test';
import { SummaryGenerator } from '../../src/summary-generator.js';
import { ContextRouter } from '../../src/router.js';

describe('SummaryGenerator', () => {
  let summaryGenerator: SummaryGenerator;
  let router: ContextRouter;

  const poolNameMap: Record<string, string> = {
    'planning': 'Planning',
    'execution': 'Execution',
    'testing': 'Testing',
    'global': 'Global'
  };

  const stateToPool: Record<string, string> = {
    'planning': 'planning',
    'coding': 'execution',
    'debugging': 'testing',
    'complete': 'planning'
  };

  beforeEach(() => {
    router = new ContextRouter();
    summaryGenerator = new SummaryGenerator(router);
  });

  describe('generateSummary', () => {
    it('generates valid 1-sentence summary for planning', () => {
      const summary = summaryGenerator.generateSummary('planning' as any, 'Task switch');
      expect(summary).toBe('Swapped to Planning Pool. Task switch');
    });

    it('generates summary for execution pool', () => {
      const summary = summaryGenerator.generateSummary('coding' as any, 'File read: user-service.ts');
      expect(summary).toBe('Swapped to Execution Pool. File read: user-service.ts');
    });

    it('generates summary for testing pool', () => {
      const summary = summaryGenerator.generateSummary('debugging' as any, 'Modified auth.ts and db.ts');
      expect(summary).toBe('Swapped to Testing Pool. Modified auth.ts and db.ts');
    });
  });

  it('validates summary has 1 sentence', () => {
    expect(() => summaryGenerator.validateSummary('This is one sentence. This is another.')).toThrow(
      'Summary exceeds 1 sentence limit'
    );
  });

  it('rejects summary with evicted content', () => {
    expect(() => summaryGenerator.validateSummary('Swapped to Testing Pool. Evicted 15 messages')).toThrow(
      'Summary contains prohibited content'
    );
  });

  it('rejects summary with token counts', () => {
    expect(() => summaryGenerator.validateSummary('Swapped to Testing Pool. 5000 tokens')).toThrow(
      'Summary contains prohibited content'
    );
  });
});