import { PoolID, ContextMessage, RetainedItemCategory, EvictedBatch } from './types.js';

/**
 * Summarizer interface for background LLM/deterministic summaries.
 */
export interface Summarizer {
  /**
   * Summarize evicted messages into a journal episode.
   * Returns summary content (no metadata).
   */
  summarize(messages: EvictedBatch, opts?: SummarizeOptions): Promise<string>;
}

export interface SummarizeOptions {
  maxInputChars: number;
  maxOutputChars: number;
}

/**
 * Deterministic implementation: extend retention extractor + rollup.
 * Uses the same pattern matching as Phase 2 retention but for summarization.
 */
export class DeterministicSummarizer {
  private readonly CATEGORY_LABELS: Record<RetainedItemCategory, string> = {
    [RetainedItemCategory.ACCEPTANCE]: 'Acceptance',
    [RetainedItemCategory.REQUIREMENT]: 'Requirement',
    [RetainedItemCategory.ARCHITECTURE]: 'Architecture',
    [RetainedItemCategory.RESEARCH]: 'Research'
  };

  async summarize(batch: EvictedBatch, opts: SummarizeOptions = { maxInputChars: 8000, maxOutputChars: 600 }): Promise<string> {
    const { poolId, messages, retained, trigger } = batch;
    const poolName = this.poolName(poolId);
    
    // Extract items for rollup
    const items = this.extractItems(messages);
    
    // Build summary
    const lines: string[] = [];
    lines.push(`Evicted from ${poolName} Pool: ${trigger}`);
    
    if (retained && retained.items.length > 0) {
      lines.push('\nRetained items:');
      for (const item of retained.items) {
        lines.push(`  [${this.CATEGORY_LABELS[item.category]}] ${item.text}`);
      }
    }
    
    if (items.length > 0) {
      lines.push('\nKey content:');
      for (const item of items) {
        if (item) {
          lines.push(`  - ${item.text}`);
        }
      }
    }
    
    let summary = lines.join('\n');
    
    // Truncate if needed
    if (summary.length > opts.maxInputChars) {
      summary = summary.slice(0, opts.maxInputChars - 3) + '...';
    }
    
    return summary;
  }

  private poolName(poolId: PoolID): string {
    const names: Record<PoolID, string> = {
      [PoolID.GLOBAL]: 'Global',
      [PoolID.PROJECT]: 'Project',
      [PoolID.PLANNING]: 'Planning',
      [PoolID.EXECUTION]: 'Execution',
      [PoolID.TESTING]: 'Testing'
    };
    return names[poolId] || 'Unknown';
  }

  private extractItems(messages: ContextMessage[]): Array<{ text: string; category: RetainedItemCategory } | null> {
    const items: Array<{ text: string; category: RetainedItemCategory } | null> = [];
    const CATEGORY_PATTERNS: { category: RetainedItemCategory; patterns: RegExp[] }[] = [
      { category: RetainedItemCategory.ACCEPTANCE, patterns: [/^(given\s+.+\s+when\s+.+\s+then\b)/i, /^(acceptance\s+criteria|definition\s+of\s+done|done\s+when)/i] },
      { category: RetainedItemCategory.REQUIREMENT, patterns: [/^(requirement|req\.?)(?:\s*[#-]?\s*\w+)?:/i, /^(must|shall|needs?\s+to|non-functional\s+requirement)/i] },
      { category: RetainedItemCategory.ARCHITECTURE, patterns: [/^(architecture|arch|design)(\s+decision)?[:\-—]/i, /^decision[:\-—]/i] },
      { category: RetainedItemCategory.RESEARCH, patterns: [/^(research|finding)(\s+finding)?[:\-—]\s*/i, /based\s+on\b/i] }
    ];

    for (const msg of messages) {
      if (msg.role === 'system') continue;
      
      const lines = msg.content.split('\n');
      for (const line of lines) {
        const trimmed = line.trim();
        for (const { category, patterns } of CATEGORY_PATTERNS) {
          for (const pattern of patterns) {
            if (pattern.test(trimmed)) {
              items.push({ text: trimmed, category });
              break;
            }
          }
        }
      }
    }
    
    return items.filter((i): i is { text: string; category: RetainedItemCategory } => i !== null);
  }
}

/**
 * LLM implementation: wraps ctx.experimental.generate.text.
 * Falls back to deterministic when LLM unavailable or disabled.
 */
export class LlmSummarizer implements Summarizer {
  constructor(
    private ctx: { experimental: { generate: { text: (opts: { model?: { providerID: string; id: string } | undefined; prompt: string }) => Promise<{ text: string }> } } },
    private config: LlmSummarizerConfig
  ) {}

  async summarize(batch: EvictedBatch, opts: SummarizeOptions = { maxInputChars: 8000, maxOutputChars: 600 }): Promise<string> {
    const poolName = this.poolName(batch.poolId);
    const content = batch.messages.map(m => `[${m.role}] ${m.content}`).join('\n');
    
    // Truncate input
    const input = content.length > opts.maxInputChars 
      ? content.slice(0, opts.maxInputChars - 3) + '...'
      : content;
    
    const prompt = `Summarize the following evicted context from the ${poolName} pool. 
Focus on requirements, decisions, and key findings. Keep it concise (~600 chars).

EVACTED CONTEXT:
${input}

SUMMARY:`;

    try {
      const result = await this.ctx.experimental.generate.text({
        model: this.config.model,
        prompt
      });
      
      let summary = result.text.trim();
      
      // Truncate output
      if (summary.length > opts.maxOutputChars) {
        summary = summary.slice(0, opts.maxOutputChars - 3) + '...';
      }
      
      return summary;
    } catch (error) {
      console.warn('[summarizer] LLM summarization failed, falling back to deterministic:', error);
      const det = new DeterministicSummarizer();
      return det.summarize(batch, opts);
    }
  }

  private poolName(poolId: PoolID): string {
    const names: Record<PoolID, string> = {
      [PoolID.GLOBAL]: 'Global',
      [PoolID.PROJECT]: 'Project',
      [PoolID.PLANNING]: 'Planning',
      [PoolID.EXECUTION]: 'Execution',
      [PoolID.TESTING]: 'Testing'
    };
    return names[poolId] || 'Unknown';
  }
}

export interface LlmSummarizerConfig {
  enabled: boolean;
  model?: { providerID: string; id: string };
  inputChars: number;
  outputChars: number;
}