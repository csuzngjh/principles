import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { InternalizationIntegrityRemediation } from '../internalization-integrity-remediation.js';
import { SqliteConnection } from '../store/sqlite-connection.js';
import { resolveStateDbPath } from '../store/storage-paths.js';

/**
 * PRI-1209 batch 0 — characterization on a CANONICAL database.
 *
 * The existing internalization-integrity-remediation.test.ts builds a hand
 * written minimal schema. A green result there cannot prove production safety,
 * because production opens state.db through SqliteConnection, whose write path
 * runs initSchema() + migrateSchema() on every open and wal_checkpoint(TRUNCATE)
 * on close. These tests build the database the same way production does, then
 * assert that repair does not silently reshape the schema.
 *
 * No production code is modified by this file.
 */

const TABLES = ['tasks', 'runs', 'pi_artifacts', 'artifacts', 'commits', 'approvals', 'schema_version'] as const;

function nowIso(): string {
  return new Date().toISOString();
}

function createCanonicalWorkspace(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pri1209-canonical-'));
  const connection = new SqliteConnection({ workspaceDir: dir });
  try {
    // Forces initSchema() + migrateSchema() exactly like production writes.
    connection.getDb();
  } finally {
    connection.close();
  }
  return dir;
}

/** Raw fixture writer. Schema creation already happened through SqliteConnection. */
function withFixtureDb<T>(dbPath: string, fn: (db: Database.Database) => T): T {
  const db = new Database(dbPath);
  try {
    // Fixtures must not create rows production would reject.
    db.pragma('foreign_keys = ON');
    return fn(db);
  } finally {
    db.close();
  }
}

function schemaFingerprint(dbPath: string): string {
  const db = new Database(dbPath, { readonly: true });
  try {
    const rows = db.prepare(
      "SELECT type, name, tbl_name, COALESCE(sql, '') AS sql FROM sqlite_master ORDER BY type, name",
    ).all() as Record<string, unknown>[];
    const text = rows.map((row) => `${String(row.type)}|${String(row.name)}|${String(row.tbl_name)}|${String(row.sql)}`).join('\n');
    return crypto.createHash('sha256').update(text).digest('hex');
  } finally {
    db.close();
  }
}

function rowCounts(dbPath: string): Record<string, number> {
  const db = new Database(dbPath, { readonly: true });
  try {
    const counts: Record<string, number> = {};
    for (const table of TABLES) {
      const row = db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c: number };
      counts[table] = row.c;
    }
    return counts;
  } finally {
    db.close();
  }
}

/**
 * Seeds one instance of every defect class the repair command can act on:
 *  - dreamer-no-artifact        -> requeueTask (write)
 *  - dreamer-with-artifact      -> createPhilosopherSuccessor (write)
 *  - stuck-lease (+ running run)-> forceExpireAndMarkRunFailed (write, nested tx)
 *  - succeeded-no-run           -> supplementSucceededRun (write)
 */
