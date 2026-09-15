import { describe, expect, it, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import Database from 'better-sqlite3';

import { TrajectoryDatabase, TrajectoryRegistry } from '../../src/core/trajectory.js';
import { TRAJECTORY_TABLES } from '@principles/core/runtime-v2';

const tempDirs: string[] = [];

function makeWorkspace(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-trajectory-equiv-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function tableNames(dbPath: string): string[] {
  const db = new Database(dbPath, { readonly: true });
  try {
    return (
      db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
        .all() as Array<{ name: string }>
    ).map((r) => r.name);
  } finally {
    db.close();
  }
}

function columnNames(dbPath: string, table: string): string[] {
  const db = new Database(dbPath, { readonly: true });
  try {
    return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name);
  } finally {
    db.close();
  }
}

describe('PRI-774: plugin trajectory schema parity with the canonical module', () => {
  it('Profile C runtime DB contains exactly the canonical base tables plus runtime-only views extras', () => {
    const workspaceDir = makeWorkspace();
    TrajectoryRegistry.use(workspaceDir, () => {
      // no-op write path; initSchema applies Profile C
    });

    const dbPath = path.join(workspaceDir, '.state', 'trajectory.db');
    const tables = tableNames(dbPath);
    // Canonical Base tables must ALL exist in the runtime DB.
    for (const t of TRAJECTORY_TABLES) {
      expect(tables).toContain(t);
    }
    // Profile C extras vs base: none today beyond the retired evolution
    // tables (never created on fresh workspaces).
    const extras = tables.filter((t) => !TRAJECTORY_TABLES.includes(t));
    expect(extras).toEqual([]);
  });

  it('Fixture B: legacy evolution_tasks is backfilled through the plugin path with rows preserved', () => {
    const workspaceDir = makeWorkspace();
    const stateDir = path.join(workspaceDir, '.state');
    fs.mkdirSync(stateDir, { recursive: true });
    const dbPath = path.join(stateDir, 'trajectory.db');

    // legacy pre-V2 evolution_tasks (missing the six nullable V2 columns)
    const raw = new Database(dbPath);
    raw.exec('CREATE TABLE evolution_tasks (id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT UNIQUE NOT NULL, trace_id TEXT NOT NULL, source TEXT NOT NULL, reason TEXT, score INTEGER DEFAULT 0, status TEXT DEFAULT \'pending\', enqueued_at TEXT, started_at TEXT, completed_at TEXT, resolution TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)');
    raw.prepare('INSERT INTO evolution_tasks (task_id, trace_id, source, reason, score, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
      'task-legacy-equiv',
      'trace-legacy-equiv',
      'pain_signal',
      'legacy pain',
      90,
      'completed',
      '2026-06-01T00:00:00.000Z',
      '2026-06-01T00:00:00.000Z',
    );
    raw.close();

    // opening the database through the plugin path must backfill the columns
    TrajectoryRegistry.use(workspaceDir, () => {});

    const check = new Database(dbPath, { readonly: true });
    try {
      const cols = (check.prepare('PRAGMA table_info(evolution_tasks)').all() as Array<{ name: string }>).map((c) => c.name);
      for (const col of ['task_kind', 'priority', 'retry_count', 'max_retries', 'last_error', 'result_ref']) {
        expect(cols).toContain(col);
      }
      const row = check.prepare('SELECT score, status FROM evolution_tasks WHERE task_id = ?').get('task-legacy-equiv') as { score: number; status: string };
      expect(row.score).toBe(90);
      expect(row.status).toBe('completed');
    } finally {
      check.close();
    }
  });

  it('populated DB: applying the plugin schema never changes existing rows (Fixture C parity)', () => {
    const workspaceDir = makeWorkspace();
    const stateDir = path.join(workspaceDir, '.state');
    fs.mkdirSync(stateDir, { recursive: true });
    const dbPath = path.join(stateDir, 'trajectory.db');

    const raw = new Database(dbPath);
    raw.exec('CREATE TABLE pain_events (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, source TEXT NOT NULL, score REAL NOT NULL, reason TEXT, severity TEXT, origin TEXT, confidence REAL, text TEXT, canonical_pain_id TEXT, runtime_task_id TEXT, host_kind TEXT, created_at TEXT NOT NULL)');
    raw.prepare('INSERT INTO pain_events (session_id, source, score, reason, created_at) VALUES (?, ?, ?, ?, ?)').run(
      'session-keep',
      'manual',
      77,
      'kept pain',
      '2026-06-02T00:00:00.000Z',
    );
    const beforeRows = raw.prepare('SELECT COUNT(*) AS c FROM pain_events').get() as { c: number };
    raw.close();
    expect(beforeRows.c).toBe(1);

    TrajectoryRegistry.use(workspaceDir, () => {});

    const check = new Database(dbPath, { readonly: true });
    try {
      const after = check.prepare('SELECT COUNT(*) AS c FROM pain_events').get() as { c: number };
      expect(after.c).toBe(beforeRows.c);
      const row = check.prepare('SELECT score, reason FROM pain_events WHERE session_id = ?').get('session-keep') as { score: number; reason: string };
      expect(row.score).toBe(77);
      expect(row.reason).toBe('kept pain');
    } finally {
      check.close();
    }
  });
});
