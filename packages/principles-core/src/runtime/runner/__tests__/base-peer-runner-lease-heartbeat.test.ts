/**
 * SPEC-PD-PIPELINE-RELIABILITY-AND-EFFICIENCY-001 §5.2/§5.3 — runner lease
 * heartbeat and stale-commit fencing.
 *
 * Timings are short (tens of ms) so an integration test proves renewal across
 * a lease window without making CI wait minutes.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { BasePeerRunner } from '../base-peer-runner.js';
import type { RuntimeStateManager } from '../../store/runtime-state-manager.js';
import { RuntimeStateManager as RuntimeStateManagerClass } from '../../store/runtime-state-manager.js';
import { PDRuntimeError } from '../../error-categories.js';
import type { PDRuntimeAdapter, RunHandle, RunStatus } from '../../runtime-protocol.js';
import type { TelemetryEvent } from '../../../telemetry-event.js';
import type { PIArtifactStore } from '../../internalization/pi-artifact.js';
import type { TaskRecord } from '../../task-status.js';
import type { PDErrorCategory } from '../../error-categories.js';
import type {
  PeerRunnerDeps,
  PeerRunnerOptions,
  PeerRunnerResult,
  PeerRunnerValidationResult,
} from '../peer-runner-types.js';

interface TestContext { contextHash: string }
interface TestOutput { data: string }

class LeaseTestRunner extends BasePeerRunner<TestContext, TestOutput> {
  public succeedCount = 0;
  /** Optional work performed inside the completion-intent resume gate. */
  public onResume?: () => Promise<void>;

  constructor(deps: PeerRunnerDeps, options: PeerRunnerOptions) {
    super(deps, options, {
      runnerName: 'lease_test',
      expectedTaskKind: 'dreamer',
      defaultAgentId: 'lease-test',
      resultRefPrefix: 'lease-test',
    });
  }

  get timing() {
    return this.executionTiming;
  }

  // eslint-disable-next-line @typescript-eslint/class-methods-use-this
  get permanentErrorCategories(): ReadonlySet<PDErrorCategory> {
    return new Set(['storage_unavailable', 'input_invalid', 'output_invalid']);
  }

  // eslint-disable-next-line @typescript-eslint/class-methods-use-this
  async buildContext(): Promise<TestContext> {
    return { contextHash: 'hash' };
  }

  protected override async maybeResumePendingIntent(): Promise<PeerRunnerResult<TestOutput> | null> {
    await this.onResume?.();
    return null;
  }

  // eslint-disable-next-line @typescript-eslint/class-methods-use-this
  async invokeRuntime(): Promise<RunHandle> {
    return { runId: 'run-001', runtimeKind: 'test-double', startedAt: new Date().toISOString() };
  }

  // eslint-disable-next-line @typescript-eslint/class-methods-use-this
  async validateOutput(output: unknown): Promise<PeerRunnerValidationResult> {
    if (typeof output !== 'object' || output === null) {
      return { valid: false, errors: ['not-an-object'], errorCategory: 'output_invalid' };
    }
    return { valid: true, errors: [] };
  }

  // eslint-disable-next-line @typescript-eslint/max-params -- mirrors the abstract succeedTask signature
  async succeedTask(
    taskId: string,
    runId: string,
    output: TestOutput,
    task: TaskRecord,
  ): Promise<PeerRunnerResult<TestOutput>> {
    this.succeedCount += 1;
    return { status: 'succeeded', taskId, runId, output, attemptCount: task.attemptCount };
  }
}

