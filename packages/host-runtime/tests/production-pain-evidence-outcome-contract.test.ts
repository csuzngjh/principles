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
import { afterEach, describe, expect, it } from 'vitest';
import type { HostEvent } from '@principles/core/host';
import { createProductionHostRuntime } from '../src/index.js';
import {
  deriveProductionToolPainIdentity,
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
  db.exec('CREATE TABLE tool_calls (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, tool_name TEXT NOT NULL, outcome TEXT NOT NULL, duration_ms INTEGER, exit_code INTEGER, error_type TEXT, error_message TEXT, gfi_before REAL, gfi_after REAL, params_json TEXT NOT NULL, result_preview TEXT, created_at TEXT NOT NULL)');
  db.exec('CREATE TABLE pain_events (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, source TEXT NOT NULL, score REAL NOT NULL, reason TEXT, severity TEXT, origin TEXT, confidence REAL, text TEXT, canonical_pain_id TEXT, runtime_task_id TEXT, host_kind TEXT, created_at TEXT NOT NULL)');
  db.exec('CREATE UNIQUE INDEX idx_pain_events_canonical_pain_id ON pain_events(canonical_pain_id) WHERE canonical_pain_id IS NOT NULL');
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
    expect(result.metadata).toEqual(expect.objectContaining({ outcome: 'failure', admitted: false }));
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
    expect(result.metadata).toEqual(expect.objectContaining({ outcome: 'success', admitted: false }));
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
      admitted: false,
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

  it('exposes the classification through the public identity derivation (parity with the installed pure function)', () => {
    const stringIdentity = deriveProductionToolPainIdentity({
      workspaceDir: 'D:/ws/probe', sessionId: 's', toolName: 'Bash',
      toolInput: { invocation: 'probe-alpha' }, toolOutput: 'probe summary: 1 failed', source: 'codex:post_tool_use',
    });
    expect(stringIdentity.outcome.outcome).toBe('unknown');
    expect(stringIdentity.outcome.exitCode).toBeNull();
    const snakeIdentity = deriveProductionToolPainIdentity({
      workspaceDir: 'D:/ws/probe', sessionId: 's', toolName: 'Bash',
      toolInput: { invocation: 'probe-alpha' }, toolOutput: { exit_code: 1 }, source: 'codex:post_tool_use',
    });
    expect(snakeIdentity.outcome.outcome).toBe('failure');
    expect(snakeIdentity.outcome.exitCode).toBe(1);
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

  it('reports unavailable when the trajectory database does not exist (rc-9, no fabricated success)', () => {
    const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-outcome-nodb-'));
    workspaces.push(workspaceDir);
    const results = recordVerifiedToolOutcomes({
      workspaceDir, sessionId: 's',
      outcomes: [{ toolUseId: 'x', toolName: 'Bash', exitCode: 1 }],
    });
    expect(results).toEqual([{ status: 'unavailable', reason: 'trajectory_db_not_found' }]);
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
