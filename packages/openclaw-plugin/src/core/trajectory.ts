import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { withLock } from '../utils/file-lock.js';
import { resolvePdPath } from './paths.js';
import { SampleNotFoundError } from '../config/index.js';
import type {
  CorrectionSampleReviewStatus,
  CorrectionExportMode,
  TrajectoryDataStats,
  TrajectoryAssistantTurnInput,
  TrajectoryUserTurnInput,
  TrajectoryToolCallInput,
  TrajectoryPainEventInput,
  TrajectoryGateBlockInput,
  DailyMetricRow,
  TrajectoryTrustChangeInput,
  TrajectoryPrincipleEventInput,
  TrajectoryTaskOutcomeInput,
  TrajectorySessionInput,
  TaskKind,
  TaskPriority,
  EvolutionTaskInput,
  EvolutionEventInput,
  EvolutionTaskRecord,
  EvolutionEventRecord,
  EvolutionTaskFilters,
  AssistantTurnRecord,
  CorrectionSampleRecord,
  TrajectoryExportResult,
  TrajectoryDatabaseOptions,
} from './trajectory-types.js';

export type {
  CorrectionSampleReviewStatus,
  CorrectionExportMode,
  TrajectoryDataStats,
  TrajectoryAssistantTurnInput,
  TrajectoryUserTurnInput,
  TrajectoryToolCallInput,
  TrajectoryPainEventInput,
  TrajectoryGateBlockInput,
  DailyMetricRow,
  TrajectoryTrustChangeInput,
  TrajectoryPrincipleEventInput,
  TrajectoryTaskOutcomeInput,
  TrajectorySessionInput,
  TaskKind,
  TaskPriority,
  EvolutionTaskInput,
  EvolutionEventInput,
  EvolutionTaskRecord,
  EvolutionEventRecord,
  EvolutionTaskFilters,
  AssistantTurnRecord,
  CorrectionSampleRecord,
  TrajectoryExportResult,
  TrajectoryDatabaseOptions,
} from './trajectory-types.js';

/**
 * Trajectory database stores HISTORICAL and ANALYTICS data.
 *
 * PURPOSE: Track task outcomes, trust changes, and evolution progress over time.
 * USAGE: Insights, trends, and Phase 3 supporting evidence (where explicitly allowed).
 * NOT FOR: Control decisions, Phase 3 eligibility, or real-time operations.
 *
 * Runtime truth comes from: queue state, workspace trust scorecard, active sessions
 */

const DEFAULT_INLINE_THRESHOLD = 16 * 1024;
const DEFAULT_BUSY_TIMEOUT_MS = 5000;
const DEFAULT_ORPHAN_BLOB_GRACE_DAYS = 7;
const SCHEMA_VERSION = 1;

function nowIso(): string {
  return new Date().toISOString();
}

function safeJson(value: unknown): string {
  return JSON.stringify(value ?? {});
}

function fileSizeIfExists(filePath: string): number {
  try {
    return fs.existsSync(filePath) ? fs.statSync(filePath).size : 0;
  } catch {
    return 0;
  }
}

function summarizeForDiff(text: string): string {
  return text.length > 240 ? `${text.slice(0, 237)}...` : text;
}