const LEASED_TASK: TaskRecord = {
  taskId: 'task-001',
  taskKind: 'dreamer',
  status: 'leased',
  leaseOwner: 'worker-a',
  leaseGeneration: 1,
  leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
  attemptCount: 1,
  maxAttempts: 3,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

function baseOptions(overrides: Partial<PeerRunnerOptions> = {}): PeerRunnerOptions {
  return {
    owner: 'worker-a',
    runtimeKind: 'test-double',
    pollIntervalMs: 1,
    timeoutMs: 5_000,
    leaseTtlMs: 60,
    heartbeatIntervalMs: 10,
    ...overrides,
  };
}

function createDeps(overrides: {
  pollImplementation?: () => Promise<RunStatus>;
  getTask?: () => Promise<TaskRecord | null>;
  renewLease?: () => Promise<TaskRecord>;
  acquireImplementation?: () => Promise<never>;
} = {}) {
  const events: TelemetryEvent[] = [];
  const renewLease = vi.fn(overrides.renewLease ?? (async () => LEASED_TASK));
  // SPEC §5.3: production acquires through the detailed variant so the runner
  // also receives its execution identity (runId + fencing generation).
  const acquireLeaseDetailed = vi.fn(overrides.acquireImplementation ?? (async () => ({
    task: LEASED_TASK,
    runId: 'run-001',
    leaseGeneration: 1,
  })));
  const acquireLease = vi.fn(async () => LEASED_TASK);
  const stateManager = {
    acquireLease,
    acquireLeaseDetailed,
    renewLease,
    getTask: vi.fn(overrides.getTask ?? (async () => LEASED_TASK)),
    getValidRunsByTaskTolerant: vi.fn(async () => ({ runs: [{ runId: 'run-001' }], degradedRuns: [] })),
    getRetryPolicy: vi.fn(() => ({ shouldRetry: () => false })),
    markTaskSucceeded: vi.fn(async () => LEASED_TASK),
    markTaskFailed: vi.fn(async () => LEASED_TASK),
    markTaskRetryWait: vi.fn(async () => LEASED_TASK),
    updateRunOutput: vi.fn(async () => ({})),
  } as unknown as RuntimeStateManager;

  const pollRun = vi.fn(overrides.pollImplementation ?? (async () => ({ status: 'succeeded' as const, runId: 'run-001' })));
  const runtimeAdapter = {
    kind: () => 'test-double',
    startRun: vi.fn(async () => ({ runId: 'run-001', runtimeKind: 'test-double', startedAt: new Date().toISOString() })),
    pollRun,
    fetchOutput: vi.fn(async () => ({ payload: { data: 'ok' }, runtimeKind: 'test-double' })),
    cancelRun: vi.fn(async () => undefined),
  } as unknown as PDRuntimeAdapter;

  const deps: PeerRunnerDeps = {
    stateManager,
    runtimeAdapter,
    eventEmitter: { emitTelemetry: (event: TelemetryEvent) => { events.push(event); } },
    artifactStore: {
      upsertArtifact: vi.fn(),
      listBySourceTaskId: vi.fn(async () => []),
    } as unknown as PIArtifactStore,
  };
  return { deps, events, acquireLease, acquireLeaseDetailed, renewLease, pollRun, stateManager };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('BasePeerRunner lease heartbeat', () => {
  beforeEach(() => {
    vi.useRealTimers();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('acquires the lease with the resolved TTL (not the legacy 300s default)', async () => {
    const { deps, acquireLeaseDetailed } = createDeps();
    const runner = new LeaseTestRunner(deps, baseOptions());
    await runner.run('task-001');
    expect(acquireLeaseDetailed).toHaveBeenCalledWith(expect.objectContaining({
      owner: 'worker-a',
      durationMs: 60,
    }));
  });

  it('defaults the lease TTL to the timing contract, not the stage timeout', async () => {
    const { deps, acquireLeaseDetailed } = createDeps();
    const runner = new LeaseTestRunner(deps, { owner: 'worker-a', runtimeKind: 'test-double' });
    await runner.run('task-001');
    expect(runner.timing.leaseTtlMs).toBe(120_000);
    expect(runner.timing.stageTimeoutMs).toBe(300_000);
    expect(acquireLeaseDetailed).toHaveBeenCalledWith(expect.objectContaining({ durationMs: 120_000 }));
  });

  it('renews the lease while a stage runs longer than one TTL window', async () => {
    const { deps, renewLease, events } = createDeps({
      // The first poll takes longer than several heartbeat intervals.
      pollImplementation: async () => {
        await sleep(55);
        return { status: 'succeeded' as const, runId: 'run-001' };
      },
    });
    const runner = new LeaseTestRunner(deps, baseOptions());
    const result = await runner.run('task-001');

    expect(result.status).toBe('succeeded');
    expect(renewLease.mock.calls.length).toBeGreaterThanOrEqual(2);
    // Every renewal carries the SAME fence identity as acquisition.
    for (const call of renewLease.mock.calls as unknown as [{ taskId: string; owner: string; leaseGeneration: number }, number][]) {
      expect(call[0]).toMatchObject({ taskId: 'task-001', owner: 'worker-a', leaseGeneration: 1 });
      expect(call[1]).toBe(60);
    }
    expect(events.some((event) => event.eventType === 'lease_renewed')).toBe(true);
    expect(events.some((event) => event.eventType === 'execution_timing_resolved')).toBe(true);
  });

  it('refuses to commit when renewal fails (lease lost)', async () => {
    const { deps, events } = createDeps({
      renewLease: async () => { throw new Error('lease_conflict: owner mismatch'); },
      pollImplementation: async () => {
        await sleep(40);
        return { status: 'succeeded' as const, runId: 'run-001' };
      },
    });
    const runner = new LeaseTestRunner(deps, baseOptions());
    const result = await runner.run('task-001');

    expect(result.status).toBe('failed');
    expect(result.errorCategory).toBe('lease_conflict');
    expect(runner.succeedCount).toBe(0);
    expect(events.some((event) => event.eventType === 'lease_renewal_failed')).toBe(true);
    expect(events.some((event) => event.eventType === 'stale_commit_rejected')).toBe(true);
  });

  it('refuses to commit when another worker owns the task at commit time', async () => {
    const { deps, events } = createDeps({
      getTask: async () => ({ ...LEASED_TASK, leaseOwner: 'worker-b' }),
      pollImplementation: async () => {
        await sleep(35);
        return { status: 'succeeded' as const, runId: 'run-001' };
      },
    });
    const runner = new LeaseTestRunner(deps, baseOptions());
    const result = await runner.run('task-001');

    expect(result.status).toBe('failed');
    expect(result.errorCategory).toBe('lease_conflict');
    expect(runner.succeedCount).toBe(0);
    expect(events.some((event) => event.eventType === 'lease_ownership_lost')).toBe(true);
    expect(events.some((event) => event.eventType === 'stale_commit_rejected')).toBe(true);
  });

  it('commits normally while the lease is still owned', async () => {
    const { deps } = createDeps();
    const runner = new LeaseTestRunner(deps, baseOptions());
    const result = await runner.run('task-001');
    expect(result.status).toBe('succeeded');
    expect(runner.succeedCount).toBe(1);
  });

  it('returns a structured failure for a pre-lease storage fault without writing any task state', async () => {
    const { deps, stateManager } = createDeps({
      acquireImplementation: async () => {
        throw new PDRuntimeError('storage_unavailable', 'state.db is locked');
      },
    });
    const runner = new LeaseTestRunner(deps, baseOptions());

    const result = await runner.run('task-001');

    expect(result).toMatchObject({ status: 'failed', errorCategory: 'storage_unavailable' });
    expect(result.failureReason).toContain('state.db is locked');
    // Pre-lease failures never own the task: no synthetic record, no write.
    expect(stateManager.markTaskFailed).not.toHaveBeenCalled();
    expect(stateManager.markTaskRetryWait).not.toHaveBeenCalled();
    expect(stateManager.markTaskSucceeded).not.toHaveBeenCalled();
    expect(runner.succeedCount).toBe(0);
  });

  it('returns lease_conflict without writing when acquisition loses the race', async () => {
    const { deps, stateManager } = createDeps({
      acquireImplementation: async () => {
        throw new PDRuntimeError('lease_conflict', 'another worker holds the lease');
      },
    });
    const runner = new LeaseTestRunner(deps, baseOptions());

    const result = await runner.run('task-001');

    expect(result).toMatchObject({ status: 'failed', errorCategory: 'lease_conflict' });
    expect(result.failureReason).toContain('another worker holds the lease');
    expect(stateManager.markTaskFailed).not.toHaveBeenCalled();
    expect(stateManager.markTaskRetryWait).not.toHaveBeenCalled();
  });

  it('starts renewal before the completion-intent resume gate', async () => {
    const { deps, renewLease } = createDeps();
    const runner = new LeaseTestRunner(deps, { ...baseOptions(), heartbeatIntervalMs: 10 });
    // The resume gate used to run BEFORE the heartbeat existed, so a slow
    // resume consumed the lease unreserved. It now renews while it runs.
    runner.onResume = async () => { await sleep(45); };
    const result = await runner.run('task-001');
    expect(result.status).toBe('succeeded');
    expect(renewLease.mock.calls.length).toBeGreaterThanOrEqual(2);
  });
});

// ── Real-SQLite dual-worker regression (task-book §1.5) ──────────────────────

class RealSqliteRunner extends BasePeerRunner<TestContext, TestOutput> {
  public succeedCount = 0;
  private validation: PeerRunnerValidationResult = { valid: true, errors: [] };

  constructor(deps: PeerRunnerDeps, options: PeerRunnerOptions) {
    super(deps, options, {
      runnerName: 'real_sqlite_test',
      expectedTaskKind: 'dreamer',
      defaultAgentId: 'real-sqlite-test',
      resultRefPrefix: 'real-sqlite-test',
    });
  }

  setValidation(result: PeerRunnerValidationResult): void {
    this.validation = result;
  }

  // eslint-disable-next-line @typescript-eslint/class-methods-use-this
  get permanentErrorCategories(): ReadonlySet<PDErrorCategory> {
    return new Set(['input_invalid', 'output_invalid']);
  }

  // eslint-disable-next-line @typescript-eslint/class-methods-use-this
  async buildContext(): Promise<TestContext> {
    return { contextHash: 'real-hash' };
  }

  // eslint-disable-next-line @typescript-eslint/class-methods-use-this
  async invokeRuntime(): Promise<RunHandle> {
    return { runId: 'adapter-run', runtimeKind: 'test-double', startedAt: new Date().toISOString() };
  }

  async validateOutput(): Promise<PeerRunnerValidationResult> {
    return this.validation;
  }

  async succeedTask(
    taskId: string,
    runId: string,
  ): Promise<PeerRunnerResult<TestOutput>> {
    this.succeedCount += 1;
    const task = await this.markSucceededFenced(taskId, `real-sqlite://${runId}`);
    return {
      status: 'succeeded',
      taskId,
      runId,
      output: { data: 'ok' },
      attemptCount: task.attemptCount,
    };
  }
}

describe('BasePeerRunner dual-worker ownership against real SQLite', () => {
  const tmpRoot = path.join(os.tmpdir(), `pd-runner-fencing-${process.pid}-${Date.now()}`);
  const TASK_ID = 'task-runner-fencing';
  let workspace: string;
  let workerA: RuntimeStateManagerClass;
  let workerB: RuntimeStateManagerClass;

  beforeEach(async () => {
    workspace = path.join(tmpRoot, `ws-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    fs.mkdirSync(workspace, { recursive: true });
    workerA = new RuntimeStateManagerClass({ workspaceDir: workspace });
    await workerA.initialize();
    workerB = new RuntimeStateManagerClass({ workspaceDir: workspace });
    await workerB.initialize();
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

  async function seedTask(maxAttempts = 3): Promise<void> {
    await workerA.createTask({
      taskId: TASK_ID,
      taskKind: 'dreamer',
      status: 'pending',
      attemptCount: 0,
      maxAttempts,
    });
  }

  /** Worker B reclaims the task while A is still executing. */
  async function takeOver(): Promise<{ runId: string; leaseGeneration: number }> {
    await workerA.forceExpireLease(TASK_ID);
    return workerB.acquireLeaseDetailed({
      taskId: TASK_ID,
      owner: 'worker-b',
      runtimeKind: 'test-double',
    });
  }

  function buildRunner(): {
    runner: RealSqliteRunner;
    events: TelemetryEvent[];
    adapter: {
      pollRun: ReturnType<typeof vi.fn>;
      fetchOutput: ReturnType<typeof vi.fn>;
    };
  } {
    const events: TelemetryEvent[] = [];
    const adapter = {
      kind: () => 'test-double',
      startRun: vi.fn(),
      pollRun: vi.fn(async () => ({ status: 'succeeded', runId: 'adapter-run' })),
      fetchOutput: vi.fn(async () => ({ payload: { data: 'ok' }, runtimeKind: 'test-double' })),
      cancelRun: vi.fn(async () => undefined),
    };
    const deps: PeerRunnerDeps = {
      stateManager: workerA,
      runtimeAdapter: adapter as unknown as PDRuntimeAdapter,
      eventEmitter: { emitTelemetry: (event: TelemetryEvent) => { events.push(event); } },
      artifactStore: {
        upsertArtifact: vi.fn(),
        listBySourceTaskId: vi.fn(async () => []),
      } as unknown as PIArtifactStore,
    };
    const runner = new RealSqliteRunner(deps, {
      owner: 'worker-a',
      runtimeKind: 'test-double',
      pollIntervalMs: 1,
      timeoutMs: 5_000,
      // Long renewal cadence: the test controls expiry explicitly instead of
      // racing wall-clock renewal.
      leaseTtlMs: 60_000,
      heartbeatIntervalMs: 60_000,
    });
    return { runner, events, adapter };
  }

  async function assertBTaskUntouched(): Promise<void> {
    const task = await workerB.getTask(TASK_ID);
    expect(task?.status).toBe('leased');
    expect(task?.leaseOwner).toBe('worker-b');
    expect(task?.lastError ?? null).toBeNull();
    expect(task?.resultRef ?? null).toBeNull();
    expect(task?.diagnosticJson ?? null).toBeNull();
  }

  it('A runtime error after B took over cannot fail B task', async () => {
    await seedTask();
    const { runner, events, adapter } = buildRunner();
    adapter.pollRun.mockImplementation(async () => {
      await takeOver();
      throw new PDRuntimeError('execution_failed', 'A runtime blew up');
    });

    const result = await runner.run(TASK_ID);

    expect(result.status).toBe('failed');
    expect(result.errorCategory).toBe('lease_conflict');
    await assertBTaskUntouched();
    const stale = events.filter((event) => event.eventType === 'stale_commit_rejected');
    expect(stale.length).toBeGreaterThanOrEqual(1);
    expect(stale.map((event) => event.payload.phase)).toContain('retry_wait write');
  });

  it('A validation error after B took over cannot overwrite B diagnostics', async () => {
    await seedTask();
    const { runner, events, adapter } = buildRunner();
    runner.setValidation({ valid: false, errors: ['bad-shape'], errorCategory: 'output_invalid' });
    adapter.pollRun.mockImplementation(async () => {
      await takeOver();
      return { status: 'succeeded', runId: 'adapter-run' };
    });

    const result = await runner.run(TASK_ID);

    expect(result.status).toBe('failed');
    expect(result.errorCategory).toBe('lease_conflict');
    await assertBTaskUntouched();
    expect(events.filter((event) => event.eventType === 'stale_commit_rejected').length).toBeGreaterThanOrEqual(2);
  });

  it('A stale success after B took over is rejected before the commit', async () => {
    await seedTask();
    const { runner, events, adapter } = buildRunner();
    adapter.fetchOutput.mockImplementation(async () => {
      await takeOver();
      return { payload: { data: 'ok' }, runtimeKind: 'test-double' };
    });

    const result = await runner.run(TASK_ID);

    expect(result.status).toBe('failed');
    expect(result.errorCategory).toBe('lease_conflict');
    expect(runner.succeedCount).toBe(0);
    await assertBTaskUntouched();
    expect(events.map((event) => event.payload.phase)).toContain('before_success_commit');
  });

  it('A exhausted retries after B took over cannot stamp B terminal facts', async () => {
    await seedTask(1);
    const { runner, events, adapter } = buildRunner();
    adapter.pollRun.mockImplementation(async () => {
      await takeOver();
      throw new PDRuntimeError('execution_failed', 'A exhausted its budget');
    });

    const result = await runner.run(TASK_ID);

    expect(result.status).toBe('failed');
    expect(result.errorCategory).toBe('lease_conflict');
    await assertBTaskUntouched();
    const phases = events
      .filter((event) => event.eventType === 'stale_commit_rejected')
      .map((event) => event.payload.phase);
    expect(phases).toContain('terminal diagnostic write');
    expect(phases).toContain('terminal failure write');
  });

  it('B still completes normally after rejecting all of A writes', async () => {
    await seedTask();
    const { runner, adapter } = buildRunner();
    const captured: { lease: { runId: string; leaseGeneration: number } | null } = { lease: null };
    adapter.pollRun.mockImplementation(async () => {
      captured.lease = await takeOver();
      throw new PDRuntimeError('execution_failed', 'A lost the lease');
    });
    await runner.run(TASK_ID);
    const leaseB = captured.lease;
    if (leaseB === null) throw new Error('worker B never acquired the task');

    const completed = await workerB.markTaskSucceeded(
      TASK_ID,
      'result-from-b',
      { taskId: TASK_ID, owner: 'worker-b', leaseGeneration: leaseB.leaseGeneration },
      leaseB.runId,
    );
    expect(completed.status).toBe('succeeded');
    expect(completed.resultRef).toBe('result-from-b');
  });
});
