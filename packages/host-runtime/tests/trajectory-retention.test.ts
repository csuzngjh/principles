/**
 * SPEC-PD-TR-001 — the I/O boundary of the retention runner.
 *
 * The batch engine itself is covered by principles-core. Here we prove the
 * wiring that only exists with real files: config fail-closed, the disabled
 * states, the single-instance lock, the marker, the deleted-row export list,
 * the WAL assertion and the worker-only gating (interval / backoff).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import {
  RETENTION_BATCH_BUDGET_MS,
  TRAJECTORY_RETENTION_DEFAULTS,
  applyTrajectorySchemaBase,
  getDefaultPdConfig,
} from '@principles/core/runtime';
import {
  TRAJECTORY_RETENTION_LOCK_FILENAME,
  TRAJECTORY_RETENTION_MARKER_FILENAME,
  TRAJECTORY_RETENTION_WRITE_LOCK_WAIT_MS,
  readTrajectoryRetentionStatus,
  retentionWarning,
  runTrajectoryRetention,
  scheduleTrajectoryRetention,
  trajectoryRetentionPaths,
  vacuumTrajectoryDatabase,
} from '../src/trajectory-retention.js';
import { ensureGovernanceSchema } from '../src/governance-observation-store.js';
import {
  releaseExclusiveLock,
  tryAcquireExclusiveLockSync,
  type ExclusiveLockHandle,
} from '../src/product-telemetry/control-state-lock.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-11-11T12:00:00.000Z');
const dirs: string[] = [];
const handles: Database.Database[] = [];
let heldLock: ExclusiveLockHandle | undefined;

afterEach(() => {
  if (heldLock !== undefined) {
    releaseExclusiveLock(heldLock);
    heldLock = undefined;
  }
  for (const db of handles.splice(0)) {
    try {
      db.close();
    } catch {
      // already closed
    }
  }
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

/**
 * A real config file: the validator requires the mandatory sections, so a
 * section-only file is (correctly) rejected as config_invalid.
 */
function configWithTrajectoryRetention(section: Record<string, unknown>): Record<string, unknown> {
  const raw: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(getDefaultPdConfig())) raw[key] = value;
  raw.trajectoryRetention = section;
  return raw;
}

function retentionMarker(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    lastRunAt: null,
    lastCutoff: null,
    lastOutcome: null,
    deletedByTable: {},
    durationMs: null,
    totalDurationMs: null,
    partial: false,
    backoffUntil: null,
    consecutiveBusy: 0,
    reason: null,
    ...overrides,
  };
}

function openDb(file: string): Database.Database {
  const db = new Database(file);
  handles.push(db);
  return db;
}

function makeWorkspace(options: {
  wal?: boolean;
  config?: unknown;
  governance?: boolean;
} = {}): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-retention-ws-'));
  dirs.push(dir);
  fs.mkdirSync(path.join(dir, '.pd'), { recursive: true });
  if (options.config !== undefined) {
    fs.writeFileSync(path.join(dir, '.pd', 'config.yaml'), JSON.stringify(options.config), 'utf8');
  }
  fs.mkdirSync(path.join(dir, '.state'), { recursive: true });
  const db = openDb(path.join(dir, '.state', 'trajectory.db'));
  if (options.wal !== false) db.pragma('journal_mode = WAL');
  applyTrajectorySchemaBase(db, { views: false });
  if (options.governance === true) ensureGovernanceSchema(db);
  db.close();
  return dir;
}

function seedExpiredToolCalls(dir: string, count: number, daysAgo: number): void {
  const db = openDb(path.join(dir, '.state', 'trajectory.db'));
  const insert = db.prepare(`
    INSERT INTO tool_calls (session_id, tool_name, outcome, params_json, created_at)
    VALUES ('s', 't', 'ok', '{}', ?)
  `);
  for (let i = 0; i < count; i += 1) insert.run(iso(NOW - (daysAgo + i) * DAY_MS));
  db.close();
}

function readMarker(dir: string): Record<string, unknown> {
  const raw = fs.readFileSync(
    path.join(dir, '.state', TRAJECTORY_RETENTION_MARKER_FILENAME),
    'utf8',
  );
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('marker_not_object');
  }
  return parsed as Record<string, unknown>;
}

function writeMarker(dir: string, marker: Record<string, unknown>): void {
  fs.writeFileSync(
    path.join(dir, '.state', TRAJECTORY_RETENTION_MARKER_FILENAME),
    JSON.stringify(marker),
    'utf8',
  );
}

