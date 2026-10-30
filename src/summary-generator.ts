import {
  StateMachineState,
  PoolID,
  STATE_TO_POOL,
  ContextMessage,
  ContextPagerConfig,
  DEFAULT_CONFIG,
  RetainedContext,
  RetainedContextItem,
  RetainedItemCategory,
  RETAINED_CONTEXT_PREFIX
} from './types.js';
import { ContextRouter } from './router.js';

const POOL_NAME_MAP: Record<PoolID, string> = {
  [PoolID.GLOBAL]: 'Global',
  [PoolID.PLANNING]: 'Planning',
  [PoolID.EXECUTION]: 'Execution',
  [PoolID.TESTING]: 'Testing'
};

/** Category priority for ordering retained items (lower = earlier). */
const CATEGORY_PRIORITY: Record<RetainedItemCategory, number> = {
  [RetainedItemCategory.ACCEPTANCE]: 0,
  [RetainedItemCategory.REQUIREMENT]: 1,
  [RetainedItemCategory.ARCHITECTURE]: 2,
  [RetainedItemCategory.RESEARCH]: 3
};

/**
 * Deterministic pattern table (contract §3.2). All patterns are case-insensitive
 * and linear (no catastrophic backtracking). "starts-with" patterns are anchored
 * to the effective text; "contains" patterns may match anywhere in it.
 * Category priority: ACCEPTANCE → REQUIREMENT → ARCHITECTURE → RESEARCH.
 */
