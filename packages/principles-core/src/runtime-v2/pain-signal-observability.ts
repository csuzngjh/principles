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

function ensurePainEventsSchema(db: Database.Database): void {
  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec(`
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
      CREATE INDEX IF NOT EXISTS idx_pain_events_session_id ON pain_events(session_id);
      CREATE INDEX IF NOT EXISTS idx_pain_events_created_at ON pain_events(created_at);
    `);

    // Ensure sessions table exists (legacy schema without metadata_json is OK)
    const existingTables = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='sessions'"
    ).all() as { name: string }[];

    if (existingTables.length === 0) {
      db.exec(`
        CREATE TABLE sessions (
          session_id TEXT PRIMARY KEY,
          started_at TEXT,
          updated_at TEXT,
          metadata_json TEXT
        );
      `);
    }
    // Schema MUST stay in sync with packages/openclaw-plugin/src/core/schema/schema-definitions.ts pain_events.
    // core cannot import plugin schema (dependency direction), so DDL is duplicated intentionally.
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
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

function recordTrajectoryPainEvent(opts: TrajectoryRecordOptions): number | undefined {
  const { stateDir, data, timestamp, workspaceDir, canonicalPainId, runtimeTaskId } = opts;
  const dbPath = nodePath.join(stateDir, 'trajectory.db');
  fs.mkdirSync(nodePath.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  try {
    ensurePainEventsSchema(db);

    // PRI-406: Add canonical_pain_id and runtime_task_id columns if missing
    for (const col of [
      { name: 'canonical_pain_id', type: 'TEXT' },
      { name: 'runtime_task_id', type: 'TEXT' },
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

    // PRI-406: Create partial unique index for canonical_pain_id dedup
    db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_pain_events_canonical_pain_id
      ON pain_events(canonical_pain_id)
      WHERE canonical_pain_id IS NOT NULL
    `);

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
    try {
      const result = db.prepare(`
        INSERT INTO pain_events (
          session_id, source, score, reason, severity, origin, confidence, text, created_at,
          canonical_pain_id, runtime_task_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
      );
      return Number(result.lastInsertRowid);
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
          SET runtime_task_id = COALESCE(?, runtime_task_id)
          WHERE canonical_pain_id = ?
        `).run(runtimeTaskId ?? null, canonicalPainId);
        const rawRow = db.prepare('SELECT id FROM pain_events WHERE canonical_pain_id = ?').get(canonicalPainId);
        // Runtime Contract #1/#2: validate DB row instead of `as` cast
        if (rawRow && typeof rawRow === 'object' && Object.hasOwn(rawRow, 'id') && typeof (rawRow as Record<string, unknown>).id === 'number') {
          return (rawRow as { id: number }).id;
        }
        return undefined;
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
    result.trajectoryPainEventId = recordTrajectoryPainEvent({
      stateDir: opts.stateDir, data: opts.data, timestamp, workspaceDir: opts.workspaceDir,
      canonicalPainId: opts.canonicalPainId, runtimeTaskId: opts.runtimeTaskId,
    });
  } catch (err) {
    warnings.push(`trajectory pain_events write failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  return result;
}
