/**
 * Pain Ingress SPEC §9.6 — entry-level B-class authorization gate.
 *
 * The lazy `isAutoPainSubmissionAuthorized` probe must refuse an
 * `automatic_hook` Pain BEFORE any task-store I/O — ahead of the
 * capabilityDisabled ensure, the empty-evidence short-circuit, and every
 * existing-task path. Verification is against REAL persisted state
 * (RuntimeStateManager + state.db), not source assertions.
 *
 * owner_manual / host_context_bound / agent_reported_owner_approved
 * provenance is exempt: their Owner authorization is intrinsic.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { PainSignalBridge } from '../pain-signal-bridge.js';
import type { DiagnosticianRunnerLike } from '../pain-signal-bridge.js';
import { PainToPrincipleService } from '../pain-to-principle-service.js';
import { RuntimeStateManager } from '../store/runtime-state-manager.js';
import { PrincipleTreeLedgerAdapter } from '../adapter/principle-tree-ledger-adapter.js';

let tmpDir: string;
let stateManager: RuntimeStateManager;

function makeRunner(): DiagnosticianRunnerLike {
  return { run: async () => ({ status: 'succeeded', taskId: 't', attemptCount: 1 }) };
}

function makeBridge(opts: {
  authorized: () => boolean;
  capabilityDisabled?: { reason: string; nextAction: string };
}): PainSignalBridge {
  return new PainSignalBridge({
    stateManager,
    runner: makeRunner(),
    intakeService: {} as never,
    ledgerAdapter: { register: () => undefined, existsForCandidate: () => undefined, getEntries: () => [] } as never,
    workspaceDir: tmpDir,
    isAutoPainSubmissionAuthorized: opts.authorized,
    ...(opts.capabilityDisabled ? { capabilityDisabled: opts.capabilityDisabled } : {}),
  });
}

const AUTO_PAIN = {
  painType: 'user_frustration' as const,
  source: 'user_correction',
  reason: 'auto correction signal',
  score: 80,
  evidence: [{ sourceRef: 'owner_message:m1', note: 'real excerpt' }],
  provenance: 'automatic_hook' as const,
};

async function listTaskIds(): Promise<string[]> {
  return (await stateManager.listTasks()).map((t) => t.taskId);
}

describe('B-class automatic_pain_submission gate (SPEC §9.6)', () => {
  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-autopain-gate-'));
    stateManager = new RuntimeStateManager({ workspaceDir: tmpDir });
    await stateManager.initialize();
  });

  afterEach(async () => {
    await stateManager.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('unauthorized automatic_hook + live runner: no task, no runner call', async () => {
    const bridge = makeBridge({ authorized: () => false });
    const result = await bridge.onPainDetected({ painId: 'unauth_live', ...AUTO_PAIN });
    expect(result.status).toBe('skipped');
    expect(result.message).toBe('auto_pain_unauthorized');
    expect(await listTaskIds()).toHaveLength(0);
  });

  it('unauthorized automatic_hook + Disabled Bridge: no task persisted', async () => {
    const bridge = makeBridge({
      authorized: () => false,
      capabilityDisabled: { reason: 'Owner disabled', nextAction: 're-enable' },
    });
    const result = await bridge.onPainDetected({ painId: 'unauth_disabled', ...AUTO_PAIN });
    expect(result.status).toBe('skipped');
    expect(result.message).toBe('auto_pain_unauthorized');
    // The capabilityDisabled ensure path must NOT create the durable task.
    expect(await listTaskIds()).toHaveLength(0);
  });

  it('unauthorized automatic_hook + existing retry_wait task: state untouched', async () => {
    // Pre-seed a retry_wait task as if an earlier authorized run exists.
    const authorized = makeBridge({ authorized: () => true });
    const { taskId } = await authorized.submitPainSignal({ painId: 'seeded_rw', ...AUTO_PAIN });
    await stateManager.updateTask(taskId, { status: 'retry_wait', attemptCount: 3, lastError: 'execution_failed' });
    const before = await stateManager.getTask(taskId);

    const unauthorized = makeBridge({ authorized: () => false });
    const result = await unauthorized.onPainDetected({ painId: 'seeded_rw', ...AUTO_PAIN });
    expect(result.status).toBe('skipped');
    expect(result.message).toBe('auto_pain_unauthorized');

    const after = await stateManager.getTask(taskId);
    expect(after).not.toBeNull();
    expect(after?.status).toBe(before?.status);
    expect(after?.attemptCount).toBe(before?.attemptCount);
    expect(after?.lastError).toBe(before?.lastError);
  });

  it('unauthorized automatic_hook + existing failed task: no reset/re-trigger', async () => {
    const authorized = makeBridge({ authorized: () => true });
    const { taskId } = await authorized.submitPainSignal({ painId: 'seeded_fail', ...AUTO_PAIN });
    await stateManager.updateTask(taskId, { status: 'failed', attemptCount: 4, lastError: 'execution_failed' });

    const unauthorized = makeBridge({ authorized: () => false });
    const result = await unauthorized.onPainDetected({ painId: 'seeded_fail', ...AUTO_PAIN });
    expect(result.message).toBe('auto_pain_unauthorized');

    const after = await stateManager.getTask(taskId);
    expect(after?.status).toBe('failed');
    expect(after?.attemptCount).toBe(4);
    expect(after?.lastError).toBe('execution_failed');
  });

  it('unauthorized automatic_hook + existing succeeded task: no re-execution', async () => {
    const authorized = makeBridge({ authorized: () => true });
    const { taskId } = await authorized.submitPainSignal({ painId: 'seeded_ok', ...AUTO_PAIN });
    await stateManager.updateTask(taskId, { status: 'succeeded' });

    const unauthorized = makeBridge({ authorized: () => false });
    const result = await unauthorized.onPainDetected({ painId: 'seeded_ok', ...AUTO_PAIN });
    expect(result.status).toBe('skipped');
    expect(result.message).toBe('auto_pain_unauthorized');
    const after = await stateManager.getTask(taskId);
    expect(after?.status).toBe('succeeded');
  });

  it('authorized automatic_hook: normal submission path preserved', async () => {
    const bridge = makeBridge({ authorized: () => true });
    const result = await bridge.onPainDetected({ painId: 'auth_ok', ...AUTO_PAIN });
    // A submitted task exists (runner test-double may finish it) — the point
    // is that the gate did NOT intercept the call.
    expect(result.message ?? '').not.toBe('auto_pain_unauthorized');
    expect(await listTaskIds()).toContain(`diagnosis_auth_ok`);
  });

  it('owner_manual provenance: never gated by the flag', async () => {
    const bridge = makeBridge({ authorized: () => false });
    const result = await bridge.onPainDetected({
      painId: 'manual_ok',
      painType: 'user_frustration',
      source: 'manual',
      reason: 'owner report',
      score: 70,
      sessionId: 'sess-manual-1',
      provenance: 'host_context_bound',
      hostKind: 'openclaw',
      evidence: [{ sourceRef: 'owner_message:m1', note: 'fix it' }],
    });
    expect(result.message ?? '').not.toBe('auto_pain_unauthorized');
    expect(await listTaskIds()).toContain('diagnosis_manual_ok');
  });

  it('authorization revoked mid-flight: later calls refuse', async () => {
    let authorized = true;
    const bridge = makeBridge({ authorized: () => authorized });
    const first = await bridge.onPainDetected({ painId: 'revocable', ...AUTO_PAIN });
    expect(first.message ?? '').not.toBe('auto_pain_unauthorized');
    authorized = false;
    const second = await bridge.onPainDetected({ painId: 'revocable2', ...AUTO_PAIN });
    expect(second.message).toBe('auto_pain_unauthorized');
  });

  it('persisted automatic_hook task: executePendingDiagnosis refuses while unauthorized', async () => {
    // Task persisted while authorized; execution attempted after revocation.
    const authorized = makeBridge({ authorized: () => true });
    const { taskId } = await authorized.submitPainSignal({ painId: 'pending_auto', ...AUTO_PAIN });
    const unauthorized = makeBridge({ authorized: () => false });
    const executed = await unauthorized.executePendingDiagnosis({ taskId });
    expect(executed.status).toBe('skipped');
    expect(executed.message).toBe('auto_pain_unauthorized');
    const task = await stateManager.getTask(taskId);
    expect(task?.status).toBe('pending'); // untouched, retryable later
  });

  it('PainToPrincipleService async path: unauthorized automatic_hook persists no pending task', async () => {
    const stateDir = path.join(tmpDir, '.state');
    const service = new PainToPrincipleService({
      workspaceDir: tmpDir,
      stateDir,
      ledgerAdapter: new PrincipleTreeLedgerAdapter({ stateDir }),
      owner: 'test',
      asyncMode: true,
      isAutoPainSubmissionAuthorized: () => false,
    });
    const result = await service.recordPain({
      painId: 'async_auto',
      painType: 'user_frustration',
      source: 'user_correction',
      reason: 'async auto submit',
      provenance: 'automatic_hook',
      evidence: [{ sourceRef: 'owner_message:m1', note: 'e' }],
    });
    expect(result.status).toBe('skipped');
    expect(result.message).toBe('auto_pain_unauthorized');
    expect(await listTaskIds()).toHaveLength(0);
  });

  it('PainToPrincipleService: unprobe-able provenance stays manual-safe', async () => {
    const stateDir = path.join(tmpDir, '.state');
    const service = new PainToPrincipleService({
      workspaceDir: tmpDir,
      stateDir,
      ledgerAdapter: new PrincipleTreeLedgerAdapter({ stateDir }),
      owner: 'test',
      asyncMode: true,
      // No probe wired: manual provenance must NOT be refused (fail-open for
      // owner paths; only automatic_hook fails closed).
      isAutoPainSubmissionAuthorized: () => false,
    });
    const result = await service.recordPain({
      painId: 'async_manual',
      painType: 'user_frustration',
      source: 'manual',
      reason: 'owner manual report',
      provenance: 'owner_reported_no_host_trace',
      evidence: [],
    });
    expect(result.status).toBe('submitted');
    expect(await listTaskIds()).toContain('diagnosis_async_manual');
  });
});
