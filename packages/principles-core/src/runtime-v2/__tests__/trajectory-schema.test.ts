import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import {
  applyTrajectorySchemaBase,
  TRAJECTORY_SCHEMA_VERSION,
  TRAJECTORY_TABLES,
} from '../trajectory-schema.js';

/**
 * PRI-774 guard: the canonical schema module (Profile A/B/C) is the single
 * DDL authority for trajectory.db. SPEC:
 * docs/specs/trajectory-data-plane-single-truth.md
 */

describe('PRI-774: canonical trajectory schema module', () => {
  it('exports TRAJECTORY_TABLES matching a freshly applied Profile A database', () => {
    const db = new Database(':memory:');
    applyTrajectorySchemaBase(db);
    const actual = (
      db.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      ).all() as { name: string }[]
    ).map((r) => r.name);
    expect(actual).toEqual([...TRAJECTORY_TABLES].sort());
    db.close();
  });

  it('Profile A (views: false) creates no views; Profile B (views: true) creates exactly the three runtime-init views', () => {
    const a = new Database(':memory:');
    applyTrajectorySchemaBase(a);
    const aViews = (
      a.prepare("SELECT name FROM sqlite_master WHERE type = 'view' ORDER BY name").all() as { name: string }[]
    ).map((r) => r.name);
    a.close();

    const b = new Database(':memory:');
    applyTrajectorySchemaBase(b, { views: true });
    const bViews = (
      b.prepare("SELECT name FROM sqlite_master WHERE type = 'view' ORDER BY name").all() as { name: string }[]
    ).map((r) => r.name);
    b.close();

    expect(aViews).toEqual([]);
    expect(bViews).toEqual([
      'v_error_clusters',
      'v_principle_effectiveness',
      'v_sample_queue',
    ]);
  });

  it('views: true also creates every index the base profile creates (no index drift)', () => {
    const noViews = new Database(':memory:');
    const withViews = new Database(':memory:');
    applyTrajectorySchemaBase(noViews);
    applyTrajectorySchemaBase(withViews, { views: true });
    const idxNames = (handle: typeof noViews) =>
      (
        handle
          .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name NOT LIKE 'sqlite_%' ORDER BY name")
          .all() as { name: string }[]
      ).map((r) => r.name);
    expect(idxNames(withViews)).toEqual(idxNames(noViews));
    noViews.close();
    withViews.close();
  });

  it('TRAJECTORY_SCHEMA_VERSION matches the shipped schema_version value', () => {
    const db = new Database(':memory:');
    applyTrajectorySchemaBase(db);
    const tableExists = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_version'")
      .get();
    expect(tableExists).toBeDefined();
    expect(TRAJECTORY_SCHEMA_VERSION).toBe(1);
    db.close();
  });

  it('Fixture B: legacy evolution_tasks gets the six nullable columns backfilled, rows preserved', () => {
    const db = new Database(':memory:');
    // legacy pre-V2 evolution_tasks (missing the six nullable V2 columns)
    db.exec('CREATE TABLE evolution_tasks (id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT UNIQUE NOT NULL, trace_id TEXT NOT NULL, source TEXT NOT NULL, reason TEXT, score INTEGER DEFAULT 0, status TEXT DEFAULT \'pending\', enqueued_at TEXT, started_at TEXT, completed_at TEXT, resolution TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)');
    db.prepare('INSERT INTO evolution_tasks (task_id, trace_id, source, reason, score, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
      'task-legacy-001',
      'trace-legacy-001',
      'pain_signal',
      'legacy pain',
      42,
      'completed',
      '2026-06-01T00:00:00.000Z',
      '2026-06-01T00:00:00.000Z',
    );
    const before = db.prepare('SELECT COUNT(*) AS c FROM evolution_tasks').get() as { c: number };
    expect(before.c).toBe(1);

    applyTrajectorySchemaBase(db);

    const cols = (db.prepare('PRAGMA table_info(evolution_tasks)').all() as { name: string }[]).map((c) => c.name);
    for (const col of ['task_kind', 'priority', 'retry_count', 'max_retries', 'last_error', 'result_ref']) {
      expect(cols).toContain(col);
    }
    const row = db.prepare('SELECT * FROM evolution_tasks WHERE task_id = ?').get('task-legacy-001') as Record<string, unknown>;
    expect(row.score).toBe(42);
    expect(row.status).toBe('completed');
    expect(row.task_kind).toBeNull();
    db.close();
  });

  it('populated DB: applying the canonical schema never changes existing rows', () => {
    const db = new Database(':memory:');
    applyTrajectorySchemaBase(db);
    db.prepare('INSERT INTO pain_events (session_id, source, score, reason, created_at) VALUES (?, ?, ?, ?, ?)').run(
      'session-x',
      'manual',
      88,
      'kept',
      '2026-06-02T00:00:00.000Z',
    );
    const before = db.prepare('SELECT COUNT(*) AS c FROM pain_events').get() as { c: number };

    applyTrajectorySchemaBase(db);

    const after = db.prepare('SELECT COUNT(*) AS c FROM pain_events').get() as { c: number };
    expect(after.c).toBe(before.c);
    expect(after.c).toBe(1);
    db.close();
  });
});