function redactText(text: string): string {
  return text
    .replace(/[A-Za-z]:\\[^\s"'`]+/g, '<WINDOWS_PATH>')
    .replace(/\/[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)+/g, '<PATH>')
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '<EMAIL>')
    .replace(/\b(sk|rk|pk)_[A-Za-z0-9]+\b/g, '<TOKEN>');
}

export class TrajectoryDatabase {
  private readonly workspaceDir: string;
  private readonly stateDir: string;
  private readonly dbPath: string;
  private readonly blobDir: string;
  private readonly exportDir: string;
  private readonly blobInlineThresholdBytes: number;
  private readonly orphanBlobGraceMs: number;
  private readonly db: Database.Database;

  constructor(opts: TrajectoryDatabaseOptions) {
    this.workspaceDir = path.resolve(opts.workspaceDir);
    this.stateDir = resolvePdPath(this.workspaceDir, 'STATE_DIR');
    this.dbPath = resolvePdPath(this.workspaceDir, 'TRAJECTORY_DB');
    this.blobDir = resolvePdPath(this.workspaceDir, 'TRAJECTORY_BLOBS_DIR');
    this.exportDir = resolvePdPath(this.workspaceDir, 'EXPORTS_DIR');
    this.blobInlineThresholdBytes = opts.blobInlineThresholdBytes ?? DEFAULT_INLINE_THRESHOLD;
    this.orphanBlobGraceMs = Math.max(0, (opts.orphanBlobGraceDays ?? DEFAULT_ORPHAN_BLOB_GRACE_DAYS) * 24 * 60 * 60 * 1000);

    fs.mkdirSync(this.stateDir, { recursive: true });
    fs.mkdirSync(this.blobDir, { recursive: true });
    fs.mkdirSync(this.exportDir, { recursive: true });

    this.db = new Database(this.dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.db.pragma('synchronous = NORMAL');
    this.db.pragma(`busy_timeout = ${Math.max(0, opts.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS)}`);
    this.initSchema();
    this.importLegacyArtifacts();
    this.pruneUnreferencedBlobs();
  }

  dispose(): void {
    this.db.close();
  }

  recordSession(input: TrajectorySessionInput): void {
    const startedAt = input.startedAt ?? nowIso();
    this.withWrite(() => {
      this.db.prepare(`
        INSERT INTO sessions (session_id, started_at, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(session_id) DO UPDATE SET updated_at = excluded.updated_at
      `).run(input.sessionId, startedAt, nowIso());
    });
  }

  recordAssistantTurn(input: TrajectoryAssistantTurnInput): number {
    this.recordSession({ sessionId: input.sessionId, startedAt: input.createdAt });
    const rawStorage = this.storeRawText('assistant', input.rawText);
    const createdAt = input.createdAt ?? nowIso();

    return this.withWrite(() => {
      const result = this.db.prepare(`
        INSERT INTO assistant_turns (
          session_id, run_id, provider, model, raw_text, sanitized_text, usage_json,
          empathy_signal_json, blob_ref, raw_excerpt, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        input.sessionId,
        input.runId,
        input.provider,
        input.model,
        rawStorage.inlineText,
        input.sanitizedText,
        safeJson(input.usageJson),
        safeJson(input.empathySignalJson),
        rawStorage.blobRef,
        rawStorage.excerpt,
        createdAt,
      );
      return Number(result.lastInsertRowid);
    });
  }

  recordUserTurn(input: TrajectoryUserTurnInput): number {
    this.recordSession({ sessionId: input.sessionId, startedAt: input.createdAt });
    const rawStorage = this.storeRawText('user', input.rawText);
    const createdAt = input.createdAt ?? nowIso();
    return this.withWrite(() => {
      const result = this.db.prepare(`
        INSERT INTO user_turns (
          session_id, turn_index, raw_text, blob_ref, raw_excerpt,
          correction_detected, correction_cue, references_assistant_turn_id, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        input.sessionId,
        input.turnIndex,
        rawStorage.inlineText,
        rawStorage.blobRef,
        rawStorage.excerpt,
        input.correctionDetected ? 1 : 0,
        input.correctionCue ?? null,
        input.referencesAssistantTurnId ?? null,
        createdAt,
      );
      return Number(result.lastInsertRowid);
    });
  }

  recordToolCall(input: TrajectoryToolCallInput): number {
    this.recordSession({ sessionId: input.sessionId, startedAt: input.createdAt });
    const createdAt = input.createdAt ?? nowIso();
    // Extract filePath from paramsJson if provided and is an object with filePath
    const paramsObj = input.paramsJson as Record<string, unknown> | undefined;
    const _filePath = paramsObj && typeof paramsObj.filePath === 'string' ? paramsObj.filePath : null;
    const rowId = this.withWrite(() => {
      const result = this.db.prepare(`
        INSERT INTO tool_calls (
          session_id, tool_name, outcome, duration_ms, exit_code, error_type, error_message,
          gfi_before, gfi_after, params_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        input.sessionId,
        input.toolName,
        input.outcome,
        input.durationMs ?? null,
        input.exitCode ?? null,
        input.errorType ?? null,
        input.errorMessage ?? null,
        input.gfiBefore ?? null,
        input.gfiAfter ?? null,
        safeJson(input.paramsJson),
        createdAt,
      );
      return Number(result.lastInsertRowid);
    });

    if (input.outcome === 'success') {
      this.maybeCreateCorrectionSample(input.sessionId);
    }
    return rowId;
  }

  recordPainEvent(input: TrajectoryPainEventInput): void {
    this.recordSession({ sessionId: input.sessionId, startedAt: input.createdAt });
    this.withWrite(() => {
      this.db.prepare(`
        INSERT INTO pain_events (
          session_id, source, score, reason, severity, origin, confidence, text, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        input.sessionId,
        input.source,
        input.score,
        input.reason ?? null,
        input.severity ?? null,
        input.origin ?? null,
        input.confidence ?? null,
        input.text ?? null,
        input.createdAt ?? nowIso(),
      );

      // Maintain FTS5 index: insert text into pain_events_fts if text is provided (MEM-03, MEM-04)
      if (input.text) {
        const lastId = this.db.prepare('SELECT last_insert_rowid() as id').get() as { id: number };
        this.db.prepare(`
          INSERT INTO pain_events_fts (text, pain_event_id) VALUES (?, ?)
        `).run(input.text, lastId.id);
      }
    });
  }

  /**
   * Search pain_events using FTS5 full-text search (MEM-04).
   * Returns pain events matching the query, ordered by relevance.
   */
  searchPainEvents(query: string, limit = 10): {
    id: number;
    sessionId: string;
    source: string;
    score: number;
    reason: string | null;
    severity: string | null;
    origin: string | null;
    confidence: number | null;
    text: string | null;
    createdAt: string;
  }[] {
    if (!query || query.trim().length === 0) {
      return [];
    }

    // Escape FTS5 special characters and format query for porter tokenizer
    const ftsQuery = query.trim().split(/\s+/).map(term => `"${term.replace(/"/g, '""')}"`).join(' ');

    try {
      const results = this.db.prepare(`
        SELECT pe.*
        FROM pain_events_fts pf
        JOIN pain_events pe ON pe.id = pf.pain_event_id
        WHERE pain_events_fts MATCH ?
        ORDER BY bm25(pain_events_fts) DESC
        LIMIT ?
      `).all(ftsQuery, limit) as {
        id: number;
        session_id: string;
        source: string;
        score: number;
        reason: string | null;
        severity: string | null;
        origin: string | null;
        confidence: number | null;
        text: string | null;
        created_at: string;
      }[];

      return results.map(row => ({
        id: row.id,
        sessionId: row.session_id,
        source: row.source,
        score: row.score,
        reason: row.reason,
        severity: row.severity,
        origin: row.origin,
        confidence: row.confidence,
        text: row.text,
        createdAt: row.created_at,
      }));
    } catch (err) {
      // If FTS5 query fails (e.g., syntax error), return empty results
      console.warn(`[PD:TrajectoryDatabase] FTS5 search failed: ${String(err)}`);
      return [];
    }
  }

  recordGateBlock(input: TrajectoryGateBlockInput): void {
    this.withWrite(() => {
      this.db.prepare(`
        INSERT INTO gate_blocks (session_id, tool_name, file_path, reason, plan_status, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(
        input.sessionId ?? null,
        input.toolName,
        input.filePath ?? null,
        input.reason,
        input.planStatus ?? null,
        input.createdAt ?? nowIso(),
      );
    });
  }

  recordTrustChange(input: TrajectoryTrustChangeInput): void {
    this.withWrite(() => {
      this.db.prepare(`
        INSERT INTO trust_changes (session_id, previous_score, new_score, delta, reason, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(
        input.sessionId ?? null,
        input.previousScore,
        input.newScore,
        input.delta,
        input.reason,
        input.createdAt ?? nowIso(),
      );
    });
  }

  recordPrincipleEvent(input: TrajectoryPrincipleEventInput): void {
    this.withWrite(() => {
      this.db.prepare(`
        INSERT INTO principle_events (principle_id, event_type, payload_json, created_at)
        VALUES (?, ?, ?, ?)
      `).run(
        input.principleId ?? null,
        input.eventType,
        safeJson(input.payload),
        input.createdAt ?? nowIso(),
      );
    });
  }

  recordTaskOutcome(input: TrajectoryTaskOutcomeInput): void {
    this.withWrite(() => {
      this.db.prepare(`
        INSERT INTO task_outcomes (session_id, task_id, outcome, summary, principle_ids_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(
        input.sessionId,
        input.taskId ?? null,
        input.outcome,
        input.summary ?? null,
        safeJson(input.principleIdsJson),
        input.createdAt ?? nowIso(),
      );
    });
  }

  recordEvolutionTask(input: EvolutionTaskInput): void {
    const now = nowIso();
    // Cast to V2 to access new fields
    const v2 = input;
    this.withWrite(() => {
      this.db.prepare(`
        INSERT INTO evolution_tasks (
          task_id, trace_id, source, reason, score, status,
          enqueued_at, started_at, completed_at, resolution, created_at, updated_at,
          task_kind, priority, retry_count, max_retries, last_error, result_ref
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(task_id) DO UPDATE SET
          status = excluded.status,
          started_at = excluded.started_at,
          completed_at = excluded.completed_at,
          resolution = excluded.resolution,
          updated_at = excluded.updated_at,
          task_kind = excluded.task_kind,
          priority = excluded.priority,
          retry_count = excluded.retry_count,
          max_retries = excluded.max_retries,
          last_error = excluded.last_error,
          result_ref = excluded.result_ref
      `).run(
        input.taskId,
        input.traceId,
        input.source,
        input.reason ?? null,
        input.score ?? 0,
        input.status ?? 'pending',
        input.enqueuedAt ?? null,
        input.startedAt ?? null,
        input.completedAt ?? null,
        input.resolution ?? null,
        input.createdAt ?? now,
        input.updatedAt ?? now,
        v2.taskKind ?? null,
        v2.priority ?? null,
        v2.retryCount ?? null,
        v2.maxRetries ?? null,
        v2.lastError ?? null,
        v2.resultRef ?? null,
      );
    });
  }

  updateEvolutionTask(taskId: string, updates: Partial<Omit<EvolutionTaskInput, 'taskId' | 'traceId' | 'source'>>): void {
    const now = nowIso();
    // Cast to V2 to access new fields
    const v2Updates = updates;
    this.withWrite(() => {
      const setClauses: string[] = ['updated_at = ?'];
      const values: unknown[] = [now];

      if (updates.status !== undefined) {
        setClauses.push('status = ?');
        values.push(updates.status);
      }
      if (updates.startedAt !== undefined) {
        setClauses.push('started_at = ?');
        values.push(updates.startedAt);
      }
      if (updates.completedAt !== undefined) {
        setClauses.push('completed_at = ?');
        values.push(updates.completedAt);
      }
      if (updates.resolution !== undefined) {
        setClauses.push('resolution = ?');
        values.push(updates.resolution);
      }
      if (updates.score !== undefined) {
        setClauses.push('score = ?');
        values.push(updates.score);
      }
      // V2 fields
      if (v2Updates.taskKind !== undefined) {
        setClauses.push('task_kind = ?');
        values.push(v2Updates.taskKind);
      }
      if (v2Updates.priority !== undefined) {
        setClauses.push('priority = ?');
        values.push(v2Updates.priority);
      }
      if (v2Updates.retryCount !== undefined) {
        setClauses.push('retry_count = ?');
        values.push(v2Updates.retryCount);
      }
      if (v2Updates.maxRetries !== undefined) {
        setClauses.push('max_retries = ?');
        values.push(v2Updates.maxRetries);
      }
      if (v2Updates.lastError !== undefined) {
        setClauses.push('last_error = ?');
        values.push(v2Updates.lastError);
      }
      if (v2Updates.resultRef !== undefined) {
        setClauses.push('result_ref = ?');
        values.push(v2Updates.resultRef);
      }

      values.push(taskId);
      this.db.prepare(`
        UPDATE evolution_tasks SET ${setClauses.join(', ')} WHERE task_id = ?
      `).run(...values);
    });
  }

  recordEvolutionEvent(input: EvolutionEventInput): void {
    this.withWrite(() => {
      this.db.prepare(`
        INSERT INTO evolution_events (trace_id, task_id, stage, level, message, summary, metadata_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        input.traceId,
        input.taskId ?? null,
        input.stage,
        input.level ?? 'info',
        input.message,
        input.summary ?? null,
        safeJson(input.metadata),
        input.createdAt ?? nowIso(),
      );
    });
  }

  /**
   * List evolution tasks with optional filtering.
   *
   * Returns: Analytics data aggregated from trajectory database.
   * Not: Runtime truth or real-time queue state.
   */
  listEvolutionTasks(filters: EvolutionTaskFilters = {}): EvolutionTaskRecord[] {
    const conditions: string[] = [];
    const values: unknown[] = [];

    if (filters.status) {
      conditions.push('status = ?');
      values.push(filters.status);
    }
    if (filters.dateFrom) {
      conditions.push('created_at >= ?');
      values.push(filters.dateFrom);
    }
    if (filters.dateTo) {
      conditions.push('created_at <= ?');
      values.push(filters.dateTo);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const limit = filters.limit ?? 50;
    const offset = filters.offset ?? 0;

    const rows = this.db.prepare(`
      SELECT id, task_id, trace_id, source, reason, score, status,
             enqueued_at, started_at, completed_at, resolution, created_at, updated_at,
             task_kind, priority, retry_count, max_retries, last_error, result_ref
      FROM evolution_tasks
      ${whereClause}
      ORDER BY created_at DESC
      LIMIT ? OFFSET ?
    `).all(...values, limit, offset) as Record<string, unknown>[];

    return rows.map((row) => ({
      id: Number(row.id),
      taskId: String(row.task_id),
      traceId: String(row.trace_id),
      source: String(row.source),
      reason: row.reason ? String(row.reason) : null,
      score: Number(row.score ?? 0),
      status: String(row.status),
      enqueuedAt: row.enqueued_at ? String(row.enqueued_at) : null,
      startedAt: row.started_at ? String(row.started_at) : null,
      completedAt: row.completed_at ? String(row.completed_at) : null,
      resolution: row.resolution ? String(row.resolution) : null,
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
      taskKind: row.task_kind ? (row.task_kind as TaskKind) : null,
      priority: row.priority ? (row.priority as TaskPriority) : null,
      retryCount: row.retry_count != null ? Number(row.retry_count) : null,
      maxRetries: row.max_retries != null ? Number(row.max_retries) : null,
      lastError: row.last_error ? String(row.last_error) : null,
      resultRef: row.result_ref ? String(row.result_ref) : null,
    }));
  }

  /**
   * List evolution events for a trace or globally.
   *
   * Returns: Analytics data aggregated from trajectory database.
   * Not: Runtime truth or real-time queue state.
   */
  listEvolutionEvents(traceId?: string, filters: { limit?: number; offset?: number } = {}): EvolutionEventRecord[] {
    const limit = filters.limit ?? 100;
    const offset = filters.offset ?? 0;

    // eslint-disable-next-line @typescript-eslint/init-declarations -- assigned in both if/else branches
    let rows: Record<string, unknown>[];
    if (traceId) {
      rows = this.db.prepare(`
        SELECT id, trace_id, task_id, stage, level, message, summary, metadata_json, created_at
        FROM evolution_events
        WHERE trace_id = ?
        ORDER BY created_at ASC
        LIMIT ? OFFSET ?
      `).all(traceId, limit, offset) as Record<string, unknown>[];
    } else {
      rows = this.db.prepare(`
        SELECT id, trace_id, task_id, stage, level, message, summary, metadata_json, created_at
        FROM evolution_events
        ORDER BY created_at DESC
        LIMIT ? OFFSET ?
      `).all(limit, offset) as Record<string, unknown>[];
    }

    return rows.map((row) => ({
      id: Number(row.id),
      traceId: String(row.trace_id),
      taskId: row.task_id ? String(row.task_id) : null,
      stage: String(row.stage),
      level: String(row.level ?? 'info'),
      message: String(row.message),
      summary: row.summary ? String(row.summary) : null,
      metadata: JSON.parse(String(row.metadata_json ?? '{}')),
      createdAt: String(row.created_at),
    }));
  }

  /**
   * Get evolution task by trace ID.
   *
   * Returns: Analytics data aggregated from trajectory database.
   * Not: Runtime truth or real-time queue state.
   */
  getEvolutionTaskByTraceId(traceId: string): EvolutionTaskRecord | null {
    const row = this.db.prepare(`
      SELECT id, task_id, trace_id, source, reason, score, status,
             enqueued_at, started_at, completed_at, resolution, created_at, updated_at,
             task_kind, priority, retry_count, max_retries, last_error, result_ref
      FROM evolution_tasks
      WHERE trace_id = ?
      LIMIT 1
    `).get(traceId) as Record<string, unknown> | undefined;

    if (!row) return null;

    return {
      id: Number(row.id),
      taskId: String(row.task_id),
      traceId: String(row.trace_id),
      source: String(row.source),
      reason: row.reason ? String(row.reason) : null,
      score: Number(row.score ?? 0),
      status: String(row.status),
      enqueuedAt: row.enqueued_at ? String(row.enqueued_at) : null,
      startedAt: row.started_at ? String(row.started_at) : null,
      completedAt: row.completed_at ? String(row.completed_at) : null,
      resolution: row.resolution ? String(row.resolution) : null,
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
      taskKind: row.task_kind ? (row.task_kind as TaskKind) : null,
      priority: row.priority ? (row.priority as TaskPriority) : null,
      retryCount: row.retry_count != null ? Number(row.retry_count) : null,
      maxRetries: row.max_retries != null ? Number(row.max_retries) : null,
      lastError: row.last_error ? String(row.last_error) : null,
      resultRef: row.result_ref ? String(row.result_ref) : null,
    };
  }

  /**
   * Get evolution task statistics.
   *
   * Returns: Analytics data aggregated from trajectory database.
   * Not: Runtime truth or real-time queue state.
   */
  getEvolutionStats(): { total: number; pending: number; inProgress: number; completed: number; failed: number } {
    const rows = this.db.prepare(`
      SELECT status, COUNT(*) as count FROM evolution_tasks GROUP BY status
    `).all() as { status: string; count: number }[];

    const stats = { total: 0, pending: 0, inProgress: 0, completed: 0, failed: 0 };
    for (const row of rows) {
      stats.total += row.count;
      if (row.status === 'pending') stats.pending = row.count;
      else if (row.status === 'in_progress') stats.inProgress = row.count;
      else if (row.status === 'completed') stats.completed = row.count;
      else if (row.status === 'failed') stats.failed = row.count;
    }
    return stats;
  }

  /**
   * List recent sessions from the trajectory database.
   *
   * Returns: Recent session records ordered by most recently updated.
   *
   * @param options.limit - Maximum number of sessions to return (default: 20)
   * @param options.dateFrom - Only return sessions updated after this date
   * @param options.dateTo - Only return sessions updated before this date
   */
  listRecentSessions(options: { limit?: number; dateFrom?: string; dateTo?: string } = {}): { sessionId: string; startedAt: string; updatedAt: string }[] {
    const conditions: string[] = [];
    const values: unknown[] = [];

    if (options.dateFrom) {
      conditions.push('updated_at >= ?');
      values.push(options.dateFrom);
    }
    if (options.dateTo) {
      conditions.push('updated_at <= ?');
      values.push(options.dateTo);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const limit = options.limit ?? 20;

    const rows = this.db.prepare(`
      SELECT session_id, started_at, updated_at
      FROM sessions
      ${whereClause}
      ORDER BY updated_at DESC
      LIMIT ?
    `).all(...values, limit) as Record<string, unknown>[];

    return rows.map((row) => ({
      sessionId: String(row.session_id),
      startedAt: String(row.started_at),
      updatedAt: String(row.updated_at),
    }));
  }

  /**
   * List assistant turns for a session.
   *
   * Returns: Analytics data aggregated from trajectory database.
   * Not: Runtime truth or real-time queue state.
   */
  listAssistantTurns(sessionId: string): AssistantTurnRecord[] {
    const rows = this.db.prepare(`
      SELECT id, session_id, run_id, provider, model, raw_text, sanitized_text, blob_ref, created_at
      FROM assistant_turns
      WHERE session_id = ?
      ORDER BY id ASC
    `).all(sessionId) as Record<string, unknown>[];

    return rows.map((row) => ({
      id: Number(row.id),
      sessionId: String(row.session_id),
      runId: String(row.run_id),
      provider: String(row.provider),
      model: String(row.model),
      rawText: this.restoreRawText(row.raw_text as string | null, row.blob_ref as string | null),
      sanitizedText: String(row.sanitized_text ?? ''),
      blobRef: row.blob_ref ? String(row.blob_ref) : null,
      createdAt: String(row.created_at),
    }));
  }

  /**
   * List tool calls for a session.
   *
   * Returns: Analytics data aggregated from trajectory database.
   * Not: Runtime truth or real-time queue state.
   */
  listToolCallsForSession(sessionId: string): {
    id: number;
    toolName: string;
    outcome: string;
    filePath: string | null;
    durationMs: number | null;
    exitCode: number | null;
    errorType: string | null;
    errorMessage: string | null;
    gfiBefore: number | null;
    gfiAfter: number | null;
    createdAt: string;
  }[] {
    const rows = this.db.prepare(`
      SELECT id, tool_name, outcome, params_json, duration_ms, exit_code, error_type, error_message,
             gfi_before, gfi_after, created_at
      FROM tool_calls
      WHERE session_id = ?
      ORDER BY id ASC
    `).all(sessionId) as Record<string, unknown>[];

    return rows.map((row) => {
      // Extract filePath from params_json if present
      let filePath: string | null = null;
      if (row.params_json && typeof row.params_json === 'string') {
        try {
          const params = JSON.parse(row.params_json);
          if (params && typeof params.filePath === 'string') {
            // eslint-disable-next-line @typescript-eslint/prefer-destructuring -- Reason: filePath is a reassignable outer let variable - destructuring would lose the assignment semantics
            filePath = params.filePath;
          }
        } catch {
          // Ignore malformed JSON
        }
      }
      return {
        id: Number(row.id),
        toolName: String(row.tool_name),
        outcome: String(row.outcome),
        filePath,
        durationMs: row.duration_ms != null ? Number(row.duration_ms) : null,
        exitCode: row.exit_code != null ? Number(row.exit_code) : null,
        errorType: row.error_type ? String(row.error_type) : null,
        errorMessage: row.error_message ? String(row.error_message) : null,
        gfiBefore: row.gfi_before != null ? Number(row.gfi_before) : null,
        gfiAfter: row.gfi_after != null ? Number(row.gfi_after) : null,
        createdAt: String(row.created_at),
      };
    });
  }

  /**
   * List pain events for a session.
   *
   * Returns: Analytics data aggregated from trajectory database.
   * Not: Runtime truth or real-time queue state.
   */
  listPainEventsForSession(sessionId: string): {
    id: number;
    source: string;
    score: number;
    reason: string | null;
    severity: string | null;
    origin: string | null;
    confidence: number | null;
    createdAt: string;
  }[] {
    const rows = this.db.prepare(`
      SELECT id, source, score, reason, severity, origin, confidence, created_at
      FROM pain_events
      WHERE session_id = ?
      ORDER BY created_at ASC
    `).all(sessionId) as Record<string, unknown>[];

    return rows.map((row) => ({
      id: Number(row.id),
      source: String(row.source),
      score: Number(row.score),
      reason: row.reason ? String(row.reason) : null,
      severity: row.severity ? String(row.severity) : null,
      origin: row.origin ? String(row.origin) : null,
      confidence: row.confidence != null ? Number(row.confidence) : null,
      createdAt: String(row.created_at),
    }));
  }

  /**
   * List user turns for a session.
   * Returns sanitized/reduced fields for nocturnal use — NO raw text.
   */
  listUserTurnsForSession(sessionId: string): {
    id: number;
    turnIndex: number;
    correctionDetected: boolean;
    correctionCue: string | null;
    createdAt: string;
  }[] {
    const rows = this.db.prepare(`
      SELECT id, turn_index, correction_detected, correction_cue, created_at
      FROM user_turns
      WHERE session_id = ?
      ORDER BY turn_index ASC
    `).all(sessionId) as Record<string, unknown>[];

    return rows.map((row) => ({
      id: Number(row.id),
      turnIndex: Number(row.turn_index),
      correctionDetected: Boolean(row.correction_detected),
      correctionCue: row.correction_cue ? String(row.correction_cue) : null,
      createdAt: String(row.created_at),
    }));
  }

  /**
   * List correction samples with optional review status filter.
   *
   * Returns: Analytics data aggregated from trajectory database.
   * Not: Runtime truth or real-time queue state.
   */
  listCorrectionSamples(status: CorrectionSampleReviewStatus = 'pending'): CorrectionSampleRecord[] {
    const rows = this.db.prepare(`
      SELECT sample_id, session_id, bad_assistant_turn_id, user_correction_turn_id,
             recovery_tool_span_json, diff_excerpt, principle_ids_json, quality_score,
             review_status, export_mode, created_at, updated_at
      FROM correction_samples
      WHERE review_status = ?
      ORDER BY created_at DESC
    `).all(status) as Record<string, unknown>[];

    return rows.map((row) => ({
      sampleId: String(row.sample_id),
      sessionId: String(row.session_id),
      badAssistantTurnId: Number(row.bad_assistant_turn_id),
      userCorrectionTurnId: Number(row.user_correction_turn_id),
      recoveryToolSpanJson: String(row.recovery_tool_span_json),
      diffExcerpt: String(row.diff_excerpt ?? ''),
      principleIdsJson: String(row.principle_ids_json ?? '[]'),
      qualityScore: Number(row.quality_score),
      reviewStatus: row.review_status as CorrectionSampleReviewStatus,
      exportMode: row.export_mode as CorrectionExportMode,
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    }));
  }

  /**
   * List gate blocks for a session.
   * Returns minimal fields for nocturnal use — no raw text.
   */
  listGateBlocksForSession(sessionId: string): {
    id: number;
    toolName: string;
    filePath: string | null;
    reason: string;
    planStatus: string | null;
    createdAt: string;
  }[] {
    const rows = this.db.prepare(`
      SELECT id, tool_name, file_path, reason, plan_status, created_at
      FROM gate_blocks
      WHERE session_id = ?
      ORDER BY id ASC
    `).all(sessionId) as Record<string, unknown>[];

    return rows.map((row) => ({
      id: Number(row.id),
      toolName: String(row.tool_name),
      filePath: row.file_path ? String(row.file_path) : null,
      reason: String(row.reason),
      planStatus: row.plan_status ? String(row.plan_status) : null,
      createdAt: String(row.created_at),
    }));
  }

  reviewCorrectionSample(sampleId: string, status: Exclude<CorrectionSampleReviewStatus, 'pending'>, note?: string): CorrectionSampleRecord {
    const updatedAt = nowIso();
    const updated = this.withWrite(() => {
      const updateResult = this.db.prepare(`
        UPDATE correction_samples
        SET review_status = ?, updated_at = ?
        WHERE sample_id = ?
      `).run(status, updatedAt, sampleId);
      if (updateResult.changes === 0) {
        return false;
      }
      this.db.prepare(`
        INSERT INTO sample_reviews (sample_id, review_status, note, created_at)
        VALUES (?, ?, ?, ?)
      `).run(sampleId, status, note ?? null, updatedAt);
      return true;
    });
    if (!updated) {
      throw new SampleNotFoundError(sampleId);
    }

    const record = this.db.prepare(`
      SELECT sample_id, session_id, bad_assistant_turn_id, user_correction_turn_id,
             recovery_tool_span_json, diff_excerpt, principle_ids_json, quality_score,
             review_status, export_mode, created_at, updated_at
      FROM correction_samples
      WHERE sample_id = ?
    `).get(sampleId) as Record<string, unknown>;
    if (!record) {
      throw new SampleNotFoundError(`${sampleId} (after update)`);
    }

    return {
      sampleId: String(record.sample_id),
      sessionId: String(record.session_id),
      badAssistantTurnId: Number(record.bad_assistant_turn_id),
      userCorrectionTurnId: Number(record.user_correction_turn_id),
      recoveryToolSpanJson: String(record.recovery_tool_span_json),
      diffExcerpt: String(record.diff_excerpt ?? ''),
      principleIdsJson: String(record.principle_ids_json ?? '[]'),
      qualityScore: Number(record.quality_score),
      reviewStatus: record.review_status as CorrectionSampleReviewStatus,
      exportMode: record.export_mode as CorrectionExportMode,
      createdAt: String(record.created_at),
      updatedAt: String(record.updated_at),
    };
  }

  /**
   * Export correction samples to JSONL file.
   *
   * Returns: Analytics data aggregated from trajectory database.
   * Not: Runtime truth or real-time queue state.
   */
  exportCorrections(opts: { mode: CorrectionExportMode; approvedOnly: boolean }): TrajectoryExportResult {
    const rows = this.db.prepare(`
      SELECT cs.sample_id, cs.session_id, cs.recovery_tool_span_json, cs.diff_excerpt, cs.quality_score,
             at.raw_text AS assistant_raw_text, at.blob_ref AS assistant_blob_ref, at.sanitized_text,
             ut.raw_text AS user_raw_text, ut.blob_ref AS user_blob_ref, ut.correction_cue
      FROM correction_samples cs
      JOIN assistant_turns at ON at.id = cs.bad_assistant_turn_id
      JOIN user_turns ut ON ut.id = cs.user_correction_turn_id
      WHERE (? = 0 OR cs.review_status = 'approved')
      ORDER BY cs.created_at ASC
    `).all(opts.approvedOnly ? 1 : 0) as Record<string, unknown>[];

    const exportPath = path.join(this.exportDir, `corrections-${Date.now()}-${opts.mode}.jsonl`);
    const lines = rows.map((row) => {
      const assistantRaw = this.restoreRawText(row.assistant_raw_text as string | null, row.assistant_blob_ref as string | null);
      const userRaw = this.restoreRawText(row.user_raw_text as string | null, row.user_blob_ref as string | null);
      const assistantText = opts.mode === 'redacted' ? redactText(assistantRaw) : assistantRaw;
      const userText = opts.mode === 'redacted' ? redactText(userRaw) : userRaw;
      return JSON.stringify({
        sample_id: row.sample_id,
        session_id: row.session_id,
        instruction: userText,
        input_context: assistantText,
        bad_attempt_summary: String(row.diff_excerpt ?? ''),
        preferred_response: userText,
        labels: {
          correction_cue: row.correction_cue,
          quality_score: row.quality_score,
        },
        metadata: {
          mode: opts.mode,
          recovery_tool_span_json: row.recovery_tool_span_json,
        },
      });
    });

    fs.writeFileSync(exportPath, `${lines.join('\n')}${lines.length > 0 ? '\n' : ''}`, 'utf8');
    this.recordExportAudit('corrections', opts.mode, opts.approvedOnly, exportPath, rows.length);
    return { filePath: exportPath, count: rows.length, mode: opts.mode };
  }

  /**
   * Export analytics data to JSON file.
   *
   * Returns: Analytics data aggregated from trajectory database.
   * Not: Runtime truth or real-time queue state.
   */
  exportAnalytics(): TrajectoryExportResult {
    const payload = {
      generatedAt: nowIso(),
      stats: this.getDataStats(),
      dailyMetrics: this.dailyMetrics(),
      errorClusters: this.db.prepare('SELECT * FROM v_error_clusters').all(),
      principleEffectiveness: this.db.prepare('SELECT * FROM v_principle_effectiveness').all(),
      sampleQueue: this.db.prepare('SELECT * FROM v_sample_queue').all(),
    };
    const exportPath = path.join(this.exportDir, `analytics-${Date.now()}.json`);
    fs.writeFileSync(exportPath, JSON.stringify(payload, null, 2), 'utf8');
    this.recordExportAudit('analytics', 'raw', true, exportPath, Array.isArray(payload.dailyMetrics) ? payload.dailyMetrics.length : 0);
    return { filePath: exportPath, count: Array.isArray(payload.dailyMetrics) ? payload.dailyMetrics.length : 0 };
  }

  /**
   * Get trajectory database statistics.
   *
   * Returns: Analytics data aggregated from trajectory database.
   * Not: Runtime truth or real-time queue state.
   */
  getDataStats(): TrajectoryDataStats {
    const getCount = (table: string, where?: string) => {
      const sql = where ? `SELECT COUNT(*) as count FROM ${table} WHERE ${where}` : `SELECT COUNT(*) as count FROM ${table}`;
      return Number((this.db.prepare(sql).get() as { count: number }).count);
    };
    const lastIngest = this.db.prepare(`
      SELECT MAX(ts) AS ts FROM (
        SELECT MAX(created_at) AS ts FROM assistant_turns
        UNION ALL SELECT MAX(created_at) AS ts FROM user_turns
        UNION ALL SELECT MAX(created_at) AS ts FROM tool_calls
        UNION ALL SELECT MAX(created_at) AS ts FROM pain_events
      )
    `).get() as { ts: string | null };
    return {
      dbPath: this.dbPath,
      dbSizeBytes: fileSizeIfExists(this.dbPath),
      assistantTurns: getCount('assistant_turns'),
      userTurns: getCount('user_turns'),
      toolCalls: getCount('tool_calls'),
      painEvents: getCount('pain_events'),
      pendingSamples: getCount('correction_samples', `review_status = 'pending'`),
      approvedSamples: getCount('correction_samples', `review_status = 'approved'`),
      blobBytes: this.computeBlobBytes(),
      lastIngestAt: lastIngest.ts ?? null,
    };
  }

  cleanupBlobStorage(): { removedFiles: number; reclaimedBytes: number } {
    return this.pruneUnreferencedBlobs();
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS ingest_checkpoint (
        source_key TEXT PRIMARY KEY,
        imported_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS sessions (
        session_id TEXT PRIMARY KEY,
        started_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS assistant_turns (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        raw_text TEXT,
        sanitized_text TEXT NOT NULL,
        usage_json TEXT NOT NULL,
        empathy_signal_json TEXT NOT NULL,
        blob_ref TEXT,
        raw_excerpt TEXT,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS user_turns (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        turn_index INTEGER NOT NULL,
        raw_text TEXT,
        blob_ref TEXT,
        raw_excerpt TEXT,
        correction_detected INTEGER NOT NULL DEFAULT 0,
        correction_cue TEXT,
        references_assistant_turn_id INTEGER,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS tool_calls (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        tool_name TEXT NOT NULL,
        outcome TEXT NOT NULL,
        duration_ms INTEGER,
        exit_code INTEGER,
        error_type TEXT,
        error_message TEXT,
        gfi_before REAL,
        gfi_after REAL,
        params_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS pain_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        source TEXT NOT NULL,
        score REAL NOT NULL,
        reason TEXT,
        severity TEXT,
        origin TEXT,
        confidence REAL,
        text TEXT,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS gate_blocks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT,
        tool_name TEXT NOT NULL,
        file_path TEXT,
        reason TEXT NOT NULL,
        plan_status TEXT,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS trust_changes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT,
        previous_score REAL NOT NULL,
        new_score REAL NOT NULL,
        delta REAL NOT NULL,
        reason TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS principle_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        principle_id TEXT,
        event_type TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS task_outcomes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        task_id TEXT,
        outcome TEXT NOT NULL,
        summary TEXT,
        principle_ids_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS correction_samples (
        sample_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        bad_assistant_turn_id INTEGER NOT NULL,
        user_correction_turn_id INTEGER NOT NULL,
        recovery_tool_span_json TEXT NOT NULL,
        diff_excerpt TEXT NOT NULL,
        principle_ids_json TEXT NOT NULL,
        quality_score REAL NOT NULL,
        review_status TEXT NOT NULL,
        export_mode TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS sample_reviews (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        sample_id TEXT NOT NULL,
        review_status TEXT NOT NULL,
        note TEXT,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS exports_audit (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        export_kind TEXT NOT NULL,
        mode TEXT NOT NULL,
        approved_only INTEGER NOT NULL,
        file_path TEXT NOT NULL,
        row_count INTEGER NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS evolution_tasks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT UNIQUE NOT NULL,
        trace_id TEXT NOT NULL,
        source TEXT NOT NULL,
        reason TEXT,
        score INTEGER DEFAULT 0,
        status TEXT DEFAULT 'pending',
        enqueued_at TEXT,
        started_at TEXT,
        completed_at TEXT,
        resolution TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS evolution_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        trace_id TEXT NOT NULL,
        task_id TEXT,
        stage TEXT NOT NULL,
        level TEXT DEFAULT 'info',
        message TEXT NOT NULL,
        summary TEXT,
        metadata_json TEXT,
        created_at TEXT NOT NULL
      );
    `);

    // Migration: Add text column to pain_events if it doesn't exist (MEM-01)
    // SQLite doesn't support IF NOT EXISTS for ADD COLUMN, so we use try/catch
    try {
      this.db.exec(`ALTER TABLE pain_events ADD COLUMN text TEXT`);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      if (!message.includes('duplicate column name') && !message.includes('no column named')) {
        // Re-throw unexpected errors — silently swallowing migration failures is dangerous
        throw err;
      }
    }

    // Create FTS5 virtual table for pain_events text search (MEM-04)
    this.db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS pain_events_fts USING fts5(
        text,
        pain_event_id UNINDEXED,
        tokenize='porter unicode61'
      )
    `);

    // V2 migration: Add V2 columns to evolution_tasks if they don't exist
    // SQLite does not support IF NOT EXISTS for ADD COLUMN, so we must check manually
    // before each ALTER to avoid "duplicate column name" errors on existing DBs
    const v2Columns = [
      { name: 'task_kind', type: 'TEXT' },
      { name: 'priority', type: 'TEXT' },
      { name: 'retry_count', type: 'INTEGER' },
      { name: 'max_retries', type: 'INTEGER' },
      { name: 'last_error', type: 'TEXT' },
      { name: 'result_ref', type: 'TEXT' },
    ];
    for (const col of v2Columns) {
      const exists = this.db.prepare(`PRAGMA table_info(evolution_tasks)`).all()
        .some((row: Record<string, unknown>) => row.name === col.name);
      if (!exists) {
        this.db.exec(`ALTER TABLE evolution_tasks ADD COLUMN ${col.name} ${col.type}`);
      }
    }

    this.db.exec(`
      CREATE VIEW IF NOT EXISTS v_error_clusters AS
      SELECT tool_name, COALESCE(error_type, 'unknown') AS error_type, COUNT(*) AS occurrences
      FROM tool_calls
      WHERE outcome = 'failure'
      GROUP BY tool_name, COALESCE(error_type, 'unknown')
      ORDER BY occurrences DESC;
      CREATE VIEW IF NOT EXISTS v_principle_effectiveness AS
      SELECT event_type, COUNT(*) AS total
      FROM principle_events
      GROUP BY event_type
      ORDER BY total DESC;
      CREATE VIEW IF NOT EXISTS v_sample_queue AS
      SELECT review_status, COUNT(*) AS total
      FROM correction_samples
      GROUP BY review_status;
      CREATE INDEX IF NOT EXISTS idx_assistant_turns_session_id ON assistant_turns(session_id);
      CREATE INDEX IF NOT EXISTS idx_assistant_turns_created_at ON assistant_turns(created_at);
      CREATE INDEX IF NOT EXISTS idx_assistant_turns_provider_model ON assistant_turns(provider, model);
      CREATE INDEX IF NOT EXISTS idx_user_turns_session_id ON user_turns(session_id);
      CREATE INDEX IF NOT EXISTS idx_tool_calls_session_id ON tool_calls(session_id);
      CREATE INDEX IF NOT EXISTS idx_tool_calls_created_at ON tool_calls(created_at);
      CREATE INDEX IF NOT EXISTS idx_pain_events_session_id ON pain_events(session_id);
      CREATE INDEX IF NOT EXISTS idx_correction_samples_review_status ON correction_samples(review_status);
      CREATE INDEX IF NOT EXISTS idx_evolution_tasks_trace_id ON evolution_tasks(trace_id);
      CREATE INDEX IF NOT EXISTS idx_evolution_tasks_status ON evolution_tasks(status);
      CREATE INDEX IF NOT EXISTS idx_evolution_tasks_created_at ON evolution_tasks(created_at);
      CREATE INDEX IF NOT EXISTS idx_evolution_events_trace_id ON evolution_events(trace_id);
      CREATE INDEX IF NOT EXISTS idx_evolution_events_created_at ON evolution_events(created_at);
    `);

    const row = this.db.prepare('SELECT version FROM schema_version LIMIT 1').get() as { version?: number } | undefined;
    this.migrateSchema(row?.version);
    if (!row) {
      this.db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(SCHEMA_VERSION);
    } else if (row.version !== SCHEMA_VERSION) {
      this.db.prepare('UPDATE schema_version SET version = ?').run(SCHEMA_VERSION);
    }
  }

  private importLegacyArtifacts(): void {
    this.importLegacySessions();
    this.importLegacyEvents();
    this.importLegacyEvolution();
  }

  private migrateSchema(_fromVersion?: number): void {
    this.db.exec(`
      DROP VIEW IF EXISTS v_daily_metrics;
      CREATE VIEW IF NOT EXISTS v_daily_metrics AS
      WITH tool_daily AS (
        SELECT
          substr(created_at, 1, 10) AS day,
          COUNT(*) AS tool_calls,
          SUM(CASE WHEN outcome = 'failure' THEN 1 ELSE 0 END) AS failures
        FROM tool_calls
        GROUP BY substr(created_at, 1, 10)
      ),
      correction_daily AS (
        SELECT
          substr(created_at, 1, 10) AS day,
          SUM(CASE WHEN correction_detected = 1 THEN 1 ELSE 0 END) AS user_corrections
        FROM user_turns
        GROUP BY substr(created_at, 1, 10)
      )
      SELECT
        tool_daily.day AS day,
        tool_daily.tool_calls AS tool_calls,
        tool_daily.failures AS failures,
        COALESCE(correction_daily.user_corrections, 0) AS user_corrections
      FROM tool_daily
      LEFT JOIN correction_daily ON correction_daily.day = tool_daily.day;
    `);
  }

  /**
   * Get daily metrics for analytics.
   *
   * Returns: Analytics data aggregated from trajectory database.
   * Not: Runtime truth or real-time queue state.
   */
  private dailyMetrics(): DailyMetricRow[] {
    return this.db.prepare('SELECT * FROM v_daily_metrics ORDER BY day ASC').all() as DailyMetricRow[];
  }

  private importLegacySessions(): void {
    const key = 'legacy:sessions';
    if (this.isImported(key)) return;
    const sessionDir = resolvePdPath(this.workspaceDir, 'SESSION_DIR');
    if (!fs.existsSync(sessionDir)) return;
    for (const file of fs.readdirSync(sessionDir).filter((entry) => entry.endsWith('.json'))) {
      try {
        const content = JSON.parse(fs.readFileSync(path.join(sessionDir, file), 'utf8')) as { sessionId?: string; lastActivityAt?: number };
        if (content.sessionId) {
          const startedAt = typeof content.lastActivityAt === 'number'
            ? new Date(content.lastActivityAt).toISOString()
            : nowIso();
          this.recordSession({ sessionId: content.sessionId, startedAt });
        }
      } catch {
        // Ignore malformed legacy sessions.
      }
    }
    this.markImported(key);
  }

  private importLegacyEvents(): void {
    const key = 'legacy:events';
    if (this.isImported(key)) return;
    const eventsPath = path.join(this.stateDir, 'logs', 'events.jsonl');
    if (!fs.existsSync(eventsPath)) return;
    const raw = fs.readFileSync(eventsPath, 'utf8').trim();
    if (!raw) {
      this.markImported(key);
      return;
    }
    for (const line of raw.split('\n')) {
      try {
        const event = JSON.parse(line) as { type?: string; sessionId?: string; data?: Record<string, unknown>; ts?: string };
        if (event.type === 'pain_signal' && event.sessionId) {
          this.recordPainEvent({
            sessionId: event.sessionId,
            source: String(event.data?.source ?? 'legacy'),
            score: Number(event.data?.score ?? 0),
            reason: typeof event.data?.reason === 'string' ? event.data.reason : null,
            severity: typeof event.data?.severity === 'string' ? event.data.severity : null,
            origin: typeof event.data?.origin === 'string' ? event.data.origin : null,
            confidence: typeof event.data?.confidence === 'number' ? event.data.confidence : null,
            createdAt: event.ts,
          });
        }
        if (event.type === 'trust_change') {
          this.recordTrustChange({
            sessionId: event.sessionId,
            previousScore: Number(event.data?.previousScore ?? 0),
            newScore: Number(event.data?.newScore ?? 0),
            delta: Number(event.data?.delta ?? 0),
            reason: String(event.data?.reason ?? 'legacy'),
            createdAt: event.ts,
          });
        }
        if (event.type === 'gate_block') {
          this.recordGateBlock({
            sessionId: event.sessionId,
            toolName: String(event.data?.toolName ?? 'unknown'),
            filePath: typeof event.data?.filePath === 'string' ? event.data.filePath : null,
            reason: String(event.data?.reason ?? 'legacy'),
            planStatus: typeof event.data?.planStatus === 'string' ? event.data.planStatus : null,
            createdAt: event.ts,
          });
        }
      } catch {
        // Ignore malformed legacy events.
      }
    }
    this.markImported(key);
  }

  private importLegacyEvolution(): void {
    const key = 'legacy:evolution';
    if (this.isImported(key)) return;
    const evolutionPath = resolvePdPath(this.workspaceDir, 'EVOLUTION_STREAM');
    if (!fs.existsSync(evolutionPath)) return;
    const raw = fs.readFileSync(evolutionPath, 'utf8').trim();
    if (!raw) {
      this.markImported(key);
      return;
    }
    for (const line of raw.split('\n')) {
      try {
        const event = JSON.parse(line) as { type?: string; data?: Record<string, unknown>; ts?: string };
        this.recordPrincipleEvent({
          principleId: typeof event.data?.principleId === 'string' ? event.data.principleId : null,
          eventType: String(event.type ?? 'legacy'),
          payload: event.data ?? {},
          createdAt: event.ts,
        });
      } catch {
        // Ignore malformed legacy evolution events.
      }
    }
    this.markImported(key);
  }

  private markImported(sourceKey: string): void {
    this.withWrite(() => {
      this.db.prepare(`
        INSERT INTO ingest_checkpoint (source_key, imported_at)
        VALUES (?, ?)
        ON CONFLICT(source_key) DO UPDATE SET imported_at = excluded.imported_at
      `).run(sourceKey, nowIso());
    });
  }

  private isImported(sourceKey: string): boolean {
    const row = this.db.prepare('SELECT source_key FROM ingest_checkpoint WHERE source_key = ?').get(sourceKey);
    return Boolean(row);
  }

  private maybeCreateCorrectionSample(sessionId: string): void {
    const pending = this.db.prepare(`
      SELECT sample_id FROM correction_samples
      WHERE session_id = ? AND review_status = 'pending'
      ORDER BY created_at DESC
      LIMIT 1
    `).get(sessionId) as { sample_id?: string } | undefined;
    if (pending?.sample_id) return;

    const correctionTurn = this.db.prepare(`
      SELECT id, references_assistant_turn_id, correction_cue, raw_text, blob_ref
      FROM user_turns
      WHERE session_id = ? AND correction_detected = 1
      ORDER BY id DESC
      LIMIT 1
    `).get(sessionId) as Record<string, unknown> | undefined;
    if (!correctionTurn || !correctionTurn.references_assistant_turn_id) return;

    const failedCall = this.db.prepare(`
      SELECT id, tool_name, error_type, error_message
      FROM tool_calls
      WHERE session_id = ? AND outcome = 'failure'
      ORDER BY id DESC
      LIMIT 1
    `).get(sessionId) as Record<string, unknown> | undefined;
    if (!failedCall) return;

    const successfulCalls = this.db.prepare(`
      SELECT id, tool_name
      FROM tool_calls
      WHERE session_id = ? AND outcome = 'success'
      ORDER BY id DESC
      LIMIT 3
    `).all(sessionId) as Record<string, unknown>[];
    if (successfulCalls.length === 0) return;

    const sampleId = `sample_${crypto.createHash('md5').update(`${sessionId}:${correctionTurn.id}:${successfulCalls[0].id}`).digest('hex').slice(0, 12)}`;
    const userRawText = this.restoreRawText(correctionTurn.raw_text as string | null, correctionTurn.blob_ref as string | null);
    const qualityScore = [
      correctionTurn.references_assistant_turn_id ? 35 : 0,
      correctionTurn.correction_cue ? 20 : 0,
      failedCall ? 20 : 0,
      successfulCalls.length > 0 ? 25 : 0,
    ].reduce((sum, value) => sum + value, 0);

    this.withWrite(() => {
      this.db.prepare(`
        INSERT OR IGNORE INTO correction_samples (
          sample_id, session_id, bad_assistant_turn_id, user_correction_turn_id,
          recovery_tool_span_json, diff_excerpt, principle_ids_json, quality_score,
          review_status, export_mode, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', 'raw', ?, ?)
      `).run(
        sampleId,
        sessionId,
        Number(correctionTurn.references_assistant_turn_id),
        Number(correctionTurn.id),
        safeJson(successfulCalls.map((call) => ({ id: call.id, toolName: call.tool_name }))),
        summarizeForDiff(userRawText || String(failedCall.error_message ?? failedCall.error_type ?? failedCall.tool_name)),
        '[]',
        qualityScore,
        nowIso(),
        nowIso(),
      );
    });
  }

  private recordExportAudit(
    exportKind: string,
    mode: CorrectionExportMode,
    approvedOnly: boolean,
    filePath: string,
    rowCount: number,
  ): void {
    this.withWrite(() => {
      this.db.prepare(`
        INSERT INTO exports_audit (export_kind, mode, approved_only, file_path, row_count, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(exportKind, mode, approvedOnly ? 1 : 0, filePath, rowCount, nowIso());
    });
  }

  private storeRawText(kind: 'assistant' | 'user', text: string): { inlineText: string | null; blobRef: string | null; excerpt: string } {
    const excerpt = text.length > 200 ? `${text.slice(0, 197)}...` : text;
    const bytes = Buffer.byteLength(text, 'utf8');
    if (bytes <= this.blobInlineThresholdBytes) {
      return { inlineText: text, blobRef: null, excerpt };
    }
    const hash = crypto.createHash('sha256').update(text).digest('hex');
    const relativePath = `${kind}-${hash}.txt`;
    const fullPath = path.join(this.blobDir, relativePath);
    if (!fs.existsSync(fullPath)) {
      fs.writeFileSync(fullPath, text, 'utf8');
    }
    return { inlineText: null, blobRef: relativePath, excerpt };
  }

  private restoreRawText(inlineText: string | null, blobRef: string | null): string {
    if (inlineText) return inlineText;
    if (!blobRef) return '';
    const fullPath = path.join(this.blobDir, blobRef);
    return fs.existsSync(fullPath) ? fs.readFileSync(fullPath, 'utf8') : '';
  }

  private computeBlobBytes(): number {
    if (!fs.existsSync(this.blobDir)) return 0;
    return fs.readdirSync(this.blobDir).reduce((sum, file) => sum + fileSizeIfExists(path.join(this.blobDir, file)), 0);
  }

  private pruneUnreferencedBlobs(): { removedFiles: number; reclaimedBytes: number } {
    if (!fs.existsSync(this.blobDir)) {
      return { removedFiles: 0, reclaimedBytes: 0 };
    }

    const referenced = new Set<string>();
    const rows = this.db.prepare(`
      SELECT blob_ref FROM assistant_turns WHERE blob_ref IS NOT NULL
      UNION
      SELECT blob_ref FROM user_turns WHERE blob_ref IS NOT NULL
    `).all() as { blob_ref?: string | null }[];
    for (const row of rows) {
      if (row.blob_ref) referenced.add(String(row.blob_ref));
    }

    const now = Date.now();
    let removedFiles = 0;
    let reclaimedBytes = 0;

    for (const entry of fs.readdirSync(this.blobDir)) {
      if (referenced.has(entry)) continue;
      const fullPath = path.join(this.blobDir, entry);
      // eslint-disable-next-line @typescript-eslint/init-declarations -- assigned in try, catch continues
      let stat: fs.Stats;
      try {
        stat = fs.statSync(fullPath);
      } catch {
        continue;
      }
      if (!stat.isFile()) continue;
      if (this.orphanBlobGraceMs > 0 && now - stat.mtimeMs < this.orphanBlobGraceMs) continue;
      reclaimedBytes += stat.size;
      removedFiles += 1;
      fs.rmSync(fullPath, { force: true });
    }

    return { removedFiles, reclaimedBytes };
  }

  private withWrite<T>(fn: () => T): T {
    return withLock(this.dbPath, fn, { lockSuffix: '.trajectory.lock', lockStaleMs: 30000 });
  }
}

export class TrajectoryRegistry {
  private static readonly instances = new Map<string, TrajectoryDatabase>();

  static get(workspaceDir: string, opts: Omit<TrajectoryDatabaseOptions, 'workspaceDir'> = {}): TrajectoryDatabase {
    const normalized = path.resolve(workspaceDir);
    const existing = this.instances.get(normalized);
    if (existing) return existing;
    const created = new TrajectoryDatabase({ workspaceDir: normalized, ...opts });
    this.instances.set(normalized, created);
    return created;
  }

  static dispose(workspaceDir: string): void {
    const normalized = path.resolve(workspaceDir);
    const instance = this.instances.get(normalized);
    if (instance) {
      instance.dispose();
      this.instances.delete(normalized);
    }
  }

  static clear(): void {
    for (const instance of this.instances.values()) {
      instance.dispose();
    }
    this.instances.clear();
  }

  static use<T>(workspaceDir: string, fn: (db: TrajectoryDatabase) => T, opts: Omit<TrajectoryDatabaseOptions, 'workspaceDir'> = {}): T {
    const normalized = path.resolve(workspaceDir);
    const existing = this.instances.get(normalized);
    if (existing) {
      return fn(existing);
    }

    const transient = new TrajectoryDatabase({ workspaceDir: normalized, ...opts });
    try {
      return fn(transient);
    } finally {
      transient.dispose();
    }
  }
}
