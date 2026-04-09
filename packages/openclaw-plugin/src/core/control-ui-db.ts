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
 */

export interface ThinkingModelEventInput {
  sessionId: string;
  runId: string;
  assistantTurnId: number;
  modelId: string;
  matchedPattern: string;
  scenarioJson: unknown;
  toolContextJson: unknown;
  painContextJson: unknown;
  principleContextJson: unknown;
  triggerExcerpt: string;
  createdAt: string;
}

export interface ControlUiDatabaseOptions {
  workspaceDir: string;
  busyTimeoutMs?: number;
}

export interface RecentThinkingContext {
  toolCalls: {
    id: number;
    toolName: string;
    outcome: 'success' | 'failure' | 'blocked';
    errorType: string | null;
    errorMessage: string | null;
    createdAt: string;
  }[];
  painEvents: {
    id: number;
    source: string;
    score: number;
    reason: string | null;
    createdAt: string;
  }[];
  gateBlocks: {
    id: number;
    toolName: string;
    reason: string;
    filePath: string | null;
    createdAt: string;
  }[];
  userCorrections: {
    id: number;
    correctionCue: string | null;
    rawExcerpt: string | null;
    createdAt: string;
  }[];
  principleEvents: {
    id: number;
    principleId: string | null;
    eventType: string;
    createdAt: string;
  }[];
}

const DEFAULT_BUSY_TIMEOUT_MS = 5000;

