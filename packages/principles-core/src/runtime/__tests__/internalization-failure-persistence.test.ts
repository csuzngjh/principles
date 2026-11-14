import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { RuntimeStateManager } from '../store/runtime-state-manager.js';
import { DreamerRunner } from '../internalization/dreamer-runner.js';
import { MemoryPIArtifactStore } from '../internalization/pi-artifact-store.js';
import { StoreEventEmitter } from '../store/event-emitter.js';
import type { PDRuntimeAdapter } from '../runtime-protocol.js';
import { DefaultDreamerValidator } from '../internalization/dreamer-output.js';

describe('PRI-384: Failure reason persistence to runs table', () => {
  let tmpDir: string;
  let stateManager: RuntimeStateManager;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-failure-persist-'));
    stateManager = new RuntimeStateManager({ workspaceDir: tmpDir });
    await stateManager.initialize();
  });

  afterEach(async () => {
    await stateManager.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('markTaskFailed records the terminal marker on the run (SPEC §5.3 contract)', async () => {
    const taskId = 'task-failed-001';
    await stateManager.taskStore.createTask({
      taskId,
      taskKind: 'dreamer',
      status: 'pending',
      attemptCount: 0,
      maxAttempts: 3,
    });

    // Acquire lease to start a run
    const __lease1 = await stateManager.acquireLeaseDetailed({
      taskId,
      owner: 'test-agent',
      runtimeKind: 'pi-ai',
    });

    const detailedReason = 'Validation failed: candidate index 0 is missing badDecision';
    const task = await stateManager.markTaskFailed(taskId, 'output_invalid', detailedReason, { taskId: taskId, owner: 'test-agent', leaseGeneration: __lease1.leaseGeneration }, __lease1.runId);

    // Verify task state
    expect(task.status).toBe('failed');
    expect(task.lastError).toBe('output_invalid');

    // Verify run record. SPEC §5.3: a FAILED terminal write records the
    // canonical `task_failed` marker; the free-text failureReason is returned
    // to the runner (result.failureReason) instead of being persisted here.
    const runs = await stateManager.runStore.listRunsByTask(taskId);
    expect(runs).toHaveLength(1);
    const [run] = runs;
    expect(run?.executionStatus).toBe('failed');
    expect(run?.reason).toBe('task_failed');
    expect(run?.errorCategory).toBe('output_invalid');
  });

  it('markTaskRetryWait persists detailed reason to SQLite runs table', async () => {
    const taskId = 'task-retry-001';
    await stateManager.taskStore.createTask({
      taskId,
      taskKind: 'dreamer',
      status: 'pending',
      attemptCount: 0,
      maxAttempts: 3,
    });

    // Acquire lease to start a run
    const __lease2 = await stateManager.acquireLeaseDetailed({
      taskId,
      owner: 'test-agent',
      runtimeKind: 'pi-ai',
    });

    const detailedReason = 'API request failed with status code 503 Service Unavailable';
    await stateManager.markTaskRetryWait(taskId, 'execution_failed', detailedReason, { taskId: taskId, owner: 'test-agent', leaseGeneration: __lease2.leaseGeneration }, __lease2.runId);

    // Verify task state
    const task = await stateManager.taskStore.getTask(taskId);
    expect(task?.status).toBe('retry_wait');
    expect(task?.lastError).toBe('execution_failed');

    // Verify run record
    const runs = await stateManager.runStore.listRunsByTask(taskId);
    expect(runs).toHaveLength(1);
    const [run] = runs;
    expect(run?.executionStatus).toBe('failed');
    expect(run?.reason).toBe(detailedReason);
    expect(run?.errorCategory).toBe('execution_failed');
  });

  it('BasePeerRunner failure propagates reason to SQLite runs table', async () => {
    const taskId = 'task-runner-fail-001';
    const diagnosticJson = JSON.stringify({
      pi_metadata: {
        dependencyTaskIds: [],
        channel: 'prompt',
      },
    });
    await stateManager.taskStore.createTask({
      taskId,
      taskKind: 'dreamer',
      status: 'pending',
      attemptCount: 0,
      maxAttempts: 3,
      diagnosticJson,
    });

    // Mock an adapter that fails on startRun
    const mockAdapter: PDRuntimeAdapter = {
      kind() { return 'pi-ai'; },
      async getCapabilities() {
        return {
          supportsStructuredJsonOutput: true,
          supportsToolUse: false,
          supportsWorkingDirectory: false,
          supportsModelSelection: false,
          supportsLongRunningSessions: false,
          supportsCancellation: false,
          supportsArtifactWriteBack: false,
          supportsConcurrentRuns: false,
          supportsStreaming: false,
        };
      },
      async healthCheck() {
        return {
          healthy: true,
          degraded: false,
          warnings: [],
          lastCheckedAt: new Date().toISOString(),
        };
      },
      async startRun() {
        throw new Error('LLM provider error');
      },
      async pollRun() {
        return { runId: 'run-1', status: 'failed', reason: 'Aborted' };
      },
      async cancelRun() {
        // Mock cancel
      },
      async fetchOutput() {
        return { runId: 'run-1', payload: {} };
      },
      async fetchArtifacts() { return []; },
    };

    const runner = new DreamerRunner(
      {
        stateManager,
        runtimeAdapter: mockAdapter,
        eventEmitter: new StoreEventEmitter(),
        artifactStore: new MemoryPIArtifactStore(),
        validator: new DefaultDreamerValidator(),
      },
      { owner: 'test-agent', runtimeKind: 'pi-ai' },
    );

    const result = await runner.run(taskId);
    expect(result.status).toBe('retried');
    expect(result.failureReason).toBe('LLM provider error');

    // Verify run record has the failure reason
    const runs = await stateManager.runStore.listRunsByTask(taskId);
    expect(runs).toHaveLength(1);
    const [run] = runs;
    expect(run?.executionStatus).toBe('failed');
    expect(run?.reason).toBe('LLM provider error');
    expect(run?.errorCategory).toBe('execution_failed');
  });
});
