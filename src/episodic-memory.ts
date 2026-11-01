import { PoolID, StateMachineState, ContextMessage, EpisodeRow } from './types.js';

// SQLite database type for bun:sqlite
type Database = import('bun:sqlite').Database;

/**
 * SQLite-backed episodic memory journal.
 * Archive-before-evict writes, recall-on-transition reads.
 */
export class EpisodicMemory {
  private db: Database | null = null;
  private dbPath: string;
  private initialized = false;

  constructor(dbPath: string) {
    this.dbPath = dbPath;
  }

  /**
   * Initialize database with schema (FTS5 always, vec0 if enabled).
   */
  async init(): Promise<void> {
    if (this.initialized) return;

    // Load bun:sqlite
    const sqlite = await import('bun:sqlite');
    const { Database } = sqlite;

    this.db = new Database(this.dbPath);

    // Enable WAL mode for better concurrency
    this.db.exec('PRAGMA journal_mode=WAL');
    this.db.exec('PRAGMA synchronous=NORMAL');

    // Create schema
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS episodes (
        id            INTEGER PRIMARY KEY,
        ts            INTEGER NOT NULL,
        pool          TEXT NOT NULL,
        state         TEXT NOT NULL,
        role          TEXT NOT NULL,
        content       TEXT NOT NULL,
        category      TEXT,
        summary_of    INTEGER,
        superseded_by INTEGER,
        access_count  INTEGER NOT NULL DEFAULT 0,
        last_accessed INTEGER
      );
      
      CREATE VIRTUAL TABLE IF NOT EXISTS episodes_fts USING fts5(
        content, content='episodes', content_rowid='id'
      );
      
      CREATE TABLE IF NOT EXISTS job_queue (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        kind        TEXT NOT NULL,
        payload     TEXT NOT NULL,
        queuedAt    INTEGER NOT NULL,
        attempts    INTEGER NOT NULL DEFAULT 1
      );
    `);

    this.initialized = true;
  }

  /**
   * Archive evicted/cleared messages BEFORE removal.
   * reason = 'eviction' | 'clearPool' | 'transition' | 'summary'
   */
  async archive(
    poolId: PoolID,
    messages: ContextMessage[],
    reason: string,
    state?: StateMachineState
  ): Promise<void> {
    if (!this.db || !this.initialized) return;

    if (messages.length === 0) return;

    const now = Date.now();
    const insert = this.db.prepare(`
      INSERT INTO episodes (ts, pool, state, role, content, category, summary_of, superseded_by, access_count, last_accessed)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const insertFts = this.db.prepare(`
      INSERT INTO episodes_fts (rowid, content) VALUES (?, ?)
    `);

    for (const msg of messages) {
      const row: EpisodeRow = {
        id: 0,
        ts: now,
        pool: poolId,
        state: state ?? StateMachineState.PLANNING,
        role: msg.role,
        content: msg.content,
        category: null,
        summary_of: null,
        superseded_by: null,
        access_count: 0,
        last_accessed: null
      };

      insert.run(
        row.ts,
        row.pool,
        row.state,
        row.role,
        row.content,
        row.category,
        row.summary_of,
        row.superseded_by,
        row.access_count,
        row.last_accessed
      );
      
      // Get the last insert rowid for FTS
      const rowid = this.db!.prepare('SELECT last_insert_rowid() as id').get() as { id: number };

      insertFts.run(rowid.id, row.content);
    }
  }

  /**
   * Recall recent episodes for a state transition.
   * Budget-constrained top-K by recency + FTS5 BM25 score.
   */
  async recall(state: StateMachineState, budgetTokens: number): Promise<string> {
    if (!this.db || !this.initialized) return '';

    // Query episodes by joining with main table to get ts and pool columns
    const query = this.db.prepare(`
      SELECT e.id, e.ts, e.pool, e.content
      FROM episodes e
      JOIN episodes_fts fts ON fts.rowid = e.id
      WHERE e.summary_of IS NULL AND e.superseded_by IS NULL
      ORDER BY e.ts DESC
      LIMIT 50
    `);

    const rows = query.all() as Array<{ id: number; ts: number; pool: PoolID; content: string }>;

    if (rows.length === 0) return '';

    // Filter by budget and format
    let tokenCount = 0;
    const selected: string[] = [];

    for (const row of rows) {
      const estimatedSize = Math.ceil(row.content.length / 4) + 4;
      if (tokenCount + estimatedSize > budgetTokens) break;

      selected.push(row.content);
      tokenCount += estimatedSize;
    }

    if (selected.length === 0) return '';

    const poolName = Object.values(PoolID).find(k => k === rows[0].pool) ?? 'Unknown';
    return `Previously in ${poolName} Pool:\n${selected.join('\n\n')}`;
  }

  /**
   * Mark episodes as consolidated (superseded by summary).
   */
  async markSuperseded(ids: number[]): Promise<void> {
    if (!this.db || !this.initialized) return;
    if (ids.length === 0) return;

    const update = this.db.prepare(`
      UPDATE episodes SET superseded_by = (
        SELECT id FROM episodes WHERE content LIKE 'Consolidated summary%' LIMIT 1
      ) WHERE id IN (${ids.map(() => '?').join(',')})
    `);

    update.run(...ids);
  }

  /**
   * Prune old cold entries (aging policy).
   */
  async prune(archiveAfterDays: number, purgeAfterDays: number): Promise<{ archived: number; purged: number }> {
    if (!this.db || !this.initialized) return { archived: 0, purged: 0 };

    const cutoffArchive = Date.now() - archiveAfterDays * 24 * 60 * 60 * 1000;
    const cutoffPurge = Date.now() - purgeAfterDays * 24 * 60 * 60 * 1000;

    let archived = 0;
    let purged = 0;

    // Move old entries to cold storage (simplified: just mark as archived)
    const archiveStmt = this.db.prepare(`
      UPDATE episodes SET content = '[ARCHIVED]' || substr(content, 1, 100) || '...'
      WHERE ts < ? AND access_count = 0 AND superseded_by IS NULL
    `);

    const result = archiveStmt.run(cutoffArchive);
    if ('changes' in result) {
      archived = (result as { changes: number }).changes;
    }

    // Purge very old entries
    const purgeStmt = this.db.prepare(`
      DELETE FROM episodes WHERE ts < ? AND access_count = 0
    `);

    const purgeResult = purgeStmt.run(cutoffPurge);
    if ('changes' in purgeResult) {
      purged = (purgeResult as { changes: number }).changes;
    }

    return { archived, purged };
  }

  /**
   * Close the database connection.
   */
  close(): void {
    if (this.db) {
      this.db.close();
      this.db = null;
      this.initialized = false;
    }
  }

  /**
   * Check if memory is initialized.
   */
  isInitialized(): boolean {
    return this.initialized;
  }
}