/**
 * SPEC-PD-PIPELINE-RELIABILITY-AND-EFFICIENCY-001 §5.3 — lease FENCING against a
 * real SQLite state database (no mocks).
 *
 * The remediation scenarios:
 *   A  an expired lease is re-acquired by the SAME owner label → the previous
 *      execution's renew / success / failure / retry-wait / diagnostic writes
 *      are all refused, the new execution works;
 *   B  two independent connections race for one task → exactly one wins;
 *   C  an expired-but-not-yet-recovered lease can neither commit nor renew;
 *   D  a missing lease row means "ownership lost" (fail-closed), including the
 *      heartbeat commit-time probe.
 *
 * `lease_owner` is a caller-chosen label and is deliberately reused across A and
 * B: the generation is what distinguishes two acquisitions.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { RuntimeStateManager } from './runtime-state-manager.js';
import type { LeaseFence } from './lifecycle/lease-fence.js';
import { LeaseHeartbeat } from './lifecycle/lease-heartbeat.js';
import type { PDRuntimeError } from '../error-categories.js';

const OWNER = 'same-owner-label';

function expireLeaseDirect(mgr: RuntimeStateManager, taskId: string): void {
  // Simulate wall-clock passage without sleeping (CI must not wait on TTLs).
  mgr.connection.getDb()
    .prepare('UPDATE tasks SET lease_expires_at = ? WHERE task_id = ?')
    .run(new Date(Date.now() - 60_000).toISOString(), taskId);
}

describe('lease fencing — generation, not owner label', () => {
  const tmpRoot = path.join(os.tmpdir(), `pd-fencing-${process.pid}-${Date.now()}`);
  let workspace: string;
  let mgr: RuntimeStateManager;
  let mgrB: RuntimeStateManager;

  beforeEach(async () => {
    workspace = path.join(tmpRoot, `ws-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    fs.mkdirSync(workspace, { recursive: true });
    mgr = new RuntimeStateManager({ workspaceDir: workspace });
    await mgr.initialize();
    mgrB = new RuntimeStateManager({ workspaceDir: workspace });
    await mgrB.initialize();
    await mgr.createTask({
      taskId: 'task-1',
      taskKind: 'diagnostician',
      status: 'pending',
      attemptCount: 0,
      maxAttempts: 3,
    });
  });

  afterEach(async () => {
    await mgr.close();
    await mgrB.close();
    try {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    } catch {
      // ignore Windows cleanup failures
    }
  });

  it('mints a strictly greater generation for every successful acquisition', async () => {
    const first = await mgr.acquireLeaseDetailed({ taskId: 'task-1', owner: OWNER, runtimeKind: 'pi-ai' });
    expect(first.leaseGeneration).toBe(1);
    expect(first.task.leaseGeneration).toBe(1);
    expect(first.runId).toBeTruthy();

    await mgr.markTaskSucceeded(
      'task-1',
      'ref-1',
      { taskId: 'task-1', owner: OWNER, leaseGeneration: first.leaseGeneration },
      first.runId,
    );

    await mgr.updateTask('task-1', { status: 'pending' });
    const second = await mgr.acquireLeaseDetailed({ taskId: 'task-1', owner: OWNER, runtimeKind: 'pi-ai' });
    expect(second.leaseGeneration).toBe(2);
    expect(second.leaseGeneration).toBeGreaterThan(first.leaseGeneration);
  });

  it('accepts the terminal write from the current acquisition', async () => {
    const lease = await mgr.acquireLeaseDetailed({ taskId: 'task-1', owner: OWNER, runtimeKind: 'pi-ai' });
    const fence: LeaseFence = { taskId: 'task-1', owner: OWNER, leaseGeneration: lease.leaseGeneration };

    const updated = await mgr.markTaskSucceeded('task-1', 'ref-1', fence, lease.runId);

    expect(updated.status).toBe('succeeded');
    expect(updated.leaseOwner ?? null).toBeNull();
    expect(updated.resultRef).toBe('ref-1');
  });

  it('scenario A — same owner, new generation: every old-execution write is refused', async () => {
    const oldLease = await mgr.acquireLeaseDetailed({ taskId: 'task-1', owner: OWNER, runtimeKind: 'pi-ai' });
    const oldFence: LeaseFence = { taskId: 'task-1', owner: OWNER, leaseGeneration: oldLease.leaseGeneration };

    // Lease expires (no recovery yet), then the SAME label re-acquires.
    expireLeaseDirect(mgr, 'task-1');
    await mgr.forceExpireLease('task-1');
    const newLease = await mgrB.acquireLeaseDetailed({ taskId: 'task-1', owner: OWNER, runtimeKind: 'pi-ai' });
    expect(newLease.leaseGeneration).toBe(oldLease.leaseGeneration + 1);

    await expect(mgr.renewLease(oldFence, 300_000)).rejects.toMatchObject({ category: 'lease_conflict' });
    await expect(mgr.markTaskSucceeded('task-1', 'stale', oldFence, oldLease.runId))
      .rejects.toMatchObject({ category: 'lease_conflict' });
    await expect(mgr.markTaskFailed('task-1', 'execution_failed', 'stale', oldFence, oldLease.runId))
      .rejects.toMatchObject({ category: 'lease_conflict' });
    await expect(mgr.markTaskRetryWait('task-1', 'output_invalid', 'stale', oldFence, oldLease.runId))
      .rejects.toMatchObject({ category: 'lease_conflict' });
    await expect(mgr.applyFencedDiagnosticJson(oldFence, () => '{"stale":true}'))
      .rejects.toMatchObject({ category: 'lease_conflict' });

    // The stale execution changed nothing.
    const stillLeasedByNew = await mgr.getTask('task-1');
    expect(stillLeasedByNew?.status).toBe('leased');
    expect(stillLeasedByNew?.leaseGeneration).toBe(newLease.leaseGeneration);
    expect(stillLeasedByNew?.resultRef ?? null).toBeNull();
    expect(stillLeasedByNew?.diagnosticJson ?? null).toBeNull();

    // The new execution works.
    const newFence: LeaseFence = { taskId: 'task-1', owner: OWNER, leaseGeneration: newLease.leaseGeneration };
    const succeeded = await mgr.markTaskSucceeded('task-1', 'fresh', newFence, newLease.runId);
    expect(succeeded.status).toBe('succeeded');
  });

  it('scenario B — two connections race for one task: exactly one acquires', async () => {
    const results = await Promise.allSettled([
      mgr.acquireLeaseDetailed({ taskId: 'task-1', owner: OWNER, runtimeKind: 'pi-ai' }),
      mgrB.acquireLeaseDetailed({ taskId: 'task-1', owner: OWNER, runtimeKind: 'pi-ai' }),
    ]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    const reason = (rejected[0] as PromiseRejectedResult).reason as PDRuntimeError;
    expect(reason.category).toBe('lease_conflict');

    const task = await mgr.getTask('task-1');
    expect(task?.status).toBe('leased');
    expect(task?.leaseGeneration).toBe(1);
  });

  it('scenario C — expired but not recovered: cannot commit and cannot renew', async () => {
    const lease = await mgr.acquireLeaseDetailed({ taskId: 'task-1', owner: OWNER, runtimeKind: 'pi-ai' });
    const fence: LeaseFence = { taskId: 'task-1', owner: OWNER, leaseGeneration: lease.leaseGeneration };
    expireLeaseDirect(mgr, 'task-1');

    await expect(mgr.renewLease(fence, 300_000)).rejects.toMatchObject({ category: 'lease_conflict' });
    await expect(mgr.markTaskSucceeded('task-1', 'late', fence, lease.runId))
      .rejects.toMatchObject({ category: 'lease_conflict' });

    // Recovery has NOT run: the row is still 'leased' and unchanged.
    const task = await mgr.getTask('task-1');
    expect(task?.status).toBe('leased');
    expect(task?.leaseOwner).toBe(OWNER);
    expect(task?.resultRef ?? null).toBeNull();
  });

  it('scenario D — missing lease row: ownership is lost and no write is accepted', async () => {
    const lease = await mgr.acquireLeaseDetailed({ taskId: 'task-1', owner: OWNER, runtimeKind: 'pi-ai' });
    const fence: LeaseFence = { taskId: 'task-1', owner: OWNER, leaseGeneration: lease.leaseGeneration };

    mgr.connection.getDb().prepare('DELETE FROM tasks WHERE task_id = ?').run('task-1');

    expect(await mgr.assertLeaseOwned(fence)).toBe(false);
    await expect(mgr.markTaskSucceeded('task-1', 'late', fence, lease.runId))
      .rejects.toMatchObject({ category: 'lease_conflict' });

    // Heartbeat probe sees null → reports lost instead of the old fail-open `return true`.
    const heartbeat = new LeaseHeartbeat({
      taskId: 'task-1',
      owner: OWNER,
      leaseGeneration: lease.leaseGeneration,
      leaseTtlMs: 60_000,
      intervalMs: 10_000,
      renewLease: async () => undefined,
      readOwnership: async () => null,
    });
    expect(await heartbeat.assertOwned()).toBe(false);
    expect(heartbeat.lost).toBe(true);
  });

  it('scenario D2 — a leased row without an expiry cannot prove ownership', async () => {
    const { leaseGeneration } = await mgr.acquireLeaseDetailed({ taskId: 'task-1', owner: OWNER, runtimeKind: 'pi-ai' });
    const heartbeat = new LeaseHeartbeat({
      taskId: 'task-1',
      owner: OWNER,
      leaseGeneration,
      leaseTtlMs: 60_000,
      intervalMs: 10_000,
      renewLease: async () => undefined,
      readOwnership: async () => ({
        status: 'leased',
        leaseOwner: OWNER,
        leaseGeneration,
        leaseExpiresAt: null,
      }),
    });

    expect(await heartbeat.assertOwned()).toBe(false);
    expect(heartbeat.lost).toBe(true);
  });

  it('scenario D3 — only an explicit harness opt-in skips the ownership probe', async () => {
    // Production can never reach this path (the constructor refuses it without
    // the flag); the assert documents what the opt-in means.
    const heartbeat = new LeaseHeartbeat({
      taskId: 'task-1',
      owner: OWNER,
      leaseGeneration: 0,
      leaseTtlMs: 60_000,
      intervalMs: 10_000,
      renewLease: async () => undefined,
      unfencedTestMode: true,
    });

    expect(await heartbeat.assertOwned()).toBe(true);
  });

  it('refuses a runId that does not belong to the task and rolls the task write back', async () => {    const lease = await mgr.acquireLeaseDetailed({ taskId: 'task-1', owner: OWNER, runtimeKind: 'pi-ai' });
    const fence: LeaseFence = { taskId: 'task-1', owner: OWNER, leaseGeneration: lease.leaseGeneration };

    await expect(mgr.markTaskSucceeded('task-1', 'ref', fence, 'run_other-task_1'))
      .rejects.toMatchObject({ category: 'storage_unavailable' });

    const task = await mgr.getTask('task-1');
    expect(task?.status).toBe('leased');
    expect(task?.resultRef ?? null).toBeNull();
  });

  it('retry_wait race across two connections: Task and Run are one rollout unit', async () => {
    const oldLease = await mgr.acquireLeaseDetailed({ taskId: 'task-1', owner: OWNER, runtimeKind: 'pi-ai' });

    // A second connection reclaims the task: the old execution's retry write
    // must leave BOTH rows untouched.
    await mgrB.forceExpireLease('task-1');
    const newLease = await mgrB.acquireLeaseDetailed({ taskId: 'task-1', owner: OWNER, runtimeKind: 'pi-ai' });
    expect(newLease.leaseGeneration).toBe(oldLease.leaseGeneration + 1);

    await expect(mgr.markTaskRetryWait(
      'task-1',
      'output_invalid',
      'stale retry',
      { taskId: 'task-1', owner: OWNER, leaseGeneration: oldLease.leaseGeneration },
      oldLease.runId,
    )).rejects.toMatchObject({ category: 'lease_conflict' });

    const task = await mgr.getTask('task-1');
    expect(task?.status).toBe('leased');
    expect(task?.leaseGeneration).toBe(newLease.leaseGeneration);
    expect(task?.lastError ?? null).toBeNull();

    const oldRun = mgr.connection.getDb()
      .prepare('SELECT execution_status, ended_at, reason FROM runs WHERE run_id = ?')
      .get(oldLease.runId) as { execution_status: string; ended_at: string | null; reason: string | null };
    expect(oldRun.execution_status).toBe('running');
    expect(oldRun.ended_at ?? null).toBeNull();
    expect(oldRun.reason ?? null).toBeNull();
  });

  it('retry_wait rolls the task write back when the run does not belong to it', async () => {
    const lease = await mgr.acquireLeaseDetailed({ taskId: 'task-1', owner: OWNER, runtimeKind: 'pi-ai' });
    const fence: LeaseFence = { taskId: 'task-1', owner: OWNER, leaseGeneration: lease.leaseGeneration };

    await expect(mgr.markTaskRetryWait('task-1', 'output_invalid', 'boom', fence, 'run_missing_1'))
      .rejects.toMatchObject({ category: 'storage_unavailable' });

    const task = await mgr.getTask('task-1');
    expect(task?.status).toBe('leased');
    expect(task?.lastError ?? null).toBeNull();
  });

  it('DB trigger blocks renewal of a pre-upgrade (generation 0) lease', async () => {
    const lease = await mgr.acquireLeaseDetailed({ taskId: 'task-1', owner: OWNER, runtimeKind: 'pi-ai' });
    // Simulate a row leased by the previous build (no fencing token).
    mgr.connection.getDb().prepare('UPDATE tasks SET lease_generation = 0 WHERE task_id = ?').run('task-1');

    expect(() => {
      mgr.connection.getDb()
        .prepare('UPDATE tasks SET lease_expires_at = ? WHERE task_id = ?')
        .run(new Date(Date.now() + 300_000).toISOString(), 'task-1');
    }).toThrow(/lease_generation/);

    expect(lease.leaseGeneration).toBe(1);
  });

  it('DB trigger blocks an acquisition that does not mint a new generation', async () => {
    const lease = await mgr.acquireLeaseDetailed({ taskId: 'task-1', owner: OWNER, runtimeKind: 'pi-ai' });
    await mgr.markTaskSucceeded('task-1', 'ref', {
      taskId: 'task-1',
      owner: OWNER,
      leaseGeneration: lease.leaseGeneration,
    }, lease.runId);
    await mgr.updateTask('task-1', { status: 'pending' });

    // An old process that does not know the column (no generation bump).
    expect(() => {
      mgr.connection.getDb()
        .prepare("UPDATE tasks SET status = 'leased', lease_owner = ? WHERE task_id = ?")
        .run(OWNER, 'task-1');
    }).toThrow(/lease_generation/);
  });
});

/**
 * SPEC §5.3 / task-book §1.5 — the nine-step dual-worker regression, against a
 * real SQLite database with two independent connections and two DISTINCT
 * owners. Worker A loses its lease mid-execution; every write it attempts
 * afterwards must be refused, and worker B's result must persist untouched.
 */
