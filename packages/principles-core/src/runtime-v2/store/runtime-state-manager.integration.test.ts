/**
 * RuntimeStateManager integration tests — task/run truth alignment.
 *
 * Verifies:
 *   - acquireLease increments task.attemptCount and creates run with attemptNumber
 *   - markTaskSucceeded updates latest run to succeeded with endedAt
 *   - markTaskFailed updates latest run to failed with errorCategory
 *   - recovery uses correct task.attemptCount for maxAttempts enforcement
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { RuntimeStateManager } from './runtime-state-manager.js';
import type { TaskRecord } from '../task-status.js';

function makeTaskInput(taskId: string, overrides: Partial<Omit<TaskRecord, 'createdAt' | 'updatedAt'>> = {}): Omit<TaskRecord, 'createdAt' | 'updatedAt'> {
  return {
    taskId,
    taskKind: 'diagnostician',
    status: 'pending',
    attemptCount: 0,
    maxAttempts: 3,
    ...overrides,
  };
}

describe('RuntimeStateManager task/run truth alignment', () => {
  const tmpDir = path.join(os.tmpdir(), `pd-rsm-test-${process.pid}-${Date.now()}`);
   
  let mgr: RuntimeStateManager;

  beforeEach(async () => {
    const testDir = path.join(tmpDir, `test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    fs.mkdirSync(testDir, { recursive: true });
    mgr = new RuntimeStateManager({ workspaceDir: testDir });
    await mgr.initialize();
  });

  afterEach(() => {
    mgr.close();
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors on Windows
    }
  });

  // ── acquireLease increments task.attemptCount ────────────────────────────────

  it('first acquireLease sets task.attemptCount=1 and run.attemptNumber=1', async () => {
    await mgr.createTask(makeTaskInput('task-attempt-1'));
    const leased = await mgr.acquireLease({ taskId: 'task-attempt-1', owner: 'agent-1', runtimeKind: 'openclaw' });
    expect(leased.attemptCount).toBe(1);
    const runs = await mgr.getRunsByTask('task-attempt-1');
    expect(runs).toHaveLength(1);
    const [run0] = runs;
    if (!run0) return;
    expect(run0.attemptNumber).toBe(1);
    expect(run0.executionStatus).toBe('running');
    expect(run0.endedAt).toBeUndefined();
  });

  it('second acquireLease (after expired lease) sets task.attemptCount=2 and run.attemptNumber=2', async () => {
    await mgr.createTask(makeTaskInput('task-attempt-2'));
    await mgr.acquireLease({ taskId: 'task-attempt-2', owner: 'agent-1', runtimeKind: 'openclaw' });
    const taskAfter1 = await mgr.getTask('task-attempt-2');
    if (!taskAfter1) return;
    expect(taskAfter1.attemptCount).toBe(1);
    await mgr.updateTask('task-attempt-2', { leaseExpiresAt: new Date(Date.now() - 60_000).toISOString() });
    const sweep = await mgr.runRecoverySweep();
    expect(sweep.recovered).toBe(1);
    const taskAfterSweep = await mgr.getTask('task-attempt-2');
    if (!taskAfterSweep) return;
    expect(taskAfterSweep.status).toBe('retry_wait');

    const second = await mgr.acquireLease({ taskId: 'task-attempt-2', owner: 'agent-2', runtimeKind: 'openclaw' });
    expect(second.attemptCount).toBe(2);
    const runs = await mgr.getRunsByTask('task-attempt-2');
    expect(runs).toHaveLength(2);
    const [r0, r1] = runs;
    if (!r0 || !r1) return;
    expect(r0.attemptNumber).toBe(1);
    expect(r1.attemptNumber).toBe(2);
    expect(r1.executionStatus).toBe('running');
  });

  // ── markTaskSucceeded updates run to terminal state ──────────────────────────

  it('markTaskSucceeded updates latest run to succeeded with endedAt', async () => {
    await mgr.createTask(makeTaskInput('task-succeeded'));
    await mgr.acquireLease({ taskId: 'task-succeeded', owner: 'agent-1', runtimeKind: 'openclaw' });
    await mgr.markTaskSucceeded('task-succeeded', 'output-ref-abc');
    const runs = await mgr.getRunsByTask('task-succeeded');
    expect(runs).toHaveLength(1);
    const [run0] = runs;
    if (!run0) return;
    expect(run0.executionStatus).toBe('succeeded');
    expect(run0.endedAt).toBeTruthy();
    expect(run0.reason).toBe('task_completed');
    expect(run0.outputRef).toBe('output-ref-abc');
    const task = await mgr.getTask('task-succeeded');
    if (!task) return;
    expect(task.status).toBe('succeeded');
    expect(task.resultRef).toBe('output-ref-abc');
  });

  // ── markTaskFailed updates run to terminal state ─────────────────────────────

  it('markTaskFailed updates latest run to failed with errorCategory', async () => {
    await mgr.createTask(makeTaskInput('task-failed'));
    await mgr.acquireLease({ taskId: 'task-failed', owner: 'agent-1', runtimeKind: 'openclaw' });
    await mgr.markTaskFailed('task-failed', 'lease_conflict');
    const runs = await mgr.getRunsByTask('task-failed');
    expect(runs).toHaveLength(1);
    const [run0] = runs;
    if (!run0) return;
    expect(run0.executionStatus).toBe('failed');
    expect(run0.endedAt).toBeTruthy();
    expect(run0.reason).toBe('task_failed');
    expect(run0.errorCategory).toBe('lease_conflict');
    const task = await mgr.getTask('task-failed');
    if (!task) return;
    expect(task.status).toBe('failed');
    expect(task.lastError).toBe('lease_conflict');
  });

  // ── attemptCount + maxAttempts enforcement ───────────────────────────────────

  it('recovery uses task.attemptCount to enforce maxAttempts termination', async () => {
    // maxAttempts=3: after 3 lease expirations, recovery moves to failed
    await mgr.createTask(makeTaskInput('task-max-attempts', { attemptCount: 0, maxAttempts: 3 }));

    await mgr.acquireLease({ taskId: 'task-max-attempts', owner: 'agent-1', runtimeKind: 'openclaw' });
    let task = await mgr.getTask('task-max-attempts');
    if (!task) return;
    expect(task.attemptCount).toBe(1);
    await mgr.updateTask('task-max-attempts', { leaseExpiresAt: new Date(Date.now() - 60_000).toISOString() });
    let sweep = await mgr.runRecoverySweep();
    expect(sweep.recovered).toBe(1);
    task = await mgr.getTask('task-max-attempts');
    if (!task) return;
    expect(task.status).toBe('retry_wait');

    await mgr.acquireLease({ taskId: 'task-max-attempts', owner: 'agent-2', runtimeKind: 'openclaw' });
    task = await mgr.getTask('task-max-attempts');
    if (!task) return;
    expect(task.attemptCount).toBe(2);
    await mgr.updateTask('task-max-attempts', { leaseExpiresAt: new Date(Date.now() - 60_000).toISOString() });
    sweep = await mgr.runRecoverySweep();
    expect(sweep.recovered).toBe(1);
    task = await mgr.getTask('task-max-attempts');
    if (!task) return;
    expect(task.status).toBe('retry_wait');

    await mgr.acquireLease({ taskId: 'task-max-attempts', owner: 'agent-3', runtimeKind: 'openclaw' });
    task = await mgr.getTask('task-max-attempts');
    if (!task) return;
    expect(task.attemptCount).toBe(3);
    await mgr.updateTask('task-max-attempts', { leaseExpiresAt: new Date(Date.now() - 60_000).toISOString() });
    sweep = await mgr.runRecoverySweep();
    expect(sweep.recovered).toBe(1);

    task = await mgr.getTask('task-max-attempts');
    if (!task) return;
    expect(task.status).toBe('failed');
    expect(task.lastError).toBe('max_attempts_exceeded');
    const runs = await mgr.getRunsByTask('task-max-attempts');
    expect(runs).toHaveLength(3);
  });

  // ── retry_wait preserves attemptCount across recovery ───────────────────────

  it('retry_wait preserves attemptCount after recovery', async () => {
    await mgr.createTask(makeTaskInput('task-retry-preserve', { attemptCount: 1, maxAttempts: 3 }));
    await mgr.acquireLease({ taskId: 'task-retry-preserve', owner: 'agent-1', runtimeKind: 'openclaw' });
    // Simulate expired lease
    await mgr.updateTask('task-retry-preserve', { leaseExpiresAt: new Date(Date.now() - 60_000).toISOString() });
    await mgr.runRecoverySweep();

    let task = await mgr.getTask('task-retry-preserve');
    if (!task) return;
    expect(task.status).toBe('retry_wait');
    expect(task.attemptCount).toBe(1);

    await mgr.acquireLease({ taskId: 'task-retry-preserve', owner: 'agent-2', runtimeKind: 'openclaw' });
    task = await mgr.getTask('task-retry-preserve');
    if (!task) return;
    expect(task.attemptCount).toBe(2);
    expect(task.status).toBe('leased');
  });

  // ── markTaskSucceeded clears stale lastError ──────────────────────────────

  it('markTaskSucceeded clears lastError from previous failed attempt', async () => {
    // Simulate: task fails → retry_wait → re-lease → succeed
    await mgr.createTask(makeTaskInput('task-retry-clear-error', { attemptCount: 0, maxAttempts: 3 }));

    // First attempt: lease → fail → retry_wait
    await mgr.acquireLease({ taskId: 'task-retry-clear-error', owner: 'agent-1', runtimeKind: 'openclaw' });
    await mgr.markTaskRetryWait('task-retry-clear-error', 'output_invalid');

    let task = await mgr.getTask('task-retry-clear-error');
    if (!task) return;
    expect(task.status).toBe('retry_wait');
    expect(task.lastError).toBe('output_invalid');

    // Second attempt: lease → succeed
    await mgr.acquireLease({ taskId: 'task-retry-clear-error', owner: 'agent-2', runtimeKind: 'openclaw' });
    await mgr.markTaskSucceeded('task-retry-clear-error', 'commit://abc123');

    task = await mgr.getTask('task-retry-clear-error');
    if (!task) return;
    expect(task.status).toBe('succeeded');
    expect(task.lastError).toBeNull(); // stale error cleared (implementation sets lastError: null)

    // Verify old run still has its error_category (history preserved)
    const runs = await mgr.getRunsByTask('task-retry-clear-error');
    expect(runs).toHaveLength(2);
    // First run: failed
    const [run0, run1] = runs;
    if (!run0) return;
    expect(run0.executionStatus).toBe('failed');
    expect(run0.errorCategory).toBe('output_invalid');
    // Second run: succeeded
    if (!run1) return;
    expect(run1.executionStatus).toBe('succeeded');
  });
});
