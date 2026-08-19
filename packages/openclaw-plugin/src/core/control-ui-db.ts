import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { withLock } from '../utils/file-lock.js';
import { resolvePdPath } from './paths.js';

/**
 * Control UI database stores ANALYTICS READ MODELS.
 *
 * PURPOSE: Aggregated data for dashboard visualization and historical insights.
 * USAGE: Control UI queries and dashboard displays.
 * NOT FOR: Control decisions, Phase 3 eligibility, or real-time operations.
 *
 * Runtime truth comes from: queue state, workspace trust scorecard, active sessions
 *
 * Thinking Activity retirement (2026-08-19): the thinking_model_events table,
 * its four v_thinking_model_* views, recordThinkingModelEvent, and
 * getRecentThinkingContext were removed — the console page and /pd-thinking
 * status/audit readers no longer existed, making the writer pure write
 * amplification. Existing databases keep their table/views until a later
 * physical cleanup; nothing here reads or writes them anymore.
 */

export interface ControlUiDatabaseOptions {
  workspaceDir: string;
  busyTimeoutMs?: number;
}

const DEFAULT_BUSY_TIMEOUT_MS = 5000;

export class ControlUiDatabase {
  private readonly workspaceDir: string;
  private readonly dbPath: string;
  private readonly blobDir: string;
  private readonly db: Database.Database;

  constructor(opts: ControlUiDatabaseOptions) {
    this.workspaceDir = path.resolve(opts.workspaceDir);
    this.dbPath = resolvePdPath(this.workspaceDir, 'TRAJECTORY_DB');
    this.blobDir = resolvePdPath(this.workspaceDir, 'TRAJECTORY_BLOBS_DIR');

    fs.mkdirSync(path.dirname(this.dbPath), { recursive: true });
    fs.mkdirSync(this.blobDir, { recursive: true });

    this.db = new Database(this.dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.db.pragma('synchronous = NORMAL');
    this.db.pragma(`busy_timeout = ${Math.max(0, opts.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS)}`);
    this.initSchema();
  }

  dispose(): void {
    this.db.close();
  }

  /**
   * Execute SQL query and return all rows.
   *
   * Returns: Analytics data (read model) aggregated from trajectory database.
   * Not: Runtime truth or real-time queue state.
   */
  all<T>(sql: string, ...params: unknown[]): T[] {
    return this.db.prepare(sql).all(...params) as T[];
  }

  /**
   * Execute SQL query and return first row.
   *
   * Returns: Analytics data (read model) aggregated from trajectory database.
   * Not: Runtime truth or real-time queue state.
   */
  get<T>(sql: string, ...params: unknown[]): T | undefined {
    return this.db.prepare(sql).get(...params) as T | undefined;
  }

  /**
   * Execute SQL statement that does not return rows (DDL, CREATE TABLE, etc.).
   *
   * Returns: void (executes directly)
   * Not for: SELECT queries (use all() or get() instead)
   */
  execute(sql: string): void {
    this.db.exec(sql);
  }

  /**
   * Execute a parameterized write statement (INSERT, UPDATE, DELETE).
   */
  run(sql: string, ...params: unknown[]): void {
    this.withWrite(() => {
      this.db.prepare(sql).run(...params);
    });
  }

  restoreRawText(inlineText?: string | null, blobRef?: string | null): string {
    if (inlineText) return inlineText;
    if (!blobRef) return '';
    const fullPath = path.join(this.blobDir, blobRef);
    return fs.existsSync(fullPath) ? fs.readFileSync(fullPath, 'utf8') : '';
  }

  private initSchema(): void {
    // Thinking Activity retirement (2026-08-19): thinking_model_events table
    // creation and the four v_thinking_model_* views are no longer executed —
    // new workspaces must not generate retired schema. Existing databases are
    // left untouched (no DROP).
  }

  private withWrite<T>(fn: () => T): T {
    return withLock(this.dbPath, fn, { lockSuffix: '.trajectory.lock', lockStaleMs: 30000 });
  }
}
