/**
 * PRI-985 / SPEC-PD-IAER-001 FR-09 — `pd runtime internalization
 * audit-artificer-evidence` command contract tests.
 *
 * Layers exercised (cli-7: test the real wiring, not internal helpers):
 * 1. Handler against a REAL SQLite state.db with the production schema
 *    (T11: scan a historical data copy; assert runs ≠ tasks, read-only
 *    evidence via mtime + sha256 unchanged, `--json` = exactly one object);
 * 2. Structured refusal when state.db does not exist (cli-5/cli-6: no
 *    mutation, no bootstrap, reason + nextAction);
 * 3. Parser-level Commander registration (pain-retry CMD-* precedent).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createHash } from 'crypto';
import { Command } from 'commander';
import Database from 'better-sqlite3';
import { SqliteConnection } from '@principles/core/runtime-v2';
import {
  handleRuntimeInternalizationAuditArtificerEvidence,
  registerRuntimeInternalizationAuditArtificerEvidenceCommand,
} from '../../src/commands/runtime-internalization-audit-artificer-evidence.js';

let workspaceDir: string;
let consoleLogSpy: ReturnType<typeof vi.spyOn>;

function stateDbPath(): string {
  return path.join(workspaceDir, '.pd', 'state.db');
}

function createStateDb(): Database.Database {
  // Production schema authority: SqliteConnection write-mode init (same DDL
  // the runtime creates) — the audit must work against the real layout.
  fs.mkdirSync(path.join(workspaceDir, '.pd'), { recursive: true });
  const db = new Database(stateDbPath());
  db.exec(`
    CREATE TABLE IF NOT EXISTS tasks (
      task_id TEXT PRIMARY KEY,
      task_kind TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      attempt_count INTEGER NOT NULL DEFAULT 0,
      max_attempts INTEGER NOT NULL DEFAULT 3
    );
    CREATE TABLE IF NOT EXISTS runs (
      run_id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      runtime_kind TEXT NOT NULL,
      execution_status TEXT NOT NULL DEFAULT 'queued',
      started_at TEXT NOT NULL,
      ended_at TEXT,
      reason TEXT,
      error_category TEXT,
      attempt_number INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS pi_artifacts (
      artifact_id TEXT PRIMARY KEY,
      artifact_kind TEXT NOT NULL,
      source_task_id TEXT NOT NULL,
      lineage_artifact_ids TEXT NOT NULL DEFAULT '[]',
      content_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS approvals (
      approval_id TEXT PRIMARY KEY,
      artifact_id TEXT NOT NULL,
      channel TEXT NOT NULL,
      risk_level TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      requested_at TEXT NOT NULL
    );
  `);
  return db;
}

interface FixtureOpts {
  withGovernance?: boolean;
}

function insertHistoricalFixtures(db: Database.Database, opts: FixtureOpts = {}): void {
  const insertTask = db.prepare(
    `INSERT INTO tasks (task_id, task_kind, status, created_at, updated_at, attempt_count, max_attempts)
     VALUES (?, 'artificer', ?, '2026-09-01T09:00:00.000Z', '2026-09-02T09:00:00.000Z', ?, 3)`,
  );
  const insertRun = db.prepare(
    `INSERT INTO runs (run_id, task_id, runtime_kind, execution_status, started_at, ended_at, reason, error_category, attempt_number, created_at, updated_at)
     VALUES (?, ?, ?, 'failed', ?, ?, 'behavior_example_pack_missing: pack assembly unavailable', ?, ?, '2026-09-01T09:00:00.000Z', '2026-09-01T09:01:00.000Z')`,
  );

  // Task A: needs_human_review, 2 failing runs across BOTH runtime kinds.
  insertTask.run('task-a', 'needs_human_review', 2);
  insertRun.run('run-a1', 'task-a', 'pi-ai-l2', '2026-09-01T10:00:00.000Z', '2026-09-01T10:01:00.000Z', 'execution_failed', 1);
  insertRun.run('run-a2', 'task-a', 'pi-ai', '2026-09-01T11:00:00.000Z', '2026-09-01T11:01:00.000Z', 'max_attempts_exceeded', 2);

  // Task B: failed, one failing run only.
  insertTask.run('task-b', 'failed', 3);
  insertRun.run('run-b1', 'task-b', 'pi-ai-l2', '2026-09-01T12:00:00.000Z', '2026-09-01T12:01:00.000Z', 'execution_failed', 3);

  // Noise that must NOT match: same reason but non-audited runtime kind;
  // audited runtime kind but different reason.
  insertRun.run('run-noise-kind', 'task-a', 'dreamer', '2026-09-01T13:00:00.000Z', '2026-09-01T13:01:00.000Z', 'execution_failed', 9);
  db.prepare(
    `INSERT INTO runs (run_id, task_id, runtime_kind, execution_status, started_at, ended_at, reason, error_category, attempt_number, created_at, updated_at)
     VALUES (?, 'task-a', 'pi-ai-l2', 'failed', '2026-09-01T14:00:00.000Z', '2026-09-01T14:01:00.000Z', 'some other failure', 'execution_failed', 8, '2026-09-01T09:00:00.000Z', '2026-09-01T09:01:00.000Z')`,
  ).run('run-noise-reason');

  if (opts.withGovernance) {
    // Task A produced an artifact that entered the approval queue.
    db.prepare(
      `INSERT INTO pi_artifacts (artifact_id, artifact_kind, source_task_id, lineage_artifact_ids, content_json, created_at, updated_at)
       VALUES ('art-1', 'principle', 'task-a', '[]', '{}', '2026-09-01T09:30:00.000Z', '2026-09-01T09:30:00.000Z')`,
    ).run();
    db.prepare(
      `INSERT INTO approvals (approval_id, artifact_id, channel, risk_level, status, requested_at)
       VALUES ('apr_1', 'art-1', 'code_tool_hook', 'high', 'pending', '2026-09-01T09:31:00.000Z')`,
    ).run();
  }
}

function dbFingerprint(): { mtimeMs: number; sha256: string } {
  const stat = fs.statSync(stateDbPath());
  const sha256 = createHash('sha256').update(fs.readFileSync(stateDbPath())).digest('hex');
  return { mtimeMs: stat.mtimeMs, sha256 };
}

async function runHandlerJson(): Promise<Record<string, unknown>> {
  await handleRuntimeInternalizationAuditArtificerEvidence({ workspace: workspaceDir, json: true });
  expect(consoleLogSpy.mock.calls).toHaveLength(1); // cli-1: exactly one stdout write
  return JSON.parse(consoleLogSpy.mock.calls[0][0] as string) as Record<string, unknown>;
}

beforeEach(() => {
  workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-audit-artificer-'));
  process.exitCode = 0;
  consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  consoleLogSpy.mockRestore();
  fs.rmSync(workspaceDir, { recursive: true, force: true });
});

describe('audit-artificer-evidence handler against a real state.db (T11)', () => {
  it('aggregates pack-missing runs by task, flags anomalies, and leaves the DB byte-identical', async () => {
    const db = createStateDb();
    insertHistoricalFixtures(db, { withGovernance: true });
    db.close();

    const before = dbFingerprint();
    const out = await runHandlerJson();
    const after = dbFingerprint();

    // Read-only evidence: state.db unchanged (content + mtime).
    expect(after.sha256).toBe(before.sha256);
    expect(after.mtimeMs).toBe(before.mtimeMs);

    expect(out.ok).toBe(true);
    expect(out.mode).toBe('read_only_audit');
    expect(out.status).toBe('complete');

    const summary = out.summary as Record<string, unknown>;
    // 3 matching runs (2 for task-a across both kinds + 1 for task-b) — noise excluded.
    expect(summary.totalRuns).toBe(3);
    expect(summary.distinctTasks).toBe(2); // runs are not tasks
    expect(summary.byRuntimeKind).toEqual({ 'pi-ai-l2': 2, 'pi-ai': 1 });
    expect(summary.byFinalTaskStatus).toEqual({ needs_human_review: 1, failed: 1 });

    const tasks = out.tasks as Array<Record<string, unknown>>;
    expect(tasks).toHaveLength(2);

    const taskA = tasks.find((t) => t.taskId === 'task-a') as Record<string, unknown>;
    expect(taskA.runCount).toBe(2);
    expect(taskA.taskStatus).toBe('needs_human_review');
    expect(taskA.attemptCount).toBe(2);
    expect(taskA.maxAttempts).toBe(3);
    expect(taskA.failureCategories).toEqual({ execution_failed: 1, max_attempts_exceeded: 1 });
    expect(taskA.firstFailureAt).toBe('2026-09-01T10:00:00.000Z');
    expect(taskA.lastFailureAt).toBe('2026-09-01T11:00:00.000Z');
    const anomaliesA = taskA.anomalies as Record<string, boolean>;
    expect(anomaliesA.repeatedRetryConsumption).toBe(true);
    expect(anomaliesA.hasGovernanceSideEffects).toBe(true);
    expect(anomaliesA.packMissingFailure).toBe(true);
    expect(String(taskA.nextAction)).toContain('pd runtime internalization retry --task task-a --confirm');

    const taskB = tasks.find((t) => t.taskId === 'task-b') as Record<string, unknown>;
    const anomaliesB = taskB.anomalies as Record<string, boolean>;
    expect(anomaliesB.repeatedRetryConsumption).toBe(false);
    expect(anomaliesB.hasGovernanceSideEffects).toBe(false);
    expect(String(taskB.nextAction)).toContain('pd runtime recovery failed-tasks --confirm');

    expect(out.governanceDetection).toContain('approvals');
  });

  it('reports succeeded_artifact_then_failed when a succeeded run exists and the task finally failed', async () => {
    const db = createStateDb();
    const insertTask = db.prepare(
      `INSERT INTO tasks (task_id, task_kind, status, created_at, updated_at, attempt_count, max_attempts)
       VALUES ('task-c', 'artificer', 'failed', '2026-09-01T09:00:00.000Z', '2026-09-02T09:00:00.000Z', 3, 3)`,
    );
    insertTask.run();
    db.prepare(
      `INSERT INTO runs (run_id, task_id, runtime_kind, execution_status, started_at, ended_at, reason, error_category, attempt_number, created_at, updated_at)
       VALUES
        ('run-c-succ', 'task-c', 'pi-ai-l2', 'succeeded', '2026-09-01T10:00:00.000Z', '2026-09-01T10:05:00.000Z', NULL, NULL, 1, '2026-09-01T10:00:00.000Z', '2026-09-01T10:05:00.000Z'),
        ('run-c-fail', 'task-c', 'pi-ai-l2', 'failed', '2026-09-01T11:00:00.000Z', '2026-09-01T11:01:00.000Z', 'behavior_example_pack_missing: retry', 'execution_failed', 2, '2026-09-01T11:00:00.000Z', '2026-09-01T11:01:00.000Z')`,
    ).run();
    db.close();

    const out = await runHandlerJson();
    const tasks = out.tasks as Array<Record<string, unknown>>;
    const taskC = tasks.find((t) => t.taskId === 'task-c') as Record<string, unknown>;
    expect((taskC.anomalies as Record<string, boolean>).succeededArtifactThenFailed).toBe(true);
    expect((taskC.anomalies as Record<string, boolean>).succeededRun).toBe(true);
  });

  // PRI-980 review P2-3 (FR-09 names successful 制品/artifacts): the marker
  // must be ARTIFACT-authoritative — a task whose runs all ended `failed` but
  // which produced a persisted artifact (pi_artifacts row, no approval trace)
  // was invisible to the succeeded-run proxy.
  it('flags succeeded_artifact_then_failed when all runs failed but pi_artifacts has a row (P2-3)', async () => {
    const db = createStateDb();
    db.prepare(
      `INSERT INTO tasks (task_id, task_kind, status, created_at, updated_at, attempt_count, max_attempts)
       VALUES ('task-d', 'artificer', 'failed', '2026-09-01T09:00:00.000Z', '2026-09-02T09:00:00.000Z', 3, 3)`,
    ).run();
    db.prepare(
      `INSERT INTO runs (run_id, task_id, runtime_kind, execution_status, started_at, ended_at, reason, error_category, attempt_number, created_at, updated_at)
       VALUES
        ('run-d1', 'task-d', 'pi-ai-l2', 'failed', '2026-09-01T10:00:00.000Z', '2026-09-01T10:01:00.000Z', 'behavior_example_pack_missing: retry', 'execution_failed', 1, '2026-09-01T10:00:00.000Z', '2026-09-01T10:01:00.000Z'),
        ('run-d2', 'task-d', 'pi-ai-l2', 'failed', '2026-09-01T11:00:00.000Z', '2026-09-01T11:01:00.000Z', 'behavior_example_pack_missing: retry', 'max_attempts_exceeded', 2, '2026-09-01T11:00:00.000Z', '2026-09-01T11:01:00.000Z')`,
    ).run();
    // The artifact WAS produced and persisted — but no approval row exists,
    // so only the new artifact signal can see it.
    db.prepare(
      `INSERT INTO pi_artifacts (artifact_id, artifact_kind, source_task_id, lineage_artifact_ids, content_json, created_at, updated_at)
       VALUES ('art-d-1', 'principle', 'task-d', '[]', '{}', '2026-09-01T10:30:00.000Z', '2026-09-01T10:30:00.000Z')`,
    ).run();
    db.close();

    const out = await runHandlerJson();
    const tasks = out.tasks as Array<Record<string, unknown>>;
    const taskD = tasks.find((t) => t.taskId === 'task-d') as Record<string, unknown>;
    const anomaliesD = taskD.anomalies as Record<string, boolean>;
    expect(anomaliesD.succeededArtifactThenFailed).toBe(true);
    expect(anomaliesD.succeededArtifact).toBe(true);
    expect(anomaliesD.succeededRun).toBe(false);
    // independence from the approvals join (governance stays false)
    expect(anomaliesD.hasGovernanceSideEffects).toBe(false);
  });

  it('returns a structured empty result (not an error) when nothing matches', async () => {
    createStateDb().close();

    const out = await runHandlerJson();
    expect(out.ok).toBe(true);
    expect(out.status).toBe('empty');
    expect(out.summary).toBeDefined();
    expect((out.summary as Record<string, unknown>).distinctTasks).toBe(0);
    expect(out.tasks).toEqual([]);
    expect(String(out.reason)).toContain('behavior_example_pack_missing');
    expect(String(out.nextAction)).toContain('workspace');
    expect(process.exitCode).toBe(0);
  });

  it('refuses structurally when state.db does not exist and creates nothing (cli-5/cli-6)', async () => {
    // workspaceDir exists but has no .pd/state.db at all.
    await handleRuntimeInternalizationAuditArtificerEvidence({ workspace: workspaceDir, json: true });

    expect(consoleLogSpy.mock.calls).toHaveLength(1);
    const out = JSON.parse(consoleLogSpy.mock.calls[0][0] as string) as Record<string, unknown>;
    expect(out.ok).toBe(false);
    expect(out.status).toBe('failed');
    expect(String(out.reason)).toBeTruthy();
    expect(String(out.nextAction)).toContain('pd runtime init');
    expect(process.exitCode).toBe(1);
    // cli-5: the refusal must not bootstrap the database.
    expect(fs.existsSync(path.join(workspaceDir, '.pd', 'state.db'))).toBe(false);
  });

  it('refuses structurally when the runs table is missing from an existing state.db', async () => {
    fs.mkdirSync(path.join(workspaceDir, '.pd'), { recursive: true });
    new Database(stateDbPath()).close();

    await handleRuntimeInternalizationAuditArtificerEvidence({ workspace: workspaceDir, json: true });

    const out = JSON.parse(consoleLogSpy.mock.calls[0][0] as string) as Record<string, unknown>;
    expect(out.ok).toBe(false);
    expect(out.status).toBe('failed');
    expect(String(out.reason)).toContain('no such table');
    expect(process.exitCode).toBe(1);
  });
});

describe('Commander wiring for audit-artificer-evidence', () => {
  function createProgram(): { program: Command; capturedOpts: Record<string, unknown> } {
    const program = new Command();
    program.exitOverride();
    const capturedOpts: Record<string, unknown> = {};
    const internalization = program.command('runtime').command('internalization');
    registerRuntimeInternalizationAuditArtificerEvidenceCommand(internalization, async (opts) => {
      Object.assign(capturedOpts, opts);
    });
    return { program, capturedOpts };
  }

  it('parses --workspace into opts.workspace', async () => {
    const { program, capturedOpts } = createProgram();
    await program.parseAsync(['node', 'pd', 'runtime', 'internalization', 'audit-artificer-evidence', '--workspace', 'D:/some/ws']);
    expect(capturedOpts.workspace).toBe('D:/some/ws');
  });

  it('parses -w short form', async () => {
    const { program, capturedOpts } = createProgram();
    await program.parseAsync(['node', 'pd', 'runtime', 'internalization', 'audit-artificer-evidence', '-w', 'relative/ws']);
    expect(capturedOpts.workspace).toBe('relative/ws');
  });

  it('--json sets opts.json === true; absent leaves it undefined', async () => {
    const withJson = createProgram();
    await withJson.program.parseAsync(['node', 'pd', 'runtime', 'internalization', 'audit-artificer-evidence', '--json']);
    expect(withJson.capturedOpts.json).toBe(true);

    const withoutJson = createProgram();
    await withoutJson.program.parseAsync(['node', 'pd', 'runtime', 'internalization', 'audit-artificer-evidence']);
    expect(withoutJson.capturedOpts.json).toBeUndefined();
  });

  it('runs with no required options (audit is read-only; nothing to confirm)', async () => {
    const { program, capturedOpts } = createProgram();
    await expect(
      program.parseAsync(['node', 'pd', 'runtime', 'internalization', 'audit-artificer-evidence']),
    ).resolves.toBeTruthy(); // parses and dispatches (no missing-required rejection)
    expect(capturedOpts.workspace).toBeUndefined();
  });
});
