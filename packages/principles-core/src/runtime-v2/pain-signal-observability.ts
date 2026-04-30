/**
 * Pain signal observability for Runtime v2 manual entry points.
 *
 * Automatic OpenClaw hook paths already record event-log and trajectory rows
 * before calling PainSignalBridge. `pd pain record` does not have a
 * WorkspaceContext, so it uses this small core writer to avoid an observability
 * gap while keeping `evolution_tasks` legacy queue disabled.
 */
import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as path from 'path';
import type { PainDetectedData } from './pain-signal-bridge.js';

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
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, `${JSON.stringify(value)}\n`, 'utf8');
}

function ensurePainEventsSchema(db: Database.Database): void {
db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        session_id TEXT PRIMARY KEY,
        started_at TEXT,
        updated_at TEXT,
        metadata_json TEXT
      );
      CREATE TABLE IF NOT EXISTS pain_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        source TEXT NOT NULL,
        score INTEGER NOT NULL,
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
}

function recordTrajectoryPainEvent(
  stateDir: string,
  data: PainDetectedData,
  timestamp: string,
): number | undefined {
  const dbPath = path.join(stateDir, 'trajectory.db');
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  try {
    ensurePainEventsSchema(db);
    const sessionId = data.sessionId ?? 'cli';
    db.prepare(`
      INSERT INTO sessions (session_id, started_at, updated_at, metadata_json)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(session_id) DO UPDATE SET updated_at = excluded.updated_at
    `).run(sessionId, timestamp, timestamp, JSON.stringify({ source: 'pd-runtime-v2' }));

    const result = db.prepare(`
      INSERT INTO pain_events (
        session_id, source, score, reason, severity, origin, confidence, text, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      sessionId,
      data.source,
      data.score ?? 80,
      data.reason,
      severityFromScore(data.score ?? 80),
      data.source === 'manual' ? 'user_manual' : 'system_infer',
      1,
      data.reason,
      timestamp,
    );
    return Number(result.lastInsertRowid);
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
    const eventLogPath = path.join(opts.stateDir, 'logs', `events_${date}.jsonl`);
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
        reason: opts.data.reason,
        severity: severityFromScore(score),
        origin: opts.data.source === 'manual' ? 'user_manual' : 'system_infer',
      },
    });
    result.eventLogPath = eventLogPath;
  } catch (err) {
    warnings.push(`event log write failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  try {
    const evolutionStreamPath = path.join(opts.workspaceDir, 'memory', 'evolution.jsonl');
    appendJsonLine(evolutionStreamPath, {
      ts: timestamp,
      type: 'pain_detected',
      data: opts.data,
    });
    result.evolutionStreamPath = evolutionStreamPath;
  } catch (err) {
    warnings.push(`evolution stream write failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  try {
    result.trajectoryPainEventId = recordTrajectoryPainEvent(opts.stateDir, opts.data, timestamp);
  } catch (err) {
    warnings.push(`trajectory pain_events write failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  return result;
}
