/**
 * PRI-1274 / PRI-1283: waiting and consent-blocked dispositions on the
 * manual/split diagnosis entry are atomic with lease acquisition and
 * fail-closed on store read failures.
*/
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Mock } from 'vitest';
import { RuntimeStateManager } from '../../store/runtime-state-manager.js';
import { SplitDiagnosticianRunner } from '../split-diagnostician-runner.js';
import type { PeerRunnerResult } from '../../runner/peer-runner-types.js';
import type { TaskRecord } from '../../task-status.js';

const PARENT_TASK_ID = 'diagnosis_mcp_waiting_gate_1';

function makeSucceededResult<T>(taskId: string): PeerRunnerResult<T> {
  return { status: 'succeeded', taskId, attemptCount: 1 };
}

function makeMockRunner<T>() {
  const mock: { run: Mock; runWithDeadline: Mock } = {
    run: vi.fn().mockResolvedValue(makeSucceededResult<T>('')),
    runWithDeadline: vi.fn(),
  };
  mock.runWithDeadline.mockImplementation((taskId: string) => mock.run(taskId));
  return mock;
}

function makeMockCommitter() {
  return {
    commit: vi.fn().mockResolvedValue({ commitId: 'commit-1', artifactId: 'art-1' } as const),
  };
}

let workspaceDir: string;
let stateManager: RuntimeStateManager;

const WAITING_JSON = JSON.stringify({
  sourcePainId: 'mcp_waiting_gate_1',
  reasonSummary: 'r',
  source: 'manual',
  severity: 'moderate',
  sessionIdHint: null,
  provenance: 'owner_reported_no_host_trace',
  evidence: [],
  painIngress: {
    version: 'v1',
    origin: { kind: 'automatic_hook', source: 'codex:user_prompt' },
    correlation: { status: 'bound', hostKind: 'codex', rootSessionId: 's1', rolloutIdentity: 'r1', logicalObservationKey: 'codex|r|t|user', hostTurnId: 'turn-1' },
    evidenceClass: { status: 'unavailable', reason: 'target_turn_text_pending' },
  },
  // The gate reads `recovery.state` (the r2 persisted disposition shape).
  recovery: {
    schemaVersion: 1,
    state: 'waiting_for_target_evidence',
    reasonCode: 'target_turn_text_pending',
    attemptCount: 1,
    lastCheckedAt: '2026-11-22T10:00:00.000Z',
  },
  workspaceDir: null,
});


const WAITING_RECEIPT_JSON = JSON.stringify({
  sourcePainId: 'mcp_waiting_gate_1',
  reasonSummary: 'exact target-bearing receipt is unavailable',
  source: 'manual',
  severity: 'moderate',
  sessionIdHint: null,
  provenance: 'agent_reported_owner_approved',
  evidence: [],
  recovery: {
    schemaVersion: 1,
    state: 'waiting_for_receipt',
    reasonCode: 'target_turn_identity_unavailable',
    attemptCount: 1,
    lastCheckedAt: '2026-11-22T10:00:00.000Z',
  },
  workspaceDir: null,
});

const BLOCKED_JSON = JSON.stringify({
  sourcePainId: 'mcp_waiting_gate_1',
  reasonSummary: 'target turn is unavailable after source revocation',
  source: 'manual',
  severity: 'moderate',
  sessionIdHint: 's1',
  provenance: 'host_context_bound',
  evidence: [],
  recovery: {
    schemaVersion: 1,
    state: 'blocked_by_source_material_consent',
    reasonCode: 'target_turn_source_material_consent_revoked',
    attemptCount: 1,
    lastCheckedAt: '2026-11-22T10:00:00.000Z',
  },
  workspaceDir: null,
});

beforeEach(async () => {
  workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-wait-gate-'));
  stateManager = new RuntimeStateManager({ workspaceDir });
  await stateManager.initialize();
});

