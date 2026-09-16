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
 * core writer to avoid an observability gap. (PRI-770: the legacy
 * `evolution_tasks` queue tables this file used to mirror were retired — the
 * evolution.jsonl stream and trajectory.db pain_events write remain.)
 */
import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as nodePath from 'path';
import type { PainDetectedData } from './pain-signal-bridge.js';
import { sanitizeString } from './evidence-sanitizer.js';
import { applyTrajectorySchemaBase } from './trajectory-schema.js';

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

/**
 * PRI-750: shared event-JSONL line writer — same `events_<date>.jsonl` file and
 * entry shape as the OpenClaw EventLog, reused by the Codex host path (which
 * cannot import the plugin). Lives in this registered audit-observability seam;
 * best-effort — a failed write is not raised here, callers degrade (rc-9).
 */
export function appendEventLogLine(
  stateDir: string,
  entry: { ts: string; type: string; category: string; sessionId: string | undefined; data: unknown },
): void {
  const date = entry.ts.slice(0, 10);
  appendJsonLine(nodePath.join(stateDir, 'logs', `events_${date}.jsonl`), {
    ts: entry.ts,
    date,
    type: entry.type,
    category: entry.category,
    sessionId: entry.sessionId,
    data: entry.data,
  });
}

function getSessionsColumns(db: Database.Database): string[] {
  const cols = db.prepare('PRAGMA table_info(sessions)').all() as { name: string }[];
  return cols.map((c) => c.name);
}

/**
 * Ensure trajectory.db has the full canonical schema (tables + migrations +
 * indexes) by delegating to the single DDL authority (PRI-802).
 *
 * Views are intentionally NOT created on this path (Profile A): the Thinking
 * Activity analytics views were retired (2026-08-19) along with their writer,
 * and no reader needs them on the pain record path.
 *
 * The schema_version ROW stays untouched by core (P1-A contract): this only
 * guarantees the table exists; version read/migrate/write remains with the
 * plugin TrajectoryDatabase lifecycle.
 */
function ensureTrajectorySchema(db: Database.Database): { tables: string[]; warnings: string[] } {
  return applyTrajectorySchemaBase(db);
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
