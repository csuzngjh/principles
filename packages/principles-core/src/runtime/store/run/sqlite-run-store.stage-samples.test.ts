/**
 * SPEC-PD-PIPELINE-RELIABILITY-AND-EFFICIENCY-001 §3 — the pipeline-health read
 * model. Real SQLite: the method exists so the Console never learns the `runs`
 * schema, and its bounded-window contract must be proven against the real query.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { RuntimeStateManager } from '../runtime-state-manager.js';
import type { SqliteRunStore } from './sqlite-run-store.js';

describe('SqliteRunStore.listStageRunSamples', () => {
  const tmpRoot = path.join(os.tmpdir(), `pd-stage-samples-${process.pid}-${Date.now()}`);
  let workspace: string;
  let mgr: RuntimeStateManager;
  // The read model lives on the concrete store; `RunStore` is the general
  // interface and must not grow a Console-specific reader (P6/P7).
  const stageRunStore = () => mgr.runStore as unknown as SqliteRunStore;

  beforeEach(async () => {
    workspace = path.join(tmpRoot, `ws-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    fs.mkdirSync(workspace, { recursive: true });
    mgr = new RuntimeStateManager({ workspaceDir: workspace });
    await mgr.initialize();
  });

  afterEach(async () => {
    await mgr.close();
    try {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    } catch {
      // ignore Windows cleanup failures
    }
  });

  it('joins each run to its task kind inside the requested window', async () => {
    await mgr.createTask({ taskId: 'task-dreamer', taskKind: 'dreamer', status: 'pending', attemptCount: 0, maxAttempts: 3 });
    await mgr.createTask({ taskId: 'task-evaluator', taskKind: 'evaluator', status: 'pending', attemptCount: 0, maxAttempts: 3 });
    await mgr.acquireLeaseDetailed({ taskId: 'task-dreamer', owner: 'worker-a', runtimeKind: 'pi-ai' });
    await mgr.acquireLeaseDetailed({ taskId: 'task-evaluator', owner: 'worker-a', runtimeKind: 'pi-ai' });

    const samples = await stageRunStore().listStageRunSamples({
      sinceIso: new Date(Date.now() - 60_000).toISOString(),
    });

    expect(samples).toHaveLength(2);
    expect(samples.map((sample) => sample.taskKind).sort()).toEqual(['dreamer', 'evaluator']);
    expect(samples.every((sample) => sample.startedAt.length > 0)).toBe(true);
    expect(samples.every((sample) => sample.executionStatus === 'running')).toBe(true);
    expect(samples.every((sample) => sample.endedAt === null)).toBe(true);
    expect(samples.every((sample) => Number.isInteger(sample.attemptNumber))).toBe(true);
  });

  it('omits runs older than the window', async () => {
    await mgr.createTask({ taskId: 'task-old', taskKind: 'scribe', status: 'pending', attemptCount: 0, maxAttempts: 3 });
    const lease = await mgr.acquireLeaseDetailed({ taskId: 'task-old', owner: 'worker-a', runtimeKind: 'pi-ai' });
    mgr.connection.getDb()
      .prepare('UPDATE runs SET started_at = ? WHERE run_id = ?')
      .run(new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString(), lease.runId);

    const samples = await stageRunStore().listStageRunSamples({
      sinceIso: new Date(Date.now() - 60_000).toISOString(),
    });
    expect(samples).toHaveLength(0);
  });

  it('clamps the limit into [1, 5000]', async () => {
    for (let index = 0; index < 3; index += 1) {
      const taskId = `task-limit-${index}`;
      await mgr.createTask({ taskId, taskKind: 'dreamer', status: 'pending', attemptCount: 0, maxAttempts: 3 });
      await mgr.acquireLeaseDetailed({ taskId, owner: 'worker-a', runtimeKind: 'pi-ai' });
    }

    const sinceIso = new Date(Date.now() - 60_000).toISOString();
    expect(await stageRunStore().listStageRunSamples({ sinceIso, limit: 0 })).toHaveLength(1);
    expect(await stageRunStore().listStageRunSamples({ sinceIso, limit: 2 })).toHaveLength(2);
    expect(await stageRunStore().listStageRunSamples({ sinceIso, limit: 99_999 })).toHaveLength(3);
  });

  it('normalizes a legacy row without a usable attempt number to 0', async () => {
    await mgr.createTask({ taskId: 'task-legacy', taskKind: 'dreamer', status: 'pending', attemptCount: 0, maxAttempts: 3 });
    const lease = await mgr.acquireLeaseDetailed({ taskId: 'task-legacy', owner: 'worker-a', runtimeKind: 'pi-ai' });
    // Legacy/imported rows can carry an out-of-range value; the read model must
    // not leak it to the Console (rc-1/rc-3).
    mgr.connection.getDb()
      .prepare('UPDATE runs SET attempt_number = -1 WHERE run_id = ?')
      .run(lease.runId);

    const [sample] = await stageRunStore().listStageRunSamples({
      sinceIso: new Date(Date.now() - 60_000).toISOString(),
    });

    expect(sample?.attemptNumber).toBe(0);
  });
});