const CATEGORY_PATTERNS: {
  category: RetainedItemCategory;
  patterns: { re: RegExp; confidence: number }[];
}[] = [
  {
    category: RetainedItemCategory.ACCEPTANCE,
    patterns: [
      { re: /^(given\s+.+\s+when\s+.+\s+then\b)/i, confidence: 0.95 },
      { re: /^(acceptance\s+criteria|definition\s+of\s+done|done\s+when)(?:\s*[—:–-])?/i, confidence: 0.9 }
    ]
  },
  {
    category: RetainedItemCategory.REQUIREMENT,
    patterns: [
      { re: /^(requirement|req\.?)(?:\s*[#-]?\s*\w+)?:/i, confidence: 0.9 },
      { re: /^(must|shall|needs?\s+to|non-functional\s+requirement|nfr\b)(?:\s*[—:–-])?/i, confidence: 0.85 },
      { re: /\b(must|shall)\b/i, confidence: 0.6 }
    ]
  },
  {
    category: RetainedItemCategory.ARCHITECTURE,
    patterns: [
      { re: /^(architecture|arch|design)(\s+decision)?[:\-—]/i, confidence: 0.9 },
      { re: /^decision[:\-—]\s*/i, confidence: 0.9 },
      { re: /^(adr[-\s]?\w*\s*)?decision:/i, confidence: 0.9 },
      { re: /\b(we\s+(decided|chose|selected|rejected)|decided\s+to|chosen\s+over)\b/i, confidence: 0.8 }
    ]
  },
  {
    category: RetainedItemCategory.RESEARCH,
    patterns: [
      { re: /^(research|finding)(\s+finding)?[:\-—]\s*/i, confidence: 0.9 },
      { re: /\b(we\s+(found|discovered)|according\s+to|per\s+[A-Z]\w+\b|source[:-])\b/i, confidence: 0.7 },
      { re: /^based\s+on\b/i, confidence: 0.6 }
    ]
  }
];

/** Minimum normalized length for a non-bullet line to be a candidate. */
const NON_BULLET_MIN_LENGTH = 30;
/** Max rendered item length (240 content chars + '…' = 241 when truncated). */
const MAX_TEXT_LENGTH = 241;

export class SummaryGenerator {
  private router: ContextRouter;
  private config: ContextPagerConfig;

  constructor(router: ContextRouter, config: ContextPagerConfig = DEFAULT_CONFIG) {
    this.router = router;
    this.config = config;
  }

  generateSummary(targetState: StateMachineState, trigger: string): string {
    const poolId = STATE_TO_POOL[targetState];
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

  addSummaryToPool(state: StateMachineState, summary: string): void {
    const poolId = STATE_TO_POOL[state];
    const message: ContextMessage = {
      role: 'system',
      content: summary,
      createdAt: Date.now()
    };

    this.router.addMessage(poolId, message);
  }

  /**
   * Deterministic extraction over the messages of `sourcePoolId`.
   * Returns `{ sourcePool, fromState, items: [] }` (never throws) when:
   * - retention is disabled, or
   * - the pool is missing/empty, or
   * - no line matches any enabled category.
   * Pure function of input + config; no LLM, no I/O, no clock except capturedAt.
   */
  extractRetainedContext(sourcePoolId: PoolID, fromState: StateMachineState): RetainedContext {
    const empty = (): RetainedContext => ({
      sourcePool: sourcePoolId,
      fromState,
      items: [],
      capturedAt: Date.now()
    });

    if (!this.config.retention.enabled) {
      return empty();
    }

    const pool = this.router.getPool(sourcePoolId);
    const messages = pool?.messages ?? [];
    if (messages.length === 0) {
      return empty();
    }

    const { categories, confidenceFloor, maxItems } = this.config.retention;

    interface Candidate extends RetainedContextItem {
      messageIndex: number;
    }

    const candidates: Candidate[] = [];
    const seen = new Set<string>();

    for (let messageIndex = 0; messageIndex < messages.length; messageIndex++) {
      const message = messages[messageIndex];
      // system-role messages are plugin-generated (summaries, prior retained
      // blocks) — excluded so we never extract our own output.
      if (message.role === 'system') {
        continue;
      }

      const lines = message.content.split('\n');
      for (let lineNo = 0; lineNo < lines.length; lineNo++) {
        const trimmed = lines[lineNo].trim();
        if (trimmed.length === 0) {
          continue;
        }

        const isBullet = /^[•*-]/.test(trimmed);
        // Bullet lines are candidates regardless of length; non-bullets must
        // be long enough to carry content (filters headings, "OK", etc.).
        const effective = isBullet ? trimmed.replace(/^[•*-]\s*/, '') : trimmed;
        if (effective.length === 0) {
          continue;
        }
        if (!isBullet && this.normalize(effective).length < NON_BULLET_MIN_LENGTH) {
          continue;
        }

        const match = this.matchLine(effective);
        if (!match) {
          continue;
        }
        if (!categories.includes(match.category)) {
          continue;
        }
        if (match.confidence < confidenceFloor) {
          continue;
        }

        const text = this.truncate(this.normalize(effective));
        const key = this.normalize(text);
        if (seen.has(key)) {
          continue; // keep first occurrence (earliest message, earliest line)
        }
        seen.add(key);

        candidates.push({
          category: match.category,
          text,
          confidence: match.confidence,
          sourceMessageId: message.id ?? null,
          sourceLine: lineNo + 1,
          messageIndex
        });
      }
    }

    // Stable sort: category priority first, then original chronology
    // (message array index, then line number). Array.prototype.sort is stable.
    candidates.sort((a, b) => {
      const priority = CATEGORY_PRIORITY[a.category] - CATEGORY_PRIORITY[b.category];
      if (priority !== 0) return priority;
      if (a.messageIndex !== b.messageIndex) return a.messageIndex - b.messageIndex;
      return a.sourceLine - b.sourceLine;
    });

    const items: RetainedContextItem[] = candidates.slice(0, maxItems).map(({ messageIndex: _mi, ...item }) => item);
    return {
      sourcePool: sourcePoolId,
      fromState,
      items,
      capturedAt: Date.now()
    };
  }

  /** Structural validation of a RetainedContext (defensive; extraction output always passes). */
  validateRetainedContext(retained: RetainedContext): void {
    if (!Array.isArray(retained.items)) {
      throw new Error('RetainedContext.items must be an array');
    }
    for (const item of retained.items) {
      if (typeof item.text !== 'string' || item.text.length === 0 || item.text.length > 241) {
        throw new Error('RetainedContextItem.text must be a non-empty string of at most 241 chars');
      }
      if (typeof item.confidence !== 'number' || item.confidence < 0 || item.confidence > 1) {
        throw new Error('RetainedContextItem.confidence must be a number between 0 and 1');
      }
      if (!Object.values(RetainedItemCategory).includes(item.category)) {
        throw new Error('RetainedContextItem.category must be a RetainedItemCategory value');
      }
    }
    if (
      !Object.values(PoolID).includes(retained.sourcePool) ||
      !Object.values(StateMachineState).includes(retained.fromState) ||
      typeof retained.capturedAt !== 'number'
    ) {
      throw new Error('RetainedContext.<field> has an invalid value');
    }
  }

  /**
   * Appends the retained items to `targetState`'s pool as ONE system message:
   *   content = `${RETAINED_CONTEXT_PREFIX}<SourcePoolName> Pool:\n<rendered items>`
   * Renders nothing (no message added, returns false) when retained.items is empty.
   * Returns true when a message was written.
   */
  writeRetainedContextToPool(targetState: StateMachineState, retained: RetainedContext): boolean {
    if (retained.items.length === 0) {
      return false;
    }

    const targetPoolId = STATE_TO_POOL[targetState];
    const sourcePoolName = POOL_NAME_MAP[retained.sourcePool] || 'Unknown';
    const content = `${RETAINED_CONTEXT_PREFIX}${sourcePoolName} Pool:\n${this.renderRetained(retained)}`;

    const message: ContextMessage = {
      role: 'system',
      content,
      createdAt: Date.now()
    };

    this.router.addMessage(targetPoolId, message);
    return true;
  }

  /** Classify `effectiveText` against the pattern table; first matching category wins. */
  private matchLine(effectiveText: string): { category: RetainedItemCategory; confidence: number } | null {
    for (const { category, patterns } of CATEGORY_PATTERNS) {
      for (const { re, confidence } of patterns) {
        if (re.test(effectiveText)) {
          return { category, confidence };
        }
      }
    }
    return null;
  }

  /** Collapse \s+ → ' ', trim. */
  private normalize(text: string): string {
    return text.replace(/\s+/g, ' ').trim();
  }

  /** Truncate to MAX_TEXT_LENGTH (241) total: 240 content chars + '…' when cut. */
  private truncate(text: string): string {
    if (text.length > MAX_TEXT_LENGTH) {
      return `${text.slice(0, MAX_TEXT_LENGTH - 1)}…`;
    }
    return text;
  }

  /** One line per item, `[CATEGORY] text`, in the items' (priority) order. */
  private renderRetained(retained: RetainedContext): string {
    return retained.items
      .map((item) => `[${item.category.toUpperCase()}] ${item.text}`)
      .join('\n');
  }
}