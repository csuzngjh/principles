/**
 * Pain signal observability for Runtime v2 entry points.
 *
 * Design intent (PRI-453): This writer serves paths that do NOT have legacy
 * event-log writers — specifically `pd pain record` CLI,
 * `gate-block-helper.ts`, and `lifecycle.ts`. Hook paths that already write
 * via legacy `recordPainSignal` + `recordPainEvent` pass
 * `recordObservability: false` to avoid triple-write.
 *
 * `gate-block-helper.ts` has a legacy `recordGateBlock` call but no legacy
 * `recordPainSignal` or `recordPainEvent` for pain events — it relies on
 * this SDK writer for all pain observability (events_*.jsonl + evolution.jsonl
 * + trajectory.db with canonicalPainId).
 *
 * `pd pain record` does not have a WorkspaceContext, so it uses this small
 * core writer to avoid an observability gap while keeping `evolution_tasks`
 * legacy queue disabled.
 */
import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as nodePath from 'path';
import type { PainDetectedData } from './pain-signal-bridge.js';
import { sanitizeString } from './evidence-sanitizer.js';

export interface PainSignalObservabilityResult {
  eventLogPath?: string;
  evolutionStreamPath?: string;
  trajectoryPainEventId?: number;
  warnings: string[];
}

export interface RecordPainSignalObservabilityOptions {
  workspaceDir: string;
  stateDir: string;
  data: PainDetectedData;
  /** PRI-406: Canonical pain identity to write into pain_events.canonical_pain_id. */
  canonicalPainId?: string;
  /** PRI-406: Runtime V2 task ID to write into pain_events.runtime_task_id. */
  runtimeTaskId?: string;
}

function nowIso(): string {
  return new Date().toISOString();
}

function todayUtc(ts: string): string {
  return ts.slice(0, 10);
}

function severityFromScore(score: number): 'mild' | 'moderate' | 'severe' {
  if (score >= 70) return 'severe';
  if (score >= 40) return 'moderate';
  return 'mild';
}

function appendJsonLine(filePath: string, value: unknown): void {
  fs.mkdirSync(nodePath.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, `${JSON.stringify(value)}\n`, 'utf8');
}

function getSessionsColumns(db: Database.Database): string[] {
  const cols = db.prepare('PRAGMA table_info(sessions)').all() as { name: string }[];
  return cols.map((c) => c.name);
}

/**
 * Type guard: narrows `object` to `{ name: unknown }` without `as` casts.
 * Used for PRAGMA table_info rows (rc-2-no-as-bypass).
 */
function hasNameField(row: object): row is { name: unknown } {
  return Object.hasOwn(row, 'name');
}

/**
 * Ensure trajectory.db has the full schema (all 16 tables + indexes + migrations).
 *
 * This mirrors packages/openclaw-plugin/src/core/trajectory.ts applyTrajectorySchema()
 * to fix the fragmented initialization where `pd pain record` only created 2 tables
 * (pain_events + sessions), leaving the other 14 missing.
 *
 * Schema MUST stay in sync with applyTrajectorySchema() in
 * packages/openclaw-plugin/src/core/trajectory.ts. core cannot import plugin schema
 * (dependency direction), so DDL is duplicated intentionally. When adding/migrating a
 * table in applyTrajectorySchema(), update this function too.
 *
 * Views are intentionally NOT created here — the Thinking Activity analytics
 * views were retired (2026-08-19) along with their writer, and no reader
 * needs them on the pain record path.
 */