function toolCallCount(dir: string): number {
  const db = openDb(path.join(dir, '.state', 'trajectory.db'));
  const row = db.prepare('SELECT COUNT(*) AS c FROM tool_calls').get();
  db.close();
  if (typeof row !== 'object' || row === null) throw new Error('count_row_invalid');
  const count = (row as Record<string, unknown>).c;
  return typeof count === 'number' ? count : -1;
}

/** Rows at or after `fromMs` — i.e. rows inside the retention window. */
function toolCallsNewerThan(dir: string, fromMs: number): number {
  const db = openDb(path.join(dir, '.state', 'trajectory.db'));
  const row = db.prepare('SELECT COUNT(*) AS c FROM tool_calls WHERE created_at >= ?').get(iso(fromMs));
  db.close();
  if (typeof row !== 'object' || row === null) throw new Error('count_row_invalid');
  const count = (row as Record<string, unknown>).c;
  return typeof count === 'number' ? count : -1;
}

describe('runTrajectoryRetention — fail closed', () => {
  it('deletes nothing when the config section is invalid (config_invalid)', () => {
    const dir = makeWorkspace({
      config: configWithTrajectoryRetention({ retentionDays: 'ninety' }),
    });
    seedExpiredToolCalls(dir, 3, 200);

    const report = runTrajectoryRetention({ workspaceDir: dir, trigger: 'manual', now: () => NOW });

    expect(report.outcome).toBe('skipped');
    expect(report.reason).toContain('config_invalid');
    expect(report.deletedByTable.tool_calls).toBe(0);
    expect(toolCallCount(dir)).toBe(3);
  });

  it('treats retentionDays: 0 as "stop", not "delete everything"', () => {
    const dir = makeWorkspace({ config: configWithTrajectoryRetention({ retentionDays: 0 }) });
    seedExpiredToolCalls(dir, 3, 200);

    const report = runTrajectoryRetention({ workspaceDir: dir, trigger: 'manual', now: () => NOW });

    expect(report.outcome).toBe('skipped');
    expect(report.reason).toBe('retention_days_zero');
    expect(report.deletedByTable.tool_calls).toBe(0);
    expect(toolCallCount(dir)).toBe(3);
  });

  it('deletes nothing for an out-of-range retentionDays (degraded)', () => {
    const dir = makeWorkspace({ config: configWithTrajectoryRetention({ retentionDays: 3 }) });
    seedExpiredToolCalls(dir, 3, 200);

    const report = runTrajectoryRetention({ workspaceDir: dir, trigger: 'manual', now: () => NOW });

    expect(report.outcome).toBe('skipped');
    expect(report.reason).toBe('degraded:retention_days_out_of_range:3');
    expect(report.deletedByTable.tool_calls).toBe(0);
    expect(toolCallCount(dir)).toBe(3);
  });

  it('never switches journal_mode: a non-WAL database is refused', () => {
    const dir = makeWorkspace({ wal: false });
    seedExpiredToolCalls(dir, 2, 200);

    const report = runTrajectoryRetention({ workspaceDir: dir, trigger: 'manual', now: () => NOW });

    expect(report.outcome).toBe('skipped');
    expect(report.reason).toContain('journal_mode_not_wal');
    expect(report.deletedByTable.tool_calls).toBe(0);
    expect(toolCallCount(dir)).toBe(2);
  });

  it('skips the whole run while another process holds the single-instance lock', () => {
    const dir = makeWorkspace();
    seedExpiredToolCalls(dir, 2, 200);
    const paths = trajectoryRetentionPaths(dir);
    heldLock = tryAcquireExclusiveLockSync(paths.dbPath, {
      lockPath: path.join(dir, '.state', TRAJECTORY_RETENTION_LOCK_FILENAME),
      staleMs: 10 * 60 * 1000,
    });

    const report = runTrajectoryRetention({ workspaceDir: dir, trigger: 'manual', now: () => NOW });

    expect(report.outcome).toBe('skipped');
    expect(report.reason).toBe('locked');
    expect(report.deletedByTable.tool_calls).toBe(0);
    expect(toolCallCount(dir)).toBe(2);
  });
});

