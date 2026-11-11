/**
 * SPEC-PD-TR-001 — retention policy, cutoff arithmetic and batch engine.
 *
 * Every scenario runs against a REAL file-backed SQLite database created with
 * the canonical schema. No in-memory surrogate: the batch loop, `BEGIN
 * IMMEDIATE`, `changes()` accounting and the busy behaviour only exist for real.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import {
  EMPTY_RETENTION_MARKER,
  RETENTION_MAX_CUTOFF_ADVANCE_MS,
  applyTrajectorySchemaBase,
  computeRetentionCutoff,
  ensureTrajectoryRetentionIndexes,
  nextBackoffUntil,
  normalizeRetentionMarker,
  resolveTrajectoryRetentionPolicy,
  runTrajectoryRetentionBatches,
} from '../src/runtime/index.js';
import type { TrajectoryRetentionMarker } from '../src/runtime/index.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const workspaces: string[] = [];
const openDatabases: Database.Database[] = [];

afterEach(() => {
  // Close every handle first: on Windows an open SQLite handle makes the
  // directory undeletable (EPERM), which would mask the real failure.
  for (const db of openDatabases.splice(0)) {
    try {
      db.close();
    } catch {
      // an already-closed handle is fine
    }
  }
  for (const ws of workspaces.splice(0)) fs.rmSync(ws, { recursive: true, force: true });
});

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function makeDatabase(): { db: Database.Database; dir: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-retention-'));
  workspaces.push(dir);
  const db = new Database(path.join(dir, 'trajectory.db'));
  openDatabases.push(db);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 250');
  applyTrajectorySchemaBase(db, { views: false });
  db.exec(`
    CREATE TABLE governance_observations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      observation_id TEXT NOT NULL,
      retention_class TEXT NOT NULL,
      observed_at TEXT NOT NULL,
      expired_at TEXT
    )
  `);
  return { db, dir };
}

describe('resolveTrajectoryRetentionPolicy', () => {
  it('uses 90 days / 6 h / 2000 rows / 3000 ms when the section is absent', () => {
    const policy = resolveTrajectoryRetentionPolicy(undefined);
    expect(policy).toEqual({
      enabled: true,
      retentionDays: 90,
      intervalHours: 6,
      batchSize: 2000,
      runBudgetMs: 3000,
    });
    expect(policy.degradedReason).toBeUndefined();
  });

  it('treats retentionDays: 0 as "stop", never "delete everything"', () => {
    const policy = resolveTrajectoryRetentionPolicy({ retentionDays: 0 });
    expect(policy.enabled).toBe(false);
    expect(policy.disabledByZeroDays).toBe(true);
    expect(policy.degradedReason).toBeUndefined();
  });

  it('degrades (delete nothing) for retentionDays below the accepted minimum', () => {
    const policy = resolveTrajectoryRetentionPolicy({ retentionDays: 3 });
    expect(policy.enabled).toBe(true);
    expect(policy.degradedReason).toBe('retention_days_out_of_range:3');
    expect(policy.retentionDays).toBe(90);
  });

  it('degrades and clamps retentionDays above 3650', () => {
    const policy = resolveTrajectoryRetentionPolicy({ retentionDays: 99999 });
    expect(policy.degradedReason).toBe('retention_days_out_of_range:99999');
    expect(policy.retentionDays).toBe(3650);
  });

  it('degrades on out-of-range batchSize / runBudgetMs / intervalHours', () => {
    expect(resolveTrajectoryRetentionPolicy({ batchSize: 10 }).degradedReason).toBe('batch_size_out_of_range:10');
    expect(resolveTrajectoryRetentionPolicy({ runBudgetMs: 100 }).degradedReason).toBe('run_budget_out_of_range:100');
    expect(resolveTrajectoryRetentionPolicy({ intervalHours: 0 }).degradedReason).toBe('interval_hours_out_of_range:0');
  });

  it('degrades on non-integer and non-boolean values', () => {
    expect(resolveTrajectoryRetentionPolicy({ retentionDays: 90.5 }).degradedReason)
      .toBe('retention_days_not_integer');
    const nonBoolean = resolveTrajectoryRetentionPolicy({ enabled: 'yes' });
    expect(nonBoolean.enabled).toBe(false);
    expect(nonBoolean.degradedReason).toBe('enabled_not_boolean');
  });

  it('degrades on a non-object section and on unknown keys (fail closed)', () => {
    expect(resolveTrajectoryRetentionPolicy('90d').degradedReason).toBe('config_not_object');
    expect(resolveTrajectoryRetentionPolicy({ retentionDay: 90 }).degradedReason)
      .toBe('unknown_key:retentionDay');
  });

  it('accepts a fully valid section unchanged', () => {
    expect(resolveTrajectoryRetentionPolicy({
      enabled: true,
      retentionDays: 30,
      intervalHours: 12,
      batchSize: 500,
      runBudgetMs: 1000,
    })).toEqual({
      enabled: true,
      retentionDays: 30,
      intervalHours: 12,
      batchSize: 500,
      runBudgetMs: 1000,
    });
  });
});

describe('computeRetentionCutoff', () => {
  const nowMs = Date.parse('2026-11-11T12:00:00.000Z');
  const fresh: TrajectoryRetentionMarker = { ...EMPTY_RETENTION_MARKER };

  it('first run uses now - retentionDays', () => {
    const decision = computeRetentionCutoff({
      nowMs,
      retentionDays: 90,
      intervalHours: 6,
      marker: fresh,
    });
    expect(decision).toEqual({
      kind: 'run',
      cutoff: iso(nowMs - 90 * DAY_MS),
      computedCutoff: iso(nowMs - 90 * DAY_MS),
      advanceCapped: false,
    });
  });

  it('advances the cutoff at most 7 days per run', () => {
    const marker: TrajectoryRetentionMarker = {
      ...fresh,
      // Due (8 h > 6 h interval) but not an implausible clock jump.
      lastRunAt: iso(nowMs - 8 * 60 * 60 * 1000),
      lastCutoff: iso(nowMs - 200 * DAY_MS),
    };
    const decision = computeRetentionCutoff({ nowMs, retentionDays: 90, intervalHours: 6, marker });
    expect(decision.kind).toBe('run');
    if (decision.kind !== 'run') return;
    expect(decision.advanceCapped).toBe(true);
    expect(decision.cutoff).toBe(iso(Date.parse(marker.lastCutoff as string) + RETENTION_MAX_CUTOFF_ADVANCE_MS));
  });

  it('never moves the cutoff backwards', () => {
    const marker: TrajectoryRetentionMarker = {
      ...fresh,
      lastRunAt: iso(nowMs - 30 * 60 * 1000),
      lastCutoff: iso(nowMs - 10 * DAY_MS),
    };
    const decision = computeRetentionCutoff({ nowMs, retentionDays: 90, intervalHours: 6, marker });
    expect(decision.kind).toBe('run');
    if (decision.kind !== 'run') return;
    expect(decision.cutoff).toBe(marker.lastCutoff);
  });

  it('skips a backwards clock jump instead of deleting with a wrong cutoff', () => {
    // lastRunAt is in the FUTURE relative to now: the system clock moved back.
    const marker: TrajectoryRetentionMarker = {
      ...fresh,
      lastRunAt: iso(nowMs + 2 * 60 * 60 * 1000),
    };
    expect(computeRetentionCutoff({ nowMs, retentionDays: 90, intervalHours: 6, marker }))
      .toEqual({ kind: 'skip', reason: 'clock_backwards' });
  });

  it('skips an implausible forward clock jump', () => {
    const marker: TrajectoryRetentionMarker = { ...fresh, lastRunAt: iso(nowMs - 400 * DAY_MS) };
    expect(computeRetentionCutoff({ nowMs, retentionDays: 90, intervalHours: 6, marker }))
      .toEqual({ kind: 'skip', reason: 'clock_forward_anomaly' });
  });

  it('skips when the marker holds an unparseable timestamp', () => {
    const marker: TrajectoryRetentionMarker = { ...fresh, lastRunAt: 'not-a-date' };
    expect(computeRetentionCutoff({ nowMs, retentionDays: 90, intervalHours: 6, marker }))
      .toEqual({ kind: 'skip', reason: 'marker_timestamp_invalid' });
  });

  it('backs off 30m -> 1h -> 2h -> 6h and caps there', () => {
    const base = nowMs;
    expect(nextBackoffUntil(base, 1)).toBe(iso(base + 30 * 60 * 1000));
    expect(nextBackoffUntil(base, 2)).toBe(iso(base + 60 * 60 * 1000));
    expect(nextBackoffUntil(base, 3)).toBe(iso(base + 2 * 60 * 60 * 1000));
    expect(nextBackoffUntil(base, 4)).toBe(iso(base + 6 * 60 * 60 * 1000));
    expect(nextBackoffUntil(base, 9)).toBe(iso(base + 6 * 60 * 60 * 1000));
  });
});

describe('normalizeRetentionMarker', () => {
  const NOW = Date.parse('2026-11-11T12:00:00.000Z');

  it('normalises an unparseable timestamp to null instead of preserving it', () => {
    const { marker, damaged } = normalizeRetentionMarker({
      ...EMPTY_RETENTION_MARKER,
      lastRunAt: 'yesterday-ish',
      lastCutoff: iso(NOW - 90 * DAY_MS),
      deletedByTable: {},
    });

    expect(damaged).toBe(true);
    // Keeping the bad string would make every later run skip with
    // marker_timestamp_invalid — a permanent stall (review finding 2).
    expect(marker.lastRunAt).toBeNull();
    expect(marker.lastCutoff).toBe(iso(NOW - 90 * DAY_MS));
    // With lastRunAt null the next run is due immediately, so it recovers.
    expect(computeRetentionCutoff({
      nowMs: NOW,
      retentionDays: 90,
      intervalHours: 6,
      marker,
    })).toMatchObject({ kind: 'run' });
  });

  it('accepts a well-formed marker without damage', () => {
    const { marker, damaged } = normalizeRetentionMarker({
      ...EMPTY_RETENTION_MARKER,
      lastRunAt: iso(NOW - 60 * 60 * 1000),
      lastCutoff: iso(NOW - 90 * DAY_MS),
      lastOutcome: 'completed',
      deletedByTable: { tool_calls: 2 },
      durationMs: 12,
      totalDurationMs: 40,
      partial: false,
      backoffUntil: null,
      consecutiveBusy: 0,
      reason: null,
    });

    expect(damaged).toBe(false);
    expect(marker.deletedByTable).toEqual({ tool_calls: 2 });
    expect(marker.totalDurationMs).toBe(40);
  });

  it('treats non-objects as a damaged empty marker', () => {
    const { marker, damaged } = normalizeRetentionMarker('not a marker');
    expect(damaged).toBe(true);
    expect(marker.lastRunAt).toBeNull();
    expect(marker.lastCutoff).toBeNull();
  });
});

describe('runTrajectoryRetentionBatches', () => {
  const nowMs = Date.parse('2026-11-11T12:00:00.000Z');

  function seed(db: Database.Database, createdAt: string): void {
    db.prepare(`
      INSERT INTO tool_calls (session_id, tool_name, outcome, params_json, created_at)
      VALUES ('s', 't', 'ok', '{}', ?)
    `).run(createdAt);
  }

  it('keeps the row exactly on the cutoff and deletes only strictly older rows', () => {
    const { db } = makeDatabase();
    const cutoff = iso(nowMs - 90 * DAY_MS);
    seed(db, iso(Date.parse(cutoff) - 1));
    seed(db, cutoff);
    seed(db, iso(nowMs - 1 * DAY_MS));
    const result = runTrajectoryRetentionBatches(db, {
      policy: { batchSize: 2000, runBudgetMs: 3000 },
      cutoff,
      hooks: { now: () => nowMs },
    });
    expect(result.outcome).toBe('completed');
    expect(result.deletedByTable.tool_calls).toBe(1);
    const remaining = db.prepare('SELECT created_at FROM tool_calls ORDER BY id').all();
    expect(remaining).toEqual([{ created_at: cutoff }, { created_at: iso(nowMs - DAY_MS) }]);
    db.close();
  });

  it('never touches governance_observations outside expired/rolled_back', () => {
    const { db } = makeDatabase();
    const cutoff = iso(nowMs - 90 * DAY_MS);
    const insert = db.prepare(`
      INSERT INTO governance_observations (observation_id, retention_class, observed_at, expired_at)
      VALUES (?, ?, ?, ?)
    `);
    insert.run('o1', 'expired', iso(nowMs - 200 * DAY_MS), iso(nowMs - 120 * DAY_MS));
    insert.run('o2', 'rolled_back', iso(nowMs - 200 * DAY_MS), iso(nowMs - 120 * DAY_MS));
    insert.run('o3', 'operational', iso(nowMs - 400 * DAY_MS), iso(nowMs - 120 * DAY_MS));
    insert.run('o4', 'promoted', iso(nowMs - 400 * DAY_MS), null);
    insert.run('o5', 'expired', iso(nowMs - 200 * DAY_MS), iso(nowMs - 1 * DAY_MS));

    const result = runTrajectoryRetentionBatches(db, {
      policy: { batchSize: 2000, runBudgetMs: 3000 },
      cutoff,
      hooks: { now: () => nowMs },
    });
    expect(result.outcome).toBe('completed');
    expect(result.deletedByTable.governance_observations).toBe(2);
    const ids = db.prepare('SELECT observation_id FROM governance_observations ORDER BY id').all();
    expect(ids).toEqual([{ observation_id: 'o3' }, { observation_id: 'o4' }, { observation_id: 'o5' }]);
    db.close();
  });

  it('respects batchSize and reports one batch per commit', () => {
    const { db } = makeDatabase();
    const cutoff = iso(nowMs - 90 * DAY_MS);
    for (let i = 0; i < 5; i += 1) seed(db, iso(nowMs - (100 + i) * DAY_MS));
    const result = runTrajectoryRetentionBatches(db, {
      policy: { batchSize: 2, runBudgetMs: 60_000 },
      cutoff,
      hooks: { now: () => nowMs },
    });
    expect(result.outcome).toBe('completed');
    expect(result.batches).toBeGreaterThanOrEqual(3);
    expect(result.deletedByTable.tool_calls).toBe(5);
    db.close();
  });

  it('is idempotent: a re-run after an interruption deletes nothing and keeps fresh rows', () => {
    const { db } = makeDatabase();
    const cutoff = iso(nowMs - 90 * DAY_MS);
    for (let i = 0; i < 4; i += 1) seed(db, iso(nowMs - (200 + i) * DAY_MS));
    seed(db, iso(nowMs - 10 * DAY_MS));

    const first = runTrajectoryRetentionBatches(db, {
      policy: { batchSize: 2, runBudgetMs: 60_000 },
      cutoff,
      hooks: { now: () => nowMs },
    });
    expect(first.outcome).toBe('completed');
    expect(first.deletedByTable.tool_calls).toBe(4);

    const second = runTrajectoryRetentionBatches(db, {
      policy: { batchSize: 2, runBudgetMs: 60_000 },
      cutoff,
      hooks: { now: () => nowMs },
    });
    expect(second.outcome).toBe('completed');
    expect(second.deletedByTable.tool_calls).toBe(0);
    const remaining = db.prepare('SELECT COUNT(*) AS c FROM tool_calls').get();
    expect(remaining).toEqual({ c: 1 });
    db.close();
  });

  it('yields on SQLITE_BUSY within the write-lock budget and deletes nothing', () => {
    const { db } = makeDatabase();
    // Mirrors TRAJECTORY_RETENTION_WRITE_LOCK_WAIT_MS in @principles/host-runtime.
    // Not 250: SQLite's busy handler overshoots by up to one sleep step, which
    // pushed a 250 ms timeout past A8's 300 ms wall-clock ceiling.
    db.pragma('busy_timeout = 100');
    const cutoff = iso(nowMs - 90 * DAY_MS);
    for (let i = 0; i < 3; i += 1) seed(db, iso(nowMs - (200 + i) * DAY_MS));

    // A second writer holds the write lock for the whole attempt.
    const blocker = new Database(db.name);
    openDatabases.push(blocker);
    blocker.pragma('busy_timeout = 0');
    blocker.exec('BEGIN IMMEDIATE');
    blocker.prepare('INSERT INTO sessions (session_id, started_at, updated_at) VALUES (?, ?, ?)')
      .run('other', iso(nowMs), iso(nowMs));

    const startedAt = Date.now();
    const result = runTrajectoryRetentionBatches(db, {
      policy: { batchSize: 2000, runBudgetMs: 3000 },
      cutoff,
      hooks: { now: () => Date.now() },
    });
    const elapsed = Date.now() - startedAt;

    expect(result.outcome).toBe('deferred_busy');
    expect(result.reason).toBe('sqlite_busy');
    expect(elapsed).toBeLessThan(300);
    expect(db.prepare('SELECT COUNT(*) AS c FROM tool_calls').get()).toEqual({ c: 3 });

    blocker.exec('ROLLBACK');
    blocker.close();

    // A8: the first retry after the lock is released must succeed.
    const retry = runTrajectoryRetentionBatches(db, {
      policy: { batchSize: 2000, runBudgetMs: 3000 },
      cutoff,
      hooks: { now: () => nowMs },
    });
    expect(retry.outcome).toBe('completed');
    expect(retry.deletedByTable.tool_calls).toBe(3);
    expect(db.prepare('SELECT COUNT(*) AS c FROM tool_calls').get()).toEqual({ c: 0 });
    db.close();
  });

  it('does NOT report invariant_violation when a concurrent writer inserts between batches', () => {
    const { db } = makeDatabase();
    const cutoff = iso(nowMs - 90 * DAY_MS);
    for (let i = 0; i < 2; i += 1) seed(db, iso(nowMs - (200 + i) * DAY_MS));
    db.prepare(`
      INSERT INTO governance_observations (observation_id, retention_class, observed_at, expired_at)
      VALUES ('g1', 'expired', ?, ?)
    `).run(iso(nowMs - 200 * DAY_MS), iso(nowMs - 120 * DAY_MS));

    // tool_calls was already swept when the governance batch commits. The old
    // run-level pre/post pair counted this insert as a mismatch; the invariant
    // now lives inside each delete transaction, so this must stay green
    // (review finding 8).
    const result = runTrajectoryRetentionBatches(db, {
      policy: { batchSize: 2000, runBudgetMs: 3000 },
      cutoff,
      hooks: {
        now: () => nowMs,
        onBatchCommitted: ({ table }) => {
          if (table === 'governance_observations') seed(db, iso(nowMs - 300 * DAY_MS));
        },
      },
    });

    expect(result.outcome).toBe('completed');
    expect(result.deletedByTable.tool_calls).toBe(2);
    expect(result.deletedByTable.governance_observations).toBe(1);
    // The late insert is simply next run's work.
    expect(db.prepare('SELECT COUNT(*) AS c FROM tool_calls').get()).toEqual({ c: 1 });
    db.close();
  });

  it('rolls the batch back and stops when the in-transaction invariant breaks', () => {
    const { db } = makeDatabase();
    const cutoff = iso(nowMs - 90 * DAY_MS);
    for (let i = 0; i < 2; i += 1) seed(db, iso(nowMs - (200 + i) * DAY_MS));

    // A trigger is a real database-level fault: it re-inserts an expired row
    // inside the same delete transaction, so pre-post can never equal changes.
    db.exec(`
      CREATE TRIGGER retention_reinsert AFTER DELETE ON tool_calls
      BEGIN
        INSERT INTO tool_calls (session_id, tool_name, outcome, params_json, created_at)
        VALUES ('trigger', 't', 'ok', '{}', '${iso(nowMs - 300 * DAY_MS)}');
      END;
    `);

    const result = runTrajectoryRetentionBatches(db, {
      policy: { batchSize: 2000, runBudgetMs: 3000 },
      cutoff,
      hooks: { now: () => nowMs },
    });

    expect(result.outcome).toBe('invariant_violation');
    expect(result.reason).toContain('row_count_mismatch:tool_calls');
    // The failed batch was rolled back: both original rows are still there.
    expect(db.prepare("SELECT COUNT(*) AS c FROM tool_calls WHERE session_id != 'trigger'").get())
      .toEqual({ c: 2 });
    db.close();
  });

  it('does not delete a batch whose audit list could not be written', () => {
    const { db } = makeDatabase();
    const cutoff = iso(nowMs - 90 * DAY_MS);
    for (let i = 0; i < 3; i += 1) seed(db, iso(nowMs - (200 + i) * DAY_MS));

    const result = runTrajectoryRetentionBatches(db, {
      policy: { batchSize: 2000, runBudgetMs: 3000 },
      cutoff,
      hooks: {
        now: () => nowMs,
        onBatchPrepared: () => 'disk full',
      },
    });

    expect(result.outcome).toBe('partial');
    expect(result.reason).toBe('audit_failed:disk full');
    expect(result.batches).toBe(0);
    expect(result.deletedByTable.tool_calls).toBe(0);
    expect(db.prepare('SELECT COUNT(*) AS c FROM tool_calls').get()).toEqual({ c: 3 });
    db.close();
  });

  it('creates only the missing retention indexes and is idempotent', () => {
    const { db } = makeDatabase();
    const retentionIndexNames = [
      'idx_assistant_turns_blob_ref',
      'idx_pain_events_created_at',
      'idx_user_turns_blob_ref',
      'idx_user_turns_created_at',
    ];
    const first = ensureTrajectoryRetentionIndexes(db);
    expect(first.applied).toHaveLength(4);
    expect(first.skipped).toEqual([]);

    // Second call re-executes the same IF NOT EXISTS statements: idempotent
    // means "no error and the index set is unchanged", not "reports zero".
    const indexCountBefore = db
      .prepare("SELECT COUNT(*) AS c FROM sqlite_master WHERE type = 'index'")
      .get();
    const second = ensureTrajectoryRetentionIndexes(db);
    expect(second.applied).toHaveLength(4);
    expect(db.prepare("SELECT COUNT(*) AS c FROM sqlite_master WHERE type = 'index'").get())
      .toEqual(indexCountBefore);

    const names = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND name IN (?, ?, ?, ?) ORDER BY name",
      )
      .all(...retentionIndexNames);
    expect(names).toEqual(
      retentionIndexNames.slice().sort().map((name) => ({ name })),
    );

    // The two blob_ref indexes must be partial, otherwise they index millions
    // of NULLs and cost space without helping the orphan scan.
    const partialSql = db
      .prepare(
        "SELECT sql FROM sqlite_master WHERE type = 'index' AND name LIKE '%_blob_ref' ORDER BY name",
      )
      .pluck()
      .all();
    expect(partialSql).toHaveLength(2);
    for (const sql of partialSql) {
      expect(String(sql).toUpperCase()).toContain('WHERE BLOB_REF IS NOT NULL');
    }
    db.close();
  });

  it('skips an index whose table is absent instead of failing the run', () => {
    const { db } = makeDatabase();
    db.exec('DROP TABLE pain_events');
    const report = ensureTrajectoryRetentionIndexes(db);
    expect(report.applied).toHaveLength(3);
    expect(report.skipped).toEqual([
      'CREATE INDEX IF NOT EXISTS idx_pain_events_created_at ON pain_events(created_at)',
    ]);
    db.close();
  });
});
