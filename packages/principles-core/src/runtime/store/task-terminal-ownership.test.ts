/**
 * SPEC-PD-PIPELINE-RELIABILITY-AND-EFFICIENCY-001 §5.3 — ownership-fenced
 * terminal writes against a real SQLite state database.
 *
 * Proves the stale-worker scenario: A holds the lease, the task is reclaimed,
 * B acquires it, then A's delayed commit must be refused rather than flipping
 * the task to a terminal state that B now owns.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { RuntimeStateManager } from './runtime-state-manager.js';
import { PDRuntimeError } from '../error-categories.js';

const OWNER_A = 'worker-a';
const OWNER_B = 'worker-b';

describe('terminal write ownership fence', () => {
  const tmpRoot = path.join(os.tmpdir(), `pd-terminal-owner-${process.pid}-${Date.now()}`);
  let workspace: string;
  let mgr: RuntimeStateManager;

  beforeEach(async () => {
    workspace = path.join(tmpRoot, `ws-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    fs.mkdirSync(workspace, { recursive: true });
    mgr = new RuntimeStateManager({ workspaceDir: workspace });
    await mgr.initialize();
    await mgr.createTask({
      taskId: 'task-1',
      taskKind: 'diagnostician',
      status: 'pending',
      attemptCount: 0,
      maxAttempts: 3,
    });
    await mgr.acquireLease({ taskId: 'task-1', owner: OWNER_A, runtimeKind: 'pi-ai' });
  });

  afterEach(async () => {
    await mgr.close();
    try {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    } catch {
      // ignore Windows cleanup failures
    }
  });

  it('accepts the terminal write from the current owner', async () => {
    const updated = await mgr.markTaskSucceeded('task-1', 'ref-1', { expectedOwner: OWNER_A });
    expect(updated.status).toBe('succeeded');
    expect(updated.leaseOwner ?? null).toBeNull();
  });

  it('rejects a success write from a worker whose lease was reclaimed', async () => {
    await mgr.forceExpireLease('task-1');
    await mgr.acquireLease({ taskId: 'task-1', owner: OWNER_B, runtimeKind: 'pi-ai' });

    await expect(
      mgr.markTaskSucceeded('task-1', 'stale-ref', { expectedOwner: OWNER_A }),
    ).rejects.toMatchObject({ category: 'lease_conflict' });

    const task = await mgr.getTask('task-1');
    expect(task?.status).toBe('leased');
    expect(task?.leaseOwner).toBe(OWNER_B);
    expect(task?.resultRef ?? null).toBeNull();
  });

  it('rejects a terminal failure write from a stale worker', async () => {
    await mgr.forceExpireLease('task-1');
    await mgr.acquireLease({ taskId: 'task-1', owner: OWNER_B, runtimeKind: 'pi-ai' });

    await expect(
      mgr.markTaskFailed('task-1', 'execution_failed', 'stale failure', { expectedOwner: OWNER_A }),
    ).rejects.toMatchObject({ category: 'lease_conflict' });

    const task = await mgr.getTask('task-1');
    expect(task?.status).toBe('leased');
    expect(task?.lastError ?? null).toBeNull();
  });

  it('rejects a retry-wait write from a stale worker', async () => {
    await mgr.forceExpireLease('task-1');
    await mgr.acquireLease({ taskId: 'task-1', owner: OWNER_B, runtimeKind: 'pi-ai' });

    await expect(
      mgr.markTaskRetryWait('task-1', 'output_invalid', 'stale retry', { expectedOwner: OWNER_A }),
    ).rejects.toBeInstanceOf(PDRuntimeError);

    const task = await mgr.getTask('task-1');
    expect(task?.status).toBe('leased');
    expect(task?.leaseOwner).toBe(OWNER_B);
  });

  it('preserves legacy behaviour when no expectedOwner is supplied', async () => {
    const updated = await mgr.markTaskSucceeded('task-1', 'ref-legacy');
    expect(updated.status).toBe('succeeded');
  });
});