describe('runTrajectoryRetention — successful sweep', () => {
  it('deletes expired rows, writes the marker and the export list', () => {
    const dir = makeWorkspace({ governance: true });
    seedExpiredToolCalls(dir, 2, 200);
    seedExpiredToolCalls(dir, 1, 10); // inside the 90-day window — must survive

    const report = runTrajectoryRetention({ workspaceDir: dir, trigger: 'manual', now: () => NOW });

    expect(report.outcome).toBe('completed');
    expect(report.deletedByTable.tool_calls).toBe(2);
    // F2: a regular sweep never creates indexes; it reports them missing.
    expect(report.indexes).toBeNull();
    expect(report.indexesError).toMatch(/^index_missing:/);
    expect(toolCallCount(dir)).toBe(1);

    const marker = readMarker(dir);
    expect(marker.lastOutcome).toBe('completed');
    expect(marker.lastRunAt).toBe(iso(NOW));
    expect(marker.lastCutoff).toBe(iso(NOW - 194 * DAY_MS));
    expect(marker.deletedByTable).toEqual({
      tool_calls: 2,
      assistant_turns: 0,
      user_turns: 0,
      governance_observations: 0,
    });
    expect(marker.partial).toBe(false);
    // A1 is measured against the whole run, not just the batch engine.
    expect(marker.totalDurationMs).toBeGreaterThanOrEqual(marker.durationMs as number);
    expect(report.totalDurationMs).toBeGreaterThanOrEqual(report.durationMs);

    // The deleted-row list is id + timestamp only (Owner decision: no export).
    const exportPath = path.join(dir, '.state', 'exports', 'trajectory-retention-2026-11-11.jsonl');
    const lines = fs.readFileSync(exportPath, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(2);
    const exportedTimestamps: string[] = [];
    for (const line of lines) {
      const entry: unknown = JSON.parse(line);
      expect(typeof entry).toBe('object');
      if (typeof entry !== 'object' || entry === null) throw new Error('export_entry_invalid');
      const record = entry as Record<string, unknown>;
      expect(Object.keys(record).sort()).toEqual(['created_at', 'id', 'table']);
      expect(record.table).toBe('tool_calls');
      expect(typeof record.id).toBe('number');
      if (typeof record.created_at !== 'string') throw new Error('export_created_at_invalid');
      exportedTimestamps.push(record.created_at);
    }
    expect(exportedTimestamps.sort()).toEqual([
      iso(NOW - 201 * DAY_MS),
      iso(NOW - 200 * DAY_MS),
    ]);

    // F2: a sweep only checks for the indexes; it never runs DDL. Creation
    // belongs to the explicit maintenance entry (covered below).
    const db = openDb(path.join(dir, '.state', 'trajectory.db'));
    const names = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_%' ORDER BY name")
      .pluck()
      .all()
      .map((name) => String(name));
    for (const absent of [
      'idx_assistant_turns_blob_ref',
      'idx_pain_events_created_at',
      'idx_user_turns_blob_ref',
      'idx_user_turns_created_at',
    ]) {
      expect(names).not.toContain(absent);
    }
  });

  it('reports the expired backlog read-only through status', () => {
    const dir = makeWorkspace();
    seedExpiredToolCalls(dir, 2, 200);
    seedExpiredToolCalls(dir, 1, 120); // older than 90 d but inside the 7-day cap
    seedExpiredToolCalls(dir, 1, 10);

    const status = readTrajectoryRetentionStatus(dir, () => NOW);

    expect(status.dbExists).toBe(true);
    expect(status.markerError).toBeNull();
    // F4: "next delete" is the cutoff the NEXT run will use (oldest stored row
    // + the 7-day cap). `now - retentionDays` would say 3 here while the run
    // deletes 2 — the exact inconsistency the review measured.
    expect(status.nextCutoff).toBe(iso(NOW - 194 * DAY_MS));
    expect(status.expiredByTable?.tool_calls).toBe(2);
    expect(status.indexesMissing).toContain('idx_user_turns_created_at');
  });

  it('F4: the status projection matches what the next run actually deletes', () => {
    const dir = makeWorkspace();
    seedExpiredToolCalls(dir, 2, 200);
    seedExpiredToolCalls(dir, 1, 120);
    seedExpiredToolCalls(dir, 1, 10);

    const status = readTrajectoryRetentionStatus(dir, () => NOW);
    const report = runTrajectoryRetention({ workspaceDir: dir, trigger: 'manual', now: () => NOW });

    expect(status.expiredByTable?.tool_calls).toBe(2);
    expect(report.cutoff).toBe(status.nextCutoff);
    expect(report.deletedByTable.tool_calls).toBe(status.expiredByTable?.tool_calls);
  });
});

describe('runTrajectoryRetention — safety edges', () => {
  it('caps the first sweep at 7 days when the marker carries no lastCutoff', () => {
    const dir = makeWorkspace({ config: configWithTrajectoryRetention({ retentionDays: 30 }) });
    seedExpiredToolCalls(dir, 1, 200); // far outside a 30-day window
    seedExpiredToolCalls(dir, 1, 190); // 10 days after the oldest row
    seedExpiredToolCalls(dir, 1, 1); // inside the window

    const report = runTrajectoryRetention({ workspaceDir: dir, trigger: 'manual', now: () => NOW });

    // Baseline = oldest stored row (200 days ago), so the cutoff can only
    // advance to 193 days ago. Losing the marker must never delete 60 days of
    // history in one shot (review finding 6).
    expect(report.outcome).toBe('completed');
    expect(report.cutoff).toBe(iso(NOW - 193 * DAY_MS));
    expect(report.deletedByTable.tool_calls).toBe(1);
    expect(toolCallCount(dir)).toBe(2);
  });

  /**
   * F1 regression ①: a future `lastCutoff` must never be honoured.
   *
   * Before the fix, `computeRetentionCutoff` accepted any parseable value and
   * took `max(lastCutoff, ...)`, so `lastCutoff = now + 3650d` deleted every
   * row — including rows inside the retention window.
   */
  it('F1: discards a future marker cutoff and deletes nothing inside the window', () => {
    const dir = makeWorkspace();
    seedExpiredToolCalls(dir, 1, 200);
    seedExpiredToolCalls(dir, 1, 100);
    seedExpiredToolCalls(dir, 1, 1); // inside the 90-day window
    writeMarker(dir, retentionMarker({
      lastRunAt: iso(NOW - 60 * 60 * 1000),
      lastCutoff: iso(NOW + 3650 * DAY_MS),
    }));

    const report = runTrajectoryRetention({ workspaceDir: dir, trigger: 'manual', now: () => NOW });

    expect(report.outcome).toBe('completed');
    // Discarded ⇒ conservative baseline = oldest stored row + the 7-day cap.
    expect(report.cutoff).toBe(iso(NOW - 193 * DAY_MS));
    expect(report.deletedByTable.tool_calls).toBe(1);
    expect(toolCallCount(dir)).toBe(2);
    // The row inside the window survives.
    expect(toolCallsNewerThan(dir, NOW - 90 * DAY_MS)).toBe(1);

    const marker = readMarker(dir);
    expect(marker.reason).toBe('marker_cutoff_discarded');
    expect(Date.parse(String(marker.lastCutoff))).toBeLessThan(NOW);
  });

  /**
   * F1 regression ②: the real-world path. A clock that ran fast advanced the
   * cutoff; after the clock is corrected the first run only repairs
   * `lastRunAt`, so the NEXT run must not delete the window either.
   */
  it('F1: a corrected clock does not let the future marker cutoff delete the window', () => {
    const dir = makeWorkspace();
    seedExpiredToolCalls(dir, 1, 200);
    seedExpiredToolCalls(dir, 1, 1); // inside the window
    writeMarker(dir, retentionMarker({
      lastRunAt: iso(NOW + 100 * DAY_MS - 6 * 60 * 60 * 1000),
      lastCutoff: iso(NOW + 10 * DAY_MS),
    }));

    const corrected = runTrajectoryRetention({ workspaceDir: dir, trigger: 'manual', now: () => NOW });

    expect(corrected.outcome).toBe('skipped');
    expect(corrected.reason).toBe('clock_backwards');
    // The untrusted cutoff is normalised away immediately, not carried forward.
    expect(Date.parse(String(readMarker(dir).lastCutoff))).toBeLessThan(NOW);
    expect(toolCallCount(dir)).toBe(2);

    const second = runTrajectoryRetention({
      workspaceDir: dir,
      trigger: 'manual',
      now: () => NOW + 6 * 60 * 60 * 1000 + 1,
    });

    expect(second.outcome).toBe('completed');
    expect(second.deletedByTable.tool_calls).toBe(1); // only the 200-day row
    expect(toolCallCount(dir)).toBe(1);
    expect(toolCallsNewerThan(dir, NOW - 90 * DAY_MS)).toBe(1);
  });

  it('recovers from a long clock gap without advancing the cutoff', () => {
    const dir = makeWorkspace();
    seedExpiredToolCalls(dir, 1, 200);
    const staleCutoff = iso(NOW - 150 * DAY_MS);
    writeMarker(dir, retentionMarker({
      lastRunAt: iso(NOW - 20 * DAY_MS),
      lastCutoff: staleCutoff,
    }));

    const first = runTrajectoryRetention({ workspaceDir: dir, trigger: 'manual', now: () => NOW });

    expect(first.outcome).toBe('skipped');
    expect(first.reason).toBe('clock_forward_anomaly');
    const marker = readMarker(dir);
    // The clock baseline moves so the NEXT run is no longer an anomaly...
    expect(marker.lastRunAt).toBe(iso(NOW));
    // ...but the cutoff does not (review finding 2).
    expect(marker.lastCutoff).toBe(staleCutoff);
    expect(toolCallCount(dir)).toBe(1);

    const later = NOW + 6 * 60 * 60 * 1000 + 1;
    const second = runTrajectoryRetention({ workspaceDir: dir, trigger: 'manual', now: () => later });
    expect(second.outcome).toBe('completed');
    expect(second.deletedByTable.tool_calls).toBe(1);
  });

  it('recovers from an unparseable marker timestamp instead of stalling forever', () => {
    const dir = makeWorkspace();
    seedExpiredToolCalls(dir, 1, 200);
    writeMarker(dir, {
      ...retentionMarker({ lastCutoff: iso(NOW - 90 * DAY_MS) }),
      lastRunAt: 'garbage',
    });

    const report = runTrajectoryRetention({ workspaceDir: dir, trigger: 'manual', now: () => NOW });

    expect(report.outcome).toBe('completed');
    expect(readMarker(dir).lastRunAt).toBe(iso(NOW));
    expect(toolCallCount(dir)).toBe(0);
  });

  it('does not advance lastCutoff on an invariant violation, and the next run recovers', () => {
    const dir = makeWorkspace();
    seedExpiredToolCalls(dir, 2, 200);
    const staleCutoff = iso(NOW - 90 * DAY_MS);
    writeMarker(dir, retentionMarker({
      lastRunAt: iso(NOW - 7 * 60 * 60 * 1000),
      lastCutoff: staleCutoff,
    }));

    // A real database-level fault: the trigger re-inserts inside the delete
    // transaction, so the in-transaction pre/post counts cannot reconcile.
    const db = openDb(trajectoryRetentionPaths(dir).dbPath);
    db.exec(`
      CREATE TRIGGER retention_reinsert AFTER DELETE ON tool_calls
      BEGIN
        INSERT INTO tool_calls (session_id, tool_name, outcome, params_json, created_at)
        VALUES ('trigger', 't', 'ok', '{}', '${iso(NOW - 300 * DAY_MS)}');
      END;
    `);
    db.close();

    const first = runTrajectoryRetention({ workspaceDir: dir, trigger: 'manual', now: () => NOW });

    expect(first.outcome).toBe('invariant_violation');
    // A false positive must never move the cutoff, or the un-deleted rows
    // would silently fall out of the next run's window (review finding 8).
    const afterInvariant = readMarker(dir);
    expect(afterInvariant.lastCutoff).toBe(staleCutoff);
    // SPEC §4.5: the run did not complete, so the clock baseline must NOT move
    // either — otherwise the retry waits a whole intervalHours (F5).
    expect(afterInvariant.lastRunAt).toBe(iso(NOW - 7 * 60 * 60 * 1000));
    expect(toolCallCount(dir)).toBe(2);

    const fault = openDb(trajectoryRetentionPaths(dir).dbPath);
    fault.exec('DROP TRIGGER retention_reinsert');
    fault.close();

    const second = runTrajectoryRetention({ workspaceDir: dir, trigger: 'manual', now: () => NOW + 1 });

    expect(second.outcome).toBe('completed');
    expect(second.deletedByTable.tool_calls).toBe(2);
  });

  /**
   * F2 regression: missing indexes + a concurrent writer.
   *
   * Before the fix every run executed `CREATE INDEX` with `busy_timeout = 5000`
   * before doing any work, so a busy database stalled the host ~5.7 s and still
   * created nothing. A regular sweep now performs a read-only existence check
   * and yields on the 100 ms write wait.
   */
  it('F2: a sweep with missing indexes does not stall behind a concurrent writer', () => {
    const dir = makeWorkspace();
    seedExpiredToolCalls(dir, 2, 200);
    const blocker = openDb(trajectoryRetentionPaths(dir).dbPath);
    blocker.exec('BEGIN IMMEDIATE');
    try {
      const startedAt = Date.now();
      const report = runTrajectoryRetention({ workspaceDir: dir, trigger: 'manual', now: () => NOW });
      const wallMs = Date.now() - startedAt;

      // A8's ceiling is 300 ms; this keeps headroom for a slow CI filesystem
      // while still excluding the 5 s DDL wait the test exists to prevent.
      expect(wallMs).toBeLessThan(1500);
      expect(report.outcome).toBe('deferred:busy');
      expect(report.indexes).toBeNull();
      expect(report.indexesError).toMatch(/^index_missing:/);
      expect(report.deletedByTable.tool_calls).toBe(0);
      // The sweep must not have run DDL while the writer held the lock.
      const names = blocker
        .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_%'")
        .pluck()
        .all()
        .map((name) => String(name));
      expect(names).not.toContain('idx_user_turns_created_at');
    } finally {
      blocker.exec('ROLLBACK');
      blocker.close();
    }
  });

  it('reports rows already committed when a later batch throws', () => {
    const dir = makeWorkspace({ config: configWithTrajectoryRetention({ batchSize: 100 }) });
    // A prior cutoff keeps the conservative first-run cap out of the way, so
    // all 101 rows are eligible: 100 commit, then row 101 aborts.
    writeMarker(dir, retentionMarker({
      lastRunAt: iso(NOW - 60 * 60 * 1000),
      lastCutoff: iso(NOW - 90 * DAY_MS),
    }));
    seedExpiredToolCalls(dir, 101, 200);
    const db = openDb(trajectoryRetentionPaths(dir).dbPath);
    db.exec(`
      CREATE TRIGGER retention_boom BEFORE DELETE ON tool_calls
      WHEN OLD.id = 101
      BEGIN SELECT RAISE(ABORT, 'boom'); END;
    `);
    db.close();

    const report = runTrajectoryRetention({ workspaceDir: dir, trigger: 'manual', now: () => NOW });

    expect(report.outcome).toBe('skipped');
    expect(report.reason).toContain('failed:');
    // The first batch committed; an exception must not report 0 (review 4).
    expect(report.deletedByTable.tool_calls).toBe(100);
    expect(toolCallCount(dir)).toBe(1);
    // The marker is the ledger: it must carry THIS run's committed counts,
    // not the previous run's numbers (review item 2).
    const marker = readMarker(dir);
    expect(marker.deletedByTable).toEqual(report.deletedByTable);
    expect(marker.totalDurationMs).toBe(report.totalDurationMs);
    expect(marker.lastOutcome).toBe('failed');
  });

  it('does not delete when the audit list cannot be written (fail closed)', () => {
    const dir = makeWorkspace();
    seedExpiredToolCalls(dir, 2, 200);
    // A file where the exports directory should be makes mkdir/append fail.
    fs.writeFileSync(path.join(dir, '.state', 'exports'), 'not a directory', 'utf8');

    const report = runTrajectoryRetention({ workspaceDir: dir, trigger: 'manual', now: () => NOW });

    expect(report.outcome).toBe('partial');
    expect(report.reason).toContain('audit_failed:');
    expect(report.deletedByTable.tool_calls).toBe(0);
    expect(toolCallCount(dir)).toBe(2);
    expect(readMarker(dir).reason).toContain('audit_failed:');
  });
});

describe('runTrajectoryRetention — worker gating', () => {
  it('waits for intervalHours between worker runs', () => {
    const dir = makeWorkspace();
    seedExpiredToolCalls(dir, 1, 200);
    writeMarker(dir, retentionMarker({ lastRunAt: iso(NOW - 1 * 60 * 60 * 1000) }));

    const report = runTrajectoryRetention({ workspaceDir: dir, trigger: 'worker', now: () => NOW });

    expect(report.outcome).toBe('skipped');
    expect(report.reason).toContain('not_due');
    expect(toolCallCount(dir)).toBe(1);
  });

  it('honours a busy backoff window before retrying', () => {
    const dir = makeWorkspace();
    writeMarker(dir, retentionMarker({ backoffUntil: iso(NOW + 30 * 60 * 1000), consecutiveBusy: 1 }));

    const report = runTrajectoryRetention({ workspaceDir: dir, trigger: 'worker', now: () => NOW });

    expect(report.outcome).toBe('skipped');
    expect(report.reason).toContain('backoff');
  });

  it('manual trigger ignores the interval gate', () => {
    const dir = makeWorkspace();
    seedExpiredToolCalls(dir, 1, 200);
    writeMarker(dir, retentionMarker({ lastRunAt: iso(NOW - 60 * 1000) }));

    const report = runTrajectoryRetention({ workspaceDir: dir, trigger: 'manual', now: () => NOW });

    expect(report.outcome).toBe('completed');
    expect(report.deletedByTable.tool_calls).toBe(1);
  });
});

describe('vacuumTrajectoryDatabase', () => {
  it('is a dry run unless --yes is passed', () => {
    const dir = makeWorkspace();

    const report = vacuumTrajectoryDatabase({ workspaceDir: dir, apply: false, now: () => NOW });

    expect(report.applied).toBe(false);
    expect(report.refusedReason).toBeNull();
    expect(report.nextAction).toContain('--yes');
    expect(report.sizeBeforeBytes).toBeGreaterThan(0);
    // A dry run mutates nothing — not even the indexes (F2).
    expect(report.indexes).toBeNull();
    expect(readTrajectoryRetentionStatus(dir, () => NOW).indexesMissing)
      .toContain('idx_user_turns_created_at');
  });

  it('creates the retention indexes only in this explicit maintenance entry (F2)', () => {
    const dir = makeWorkspace();
    expect(readTrajectoryRetentionStatus(dir, () => NOW).indexesMissing)
      .toContain('idx_user_turns_created_at');

    const report = vacuumTrajectoryDatabase({ workspaceDir: dir, apply: true, now: () => NOW });

    expect(report.applied).toBe(true);
    expect(report.indexes).not.toBeNull();
    expect(report.indexes?.applied.some((sql) => sql.includes('idx_user_turns_created_at'))).toBe(true);
    expect(readTrajectoryRetentionStatus(dir, () => NOW).indexesMissing)
      .not.toContain('idx_user_turns_created_at');
  });

  it('refuses when the trajectory database does not exist', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-retention-empty-'));
    dirs.push(dir);

    const report = vacuumTrajectoryDatabase({ workspaceDir: dir, apply: true, now: () => NOW });

    expect(report.applied).toBe(false);
    expect(report.refusedReason).toBe('trajectory_db_missing');
  });
});