afterEach(async () => {
  await stateManager.close().catch(() => undefined);
  fs.rmSync(workspaceDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

function makeRunner(sm: RuntimeStateManager): { runner: SplitDiagnosticianRunner; rootCause: ReturnType<typeof makeMockRunner<unknown>> } {
  const rootCause = makeMockRunner<unknown>();
  const runner = new SplitDiagnosticianRunner({
    rootCauseRunner: rootCause as never,
    distillerRunner: makeMockRunner<unknown>() as never,
    routerRunner: makeMockRunner<unknown>() as never,
    stateManager: sm,
    committer: makeMockCommitter(),
    perStageTimeoutMs: 5_000,
  });
  return { runner, rootCause };
}

describe('PRI-1274 r2 H — atomic waiting gate on the split/manual diagnosis entry', () => {
  it('a stale pre-check snapshot cannot race the gate: the in-transaction predicate refuses the lease', async () => {
    await stateManager.createTask({
      taskId: PARENT_TASK_ID,
      taskKind: 'diagnostician',
      inputRef: 'mcp_waiting_gate_1',
      status: 'pending',
      attemptCount: 0,
      maxAttempts: 3,
      diagnosticJson: WAITING_JSON,
    });

    // The stale pre-check read: hand the runner a snapshot WITHOUT the
    // waiting disposition (the read→check→lease race window), while the
    // authoritative row stays waiting.
    const realGetTask = stateManager.getTask.bind(stateManager);
    const staleTask = async (id: string): Promise<TaskRecord | null> => {
      const observed = await realGetTask(id);
      if (observed === null || id !== PARENT_TASK_ID) return observed;
      return { ...observed, diagnosticJson: JSON.stringify({ ...JSON.parse(observed.diagnosticJson ?? '{}'), recovery: undefined }) };
    };
    const wrapped = Object.create(stateManager);
    wrapped.getTask = vi.fn(staleTask);

    const { runner, rootCause } = makeRunner(wrapped as RuntimeStateManager);
    const result = await runner.run(PARENT_TASK_ID);

    expect(result.status).toBe('failed');
    if (result.status === 'failed') {
      expect(result.errorCategory).toBe('input_invalid');
      expect(result.failureReason).toContain('target_evidence_pending');
      expect(result.attemptCount).toBe(0);
    }
    // Zero provider work: the stage runners never ran.
    expect(rootCause.run).not.toHaveBeenCalled();

    // The authoritative row is untouched: still pending, still waiting,
    // generation NOT incremented, no run record created.
    const task = await realGetTask(PARENT_TASK_ID);
    expect(task?.status).toBe('pending');
    expect((task?.leaseGeneration ?? 0)).toBe(0);
    expect(task?.diagnosticJson).toBe(WAITING_JSON);
    const runs = await stateManager.getRunsByTask(PARENT_TASK_ID);
    expect(runs.length).toBe(0);
  });

  it('a waiting_for_receipt task cannot lease or call providers before a target-bearing retry binds it', async () => {
    await stateManager.createTask({
      taskId: PARENT_TASK_ID,
      taskKind: 'diagnostician',
      inputRef: 'mcp_waiting_gate_1',
      status: 'pending',
      attemptCount: 0,
      maxAttempts: 3,
      diagnosticJson: WAITING_RECEIPT_JSON,
    });

    const { runner, rootCause } = makeRunner(stateManager);
    const result = await runner.run(PARENT_TASK_ID);

    expect(result.status).toBe('failed');
    if (result.status === 'failed') {
      expect(result.errorCategory).toBe('input_invalid');
      expect(result.failureReason).toContain('target_receipt_pending');
      expect(result.failureReason).toContain('target_turn_identity_unavailable');
      expect(result.attemptCount).toBe(0);
    }
    expect(rootCause.run).not.toHaveBeenCalled();
    const task = await stateManager.getTask(PARENT_TASK_ID);
    expect(task?.status).toBe('pending');
    expect(task?.leaseGeneration).toBe(0);
    expect(task?.diagnosticJson).toBe(WAITING_RECEIPT_JSON);
    expect(await stateManager.getRunsByTask(PARENT_TASK_ID)).toEqual([]);
  });

  it('a consent-blocked task cannot lease or call providers even when the fast pre-check is stale', async () => {
    await stateManager.createTask({
      taskId: PARENT_TASK_ID,
      taskKind: 'diagnostician',
      inputRef: 'mcp_waiting_gate_1',
      status: 'pending',
      attemptCount: 0,
      maxAttempts: 3,
      diagnosticJson: BLOCKED_JSON,
    });

    const realGetTask = stateManager.getTask.bind(stateManager);
    const staleTask = async (id: string): Promise<TaskRecord | null> => {
      const observed = await realGetTask(id);
      if (observed === null || id !== PARENT_TASK_ID) return observed;
      return {
        ...observed,
        diagnosticJson: JSON.stringify({
          ...JSON.parse(observed.diagnosticJson ?? '{}'),
          recovery: undefined,
        }),
      };
    };
    const wrapped = Object.create(stateManager);
    wrapped.getTask = vi.fn(staleTask);
    const { runner, rootCause } = makeRunner(wrapped as RuntimeStateManager);
    const result = await runner.run(PARENT_TASK_ID);

    expect(result.status).toBe('failed');
    if (result.status === 'failed') {
      expect(result.errorCategory).toBe('input_invalid');
      expect(result.failureReason).toContain('target_evidence_blocked_by_consent');
      expect(result.failureReason).toContain('target_turn_source_material_consent_revoked');
      expect(result.attemptCount).toBe(0);
    }
    expect(rootCause.run).not.toHaveBeenCalled();
    const task = await realGetTask(PARENT_TASK_ID);
    expect(task?.status).toBe('pending');
    expect(task?.leaseGeneration).toBe(0);
    expect(task?.diagnosticJson).toBe(BLOCKED_JSON);
    expect(await stateManager.getRunsByTask(PARENT_TASK_ID)).toEqual([]);
  });

  it('an unreadable authoritative task state fails CLOSED: no lease, no run, no provider', async () => {
    const wrapped = Object.create(stateManager);
    wrapped.getTask = vi.fn().mockRejectedValue(new Error('store read blew up'));
    const { runner, rootCause } = makeRunner(wrapped as RuntimeStateManager);

    const result = await runner.run(PARENT_TASK_ID);

    expect(result.status).toBe('failed');
    if (result.status === 'failed') {
      expect(result.errorCategory).toBe('storage_unavailable');
      expect(result.failureReason).toContain('target_evidence_gate_unreadable');
      expect(result.attemptCount).toBe(0);
    }
    expect(rootCause.run).not.toHaveBeenCalled();
    const runs = await stateManager.getRunsByTask(PARENT_TASK_ID);
    expect(runs.length).toBe(0);
  });

  it('a NON-waiting task passes both gates and acquires the lease normally', async () => {
    await stateManager.createTask({
      taskId: PARENT_TASK_ID,
      taskKind: 'diagnostician',
      inputRef: 'mcp_waiting_gate_1',
      status: 'pending',
      attemptCount: 0,
      maxAttempts: 3,
      diagnosticJson: JSON.stringify({
        sourcePainId: 'mcp_waiting_gate_1', reasonSummary: 'r', source: 'manual', severity: 'moderate',
        sessionIdHint: null, provenance: 'owner_reported_no_host_trace', evidence: [], workspaceDir: null,
      }),
    });
    const { runner } = makeRunner(stateManager);
    const result = await runner.run(PARENT_TASK_ID);
    // The chain proceeds past acquisition (mock stage runners succeed).
    expect(result.status).not.toBe('failed');
    const task = await stateManager.getTask(PARENT_TASK_ID);
    expect(['leased', 'succeeded']).toContain(task?.status);
  });
});