function seedAllDefectClasses(dbPath: string): void {
  const now = nowIso();
  const past = new Date(Date.now() - 60 * 60 * 1000).toISOString();

  withFixtureDb(dbPath, (db) => {
    const insertTask = db.prepare(`
      INSERT INTO tasks (
        task_id, task_kind, status, attempt_count, max_attempts,
        input_ref, result_ref, lease_owner, lease_expires_at, diagnostic_json,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    insertTask.run('dreamer-no-artifact', 'dreamer', 'succeeded', 2, 3, null, null, null, null, null, now, now);
    insertTask.run('dreamer-with-artifact', 'dreamer', 'succeeded', 1, 3, null, null, null, null, null, now, now);
    insertTask.run('stuck-lease', 'worker', 'leased', 1, 3, null, null, 'runner-x', past, null, now, now);
    insertTask.run('succeeded-no-run', 'worker', 'succeeded', 1, 3, null, 'result-ref', null, null, null, now, now);

    db.prepare(`
      INSERT INTO pi_artifacts (
        artifact_id, artifact_kind, source_task_id, lineage_artifact_ids,
        validation_status, content_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run('pi-1', 'principle', 'dreamer-with-artifact', '[]', 'valid', '{}', now, now);

    db.prepare(`
      INSERT INTO runs (
        run_id, task_id, runtime_kind, execution_status, started_at, ended_at,
        reason, output_ref, attempt_number, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run('run-stuck', 'stuck-lease', 'openclaw', 'running', now, null, null, null, 1, now, now);
  });
}

function actionTypes(result: { actions: { type?: string }[] }): string[] {
  return result.actions.map((action) => action.type ?? '');
}

describe('InternalizationIntegrityRemediation on a canonical state.db', () => {
  let workspaceDir = '';
  let dbPath = '';

  beforeEach(() => {
    workspaceDir = createCanonicalWorkspace();
    dbPath = resolveStateDbPath(workspaceDir);
    seedAllDefectClasses(dbPath);
  });

  afterEach(() => {
    try {
      fs.rmSync(workspaceDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it('dry-run leaves the schema fingerprint and every row count untouched', () => {
    const beforeSchema = schemaFingerprint(dbPath);
    const beforeCounts = rowCounts(dbPath);

    const remediation = new InternalizationIntegrityRemediation({ workspaceDir });
    const result = remediation.repair({ dryRun: true });

    expect(result.repairedCount).toBe(0);
    expect(result.actions.length).toBeGreaterThan(0);
    expect(actionTypes(result)).toEqual(
      expect.arrayContaining([
        'missing_dreamer_pi_artifact',
        'missing_philosopher_successor',
        'lease_stuck',
        'task_succeeded_no_succeeded_run',
      ]),
    );

    expect(schemaFingerprint(dbPath)).toBe(beforeSchema);
    expect(rowCounts(dbPath)).toEqual(beforeCounts);
  });

  it('confirm writes repairs without changing the schema (migrateSchema is a no-op on canonical DB)', () => {
    const beforeSchema = schemaFingerprint(dbPath);

    const remediation = new InternalizationIntegrityRemediation({ workspaceDir });
    const result = remediation.repair({ dryRun: false });

    expect(result.repairedCount).toBeGreaterThanOrEqual(4);
    expect(actionTypes(result)).toEqual(
      expect.arrayContaining([
        'missing_dreamer_pi_artifact',
        'missing_philosopher_successor',
        'lease_stuck',
        'task_succeeded_no_succeeded_run',
      ]),
    );

    // The critical assertion: opening a write connection must not reshape the
    // canonical schema (no CREATE/ALTER/DROP INDEX side effects).
    expect(schemaFingerprint(dbPath)).toBe(beforeSchema);

    const afterCounts = rowCounts(dbPath);
    expect(afterCounts.schema_version).toBeGreaterThan(0);
  });

  it('confirm is idempotent — a second pass repairs nothing and mutates no rows', () => {
    const remediation = new InternalizationIntegrityRemediation({ workspaceDir });

    const first = remediation.repair({ dryRun: false });
    expect(first.repairedCount).toBeGreaterThanOrEqual(4);

    const schemaAfterFirst = schemaFingerprint(dbPath);
    const countsAfterFirst = rowCounts(dbPath);

    const second = remediation.repair({ dryRun: false });

    expect(second.repairedCount).toBe(0);
    expect(schemaFingerprint(dbPath)).toBe(schemaAfterFirst);
    expect(rowCounts(dbPath)).toEqual(countsAfterFirst);
  });

  it('pins current lock behavior: a competing writer makes confirm fail loudly and write nothing', () => {
    const beforeSchema = schemaFingerprint(dbPath);
    const beforeCounts = rowCounts(dbPath);

    const holder = new Database(dbPath);
    holder.pragma('busy_timeout = 0');
    holder.exec('BEGIN IMMEDIATE');
    try {
      const remediation = new InternalizationIntegrityRemediation({ workspaceDir });
      let thrown: unknown;
      try {
        remediation.repair({ dryRun: false });
      } catch (error) {
        thrown = error;
      }

      // Characterization of TODAY'S behavior on the raw connection:
      // better-sqlite3 surfaces SQLITE_BUSY as a raw SqliteError, not PDRuntimeError.
      expect(thrown).toBeInstanceOf(Error);
      expect(String((thrown as Error).message)).toMatch(/SQLITE_BUSY|database is locked/i);
    } finally {
      holder.exec('ROLLBACK');
      holder.close();
    }

    expect(schemaFingerprint(dbPath)).toBe(beforeSchema);
    expect(rowCounts(dbPath)).toEqual(beforeCounts);

    // After the competing writer releases, the command completes normally and
    // leaves no poisoned state behind.
    const retry = new InternalizationIntegrityRemediation({ workspaceDir }).repair({ dryRun: false });
    expect(retry.repairedCount).toBeGreaterThanOrEqual(4);
  }, 30_000);
});
