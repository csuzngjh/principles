/**
 * A12 — real command registration + functional contract for the retention
 * commands (cli-1 / cli-6 / cli-7):
 *
 *   pd trajectory maintain            [--json]
 *   pd trajectory retention status    [--json]
 *   pd trajectory vacuum              [--yes]
 *
 * Registration mirrors src/index.ts. The functional cases run the real handlers
 * against a temp workspace: `--json` emits exactly one parseable object, skip
 * paths carry reason + nextAction, and only genuine failure paths set a
 * non-zero exit code.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { applyTrajectorySchemaBase, getDefaultPdConfig } from '@principles/core/runtime';
import { buildPdProgram } from '../../src/index.js';
import {
  handleTrajectoryMaintain,
  handleTrajectoryRetentionStatus,
  handleTrajectoryVacuum,
  retentionExitCode,
} from '../../src/commands/trajectory-retention.js';
import type { TrajectoryRetentionReport } from '@principles/host-runtime';

const DAY_MS = 24 * 60 * 60 * 1000;
const dirs: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = undefined;
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  process.exitCode = undefined;
});

function findTrajectoryCommand(program: ReturnType<typeof buildPdProgram>) {
  return program.commands.find((command) => command.name() === 'trajectory');
}

function makeWorkspace(options: { config?: unknown; dbIsDirectory?: boolean } = {}): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-retention-cli-'));
  dirs.push(dir);
  fs.mkdirSync(path.join(dir, '.pd'), { recursive: true });
  if (options.config !== undefined) {
    fs.writeFileSync(path.join(dir, '.pd', 'config.yaml'), JSON.stringify(options.config), 'utf8');
  }
  fs.mkdirSync(path.join(dir, '.state'), { recursive: true });
  const dbPath = path.join(dir, '.state', 'trajectory.db');
  if (options.dbIsDirectory === true) {
    fs.mkdirSync(dbPath, { recursive: true });
    return dir;
  }
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  applyTrajectorySchemaBase(db, { views: false });
  const insert = db.prepare(
    'INSERT INTO tool_calls (session_id, tool_name, outcome, params_json, created_at) VALUES (?, ?, ?, ?, ?)',
  );
  insert.run('s1', 'read', 'ok', '{}', new Date(Date.now() - 200 * DAY_MS).toISOString());
  insert.run('s1', 'read', 'ok', '{}', new Date(Date.now() - 1 * DAY_MS).toISOString());
  db.close();
  return dir;
}

function captureJson(): () => Record<string, unknown> {
  const chunks: string[] = [];
  vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    chunks.push(args.map((a) => String(a)).join(' '));
  });
  return () => {
    expect(chunks).toHaveLength(1);
    const parsed: unknown = JSON.parse(chunks[0] ?? '');
    expect(typeof parsed).toBe('object');
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error('json_stdout_not_an_object');
    }
    return parsed as Record<string, unknown>;
  };
}

describe('retention command registration (cli-7)', () => {
  it('registers maintain / retention status / vacuum on the REAL program', () => {
    // Inspecting the real tree (not a hand-copied one) means a renamed command
    // or flag breaks this test; parsing it would execute the action handlers.
    const program = buildPdProgram();
    const trajectory = findTrajectoryCommand(program);
    expect(trajectory).toBeDefined();

    const maintain = trajectory?.commands.find((command) => command.name() === 'maintain');
    expect(maintain).toBeDefined();
    expect(maintain?.options.map((option) => option.long)).toEqual(
      expect.arrayContaining(['--workspace', '--json']),
    );

    const retention = trajectory?.commands.find((command) => command.name() === 'retention');
    const status = retention?.commands.find((command) => command.name() === 'status');
    expect(status).toBeDefined();
    expect(status?.options.map((option) => option.long)).toEqual(
      expect.arrayContaining(['--workspace', '--json']),
    );

    const vacuum = trajectory?.commands.find((command) => command.name() === 'vacuum');
    expect(vacuum).toBeDefined();
    expect(vacuum?.options.map((option) => option.long)).toEqual(
      expect.arrayContaining(['--workspace', '--yes', '--json']),
    );
  });
});

describe('retention command contract (cli-1 / cli-6)', () => {
  it('maintain --json prints exactly one object and exits 0 on success', async () => {
    const dir = makeWorkspace();
    const readJson = captureJson();

    await handleTrajectoryMaintain({ workspace: dir, json: true });

    const report = readJson();
    expect(report.outcome).toBe('completed');
    // Tables absent from this workspace (no governance_observations) are not
    // reported as "0 deleted" — the run only sweeps tables that exist.
    expect(report.deletedByTable).toEqual({
      tool_calls: 1,
      assistant_turns: 0,
      user_turns: 0,
    });
    expect(process.exitCode).toBeUndefined();

    // The expired row is gone, the recent one survives.
    const db = new Database(path.join(dir, '.state', 'trajectory.db'));
    expect(db.prepare('SELECT COUNT(*) AS c FROM tool_calls').get()).toEqual({ c: 1 });
    db.close();
  });

  it('a skipped run reports reason + nextAction and still exits 0 (SPEC §4.2)', async () => {
    const base: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(getDefaultPdConfig())) base[key] = value;
    base.trajectoryRetention = { retentionDays: 0 };
    const dir = makeWorkspace({ config: base });
    const readJson = captureJson();

    await handleTrajectoryMaintain({ workspace: dir, json: true });

    const report = readJson();
    expect(report.outcome).toBe('skipped');
    expect(report.reason).toBe('retention_days_zero');
    expect(typeof report.nextAction).toBe('string');
    expect(process.exitCode).toBeUndefined();
  });

  it('a genuine failure path exits non-zero and stays machine-readable', async () => {
    const dir = makeWorkspace({ dbIsDirectory: true });
    const readJson = captureJson();

    await handleTrajectoryMaintain({ workspace: dir, json: true });

    const report = readJson();
    expect(report.outcome).toBe('skipped');
    expect(String(report.reason)).toMatch(/^failed:/);
    expect(typeof report.nextAction).toBe('string');
    expect(process.exitCode).toBe(1);
  });

  it('retention status --json is read-only and reports the backlog', async () => {
    const dir = makeWorkspace();
    const readJson = captureJson();

    await handleTrajectoryRetentionStatus({ workspace: dir, json: true });

    const status = readJson();
    expect(status.dbExists).toBe(true);
    expect(status.markerError).toBeNull();
    expect(status.expiredByTable).toMatchObject({ tool_calls: 1 });
  });

  it('vacuum without --yes is a dry run; --yes is required to apply', async () => {
    const dir = makeWorkspace();
    const readJson = captureJson();

    await handleTrajectoryVacuum({ workspace: dir, yes: false, json: true });

    const report = readJson();
    expect(report.applied).toBe(false);
    expect(report.refusedReason).toBeNull();
    expect(String(report.nextAction)).toContain('--yes');
    expect(process.exitCode).toBeUndefined();
  });
});

describe('maintain exit code classification', () => {
  function makeReport(overrides: Partial<TrajectoryRetentionReport>): TrajectoryRetentionReport {
    return {
      outcome: 'completed',
      reason: null,
      workspaceDir: 'ws',
      cutoff: null,
      deletedByTable: {},
      batches: 0,
      durationMs: 0,
      totalDurationMs: 0,
      maxBatchDurationMs: 0,
      partial: false,
      backoffUntil: null,
      policy: { enabled: true, retentionDays: 90, intervalHours: 6, batchSize: 2000, runBudgetMs: 3000 },
      indexes: null,
      indexesError: null,
      ...overrides,
    };
  }

  it('fails only when a human must act; designed yields stay exit 0', () => {
    const cases: { label: string; report: TrajectoryRetentionReport; expected: 0 | 1 }[] = [
      // "Supposed to delete but didn't" → non-zero (review item 1).
      { label: 'audit_failed', report: makeReport({ outcome: 'partial', reason: 'audit_failed:disk full' }), expected: 1 },
      { label: 'failed', report: makeReport({ outcome: 'skipped', reason: 'failed:SQLITE_CORRUPT' }), expected: 1 },
      { label: 'config_invalid', report: makeReport({ outcome: 'skipped', reason: 'config_invalid: bad key' }), expected: 1 },
      { label: 'degraded', report: makeReport({ outcome: 'skipped', reason: 'degraded:retention_days_out_of_range' }), expected: 1 },
      { label: 'journal_mode', report: makeReport({ outcome: 'skipped', reason: 'journal_mode_not_wal:delete' }), expected: 1 },
      { label: 'clock_forward', report: makeReport({ outcome: 'skipped', reason: 'clock_forward_anomaly' }), expected: 1 },
      { label: 'clock_backwards', report: makeReport({ outcome: 'skipped', reason: 'clock_backwards' }), expected: 1 },
      { label: 'marker_bad_time', report: makeReport({ outcome: 'skipped', reason: 'marker_timestamp_invalid' }), expected: 1 },
      { label: 'index_failed', report: makeReport({ outcome: 'completed', reason: 'index_failed:locked' }), expected: 1 },
      { label: 'invariant', report: makeReport({ outcome: 'invariant_violation', reason: 'row_count_mismatch' }), expected: 1 },
      // Designed yields / intentional off / nothing to do → exit 0.
      { label: 'completed', report: makeReport({}), expected: 0 },
      { label: 'disabled', report: makeReport({ outcome: 'skipped', reason: 'retention_disabled' }), expected: 0 },
      { label: 'days_zero', report: makeReport({ outcome: 'skipped', reason: 'retention_days_zero' }), expected: 0 },
      { label: 'db_missing', report: makeReport({ outcome: 'skipped', reason: 'trajectory_db_missing' }), expected: 0 },
      { label: 'locked', report: makeReport({ outcome: 'skipped', reason: 'locked' }), expected: 0 },
      { label: 'not_due', report: makeReport({ outcome: 'skipped', reason: 'not_due: interval 6h' }), expected: 0 },
      { label: 'backoff', report: makeReport({ outcome: 'skipped', reason: 'backoff:until 2026-01-01T00:00:00.000Z' }), expected: 0 },
      { label: 'busy', report: makeReport({ outcome: 'deferred:busy', reason: 'sqlite_busy:database is locked' }), expected: 0 },
      { label: 'deadline', report: makeReport({ outcome: 'deadline', reason: 'run_budget_exhausted' }), expected: 0 },
      { label: 'batch_over_budget', report: makeReport({ outcome: 'partial', reason: 'batch_over_budget' }), expected: 0 },
      { label: 'no_progress', report: makeReport({ outcome: 'partial', reason: 'no_progress:tool_calls' }), expected: 0 },
    ];

    for (const testCase of cases) {
      expect(retentionExitCode(testCase.report), testCase.label).toBe(testCase.expected);
    }
  });

  it('a fail-closed audit failure exits non-zero and deletes nothing', async () => {
    const dir = makeWorkspace();
    // A file where the exports directory must be: every append fails.
    fs.writeFileSync(path.join(dir, '.state', 'exports'), 'not a directory', 'utf8');
    const readJson = captureJson();

    await handleTrajectoryMaintain({ workspace: dir, json: true });

    const report = readJson();
    expect(report.outcome).toBe('partial');
    expect(String(report.reason)).toMatch(/^audit_failed:/);
    // Fail closed: every table reports 0 deleted (the engine seeds a zero for
    // each table it reached before the audit refused the batch).
    expect(report.deletedByTable.tool_calls).toBe(0);
    expect(Object.values(report.deletedByTable as Record<string, number>).every((n) => n === 0)).toBe(true);
    expect(process.exitCode).toBe(1);

    const db = new Database(path.join(dir, '.state', 'trajectory.db'));
    expect(db.prepare('SELECT COUNT(*) AS c FROM tool_calls').get()).toEqual({ c: 2 });
    db.close();
  });
});