function ensureTrajectorySchema(db: Database.Database): { tables: string[]; warnings: string[] } {
  const warnings: string[] = [];
  const tables = [
    'schema_version', 'ingest_checkpoint', 'sessions', 'assistant_turns',
    'user_turns', 'tool_calls', 'pain_events', 'gate_blocks', 'trust_changes',
    'principle_events', 'task_outcomes', 'correction_samples', 'sample_reviews',
    'exports_audit', 'evolution_tasks', 'evolution_events',
  ];

  db.exec(`
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
      stop_reason TEXT,
      thinking_blocks_count INTEGER,
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
      result_preview TEXT,
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
      canonical_pain_id TEXT,
      runtime_task_id TEXT,
      host_kind TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS gate_blocks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT,
      tool_name TEXT NOT NULL,
      file_path TEXT,
      reason TEXT NOT NULL,
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
      task_kind TEXT,
      priority TEXT,
      retry_count INTEGER,
      max_retries INTEGER,
      last_error TEXT,
      result_ref TEXT,
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
    db.exec(`ALTER TABLE pain_events ADD COLUMN text TEXT`);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    if (!message.includes('duplicate column name') && !message.includes('no column named')) {
      // Re-throw unexpected errors — silently swallowing migration failures is dangerous
      throw err;
    }
  }

  // PRI-406: Add canonical_pain_id and runtime_task_id columns to pain_events
  for (const col of [
    { name: 'canonical_pain_id', type: 'TEXT' },
    { name: 'runtime_task_id', type: 'TEXT' },
    // PRI-640: host attribution — observability metadata only, orthogonal to
    // `origin` (evidence semantics) and excluded from canonical pain identity.
    { name: 'host_kind', type: 'TEXT' },
  ]) {
    try {
      db.exec(`ALTER TABLE pain_events ADD COLUMN ${col.name} ${col.type}`);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      if (!message.includes('duplicate column name') && !message.includes('no column named')) {
        throw err;
      }
    }
  }

  // Trajectory enhancement: add stop_reason, thinking_blocks_count, result_preview
  const trajectoryEnhancementColumns = [
    { table: 'assistant_turns', name: 'stop_reason', type: 'TEXT' },
    { table: 'assistant_turns', name: 'thinking_blocks_count', type: 'INTEGER' },
    { table: 'tool_calls', name: 'result_preview', type: 'TEXT' },
  ];
  for (const col of trajectoryEnhancementColumns) {
    try {
      db.exec(`ALTER TABLE ${col.table} ADD COLUMN ${col.name} ${col.type}`);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      if (!message.includes('duplicate column name') && !message.includes('no column named')) {
        throw err;
      }
    }
  }

  // PRI-406: Partial unique index on canonical_pain_id (non-null only) for dedup
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_pain_events_canonical_pain_id
    ON pain_events(canonical_pain_id)
    WHERE canonical_pain_id IS NOT NULL
  `);

  // V2 migration: Add V2 columns to evolution_tasks if they don't exist
  const v2Columns = [
    { name: 'task_kind', type: 'TEXT' },
    { name: 'priority', type: 'TEXT' },
    { name: 'retry_count', type: 'INTEGER' },
    { name: 'max_retries', type: 'INTEGER' },
    { name: 'last_error', type: 'TEXT' },
    { name: 'result_ref', type: 'TEXT' },
  ];
  for (const col of v2Columns) {
    const exists = db.prepare(`PRAGMA table_info(evolution_tasks)`).all()
      .some((row): boolean => {
        if (typeof row !== 'object' || row === null) return false;
        // Use type guard predicate to narrow without `as` (rc-2-no-as-bypass)
        return hasNameField(row) && row.name === col.name;
      });
    if (!exists) {
      db.exec(`ALTER TABLE evolution_tasks ADD COLUMN ${col.name} ${col.type}`);
    }
  }

  // Indexes (views intentionally omitted — not needed by pain record path)
  db.exec(`
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

  return { tables, warnings };
}

interface TrajectoryRecordOptions {
  stateDir: string;
  data: PainDetectedData;
  timestamp: string;
  workspaceDir?: string;
  /** PRI-406: Canonical pain identity to write into pain_events.canonical_pain_id. */
  canonicalPainId?: string;
  /** PRI-406: Runtime V2 task ID to write into pain_events.runtime_task_id. */
  runtimeTaskId?: string;
}

/** PRI-640: id of the pain_events row (undefined when the dedup row could not be re-read); warnings carry host_kind conflict evidence. */
function recordTrajectoryPainEvent(opts: TrajectoryRecordOptions): { id?: number; warnings: string[] } {
  const { stateDir, data, timestamp, workspaceDir, canonicalPainId, runtimeTaskId } = opts;
  const dbPath = nodePath.join(stateDir, 'trajectory.db');
  fs.mkdirSync(nodePath.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  try {
    ensureTrajectorySchema(db);

    const sessionId = data.sessionId ?? 'cli';
    const sessionColumns = getSessionsColumns(db);
    const hasMetadataJson = sessionColumns.includes('metadata_json');

    if (hasMetadataJson) {
      db.prepare(`
        INSERT INTO sessions (session_id, started_at, updated_at, metadata_json)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(session_id) DO UPDATE SET updated_at = excluded.updated_at
      `).run(sessionId, timestamp, timestamp, JSON.stringify({ source: 'pd-runtime-v2' }));
    } else {
      db.prepare(`
        INSERT INTO sessions (session_id, started_at, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(session_id) DO UPDATE SET updated_at = excluded.updated_at
      `).run(sessionId, timestamp, timestamp);
    }

    // Try INSERT; on UNIQUE constraint violation for canonical_pain_id, do UPDATE instead.
    // SQLite UPSERT (ON CONFLICT) does not support partial unique indexes, so we
    // handle the conflict manually.
    const warnings: string[] = [];
    try {
      const result = db.prepare(`
        INSERT INTO pain_events (
          session_id, source, score, reason, severity, origin, confidence, text, created_at,
          canonical_pain_id, runtime_task_id, host_kind
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        sessionId,
        data.source,
        data.score ?? 80,
        sanitizeString(data.reason ?? '', workspaceDir),
        severityFromScore(data.score ?? 80),
        data.source === 'manual' ? 'user_manual' : 'system_infer',
        1,
        sanitizeString(data.reason ?? '', workspaceDir),
        timestamp,
        canonicalPainId ?? null,
        runtimeTaskId ?? null,
        data.hostKind ?? null,
      );
      return { id: Number(result.lastInsertRowid), warnings };
    } catch (insertErr: unknown) {
      // If UNIQUE constraint violation on canonical_pain_id, upsert manually
      if (
        canonicalPainId &&
        insertErr instanceof Error &&
        insertErr.message.includes('UNIQUE constraint failed') &&
        insertErr.message.includes('canonical_pain_id')
      ) {
        db.prepare(`
          UPDATE pain_events
          SET runtime_task_id = COALESCE(?, runtime_task_id),
              host_kind = COALESCE(host_kind, ?)
          WHERE canonical_pain_id = ?
        `).run(runtimeTaskId ?? null, data.hostKind ?? null, canonicalPainId);
        const rawRow = db.prepare('SELECT id, host_kind FROM pain_events WHERE canonical_pain_id = ?').get(canonicalPainId);
        // Runtime Contract #1/#2: validate DB row instead of `as` cast
        if (rawRow && typeof rawRow === 'object' && Object.hasOwn(rawRow, 'id') && typeof (rawRow as Record<string, unknown>).id === 'number') {
          // PRI-640 §16: keep the first durable host attribution; never overwrite.
          // A differing re-attempt is surfaced as a bounded warning (rc-9-no-silent-fallback).
          const durableHostKind = Object.getOwnPropertyDescriptor(rawRow, 'host_kind')?.value;
          if (data.hostKind && typeof durableHostKind === 'string' && durableHostKind !== data.hostKind) {
            warnings.push(`host_kind_conflict:kept=${durableHostKind},rejected=${data.hostKind}`);
          }
          return { id: (rawRow as { id: number }).id, warnings };
        }
        return { id: undefined, warnings };
      }
      throw insertErr;
    }
  } finally {
    db.close();
  }
}

