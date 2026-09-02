/**
 * PRI-624 (Codex Closure Slice C): PainSignalBridge.executePendingDiagnosis —
 * the async counterpart of submitPainSignal. A worker advances an
 * already-submitted Diagnostician task WITHOUT resetting retry state
 * (unlike onPainDetected, which resets attemptCount on re-trigger).
 */
import { describe, it, expect, vi } from 'vitest';
import type { RuntimeStateManager } from '../store/runtime-state-manager.js';
import type { TaskRecord } from '../task-status.js';
import type { DiagnosticianRunnerLike } from '../pain-signal-bridge.js';
import type { CandidateIntakeService } from '../candidate-intake-service.js';
import type { LedgerAdapter } from '../candidate-intake.js';
import { PainSignalBridge } from '../pain-signal-bridge.js';
import type { RunnerResult } from '../runner/runner-result.js';

const TASK_ID = 'diagnosis_pain-1';
const PAIN_ID = 'pain-1';

/** Realistic payload as buildDiagnosticJson writes it (PRI-642: re-entry reads it). */
const DIAGNOSTIC_JSON = JSON.stringify({
  sourcePainId: PAIN_ID,
  reasonSummary: 'test pain',
  source: 'manual',
  severity: 'moderate',
  sessionIdHint: null,
  agentIdHint: null,
  provenance: 'host_context_bound',
  provenanceReason: 'Pain reported from an authenticated host session with a bound host context',
  evidence: [],
  workspaceDir: null,
});

function taskRecord(overrides: Partial<TaskRecord>): TaskRecord {
  return {
    taskId: TASK_ID,
    taskKind: 'diagnostician',
    status: 'pending',
    createdAt: '2026-08-31T00:00:00.000Z',
    updatedAt: '2026-08-31T00:00:00.000Z',
    attemptCount: 0,
    maxAttempts: 3,
    inputRef: PAIN_ID,
    diagnosticJson: DIAGNOSTIC_JSON,
    ...overrides,
  };
}

function createBridge(task: TaskRecord | null, runResult: RunnerResult) {
  const getTask = vi.fn(async () => task);
  const getCandidatesByTaskId = vi.fn(async () => []);
  const getRunsByTask = vi.fn(async () => []);
  const updateTask = vi.fn(async () => taskRecord({}));
  const stateManager = {
    getTask,
    getCandidatesByTaskId,
    getRunsByTask,
    updateTask,
  } as unknown as RuntimeStateManager;
  const run = vi.fn(async () => runResult);
  const runner: DiagnosticianRunnerLike = { run };
  const bridge = new PainSignalBridge({
    stateManager,
    runner,
    intakeService: {} as CandidateIntakeService,
    ledgerAdapter: { register: vi.fn(), existsForCandidate: vi.fn(), getEntries: vi.fn() } as unknown as LedgerAdapter,
  });
  return { bridge, run, updateTask };
}

const SUCCESS: RunnerResult = { status: 'succeeded', taskId: TASK_ID, attemptCount: 1 };
const PROVIDER_FAIL: RunnerResult = { status: 'retried', taskId: TASK_ID, attemptCount: 1, errorCategory: 'timeout', failureReason: 'provider timeout' };