describe('scheduleTrajectoryRetention — hook path cost', () => {
  it('registers timers only: no trajectory DB is opened at schedule time', async () => {
    vi.useFakeTimers();
    try {
      const dir = makeWorkspace();
      const paths = trajectoryRetentionPaths(dir);
      // Replace the DB with a DIRECTORY: any attempt to open it would throw,
      // be recorded as a skip and write the marker. A silent marker-free
      // schedule therefore proves no connection was opened (review 13).
      fs.rmSync(paths.dbPath, { force: true });
      fs.mkdirSync(paths.dbPath);

      scheduleTrajectoryRetention(dir);

      // Nothing may run during the hook that calls this.
      expect(fs.existsSync(path.join(dir, '.state', TRAJECTORY_RETENTION_MARKER_FILENAME))).toBe(false);
      expect(fs.existsSync(path.join(dir, '.state', TRAJECTORY_RETENTION_LOCK_FILENAME))).toBe(false);
      expect(fs.existsSync(path.join(dir, '.state', 'exports'))).toBe(false);

      // The first tick is delayed by a full minute, so even a hook call that
      // sits in the event loop briefly pays nothing.
      await vi.advanceTimersByTimeAsync(59_000);
      expect(fs.existsSync(paths.markerPath)).toBe(false);
      expect(fs.existsSync(paths.lockPath)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  /**
   * F3: the worker/gateway loop is the only place a broken config becomes
   * visible. Before the fix `retentionWarning` returned null for
   * `config_invalid`, so retention stopped forever with no signal while the
   * database kept growing.
   */
  it('F3: a worker tick surfaces config_invalid once, not every cycle', async () => {
    vi.useFakeTimers();
    try {
      const dir = makeWorkspace({ config: configWithTrajectoryRetention({ retentionDays: 'ninety' }) });
      const warnings: string[] = [];
      scheduleTrajectoryRetention(dir, { warn: (message: string) => warnings.push(message) });

      await vi.advanceTimersByTimeAsync(60_000);
      expect(warnings.length).toBe(1);
      expect(warnings[0]).toContain('config_invalid');

      // Same failure on the next interval: deduped, no log spam.
      await vi.advanceTimersByTimeAsync(6 * 60 * 60 * 1000 + 10 * 60 * 1000);
      expect(warnings.length).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('reports a successful worker cycle through info', async () => {
    vi.useFakeTimers();
    try {
      const dir = makeWorkspace();
      seedExpiredToolCalls(dir, 1, 200);
      // Create the retention indexes first: a missing index is itself a
      // deduped warning (F2), which would mask the success log path.
      vacuumTrajectoryDatabase({ workspaceDir: dir, apply: true, now: () => NOW });
      const infos: string[] = [];
      const warnings: string[] = [];
      scheduleTrajectoryRetention(dir, {
        info: (message: string) => infos.push(message),
        warn: (message: string) => warnings.push(message),
      });

      await vi.advanceTimersByTimeAsync(60_000);

      expect(warnings).toEqual([]);
      expect(infos.length).toBe(1);
      expect(infos[0]).toContain('completed');
      expect(infos[0]).toContain('deleted=1');
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('runTrajectoryRetention — hook blocking envelope', () => {
  it('bounds the synchronous block a running sweep can impose on a hook', () => {
    // better-sqlite3 is synchronous, so a sweep running in the same process
    // blocks the event loop while a batch is in flight. That is why the engine
    // has a hard per-batch and per-run budget: the worst-case block is
    // `runBudgetMs` (3000 ms), not the whole backlog.
    expect(TRAJECTORY_RETENTION_DEFAULTS.runBudgetMs).toBe(3000);
    expect(RETENTION_BATCH_BUDGET_MS).toBe(250);
  });

  it('a running sweep blocks the event loop only until its run budget, then yields', async () => {
    const dir = makeWorkspace({ config: configWithTrajectoryRetention({ batchSize: 100, runBudgetMs: 500 }) });
    writeMarker(dir, retentionMarker({
      lastRunAt: iso(NOW - 30 * 60 * 60 * 1000),
      lastCutoff: iso(NOW - 90 * DAY_MS),
    }));
    seedExpiredToolCalls(dir, 1000, 200);

    // Injected clock: every read advances 100 ms, so the run budget is
    // exhausted deterministically instead of depending on wall clock speed.
    let ticks = 0;
    const clock = (): number => NOW + (ticks += 100);

    // A hook callback queued just before the sweep. better-sqlite3 is
    // synchronous, so this timer CANNOT run while the sweep holds the loop.
    let hookFired = false;
    setTimeout(() => { hookFired = true; }, 0);

    const report = runTrajectoryRetention({ workspaceDir: dir, trigger: 'manual', now: clock });

    // The hook was delayed for the whole sweep: that is the A3 risk, stated
    // honestly rather than tested away (review finding 13).
    expect(hookFired).toBe(false);
    // The sweep yields at the budget instead of draining the backlog, so the
    // hook delay is bounded by `runBudgetMs` (+ one batch), not by table size.
    expect(report.outcome).toBe('deadline');
    expect(report.batches).toBe(1);
    expect(report.deletedByTable.tool_calls).toBe(100);
    expect(toolCallCount(dir)).toBeGreaterThan(0);

    await new Promise<void>((resolve) => { setTimeout(resolve, 0); });
    expect(hookFired).toBe(true);
  });
});

describe('retentionWarning — persistent failures are surfaced (F3)', () => {
  it('warns once for config_invalid instead of silently stopping forever', () => {
    const dir = makeWorkspace({ config: configWithTrajectoryRetention({ retentionDays: 'ninety' }) });

    // Both the worker and the gateway loop go through `retentionWarning`, so
    // this is the decision point that used to return null for a config error
    // and leave retention permanently off with no signal.
    const first = runTrajectoryRetention({ workspaceDir: dir, trigger: 'worker', now: () => NOW });
    const second = runTrajectoryRetention({ workspaceDir: dir, trigger: 'worker', now: () => NOW });

    expect(first.reason).toContain('config_invalid');
    expect(retentionWarning(first)).toContain('config_invalid');
    // Deduped: the identical failure on the next 120 s cycle stays quiet.
    expect(retentionWarning(second)).toBeNull();
  });

  it('warns once for a degraded policy and re-warns when the reason changes', () => {
    const dir = makeWorkspace({ config: configWithTrajectoryRetention({ retentionDays: 3 }) });

    const degraded = runTrajectoryRetention({ workspaceDir: dir, trigger: 'worker', now: () => NOW });
    expect(degraded.reason).toBe('degraded:retention_days_out_of_range:3');
    expect(retentionWarning(degraded)).toContain('degraded:');

    const repeated = runTrajectoryRetention({ workspaceDir: dir, trigger: 'worker', now: () => NOW });
    expect(retentionWarning(repeated)).toBeNull();
  });

  it('surfaces a discarded marker cutoff as a distinct warning', () => {
    const dir = makeWorkspace();
    seedExpiredToolCalls(dir, 1, 200);
    // Create the indexes first so the standing `index_missing` state does not
    // mask the one-off F1 signal (both share the marker's single reason slot).
    vacuumTrajectoryDatabase({ workspaceDir: dir, apply: true, now: () => NOW });

    writeMarker(dir, retentionMarker({
      lastRunAt: iso(NOW - 60 * 60 * 1000),
      lastCutoff: iso(NOW + 3650 * DAY_MS),
    }));
    const discarded = runTrajectoryRetention({ workspaceDir: dir, trigger: 'manual', now: () => NOW });

    expect(discarded.reason).toBe('marker_cutoff_discarded');
    expect(retentionWarning(discarded)).toContain('marker_cutoff_discarded');
    // Deduped while the state persists.
    expect(retentionWarning(discarded)).toBeNull();
  });
});

describe('write-lock budget', () => {
  it('keeps the maintenance write wait well inside A8\'s 300 ms ceiling', () => {
    // SQLite's busy handler overshoots by up to one sleep step; a 250 ms
    // timeout measured ~355 ms, so the runner uses a smaller wait.
    expect(TRAJECTORY_RETENTION_WRITE_LOCK_WAIT_MS).toBeLessThanOrEqual(100);
  });
});