/**
 * Record observability for a Runtime v2 pain signal without reviving the legacy
 * `evolution_tasks` queue. Best-effort: failures are returned as warnings so
 * diagnosis can still proceed.
 */
export function recordPainSignalObservability(
  opts: RecordPainSignalObservabilityOptions,
): PainSignalObservabilityResult {
  const timestamp = nowIso();
  const warnings: string[] = [];
  const score = opts.data.score ?? 80;
  const sessionId = opts.data.sessionId ?? 'cli';
  const date = todayUtc(timestamp);

  const result: PainSignalObservabilityResult = { warnings };

  try {
    const eventLogPath = nodePath.join(opts.stateDir, 'logs', `events_${date}.jsonl`);
    appendJsonLine(eventLogPath, {
      ts: timestamp,
      date,
      type: 'pain_signal',
      category: 'detected',
      sessionId,
      workspaceDir: opts.workspaceDir,
      data: {
        eventId: opts.data.painId,
        score,
        source: opts.data.source,
        reason: sanitizeString(opts.data.reason ?? '', opts.workspaceDir),
        severity: severityFromScore(score),
        origin: opts.data.source === 'manual' ? 'user_manual' : 'system_infer',
      },
    });
    result.eventLogPath = eventLogPath;
  } catch (err) {
    warnings.push(`event log write failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  try {
    const evolutionStreamPath = nodePath.join(opts.workspaceDir, 'memory', 'evolution.jsonl');
    // Sanitize: store only safe bounded fields, not the full PainDetectedData
    const sanitizedData = {
      painId: opts.data.painId,
      painType: opts.data.painType,
      source: opts.data.source,
      reason: sanitizeString(opts.data.reason ?? '', opts.workspaceDir),
      score: opts.data.score,
      sessionId: opts.data.sessionId,
      provenance: opts.data.provenance,
      evidenceCount: opts.data.evidence?.length ?? 0,
    };
    appendJsonLine(evolutionStreamPath, {
      ts: timestamp,
      type: 'pain_detected',
      data: sanitizedData,
    });
    result.evolutionStreamPath = evolutionStreamPath;
  } catch (err) {
    warnings.push(`evolution stream write failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  try {
    const trajectory = recordTrajectoryPainEvent({
      stateDir: opts.stateDir, data: opts.data, timestamp, workspaceDir: opts.workspaceDir,
      canonicalPainId: opts.canonicalPainId, runtimeTaskId: opts.runtimeTaskId,
    });
    result.trajectoryPainEventId = trajectory.id;
    warnings.push(...trajectory.warnings);
  } catch (err) {
    warnings.push(`trajectory pain_events write failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  return result;
}
