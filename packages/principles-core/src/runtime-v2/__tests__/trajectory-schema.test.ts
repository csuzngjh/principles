import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import {
  applyTrajectorySchemaBase,
  migrateLegacyGfiSchema,
  TRAJECTORY_REQUIRED_COLUMNS,
  TRAJECTORY_SCHEMA_VERSION,
  TRAJECTORY_TABLES,
  convergeTrajectorySchemaVersion,
} from '../trajectory-schema.js';

/**
 * PRI-774 guard: the canonical schema module (Profile A/B/C) is the single
 * DDL authority for trajectory.db. SPEC:
 * docs/archive/specs/trajectory-data-plane-single-truth.md
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

  it('migrateLegacyGfiSchema converges the real schema_version row (v1 → v2), idempotently', () => {
    const readVersion = (db: Database.Database): unknown =>
      (db.prepare('SELECT version FROM schema_version LIMIT 1').get() as { version?: unknown } | undefined)
        ?.version;

    const db = new Database(':memory:');
    applyTrajectorySchemaBase(db);
    // Simulate a database created by the previous release: its physical schema
    // is now v2-shaped, but the persisted version row still claims v1.
    db.prepare('UPDATE schema_version SET version = ?').run(1);

    migrateLegacyGfiSchema(db);
    expect(readVersion(db)).toBe(TRAJECTORY_SCHEMA_VERSION);

    // second run: no duplicate row, still current
    migrateLegacyGfiSchema(db);
    expect(readVersion(db)).toBe(TRAJECTORY_SCHEMA_VERSION);
    expect((db.prepare('SELECT COUNT(*) AS c FROM schema_version').get() as { c: number }).c).toBe(1);
    db.close();
  });

  it('migrateLegacyGfiSchema is a no-op on an already-v2 database', () => {
    const db = new Database(':memory:');
    applyTrajectorySchemaBase(db);
    expect(TRAJECTORY_SCHEMA_VERSION).toBe(2);
    migrateLegacyGfiSchema(db);
    const row = db.prepare('SELECT version FROM schema_version LIMIT 1').get() as { version: number };
    expect(row.version).toBe(TRAJECTORY_SCHEMA_VERSION);
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

  it('adds nullable tool-call project scope without assigning historical rows a cwd', () => {
    const db = new Database(':memory:');
    db.exec(`CREATE TABLE tool_calls (
      id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, tool_name TEXT NOT NULL,
      outcome TEXT NOT NULL, duration_ms INTEGER, exit_code INTEGER, error_type TEXT, error_message TEXT,
      gfi_before REAL, gfi_after REAL, params_json TEXT NOT NULL, created_at TEXT NOT NULL
    )`);
    db.prepare('INSERT INTO tool_calls (session_id, tool_name, outcome, params_json, created_at) VALUES (?, ?, ?, ?, ?)')
      .run('legacy-session', 'apply_patch', 'success', '{"file_path":"relative.txt"}', '2026-10-18T10:00:00.000Z');

    applyTrajectorySchemaBase(db);

    const columns = db.prepare('PRAGMA table_info(tool_calls)').all() as { name: string; notnull: number }[];
    expect(columns.some((column) => column.name === 'project_dir' && column.notnull === 0)).toBe(true);
    // GFI complete removal: legacy gfi columns are dropped, historical rows preserved.
    expect(columns.some((column) => column.name === 'gfi_before')).toBe(false);
    expect(columns.some((column) => column.name === 'gfi_after')).toBe(false);
    const row = db.prepare('SELECT session_id, tool_name, project_dir FROM tool_calls WHERE session_id = ?').get('legacy-session');
    expect(row).toEqual({ session_id: 'legacy-session', tool_name: 'apply_patch', project_dir: null });
    db.close();
  });
});

describe('PRI-1135: single schema truth + single version-row writer', () => {
  it('TRAJECTORY_REQUIRED_COLUMNS matches what the real DDL produces (drift guard)', () => {
    const db = new Database(':memory:');
    applyTrajectorySchemaBase(db);
    for (const [table, required] of Object.entries(TRAJECTORY_REQUIRED_COLUMNS)) {
      const rows = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string; type: string }[];
      const actual = new Map(rows.map((r) => [r.name, r.type.toUpperCase()]));
      for (const [name, type] of Object.entries(required)) {
        expect(actual.get(name), `${table}.${name}`).toBe(type);
      }
    }
    db.close();
  });

  it('convergeTrajectorySchemaVersion inserts, upgrades a stale row, and is idempotent', () => {
    const readVersion = (handle: Database.Database): unknown =>
      (handle.prepare('SELECT version FROM schema_version LIMIT 1').get() as { version?: unknown } | undefined)?.version;

    const db = new Database(':memory:');
    db.exec('CREATE TABLE schema_version (version INTEGER NOT NULL)');
    convergeTrajectorySchemaVersion(db);
    expect(readVersion(db)).toBe(TRAJECTORY_SCHEMA_VERSION);

    db.prepare('UPDATE schema_version SET version = ?').run(1);
    convergeTrajectorySchemaVersion(db);
    expect(readVersion(db)).toBe(TRAJECTORY_SCHEMA_VERSION);

    convergeTrajectorySchemaVersion(db);
    expect(readVersion(db)).toBe(TRAJECTORY_SCHEMA_VERSION);
    expect((db.prepare('SELECT COUNT(*) AS c FROM schema_version').get() as { c: number }).c).toBe(1);
    db.close();
  });

  it('convergeTrajectorySchemaVersion is a no-op when the version table is absent', () => {
    const db = new Database(':memory:');
    expect(() => convergeTrajectorySchemaVersion(db)).not.toThrow();
    db.close();
  });
});