describe('dual-worker nine-step ownership regression (real SQLite)', () => {
  const tmpRoot = path.join(os.tmpdir(), `pd-dual-worker-${process.pid}-${Date.now()}`);
  const TASK_ID = 'task-nine-step';
  let workspace: string;
  let workerA: RuntimeStateManager;
  let workerB: RuntimeStateManager;

  beforeEach(async () => {
    workspace = path.join(tmpRoot, `ws-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    fs.mkdirSync(workspace, { recursive: true });
    workerA = new RuntimeStateManager({ workspaceDir: workspace });
    await workerA.initialize();
    workerB = new RuntimeStateManager({ workspaceDir: workspace });
    await workerB.initialize();
    await workerA.createTask({
      taskId: TASK_ID,
      taskKind: 'diagnostician',
      status: 'pending',
      attemptCount: 0,
      maxAttempts: 3,
    });
  });

  afterEach(async () => {
    await workerA.close();
    await workerB.close();
    try {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    } catch {
      // ignore Windows cleanup failures
    }
  });

  it('A cannot change B\'s status, diagnostics or run; B still completes', async () => {
    // 1. Worker A acquires the lease and writes its own diagnostic facts.
    const leaseA = await workerA.acquireLeaseDetailed({ taskId: TASK_ID, owner: 'worker-a', runtimeKind: 'pi-ai' });
    const fenceA: LeaseFence = { taskId: TASK_ID, owner: 'worker-a', leaseGeneration: leaseA.leaseGeneration };
    await workerA.applyFencedDiagnosticJson(fenceA, () => JSON.stringify({ writer: 'worker-a', stage: 'polling' }));

    // 2. A's lease expires (wall clock, no sleep).
    expireLeaseDirect(workerA, TASK_ID);
    await workerA.forceExpireLease(TASK_ID);

    // 3. Worker B takes the task over and records ITS diagnostic facts.
    const leaseB = await workerB.acquireLeaseDetailed({ taskId: TASK_ID, owner: 'worker-b', runtimeKind: 'pi-ai' });
    const fenceB: LeaseFence = { taskId: TASK_ID, owner: 'worker-b', leaseGeneration: leaseB.leaseGeneration };
    await workerB.applyFencedDiagnosticJson(fenceB, (current) => {
      const parsed = current ? JSON.parse(current) as Record<string, unknown> : {};
      return JSON.stringify({ ...parsed, writer: 'worker-b', stage: 'invoking' });
    });
    const bDiagnosticBefore = (await workerB.getTask(TASK_ID))?.diagnosticJson ?? null;
    expect(bDiagnosticBefore).toContain('worker-b');

    // 4. A hits a runtime error and tries to fail the task.
    await expect(workerA.markTaskFailed(TASK_ID, 'execution_failed', 'A runtime blew up', fenceA, leaseA.runId))
      .rejects.toMatchObject({ category: 'lease_conflict' });

    // 5. A hits a validation error and tries to persist failure diagnostics.
    await expect(workerA.applyFencedDiagnosticJson(fenceA, () => '{"writer":"worker-a","clobbered":true}'))
      .rejects.toMatchObject({ category: 'lease_conflict' });

    // 6. A exhausts its retry budget and tries to schedule a retry.
    await expect(workerA.markTaskRetryWait(TASK_ID, 'output_invalid', 'A exhausted retries', fenceA, leaseA.runId))
      .rejects.toMatchObject({ category: 'lease_conflict' });
    await expect(workerA.markTaskFailed(TASK_ID, 'max_attempts_exceeded', 'A exhausted retries', fenceA, leaseA.runId))
      .rejects.toMatchObject({ category: 'lease_conflict' });

    // 7. A tries to persist terminal-failure details.
    await expect(workerA.applyFencedDiagnosticJson(fenceA, (current) => JSON.stringify({
      ...(current ? JSON.parse(current) : {}),
      terminal_failure: { reason: 'max_attempts_exceeded', writer: 'worker-a' },
    }))).rejects.toMatchObject({ category: 'lease_conflict' });

    // 8. A tries to mark the task succeeded.
    await expect(workerA.markTaskSucceeded(TASK_ID, 'result-from-a', fenceA, leaseA.runId))
      .rejects.toMatchObject({ category: 'lease_conflict' });

    // A changed nothing: the row still belongs to B, byte-for-byte diagnostics.
    const afterA = await workerB.getTask(TASK_ID);
    expect(afterA?.status).toBe('leased');
    expect(afterA?.leaseOwner).toBe('worker-b');
    expect(afterA?.leaseGeneration).toBe(leaseB.leaseGeneration);
    expect(afterA?.lastError ?? null).toBeNull();
    expect(afterA?.resultRef ?? null).toBeNull();
    expect(afterA?.diagnosticJson ?? null).toBe(bDiagnosticBefore);

    // Neither A's run nor B's run was mutated by A's refused writes.
    const runsAfterA = await workerB.getRunsByTask(TASK_ID);
    const runA = runsAfterA.find((run) => run.runId === leaseA.runId);
    const runB = runsAfterA.find((run) => run.runId === leaseB.runId);
    expect(runA?.executionStatus).toBe('running');
    expect(runA?.endedAt ?? null).toBeNull();
    expect(runB?.executionStatus).toBe('running');

    // 9. B completes normally — its own run and the task become terminal.
    const completed = await workerB.markTaskSucceeded(TASK_ID, 'result-from-b', fenceB, leaseB.runId);
    expect(completed.status).toBe('succeeded');
    expect(completed.resultRef).toBe('result-from-b');

    const runsAfterB = await workerB.getRunsByTask(TASK_ID);
    const finishedRunB = runsAfterB.find((run) => run.runId === leaseB.runId);
    expect(finishedRunB?.executionStatus).toBe('succeeded');
    // B's success never rewrote the stale execution's run.
    expect(runsAfterB.find((run) => run.runId === leaseA.runId)?.executionStatus).toBe('running');
  });
});