function safeJson(value: unknown): string {
  return JSON.stringify(value ?? []);
}

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

  recordThinkingModelEvent(input: ThinkingModelEventInput): number {
    return this.withWrite(() => {
      const result = this.db.prepare(`
        INSERT INTO thinking_model_events (
          session_id, run_id, assistant_turn_id, model_id, matched_pattern, scenario_json,
          tool_context_json, pain_context_json, principle_context_json, trigger_excerpt, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        input.sessionId,
        input.runId,
        input.assistantTurnId,
        input.modelId,
        input.matchedPattern,
        safeJson(input.scenarioJson),
        safeJson(input.toolContextJson),
        safeJson(input.painContextJson),
        safeJson(input.principleContextJson),
        input.triggerExcerpt,
        input.createdAt,
      );
      return Number(result.lastInsertRowid);
    });
  }

  /**
   * Get recent thinking context for a session.
   *
   * Returns: Analytics data (read model) aggregated from trajectory database.
   * Not: Runtime truth or real-time queue state.
   */
  getRecentThinkingContext(sessionId: string, beforeCreatedAt: string, limit = 5): RecentThinkingContext {
    return {
      toolCalls: this.all<{
        id: number;
        tool_name: string;
        outcome: 'success' | 'failure' | 'blocked';
        error_type: string | null;
        error_message: string | null;
        created_at: string;
      }>(
        `
          SELECT id, tool_name, outcome, error_type, error_message, created_at
          FROM tool_calls
          WHERE session_id = ? AND created_at <= ?
          ORDER BY created_at DESC
          LIMIT ?
        `,
        sessionId,
        beforeCreatedAt,
        limit,
      ).map((row) => ({
        id: Number(row.id),
        toolName: String(row.tool_name),
        outcome: row.outcome,
        errorType: row.error_type,
        errorMessage: row.error_message,
        createdAt: String(row.created_at),
      })),
      painEvents: this.all<{
        id: number;
        source: string;
        score: number;
        reason: string | null;
        created_at: string;
      }>(
        `
          SELECT id, source, score, reason, created_at
          FROM pain_events
          WHERE session_id = ? AND created_at <= ?
          ORDER BY created_at DESC
          LIMIT ?
        `,
        sessionId,
        beforeCreatedAt,
        limit,
      ).map((row) => ({
        id: Number(row.id),
        source: String(row.source),
        score: Number(row.score),
        reason: row.reason,
        createdAt: String(row.created_at),
      })),
      gateBlocks: this.all<{
        id: number;
        tool_name: string;
        reason: string;
        file_path: string | null;
        created_at: string;
      }>(
        `
          SELECT id, tool_name, reason, file_path, created_at
          FROM gate_blocks
          WHERE session_id = ? AND created_at <= ?
          ORDER BY created_at DESC
          LIMIT ?
        `,
        sessionId,
        beforeCreatedAt,
        limit,
      ).map((row) => ({
        id: Number(row.id),
        toolName: String(row.tool_name),
        reason: String(row.reason),
        filePath: row.file_path,
        createdAt: String(row.created_at),
      })),
      userCorrections: this.all<{
        id: number;
        correction_cue: string | null;
        raw_excerpt: string | null;
        created_at: string;
      }>(
        `
          SELECT id, correction_cue, raw_excerpt, created_at
          FROM user_turns
          WHERE session_id = ? AND correction_detected = 1 AND created_at <= ?
          ORDER BY created_at DESC
          LIMIT ?
        `,
        sessionId,
        beforeCreatedAt,
        limit,
      ).map((row) => ({
        id: Number(row.id),
        correctionCue: row.correction_cue,
        rawExcerpt: row.raw_excerpt,
        createdAt: String(row.created_at),
      })),
      principleEvents: this.all<{
        id: number;
        principle_id: string | null;
        event_type: string;
        created_at: string;
      }>(
        `
          SELECT id, principle_id, event_type, created_at
          FROM principle_events
          WHERE created_at <= ?
          ORDER BY created_at DESC
          LIMIT ?
        `,
        beforeCreatedAt,
        limit,
      ).map((row) => ({
        id: Number(row.id),
        principleId: row.principle_id,
        eventType: String(row.event_type),
        createdAt: String(row.created_at),
      })),
    };
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
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS thinking_model_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        assistant_turn_id INTEGER NOT NULL,
        model_id TEXT NOT NULL,
        matched_pattern TEXT NOT NULL,
        scenario_json TEXT NOT NULL,
        tool_context_json TEXT NOT NULL,
        pain_context_json TEXT NOT NULL,
        principle_context_json TEXT NOT NULL,
        trigger_excerpt TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_thinking_model_events_model_created
        ON thinking_model_events(model_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_thinking_model_events_session_created
        ON thinking_model_events(session_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_thinking_model_events_assistant_turn
        ON thinking_model_events(assistant_turn_id);
      CREATE INDEX IF NOT EXISTS idx_thinking_model_events_run_id
        ON thinking_model_events(run_id);

      DROP VIEW IF EXISTS v_thinking_model_usage;
      CREATE VIEW v_thinking_model_usage AS
      WITH totals AS (
        SELECT COUNT(*) AS assistant_turns FROM assistant_turns
      ),
      usage_rows AS (
        SELECT
          model_id,
          COUNT(*) AS hits,
          COUNT(DISTINCT session_id) AS distinct_sessions,
          COUNT(DISTINCT assistant_turn_id) AS distinct_turns
        FROM thinking_model_events
        GROUP BY model_id
      )
      SELECT
        usage_rows.model_id AS model_id,
        usage_rows.hits AS hits,
        usage_rows.distinct_sessions AS distinct_sessions,
        usage_rows.distinct_turns AS distinct_turns,
        CASE
          WHEN totals.assistant_turns = 0 THEN 0
          ELSE ROUND(CAST(usage_rows.distinct_turns AS REAL) / CAST(totals.assistant_turns AS REAL), 4)
        END AS coverage_rate
      FROM usage_rows, totals
      ORDER BY usage_rows.hits DESC, usage_rows.model_id ASC;

      DROP VIEW IF EXISTS v_thinking_model_effectiveness;
      CREATE VIEW v_thinking_model_effectiveness AS
      WITH event_windows AS (
        SELECT
          e.id,
          e.session_id,
          e.model_id,
          e.created_at,
          (
            SELECT MIN(a.created_at)
            FROM assistant_turns a
            WHERE a.session_id = e.session_id AND a.created_at > e.created_at
          ) AS next_assistant_at,
          datetime(e.created_at, '+10 minutes') AS max_window_end
        FROM thinking_model_events e
      ),
      bounded_windows AS (
        SELECT
          id,
          session_id,
          model_id,
          created_at,
          CASE
            WHEN next_assistant_at IS NULL THEN max_window_end
            WHEN next_assistant_at < max_window_end THEN next_assistant_at
            ELSE max_window_end
          END AS window_end
        FROM event_windows
      )
      SELECT
        b.model_id AS model_id,
        COUNT(*) AS events,
        SUM(CASE WHEN EXISTS (
          SELECT 1 FROM tool_calls t
          WHERE t.session_id = b.session_id
            AND t.created_at > b.created_at
            AND t.created_at <= b.window_end
            AND t.outcome = 'success'
        ) THEN 1 ELSE 0 END) AS success_windows,
        SUM(CASE WHEN EXISTS (
          SELECT 1 FROM tool_calls t
          WHERE t.session_id = b.session_id
            AND t.created_at > b.created_at
            AND t.created_at <= b.window_end
            AND t.outcome = 'failure'
        ) THEN 1 ELSE 0 END) AS failure_windows,
        SUM(CASE WHEN EXISTS (
          SELECT 1 FROM pain_events p
          WHERE p.session_id = b.session_id
            AND p.created_at > b.created_at
            AND p.created_at <= b.window_end
        ) THEN 1 ELSE 0 END) AS pain_windows,
        SUM(CASE WHEN EXISTS (
          SELECT 1 FROM user_turns u
          WHERE u.session_id = b.session_id
            AND u.created_at > b.created_at
            AND u.created_at <= b.window_end
            AND u.correction_detected = 1
        ) THEN 1 ELSE 0 END) AS correction_windows,
        SUM(CASE WHEN EXISTS (
          SELECT 1 FROM correction_samples c
          WHERE c.session_id = b.session_id
            AND c.created_at > b.created_at
            AND c.created_at <= b.window_end
        ) THEN 1 ELSE 0 END) AS correction_sample_windows
      FROM bounded_windows b
      GROUP BY b.model_id
      ORDER BY events DESC, model_id ASC;

      DROP VIEW IF EXISTS v_thinking_model_scenarios;
      CREATE VIEW v_thinking_model_scenarios AS
      SELECT
        e.model_id AS model_id,
        CAST(j.value AS TEXT) AS scenario,
        COUNT(*) AS hits
      FROM thinking_model_events e
      JOIN json_each(
        CASE
          WHEN json_valid(e.scenario_json) THEN e.scenario_json
          ELSE '[]'
        END
      ) AS j
      GROUP BY e.model_id, CAST(j.value AS TEXT)
      ORDER BY hits DESC, scenario ASC;

      DROP VIEW IF EXISTS v_thinking_model_daily_trend;
      CREATE VIEW v_thinking_model_daily_trend AS
      SELECT
        substr(created_at, 1, 10) AS day,
        model_id,
        COUNT(*) AS hits
      FROM thinking_model_events
      GROUP BY substr(created_at, 1, 10), model_id
      ORDER BY day ASC, model_id ASC;
    `);
  }

  private withWrite<T>(fn: () => T): T {
    return withLock(this.dbPath, fn, { lockSuffix: '.trajectory.lock', lockStaleMs: 30000 });
  }
}
