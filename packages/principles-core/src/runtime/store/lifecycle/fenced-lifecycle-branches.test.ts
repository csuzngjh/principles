/**
 * SPEC-PD-PIPELINE-RELIABILITY-AND-EFFICIENCY-001 §5.3 — remaining fencing
 * branches, exercised against a REAL SQLite state database.
 *
 * `task-terminal-ownership.test.ts` proves the dual-worker scenarios. This
 * suite covers the guard/validation branches that the end-to-end scenarios do
 * not reach: malformed fences, missing execution identity, task/run mismatch,
 * and an honest release.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { RuntimeStateManager } from '../runtime-state-manager.js';
import { SqliteFencedTaskLifecycle } from './fenced-task-writer.js';
import {
  assertLeaseFenceInTransaction,
  assertLeaseFenceShape,
  type LeaseFence,
} from './lease-fence.js';
import { MOCK_ROUTER_OUTPUTS } from '../../adapter/split-pipeline-fixtures.js';

const TASK_ID = 'task-fenced-branches';
const OWNER = 'worker-branches';

describe('fenced lifecycle guards (real SQLite)', () => {
  const tmpRoot = path.join(os.tmpdir(), `pd-fenced-branches-${process.pid}-${Date.now()}`);
  let workspace: string;
  let mgr: RuntimeStateManager;
  let lifecycle: SqliteFencedTaskLifecycle;
  let fence: LeaseFence;
  let runId: string;

  beforeEach(async () => {
    workspace = path.join(tmpRoot, `ws-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    fs.mkdirSync(workspace, { recursive: true });
    mgr = new RuntimeStateManager({ workspaceDir: workspace });
    await mgr.initialize();
    await mgr.createTask({
      taskId: TASK_ID,
      taskKind: 'diagnostician',
      status: 'pending',
      attemptCount: 0,
      maxAttempts: 3,
    });
    const { runId: acquiredRunId, leaseGeneration } = await mgr.acquireLeaseDetailed({
      taskId: TASK_ID,
      owner: OWNER,
      runtimeKind: 'pi-ai',
    });
    runId = acquiredRunId;
    fence = { taskId: TASK_ID, owner: OWNER, leaseGeneration };
    lifecycle = new SqliteFencedTaskLifecycle(mgr.connection);
  });

  afterEach(async () => {
    await mgr.close();
    try {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    } catch {
      // ignore Windows cleanup failures
    }
  });

  it('rejects a malformed fence instead of degrading to an unfenced write', async () => {
    const malformed = { taskId: TASK_ID, owner: OWNER, leaseGeneration: Number.NaN };
    expect(() => assertLeaseFenceShape(malformed)).toThrow(/Invalid lease fence/);
    // The probe fails closed: an unprovable identity is never "owned".
    await expect(lifecycle.assertOwned(malformed)).resolves.toBe(false);
    expect(await lifecycle.assertOwned(fence)).toBe(true);
  });

  it('refuses a transaction-scoped fence that no longer owns the row', async () => {
    const db = mgr.connection.getDb();
    expect(() => assertLeaseFenceInTransaction(db, fence, new Date().toISOString())).not.toThrow();

    mgr.connection.getDb()
      .prepare('UPDATE tasks SET lease_expires_at = ? WHERE task_id = ?')
      .run(new Date(Date.now() - 60_000).toISOString(), TASK_ID);

    expect(() => assertLeaseFenceInTransaction(db, fence, new Date().toISOString()))
      .toThrow(/no longer owned by lease generation/);
  });

  it('fails loud when a fenced diagnostic write targets a task that does not exist', async () => {
    const missing: LeaseFence = { taskId: 'task-does-not-exist', owner: OWNER, leaseGeneration: 1 };
    await expect(lifecycle.applyDiagnosticJson(missing, () => '{}'))
      .rejects.toMatchObject({ category: 'storage_unavailable' });
  });

  it('requires the execution runId and the retry deadline', async () => {
    await expect(lifecycle.markSucceeded({
      fence,
      runId: '',
      errorCategory: null,
    })).rejects.toMatchObject({ category: 'input_invalid' });

    await expect(lifecycle.markRetryWait({
      fence,
      runId,
      errorCategory: 'output_invalid',
    })).rejects.toMatchObject({ category: 'input_invalid' });

    // Neither refusal mutated the row.
    const task = await mgr.getTask(TASK_ID);
    expect(task?.status).toBe('leased');
    expect(task?.leaseGeneration).toBe(fence.leaseGeneration);
  });

  it('releaseLease returns the task to pending and a second release is a conflict', async () => {
    const released = await mgr.releaseLease(fence);

    expect(released.status).toBe('pending');
    expect(released.leaseOwner ?? null).toBeNull();
    expect(released.leaseExpiresAt ?? null).toBeNull();
    await expect(mgr.releaseLease(fence)).rejects.toMatchObject({ category: 'lease_conflict' });
  });

  it('rejects a fence whose taskId does not match the task being finalized', async () => {
    await expect(mgr.markTaskSucceeded(TASK_ID, 'ref', { ...fence, taskId: 'another-task' }, runId))
      .rejects.toMatchObject({ category: 'input_invalid' });

    const task = await mgr.getTask(TASK_ID);
    expect(task?.status).toBe('leased');
  });

  it('refuses an atomic commit whose payload belongs to another task', async () => {
    // The commit unit is addressed by the fence; a payload for a different task
    // would publish artifacts under the wrong lineage, so it is rejected before
    // any write happens.
    await expect(mgr.commitDiagnosticianAndFinalize({
      fence,
      runId,
      commit: {
        runId,
        taskId: 'someone-else',
        output: MOCK_ROUTER_OUTPUTS.R6,
        idempotencyKey: `${TASK_ID}:${runId}`,
      },
    })).rejects.toMatchObject({ category: 'input_invalid' });

    const task = await mgr.getTask(TASK_ID);
    expect(task?.status).toBe('leased');
    expect(await mgr.getRunsByTask(TASK_ID)).toHaveLength(1);
  });
});
