import { StateMachineState, PoolID, STATE_TO_POOL, ContextMessage } from './types.js';
import { ContextRouter } from './router.js';

const POOL_NAME_MAP: Record<PoolID, string> = {
  [PoolID.GLOBAL]: 'Global',
  [PoolID.PLANNING]: 'Planning',
  [PoolID.EXECUTION]: 'Execution',
  [PoolID.TESTING]: 'Testing'
};

export class SummaryGenerator {
  private router: ContextRouter;

  constructor(router: ContextRouter) {
    this.router = router;
  }

  generateSummary(targetState: string, trigger: string): string {
    const poolId = STATE_TO_POOL[targetState as StateMachineState];
    const poolName = POOL_NAME_MAP[poolId] || 'Unknown';

    const summary = `Swapped to ${poolName} Pool. ${trigger}`;
    this.validateSummary(summary);
    return summary;
  }

  validateSummary(summary: string): void {
    // 1. Check for 1 sentence first (regardless of format)
    // Count periods that end sentences (period followed by space or end of string)
    const sentenceEndings = summary.match(/[.!?](?:\s|$)/g);
    if (sentenceEndings && sentenceEndings.length > 1) {
      throw new Error('Summary exceeds 1 sentence limit');
    }

    // 2. Check format: must start with "Swapped to" and contain "Pool."
    if (!summary.startsWith('Swapped to')) {
      throw new Error('Summary does not start with "Swapped to"');
    }

    if (!summary.includes('Pool.')) {
      throw new Error('Summary does not contain "Pool." as required by format');
    }

    // 3. Check for prohibited content
    const lowerSummary = summary.toLowerCase();
    if (lowerSummary.includes('evicted')) {
      throw new Error('Summary contains prohibited content: evicted details');
    }
    if (lowerSummary.includes('token count') || lowerSummary.includes('tokens')) {
      throw new Error('Summary contains prohibited content: token counts');
    }
  }

  addSummaryToPool(state: string, summary: string): void {
    const poolId = STATE_TO_POOL[state as StateMachineState];
    const message: ContextMessage = {
      role: 'system',
      content: summary,
      createdAt: Date.now()
    };

    this.router.addMessage(poolId, message);
  }
}