describe('PainSignalBridge.executePendingDiagnosis (PRI-624)', () => {
  it('runs a pending submitted task exactly once without resetting attempt state', async () => {
    const { bridge, run, updateTask } = createBridge(taskRecord({ status: 'pending', attemptCount: 2 }), SUCCESS);
    const result = await bridge.executePendingDiagnosis({ taskId: TASK_ID });
    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith(TASK_ID);
    expect(updateTask).not.toHaveBeenCalled();
    // Honest existing shaping semantics: a diagnosis that produced no candidates
    // is a failed bridge outcome — asserted here so a shaping change is visible.
    expect(result.status).toBe('failed');
    expect(result.message).toBe('Diagnostician succeeded but produced no principle candidates');
    expect(result.painId).toBe(PAIN_ID);
  });

  it('succeeded task returns the existing result idempotently without invoking the runner', async () => {
    const { bridge, run } = createBridge(taskRecord({ status: 'succeeded' }), SUCCESS);
    const result = await bridge.executePendingDiagnosis({ taskId: TASK_ID });
    expect(run).not.toHaveBeenCalled();
    expect(result.status).toBe('failed');
    expect(result.message).toBe('Task has no principle candidates — treating as failed');
  });

  it('leased task is skipped — the existing lease wins, expired leases belong to the recovery sweep', async () => {
    const { bridge, run } = createBridge(taskRecord({ status: 'leased', leaseOwner: 'other-worker', leaseExpiresAt: new Date(Date.now() + 60_000).toISOString() }), SUCCESS);
    const result = await bridge.executePendingDiagnosis({ taskId: TASK_ID });
    expect(run).not.toHaveBeenCalled();
    expect(result.status).toBe('skipped');
    expect(result.message).toBe('task_already_leased');
  });

  it('retry_wait inside the backoff window is skipped (retry budget preserved)', async () => {
    const { bridge, run } = createBridge(taskRecord({ status: 'retry_wait', leaseExpiresAt: new Date(Date.now() + 120_000).toISOString() }), SUCCESS);
    const result = await bridge.executePendingDiagnosis({ taskId: TASK_ID });
    expect(run).not.toHaveBeenCalled();
    expect(result.status).toBe('skipped');
    expect(result.message).toBe('retry_wait_pending');
  });

  it('retry_wait past the backoff deadline runs with the preserved attempt budget', async () => {
    const { bridge, run, updateTask } = createBridge(taskRecord({ status: 'retry_wait', attemptCount: 2, leaseExpiresAt: new Date(Date.now() - 1_000).toISOString() }), PROVIDER_FAIL);
    const result = await bridge.executePendingDiagnosis({ taskId: TASK_ID });
    expect(run).toHaveBeenCalledTimes(1);
    expect(updateTask).not.toHaveBeenCalled();
    expect(result.status).toBe('retried');
    expect(result.errorCategory).toBe('timeout');
  });

  it('terminal failed / needs_human_review tasks are never silently retried by a worker', async () => {
    for (const status of ['failed', 'needs_human_review'] as const) {
      const { bridge, run } = createBridge(taskRecord({ status }), SUCCESS);
      const result = await bridge.executePendingDiagnosis({ taskId: TASK_ID });
      expect(run).not.toHaveBeenCalled();
      expect(result.status).toBe('skipped');
      expect(result.message).toBe(`task_${status}`);
    }
  });

  it('unknown task id fails loudly with a structured reason', async () => {
    const { bridge, run } = createBridge(null, SUCCESS);
    const result = await bridge.executePendingDiagnosis({ taskId: TASK_ID });
    expect(run).not.toHaveBeenCalled();
    expect(result.status).toBe('failed');
    expect(result.message).toBe('task_not_found');
  });

  // ── PRI-642 SPEC §9: re-entry reads persisted facts; no host-binding
  // defaults, nested/top-level mismatch rejected before the LLM. ────────────

  it('a payload without provenance fails loud instead of defaulting to host_context_bound', async () => {
    const payload = JSON.stringify({ sourcePainId: PAIN_ID, evidence: [] });
    const { bridge, run } = createBridge(taskRecord({ diagnosticJson: payload }), SUCCESS);
    const result = await bridge.executePendingDiagnosis({ taskId: TASK_ID });
    expect(run).not.toHaveBeenCalled();
    expect(result.status).toBe('failed');
    expect(result.message).toBe('diagnostic_payload_invalid:provenance_missing');
  });

  it('an unparseable payload fails loud before the runner', async () => {
    const { bridge, run } = createBridge(taskRecord({ diagnosticJson: '{not-json' }), SUCCESS);
    const result = await bridge.executePendingDiagnosis({ taskId: TASK_ID });
    expect(run).not.toHaveBeenCalled();
    expect(result.status).toBe('failed');
    expect(result.message).toContain('diagnostic_payload_invalid');
  });

  it('a nested painIngress.v1 block contradicting the top-level fields is rejected before the LLM (SPEC 12.2.4)', async () => {
    // Nested says unbound external CLI; top-level claims host_context_bound.
    const payload = JSON.stringify({
      sourcePainId: PAIN_ID,
      provenance: 'host_context_bound',
      sessionIdHint: null,
      evidence: [],
      painIngress: {
        version: 'v1',
        origin: { kind: 'owner_manual', channel: 'external_cli_unbound' },
        correlation: { status: 'unbound', reason: 'external_cli' },
        evidenceClass: { status: 'unavailable', reason: 'trajectory_unavailable' },
      },
    });
    const { bridge, run } = createBridge(taskRecord({ diagnosticJson: payload }), SUCCESS);
    const result = await bridge.executePendingDiagnosis({ taskId: TASK_ID });
    expect(run).not.toHaveBeenCalled();
    expect(result.status).toBe('failed');
    expect(result.message).toContain('ingress_payload_mismatch');
  });

  it('a consistent painIngress.v1 block is honored: persisted correlation derives the provenance', async () => {
    const entries = [{ sourceRef: 'owner_message:t1', note: 'fix it' }];
    const payload = JSON.stringify({
      sourcePainId: PAIN_ID,
      provenance: 'host_context_bound',
      sessionIdHint: 'sess-1',
      evidence: entries,
      painIngress: {
        version: 'v1',
        origin: { kind: 'owner_manual', channel: 'openclaw_command' },
        correlation: { status: 'bound', hostKind: 'openclaw', sessionId: 'sess-1' },
        evidenceClass: { status: 'available', entryCount: entries.length },
      },
    });
    const { bridge, run } = createBridge(taskRecord({ diagnosticJson: payload }), SUCCESS);
    const result = await bridge.executePendingDiagnosis({ taskId: TASK_ID });
    expect(run).toHaveBeenCalledTimes(1);
    expect(result.status).toBe('failed'); // no candidates in this fixture
    expect(result.message).toBe('Diagnostician succeeded but produced no principle candidates');
  });

  it('legacy openclaw_context_bound spelling is normalized, not rejected', async () => {
    const payload = JSON.stringify({ sourcePainId: PAIN_ID, provenance: 'openclaw_context_bound', evidence: [] });
    const { bridge, run } = createBridge(taskRecord({ diagnosticJson: payload }), SUCCESS);
    const result = await bridge.executePendingDiagnosis({ taskId: TASK_ID });
    expect(run).toHaveBeenCalledTimes(1);
    expect(result.message).not.toContain('diagnostic_payload_invalid');
  });
});
