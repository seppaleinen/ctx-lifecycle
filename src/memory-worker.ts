import { PoolID, StateMachineState, ContextMessage, EvictedBatch } from './types.js';
import { Summarizer } from './summarizer.js';
import { EpisodicMemory } from './episodic-memory.js';

/** Job kinds for the worker */
export type JobKind = 'summarize' | 'consolidate' | 'embed' | 'calibrate' | 'prune';

export interface Job {
  kind: JobKind;
  payload: JobPayload;
  queuedAt: number;
  attempts: number;
  id?: number;
}

export type JobPayload = 
  | { kind: 'summarize'; poolId: PoolID; messages: ContextMessage[]; state?: StateMachineState; trigger: string; retained?: unknown }
  | { kind: 'consolidate'; poolId: PoolID; sinceTs: number }
  | { kind: 'embed'; episodeIds: number[] }
  | { kind: 'calibrate'; providerTokens: number; ourEstimate: number }
  | { kind: 'prune'; archiveAfterDays: number; purgeAfterDays: number };

/**
 * In-process async job queue for background summarization/consolidation.
 * Triggered by: transitions, eviction batches, session.idle, startup.
 * Hot path invariant: hooks NEVER await this worker.
 */
export class MemoryWorker {
  private queue: Job[] = [];
  private running = false;
  private readonly MAX_CONCURRENCY = 1;

  constructor(
    private summarizer: Summarizer,
    private episodicMemory: EpisodicMemory,
    private config: {
      enabled: boolean;
      recallBudgetTokens: number;
      recallTopK: number;
      journal: { archiveBeforeEvict: boolean };
      worker: { llmSummaries: boolean; consolidateEvery: number };
    }
  ) {}

  /**
   * Bootstrap from persisted job queue (restart recovery).
   * Returns immediately - processLoop runs in background.
   */
  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    // Run processLoop in background (fire and forget)
    this.processLoop();
  }

  /**
   * Stop worker and wait for queue to drain.
   */
  async stop(): Promise<void> {
    this.running = false;
    // Wait for queue to drain
    let waitCount = 0;
    while (this.queue.length > 0 && waitCount < 10) {
      await new Promise(resolve => setTimeout(resolve, 100));
      waitCount++;
    }
  }

  /**
   * Schedule a job (coalesces duplicates by kind+pool where applicable).
   */
  enqueue(kind: JobKind, payload: JobPayload): void {
    if (!this.config.enabled) return;

    const job: Job = {
      kind,
      payload,
      queuedAt: Date.now(),
      attempts: 1
    };

    // For summarize jobs, coalesce by pool
    if (kind === 'summarize') {
      const existingIdx = this.queue.findIndex(j => 
        j.kind === 'summarize' && 
        (j.payload as { poolId: PoolID }).poolId === (payload as { poolId: PoolID }).poolId
      );
      if (existingIdx >= 0) {
        this.queue[existingIdx] = job; // Replace with new job
        return;
      }
    }

    this.queue.push(job);
  }

  /**
   * Process jobs in the background.
   */
  private async processLoop(): Promise<void> {
    while (this.running) {
      if (this.queue.length === 0) {
        await new Promise(resolve => setTimeout(resolve, 100));
        continue;
      }

      const job = this.queue.shift();
      if (!job) continue;

      try {
        await this.processJob(job);
      } catch (error) {
        console.error('[memory-worker] Job failed:', error);
        job.attempts++;
        if (job.attempts <= 3) {
          this.queue.unshift(job); // Retry with backoff
          await new Promise(resolve => setTimeout(resolve, 1000 * job.attempts));
        }
      }
    }
  }

  private async processJob(job: Job): Promise<void> {
    switch (job.kind) {
      case 'summarize': {
        const payload = job.payload as { poolId: PoolID; messages: ContextMessage[]; state?: StateMachineState; trigger: string; retained?: unknown };
        const batch: EvictedBatch = {
          poolId: payload.poolId,
          state: payload.state ?? StateMachineState.PLANNING,
          messages: payload.messages,
          trigger: payload.trigger,
          retained: payload.retained as undefined
        };
        
        const summary = await this.summarizer.summarize(batch);
        
        // Archive the summary as a consolidated episode
        await this.episodicMemory.archive(
          payload.poolId,
          [{ role: 'system', content: summary }],
          'summary',
          payload.state as StateMachineState
        );
        break;
      }
      
      case 'consolidate': {
        // Implementation for journal consolidation
        break;
      }
      
      case 'prune': {
        const payload = job.payload as { archiveAfterDays: number; purgeAfterDays: number };
        await this.episodicMemory.prune(payload.archiveAfterDays, payload.purgeAfterDays);
        break;
      }
      
      default:
        console.warn(`[memory-worker] Unhandled job kind: ${job.kind}`);
    }
  }

  /**
   * Get pending job count (for testing).
   */
  getJobCount(): number {
    return this.queue.length;
  }
}