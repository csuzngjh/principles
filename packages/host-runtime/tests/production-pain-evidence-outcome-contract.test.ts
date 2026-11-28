/**
 * SPEC-CODEX-PAIN-CLOSURE-001 CR-01 / PRI-960 — three-valued tool outcome
 * contract regression tests.
 *
 * Negative control: every "must not be silent success" case below FAILS on
 * the pre-fix classifier (missing exit code defaulted to 0/success and only
 * camelCase exitCode was read — verified against installed 2.3.3 behavior
 * and the 6 misrecorded rows in PRI-960).
 *
 * Fixture toolInput values are inert data shapes (never executed).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { HostEvent } from '@principles/core/host';
import { applyTrajectorySchemaBase } from '@principles/core/runtime';
import { createProductionHostRuntime } from '../src/index.js';
import {
  recordVerifiedToolOutcomes,
} from '../src/production-pain-evidence.js';

const workspaces: string[] = [];

function workspaceWithTrajectory(): string {
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-outcome-contract-'));
  workspaces.push(workspaceDir);
  const stateDir = path.join(workspaceDir, '.state');
  fs.mkdirSync(stateDir, { recursive: true });
  const db = new Database(path.join(stateDir, 'trajectory.db'));
  // Pre-CR-01 schema (no tool_use_id) — the production ensure must migrate it.
  db.exec('CREATE TABLE sessions (session_id TEXT PRIMARY KEY, started_at TEXT NOT NULL, updated_at TEXT NOT NULL)');
  db.exec('CREATE TABLE tool_calls (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, tool_name TEXT NOT NULL, outcome TEXT NOT NULL, duration_ms INTEGER, exit_code INTEGER, error_type TEXT, error_message TEXT, params_json TEXT NOT NULL, result_preview TEXT, created_at TEXT NOT NULL)');
  db.exec('CREATE TABLE pain_events (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, source TEXT NOT NULL, score REAL NOT NULL, reason TEXT, severity TEXT, origin TEXT, confidence REAL, text TEXT, canonical_pain_id TEXT, runtime_task_id TEXT, host_kind TEXT, created_at TEXT NOT NULL)');
  db.exec('CREATE UNIQUE INDEX idx_pain_events_canonical_pain_id ON pain_events(canonical_pain_id) WHERE canonical_pain_id IS NOT NULL');
  db.close();
  return workspaceDir;
}

function workspaceWithCanonicalTrajectory(): string {
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-outcome-canonical-'));
  workspaces.push(workspaceDir);
  const stateDir = path.join(workspaceDir, '.state');
  fs.mkdirSync(stateDir, { recursive: true });
  const db = new Database(path.join(stateDir, 'trajectory.db'));
  applyTrajectorySchemaBase(db);
  db.close();
  return workspaceDir;
}

function toolEvent(workspaceDir: string, toolOutput: unknown, overrides: Partial<HostEvent['context']> = {}): HostEvent {
  return {
    kind: 'after_tool_call',
    context: {
      workspaceDir,
      sessionId: 'session-cr01',
      turnId: 'turn-cr01',
      toolName: 'Bash',
      toolInput: { invocation: 'probe-alpha' },
      toolOutput,
      ...overrides,
    },
    rawPayload: { host: 'fixture' },
    source: 'codex:post_tool_use',
  };
}

function readRow(workspaceDir: string, sql: string): Record<string, unknown> {
  const db = new Database(path.join(workspaceDir, '.state', 'trajectory.db'), { readonly: true });
  try {
    return db.prepare(sql).get() as Record<string, unknown>;
  } finally {
    db.close();
  }
}

afterEach(() => {
  vi.useRealTimers();
  for (const workspaceDir of workspaces.splice(0)) {
    fs.rmSync(workspaceDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
  }
});

describe('CR-01 three-valued outcome classification (PRI-960)', () => {
  it.each([
    ['snake_case exit_code at result level', { result: { exit_code: 1 } }],
    ['snake_case exit_code at envelope level', { exit_code: 1, result: 'output text' }],
    ['camelCase exitCode at result level', { result: { exitCode: 2 } }],
    ['camelCase exitCode at envelope level', { exitCode: 2 }],
    ['snake_case exit_code under details', { result: { details: { exit_code: 3 } } }],
    ['snake_case exit_code under metadata (shell protocol shape)', { output: 'probe-output', metadata: { exit_code: 1 } }],
  ])('classifies %s as failure with the real exit code', async (_label, toolOutput) => {
    const workspaceDir = workspaceWithTrajectory();
    const runtime = createProductionHostRuntime();
    const result = await runtime.dispatch(toolEvent(workspaceDir, toolOutput));
    expect(result.metadata).toEqual(expect.objectContaining({ outcome: 'failure' }));
    const row = readRow(workspaceDir, 'SELECT outcome, exit_code FROM tool_calls');
    expect(row.outcome).toBe('failure');
    expect(row.exit_code).not.toBe(0);
    expect(row.exit_code).not.toBeNull();
  });

  it.each([
    ['camelCase exitCode 0', { result: { exitCode: 0 } }],
    ['snake_case exit_code 0', { exit_code: 0, output: 'probe-output' }],
    ['structured MCP-style read result', { result: { content: [{ type: 'text', text: 'probe-data' }] } }],
  ])('classifies %s as success', async (_label, toolOutput) => {
    const workspaceDir = workspaceWithTrajectory();
    const runtime = createProductionHostRuntime();
    const result = await runtime.dispatch(toolEvent(workspaceDir, toolOutput));
    expect(result.metadata).toEqual(expect.objectContaining({ outcome: 'success' }));
    expect(readRow(workspaceDir, 'SELECT outcome FROM tool_calls').outcome).toBe('success');
  });

  it.each([
    ['plain string response (Codex live PostToolUse shape)', 'probe summary: 1 failed, 54 passed'],
    ['result string with failure summary', { result: 'probe summary: 2 failed' }],
    ['result string mentioning success words', { result: 'probe summary: success words only' }],
  ])('records %s as unknown — never silent success, never keyword-guessed failure', async (_label, toolOutput) => {
    const workspaceDir = workspaceWithTrajectory();
    const runtime = createProductionHostRuntime();
    const result = await runtime.dispatch(toolEvent(workspaceDir, toolOutput));
    expect(result.metadata).toEqual(expect.objectContaining({
      outcome: 'unknown',
      outcomeReason: 'text_only_response',
      exitCode: null,
    }));
    const row = readRow(workspaceDir, 'SELECT outcome, exit_code FROM tool_calls');
    expect(row.outcome).toBe('unknown');
    expect(row.exit_code).toBeNull();
  });

  it('keeps error-field failures as failure even without an exit code', async () => {
    const workspaceDir = workspaceWithTrajectory();
    const runtime = createProductionHostRuntime();
    const result = await runtime.dispatch(toolEvent(workspaceDir, { error: 'EACCES permission denied' }));
    expect(result.metadata).toEqual(expect.objectContaining({ outcome: 'failure' }));
    expect(readRow(workspaceDir, 'SELECT outcome FROM tool_calls').outcome).toBe('failure');
  });

  it('records the host tool-call id and dedupes replays by it even after a verified upgrade changed the row', async () => {
    const workspaceDir = workspaceWithTrajectory();
    const runtime = createProductionHostRuntime();
    const event = toolEvent(workspaceDir, 'probe raw output text', { toolCallId: 'exec-cr01-1' });
    await runtime.dispatch(event);
    expect(readRow(workspaceDir, 'SELECT tool_use_id FROM tool_calls').tool_use_id).toBe('exec-cr01-1');
    recordVerifiedToolOutcomes({
      workspaceDir, sessionId: 'session-cr01',
      outcomes: [{ toolUseId: 'exec-cr01-1', toolName: 'Bash', exitCode: 1, outputPreview: 'probe failure detail' }],
    });
    expect(readRow(workspaceDir, 'SELECT outcome, exit_code, result_preview FROM tool_calls')).toEqual(
      expect.objectContaining({ outcome: 'failure', exit_code: 1, result_preview: 'probe failure detail' }),
    );
    // Replay of the same live hook event must dedup on the tool-call id.
    const replay = await runtime.dispatch(event);
    expect(replay.metadata).toEqual(expect.objectContaining({ duplicate: true }));
    expect(readRow(workspaceDir, 'SELECT COUNT(*) AS n FROM tool_calls').n).toBe(1);
  });
});

describe('CR-01 verified-outcome upgrade (recordVerifiedToolOutcomes)', () => {
  it('upgrades an unknown live row with the host-verified exit code', async () => {
    const workspaceDir = workspaceWithTrajectory();
    const runtime = createProductionHostRuntime();
    await runtime.dispatch(toolEvent(workspaceDir, 'probe failing text', { toolCallId: 'exec-verify-1' }));
    const results = recordVerifiedToolOutcomes({
      workspaceDir, sessionId: 'session-cr01',
      outcomes: [{ toolUseId: 'exec-verify-1', toolName: 'Bash', params: ['probe-step-one', 'probe-step-two'], exitCode: 1, outputPreview: 'probe failure detail' }],
    });
    expect(results).toEqual([{ status: 'updated', id: expect.any(Number) }]);
    expect(readRow(workspaceDir, 'SELECT outcome, exit_code FROM tool_calls')).toEqual({ outcome: 'failure', exit_code: 1 });
  });

  it('never overwrites a structured live fact (already-final outcomes are skipped)', async () => {
    const workspaceDir = workspaceWithTrajectory();
    const runtime = createProductionHostRuntime();
    await runtime.dispatch(toolEvent(workspaceDir, { result: { exitCode: 0 } }, { toolCallId: 'exec-verify-2' }));
    const results = recordVerifiedToolOutcomes({
      workspaceDir, sessionId: 'session-cr01',
      outcomes: [{ toolUseId: 'exec-verify-2', toolName: 'Bash', exitCode: 1 }],
    });
    expect(results).toEqual([{ status: 'skipped_final', id: expect.any(Number), reason: 'outcome_already_final' }]);
    expect(readRow(workspaceDir, 'SELECT outcome, exit_code FROM tool_calls')).toEqual({ outcome: 'success', exit_code: 0 });
  });

  it('never overwrites an already-final failure with a later verified success', async () => {
    const workspaceDir = workspaceWithTrajectory();
    const runtime = createProductionHostRuntime({ hostKind: 'codex', projectDir: workspaceDir });
    await runtime.dispatch(toolEvent(workspaceDir, { result: { exitCode: 2 } }, { toolCallId: 'exec-final-failure' }));
    const results = recordVerifiedToolOutcomes({
      workspaceDir, sessionId: 'session-cr01', hostKind: 'codex',
      outcomes: [{ toolUseId: 'exec-final-failure', toolName: 'Bash', exitCode: 0 }],
    });
    expect(results).toEqual([{ status: 'skipped_final', id: expect.any(Number), reason: 'outcome_already_final' }]);
    expect(readRow(workspaceDir, 'SELECT outcome, exit_code FROM tool_calls')).toEqual({ outcome: 'failure', exit_code: 2 });
  });

  it('inserts a verified row when the live hook never fired', () => {
    const workspaceDir = workspaceWithTrajectory();
    const results = recordVerifiedToolOutcomes({
      workspaceDir, sessionId: 'session-cr01',
      outcomes: [{ toolUseId: 'exec-verify-3', toolName: 'Bash', params: ['probe-step-one'], exitCode: 1, outputPreview: 'probe failure detail' }],
    });
    expect(results).toEqual([{ status: 'inserted', id: expect.any(Number) }]);
    expect(readRow(workspaceDir, 'SELECT outcome, exit_code, tool_use_id FROM tool_calls')).toEqual(
      expect.objectContaining({ outcome: 'failure', exit_code: 1, tool_use_id: 'exec-verify-3' }),
    );
  });

  it('preserves row identity and write time during an unknown-to-known UPDATE', async () => {
    vi.useFakeTimers();
    const workspaceDir = workspaceWithTrajectory();
    const runtime = createProductionHostRuntime({ hostKind: 'codex', projectDir: workspaceDir });
    vi.setSystemTime(new Date('2026-02-01T10:00:00.000Z'));
    await runtime.dispatch(toolEvent(workspaceDir, 'probe raw output text', { toolCallId: 'exec-update-invariant' }));
    const before = readRow(workspaceDir, 'SELECT * FROM tool_calls');

    vi.setSystemTime(new Date('2026-02-01T10:15:00.000Z'));
    const results = recordVerifiedToolOutcomes({
      workspaceDir,
      sessionId: 'session-cr01',
      hostKind: 'codex',
      outcomes: [{ toolUseId: 'exec-update-invariant', toolName: 'Bash', exitCode: 1, outputPreview: 'verified failure detail' }],
    });
    const after = readRow(workspaceDir, 'SELECT * FROM tool_calls');

    expect(results).toEqual([{ status: 'updated', id: before.id }]);
    expect(after).toEqual(expect.objectContaining({ outcome: 'failure', exit_code: 1, result_preview: 'verified failure detail' }));
    expect({
      id: after.id,
      session_id: after.session_id,
      tool_name: after.tool_name,
      duration_ms: after.duration_ms,
      error_type: after.error_type,
      error_message: after.error_message,
      params_json: after.params_json,
      created_at: after.created_at,
      tool_use_id: after.tool_use_id,
      project_dir: after.project_dir,
      host_kind: after.host_kind,
    }).toEqual({
      id: before.id,
      session_id: before.session_id,
      tool_name: before.tool_name,
      duration_ms: before.duration_ms,
      error_type: before.error_type,
      error_message: before.error_message,
      params_json: before.params_json,
      created_at: before.created_at,
      tool_use_id: before.tool_use_id,
      project_dir: before.project_dir,
      host_kind: before.host_kind,
    });
    // The verification happened fifteen minutes after the row was written;
    // created_at remains the live-write time. It is not an action-occurrence
    // timestamp, and the UPDATE does not create any occurredAt-like evidence.
    expect(after.created_at).toBe('2026-02-01T10:00:00.000Z');
    expect(Object.keys(after)).not.toContain('occurredAt');
    expect(Object.keys(after)).not.toContain('occurred_at');
  });

  it('upgrades exitCode zero to success and preserves the live result_preview when no verified preview is supplied', async () => {
    const workspaceDir = workspaceWithTrajectory();
    const runtime = createProductionHostRuntime({ hostKind: 'codex', projectDir: workspaceDir });
    await runtime.dispatch(toolEvent(workspaceDir, 'probe raw output text', { toolCallId: 'exec-update-success' }));
    const before = readRow(workspaceDir, 'SELECT result_preview FROM tool_calls');
    expect(typeof before.result_preview).toBe('string');

    const results = recordVerifiedToolOutcomes({
      workspaceDir,
      sessionId: 'session-cr01',
      hostKind: 'codex',
      outcomes: [{ toolUseId: 'exec-update-success', toolName: 'Bash', exitCode: 0 }],
    });

    expect(results).toEqual([{ status: 'updated', id: expect.any(Number) }]);
    expect(readRow(workspaceDir, 'SELECT outcome, exit_code, result_preview FROM tool_calls')).toEqual({
      outcome: 'success',
      exit_code: 0,
      result_preview: before.result_preview,
    });
  });

  it('writes the current verified INSERT shape as a late backfill row without project_dir', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-02-01T11:30:00.000Z'));
    const workspaceDir = workspaceWithCanonicalTrajectory();
    const params = { command: 'probe verified insert', mode: 'fixture-only' };
    const results = recordVerifiedToolOutcomes({
      workspaceDir,
      sessionId: 'session-cr01',
      hostKind: 'codex',
      outcomes: [{ toolUseId: 'exec-insert-shape', toolName: 'Bash', params, exitCode: 0, outputPreview: 'verified output' }],
    });
    const row = readRow(workspaceDir, 'SELECT * FROM tool_calls');

    expect(results).toEqual([{ status: 'inserted', id: expect.any(Number) }]);
    expect(row).toEqual(expect.objectContaining({
      session_id: 'session-cr01',
      tool_name: 'Bash',
      outcome: 'success',
      duration_ms: null,
      exit_code: 0,
      error_type: null,
      error_message: null,
      result_preview: 'verified output',
      created_at: '2026-02-01T11:30:00.000Z',
      tool_use_id: 'exec-insert-shape',
      host_kind: 'codex',
      // Registered production limitation R6: verified INSERT currently does
      // not write project scope. This test freezes that fact; it does not fix it.
      project_dir: null,
    }));
    expect(JSON.parse(String(row.params_json))).toEqual(params);
    expect(Object.keys(row)).not.toContain('occurredAt');
    expect(Object.keys(row)).not.toContain('occurred_at');
  });

  it('treats a pre-existing blocked row as final for verified upgrade purposes', async () => {
    const workspaceDir = workspaceWithTrajectory();
    const runtime = createProductionHostRuntime({ hostKind: 'codex', projectDir: workspaceDir });
    await runtime.dispatch(toolEvent(workspaceDir, { result: { exitCode: 0 } }, { toolCallId: 'exec-blocked-candidate' }));
    // No current production writer emits `blocked`; this manually seeded row
    // characterizes only how the existing verified-upgrader treats that
    // RuleContextV2 contract value if it is already present in storage.
    const db = new Database(path.join(workspaceDir, '.state', 'trajectory.db'));
    db.prepare('UPDATE tool_calls SET outcome = ?, exit_code = NULL WHERE tool_use_id = ?').run('blocked', 'exec-blocked-candidate');
    db.close();

    const results = recordVerifiedToolOutcomes({
      workspaceDir,
      sessionId: 'session-cr01',
      hostKind: 'codex',
      outcomes: [{ toolUseId: 'exec-blocked-candidate', toolName: 'Bash', exitCode: 1, outputPreview: 'must not overwrite' }],
    });

    expect(results).toEqual([{ status: 'skipped_final', id: expect.any(Number), reason: 'outcome_already_final' }]);
    expect(readRow(workspaceDir, 'SELECT outcome, exit_code, result_preview FROM tool_calls')).toEqual(
      expect.objectContaining({ outcome: 'blocked', exit_code: null }),
    );
  });

  it('cannot upgrade a live row that has no host tool-use identity and inserts a separate verified fact instead', async () => {
    const workspaceDir = workspaceWithTrajectory();
    const runtime = createProductionHostRuntime({ hostKind: 'codex', projectDir: workspaceDir });
    await runtime.dispatch(toolEvent(workspaceDir, 'probe raw output without call identity'));

    const results = recordVerifiedToolOutcomes({
      workspaceDir,
      sessionId: 'session-cr01',
      hostKind: 'codex',
      outcomes: [{ toolUseId: 'exec-arrived-only-in-transcript', toolName: 'Bash', exitCode: 1 }],
    });
    const rows = (() => {
      const db = new Database(path.join(workspaceDir, '.state', 'trajectory.db'), { readonly: true });
      try {
        return db.prepare('SELECT outcome, tool_use_id FROM tool_calls ORDER BY id').all() as Record<string, unknown>[];
      } finally {
        db.close();
      }
    })();

    expect(results).toEqual([{ status: 'inserted', id: expect.any(Number) }]);
    expect(rows).toEqual([
      expect.objectContaining({ outcome: 'unknown', tool_use_id: null }),
      expect.objectContaining({ outcome: 'failure', tool_use_id: 'exec-arrived-only-in-transcript' }),
    ]);
  });

  it('silently drops a non-integer verified exit code without any per-input status', () => {
    const workspaceDir = workspaceWithCanonicalTrajectory();
    const results = recordVerifiedToolOutcomes({
      workspaceDir,
      sessionId: 'session-cr01',
      hostKind: 'codex',
      outcomes: [{ toolUseId: 'exec-non-integer-exit', toolName: 'Bash', exitCode: 1.5 }],
    });

    expect(results).toEqual([]);
    expect(readRow(workspaceDir, 'SELECT COUNT(*) AS n FROM tool_calls').n).toBe(0);
  });

  it('reports unavailable when the trajectory database does not exist (rc-9, no fabricated success)', () => {
    const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-outcome-nodb-'));
    workspaces.push(workspaceDir);
    const results = recordVerifiedToolOutcomes({
      workspaceDir, sessionId: 's',
      outcomes: [{ toolUseId: 'x', toolName: 'Bash', exitCode: 1 }],
    });
    expect(results).toEqual([{ status: 'unavailable', reason: 'trajectory_db_not_found' }]);
  });

  it('characterizes the current transaction-status accounting defect when a later verified insert aborts the batch', () => {
    const workspaceDir = workspaceWithCanonicalTrajectory();
    const db = new Database(path.join(workspaceDir, '.state', 'trajectory.db'));
    db.exec(`CREATE TRIGGER fail_verified_insert BEFORE INSERT ON tool_calls
      WHEN NEW.tool_use_id = 'exec-forced-abort'
      BEGIN SELECT RAISE(ABORT, 'forced verified insert abort'); END`);
    db.close();

    const results = recordVerifiedToolOutcomes({
      workspaceDir,
      sessionId: 'session-cr01',
      hostKind: 'codex',
      outcomes: [
        { toolUseId: 'exec-committed-only-in-report', toolName: 'Bash', exitCode: 0 },
        { toolUseId: 'exec-forced-abort', toolName: 'Bash', exitCode: 1 },
      ],
    });

    // Current defect characterization: SQLite rolls back the whole batch, but
    // the first JS-side success status is not rolled back. This must not be
    // read as proof that the first row is durable.
    expect(results[0]).toEqual({ status: 'inserted', id: expect.any(Number) });
    expect(results[1]?.status).toBe('unavailable');
    expect(String(results[1]?.status === 'unavailable' ? results[1].reason : '')).toContain('trajectory_write_failed');
    expect(readRow(workspaceDir, 'SELECT COUNT(*) AS n FROM tool_calls').n).toBe(0);
  });

  it('is idempotent: re-running the same upgrade does not duplicate facts', () => {
    const workspaceDir = workspaceWithTrajectory();
    const outcomes = [{ toolUseId: 'exec-verify-4', toolName: 'Bash', exitCode: 1, outputPreview: 'probe failure detail' }];
    recordVerifiedToolOutcomes({ workspaceDir, sessionId: 'session-cr01', outcomes });
    const second = recordVerifiedToolOutcomes({ workspaceDir, sessionId: 'session-cr01', outcomes });
    expect(second[0]).toEqual(expect.objectContaining({ status: 'skipped_final' }));
    expect(readRow(workspaceDir, 'SELECT COUNT(*) AS n FROM tool_calls').n).toBe(1);
  });
});
