/**
 * PRI-1135 (PRI-1104 Stage 2/3 verification):
 *   - every raw trajectory.db open path converges the schema_version row
 *     through the SAME core writer (no "physical v2 / version 1" lie);
 *   - hasProductionPainSchema stays a real runtime gate, with v1/v2
 *     characterization (audit T4) and a negative control (T5);
 *   - the plugin lifecycle no longer carries a private version-row write.
 *
 * All scenarios drive REAL production entry points against a real file-backed
 * SQLite database. No reimplemented migration and no in-memory surrogate for
 * the open-path assertions.
 */
import { readFileSync } from 'node:fs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { applyTrajectorySchemaBase, TRAJECTORY_SCHEMA_VERSION } from '@principles/core/runtime';
import {
  createProductionPainEvidenceHandler,
  hasProductionPainSchema,
  recordVerifiedToolOutcomes,
} from '../src/production-pain-evidence.js';
import { admitGovernanceSignals } from '../src/governance-signal-admission.js';

const workspaces: string[] = [];

function v1Workspace(): string {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-single-writer-'));
  workspaces.push(ws);
  const stateDir = path.join(ws, '.state');
  fs.mkdirSync(stateDir, { recursive: true });
  const db = new Database(path.join(stateDir, 'trajectory.db'));
  // A previous-release workspace: every required column is present, but the
  // retired GFI columns survive and the version row still claims v1.
  db.exec(`
    CREATE TABLE schema_version (version INTEGER NOT NULL);
    INSERT INTO schema_version (version) VALUES (1);
    CREATE TABLE sessions (session_id TEXT PRIMARY KEY, started_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE tool_calls (
      id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, tool_name TEXT NOT NULL,
      outcome TEXT NOT NULL, duration_ms INTEGER, exit_code INTEGER, error_type TEXT,
      error_message TEXT, gfi_before REAL, gfi_after REAL, params_json TEXT NOT NULL,
      result_preview TEXT, created_at TEXT NOT NULL, project_dir TEXT,
      tool_use_id TEXT, host_kind TEXT
    );
    CREATE TABLE pain_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, source TEXT NOT NULL,
      score REAL NOT NULL, reason TEXT, severity TEXT, origin TEXT, confidence REAL,
      text TEXT, canonical_pain_id TEXT, runtime_task_id TEXT, host_kind TEXT, created_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX idx_pain_events_canonical_pain_id
      ON pain_events(canonical_pain_id) WHERE canonical_pain_id IS NOT NULL;
  `);
  db.close();
  return ws;
}

function workspaceWithoutProjectDir(): string {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-single-writer-neg-'));
  workspaces.push(ws);
  fs.mkdirSync(path.join(ws, '.state'), { recursive: true });
  const db = new Database(path.join(ws, '.state', 'trajectory.db'));
  db.exec(`
    CREATE TABLE schema_version (version INTEGER NOT NULL);
    CREATE TABLE sessions (session_id TEXT PRIMARY KEY, started_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE tool_calls (
      id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, tool_name TEXT NOT NULL,
      outcome TEXT NOT NULL, params_json TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE TABLE pain_events (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, source TEXT NOT NULL, score REAL NOT NULL, created_at TEXT NOT NULL);
  `);
  db.close();
  return ws;
}

function withDb<T>(ws: string, fn: (db: Database.Database) => T): T {
  const db = new Database(path.join(ws, '.state', 'trajectory.db'));
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

function versionRow(ws: string): { value: unknown; count: number } {
  return withDb(ws, (db) => ({
    value: (db.prepare('SELECT version FROM schema_version LIMIT 1').get() as { version?: unknown } | undefined)?.version,
    count: (db.prepare('SELECT COUNT(*) AS c FROM schema_version').get() as { c: number }).c,
  }));
}

function gfiColumns(ws: string): string[] {
  return withDb(ws, (db) =>
    (db.prepare('PRAGMA table_info(tool_calls)').all() as { name: string }[])
      .map((r) => r.name)
      .filter((name) => name.startsWith('gfi_')),
  );
}

function expectConverged(ws: string): void {
  expect(versionRow(ws)).toEqual({ value: TRAJECTORY_SCHEMA_VERSION, count: 1 });
  expect(gfiColumns(ws)).toEqual([]);
}

afterEach(() => {
  for (const ws of workspaces.splice(0)) {
    fs.rmSync(ws, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
  }
});

describe('PRI-1135: every raw open path converges through the single version writer', () => {
  it('recordVerifiedToolOutcomes upgrades a v1 workspace and is idempotent (T3)', () => {
    const ws = v1Workspace();
    const outcomes = [{ toolUseId: 'tool-1', toolName: 'Read', exitCode: 0 }];

    recordVerifiedToolOutcomes({ workspaceDir: ws, sessionId: 'session-a', outcomes });
    expectConverged(ws);

    recordVerifiedToolOutcomes({ workspaceDir: ws, sessionId: 'session-a', outcomes });
    expectConverged(ws);
  });

  it('createProductionPainEvidenceHandler converges before the canonical verdict (T3)', async () => {
    const ws = v1Workspace();
    const handler = createProductionPainEvidenceHandler() as unknown as (event: never) => Promise<unknown>;
    const event = {
      kind: 'after_tool_call',
      context: {
        workspaceDir: ws,
        sessionId: 'session-b',
        turnId: 'turn-1',
        toolName: 'Read',
        toolCallId: 'tool-2',
        toolOutput: { result: { rendered: true } },
      },
      source: 'test:codex',
    } as never;

    await handler(event);
    expectConverged(ws);
  });

  it('openAdmissionStore converges through admitGovernanceSignals (T3)', () => {
    const ws = v1Workspace();
    admitGovernanceSignals({ workspaceDir: ws, candidates: [] });
    expectConverged(ws);
  });

  it('core applyTrajectorySchemaBase (pain-record open) converges too (T3)', () => {
    const ws = v1Workspace();
    withDb(ws, (db) => applyTrajectorySchemaBase(db));
    expectConverged(ws);
  });

  it('hasProductionPainSchema rejects a v1 database and accepts it after convergence (T4)', () => {
    const ws = v1Workspace();
    // v1 with retired GFI columns: not canonical even though every required
    // column is present — this is the GFI-COMPLETE-REMOVAL-001 guard.
    expect(withDb(ws, (db) => hasProductionPainSchema(db))).toBe(false);

    withDb(ws, (db) => applyTrajectorySchemaBase(db));
    expect(withDb(ws, (db) => hasProductionPainSchema(db))).toBe(true);
  });

  it('hasProductionPainSchema stays false when a required column is missing (T5 negative control)', () => {
    const ws = workspaceWithoutProjectDir();
    expect(gfiColumns(ws)).toEqual([]);
    expect(withDb(ws, (db) => hasProductionPainSchema(db))).toBe(false);
  });
});

describe('PRI-1135: single version-row writer guard', () => {
  it('the plugin lifecycle delegates to core instead of writing schema_version itself', () => {
    const src = readFileSync(
      new URL('../../openclaw-plugin/src/core/trajectory.ts', import.meta.url),
      'utf8',
    );
    expect(src).not.toMatch(/INSERT INTO schema_version|UPDATE schema_version SET version/);
    expect(src).toContain('convergeTrajectorySchemaVersion');
  });
});
