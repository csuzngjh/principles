/**
 * SPEC v0.8 §9.4 (L2b) — Diagnostician backlog read model.
 *
 * Acceptance coverage: T34 (three answers: how many / how long / which is
 * oldest, and a non-healthy verdict when a backlog exists) and T35 (a newly
 * created pending task must not masquerade as recent execution activity).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { RuntimeStateManager } from '../store/runtime-state-manager.js';
import { StalledDiagnosticianTaskReadModel } from '../stalled-diagnostician-task-read-model.js';
import type { DiagnosticianBacklogConfiguration } from '../stalled-diagnostician-task-read-model.js';

const CONFIGURATION: DiagnosticianBacklogConfiguration = {
  l3FlagEnabled: true,
  capabilityAvailable: true,
  runtimeBound: true,
};

const NOW = new Date('2026-11-10T12:00:00.000Z');
const NOW_MS = NOW.getTime();

function isoMinusMs(ms: number): string {
  return new Date(NOW_MS - ms).toISOString();
}

describe('StalledDiagnosticianTaskReadModel.getBacklog (L2b)', () => {
  let tmpDir: string;
  let stateManager: RuntimeStateManager;
  let readModel: StalledDiagnosticianTaskReadModel;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-backlog-test-'));
    stateManager = new RuntimeStateManager({ workspaceDir: tmpDir });
    await stateManager.initialize();
    readModel = new StalledDiagnosticianTaskReadModel({ stateManager });
  });

  afterEach(async () => {
    await stateManager.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  async function createTask(input: {
    taskId: string;
    status: 'pending' | 'retry_wait' | 'leased' | 'succeeded';
    inputRef?: string;
    createdAt?: string;
    leaseExpiresAt?: string;
    taskKind?: string;
  }): Promise<void> {
    await stateManager.taskStore.createTask({
      taskId: input.taskId,
      taskKind: input.taskKind ?? 'diagnostician',
      status: input.status,
      attemptCount: 0,
      maxAttempts: 3,
      inputRef: input.inputRef,
      leaseOwner: input.status === 'leased' ? 'test-lease' : undefined,
      leaseExpiresAt: input.leaseExpiresAt,
    });
    if (input.createdAt !== undefined) {
      stateManager.connection
        .getDb()
        .prepare('UPDATE tasks SET created_at = ? WHERE task_id = ?')
        .run(input.createdAt, input.taskId);
    }
  }

  it('reports idle with zero counts and null pointers on an empty workspace', async () => {
    const snapshot = await readModel.getBacklog({ configuration: CONFIGURATION, now: NOW });

    expect(snapshot.health).toBe('idle');
    expect(snapshot.pendingCount).toBe(0);
    expect(snapshot.retryWaitCount).toBe(0);
    expect(snapshot.leasedCount).toBe(0);
    expect(snapshot.staleLeaseCount).toBe(0);
    expect(snapshot.stalledCount).toBe(0);
    expect(snapshot.oldestPendingTaskId).toBeNull();
    expect(snapshot.oldestPendingPainId).toBeNull();
    expect(snapshot.oldestPendingCreatedAt).toBeNull();
    expect(snapshot.oldestPendingAgeMs).toBeNull();
    expect(snapshot.lastRunStartedAt).toBeNull();
    expect(snapshot.observedRecentActivity).toBe(false);
    expect(snapshot.configuration).toEqual(CONFIGURATION);
    expect(snapshot.generatedAt).toBe(NOW.toISOString());
    expect(snapshot.workspaceDir).toBe(tmpDir);
  });

  it('answers how many, how long, and which task is oldest (T34)', async () => {
    await createTask({ taskId: 'pending-new', status: 'pending', inputRef: 'pain-new', createdAt: isoMinusMs(2 * 60 * 1000) });
    await createTask({ taskId: 'pending-old', status: 'pending', inputRef: 'pain-old', createdAt: isoMinusMs(47 * 60 * 1000) });
    await createTask({ taskId: 'retry-wait-1', status: 'retry_wait', inputRef: 'pain-retry', createdAt: isoMinusMs(5 * 60 * 1000) });
    await createTask({
      taskId: 'leased-stale',
      status: 'leased',
      inputRef: 'pain-stale',
      createdAt: isoMinusMs(30 * 60 * 1000),
      leaseExpiresAt: isoMinusMs(10 * 60 * 1000),
    });

    const snapshot = await readModel.getBacklog({ configuration: CONFIGURATION, now: NOW });

    expect(snapshot.pendingCount).toBe(2);
    expect(snapshot.retryWaitCount).toBe(1);
    expect(snapshot.leasedCount).toBe(1);
    expect(snapshot.staleLeaseCount).toBe(1);
    // `pending-old` has no runs and is older than the 300s threshold;
    // `pending-new` (2 min) is a fresh submission, not stalled yet.
    expect(snapshot.stalledCount).toBe(1);
    expect(snapshot.oldestPendingTaskId).toBe('pending-old');
    expect(snapshot.oldestPendingPainId).toBe('pain-old');
    expect(snapshot.oldestPendingCreatedAt).toBe(isoMinusMs(47 * 60 * 1000));
    expect(snapshot.oldestPendingAgeMs).toBe(47 * 60 * 1000);
    expect(snapshot.health).toBe('running');
  });

  it('never uses tasks.updated_at as execution activity — a new pending task is not "recent activity" (T35)', async () => {
    // createTask writes created_at AND updated_at; both are "now".
    await createTask({
      taskId: 'brand-new-pending',
      status: 'pending',
      inputRef: 'pain-brand-new',
      createdAt: isoMinusMs(10 * 60 * 1000),
    });

    const snapshot = await readModel.getBacklog({ configuration: CONFIGURATION, now: NOW });

    expect(snapshot.pendingCount).toBe(1);
    expect(snapshot.lastRunStartedAt).toBeNull();
    expect(snapshot.observedRecentActivity).toBe(false);
    expect(snapshot.health).toBe('stalled');
  });

  it('uses runs.started_at as the activity signal and reports backlog when it is recent', async () => {
    await createTask({ taskId: 'pending-1', status: 'pending', inputRef: 'pain-1', createdAt: isoMinusMs(45 * 60 * 1000) });
    await createTask({ taskId: 'done-1', status: 'succeeded', inputRef: 'pain-done', createdAt: isoMinusMs(60 * 60 * 1000) });
    await stateManager.runStore.createRun({
      runId: 'run-recent',
      taskId: 'done-1',
      runtimeKind: 'test-double',
      executionStatus: 'succeeded',
      startedAt: isoMinusMs(5 * 60 * 1000),
      attemptNumber: 1,
    });

    const snapshot = await readModel.getBacklog({ configuration: CONFIGURATION, now: NOW });

    expect(snapshot.lastRunStartedAt).toBe(isoMinusMs(5 * 60 * 1000));
    expect(snapshot.observedRecentActivity).toBe(true);
    expect(snapshot.health).toBe('backlog');
  });

  it('does not count a run older than 30 minutes as recent activity', async () => {
    await createTask({ taskId: 'pending-1', status: 'pending', inputRef: 'pain-1', createdAt: isoMinusMs(90 * 60 * 1000) });
    await createTask({ taskId: 'done-1', status: 'succeeded', createdAt: isoMinusMs(120 * 60 * 1000) });
    await stateManager.runStore.createRun({
      runId: 'run-old',
      taskId: 'done-1',
      runtimeKind: 'test-double',
      executionStatus: 'succeeded',
      startedAt: isoMinusMs(31 * 60 * 1000),
      attemptNumber: 1,
    });

    const snapshot = await readModel.getBacklog({ configuration: CONFIGURATION, now: NOW });

    expect(snapshot.lastRunStartedAt).toBe(isoMinusMs(31 * 60 * 1000));
    expect(snapshot.observedRecentActivity).toBe(false);
    expect(snapshot.health).toBe('stalled');
  });

  it('ignores runs that belong to another task kind', async () => {
    await createTask({ taskId: 'pending-1', status: 'pending', createdAt: isoMinusMs(45 * 60 * 1000) });
    await createTask({
      taskId: 'intake-1',
      taskKind: 'principle_candidate_intake',
      status: 'succeeded',
      createdAt: isoMinusMs(60 * 60 * 1000),
    });
    await stateManager.runStore.createRun({
      runId: 'run-intake',
      taskId: 'intake-1',
      runtimeKind: 'test-double',
      executionStatus: 'succeeded',
      startedAt: isoMinusMs(60 * 1000),
      attemptNumber: 1,
    });

    const snapshot = await readModel.getBacklog({ configuration: CONFIGURATION, now: NOW });

    expect(snapshot.lastRunStartedAt).toBeNull();
    expect(snapshot.observedRecentActivity).toBe(false);
  });

  it('does not treat a leased task with an unexpired lease as a stale lease', async () => {
    await createTask({
      taskId: 'leased-live',
      status: 'leased',
      createdAt: isoMinusMs(60 * 1000),
      leaseExpiresAt: isoMinusMs(-5 * 60 * 1000),
    });

    const snapshot = await readModel.getBacklog({ configuration: CONFIGURATION, now: NOW });

    expect(snapshot.leasedCount).toBe(1);
    expect(snapshot.staleLeaseCount).toBe(0);
    expect(snapshot.health).toBe('running');
  });
});
