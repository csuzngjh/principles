/**
 * SPEC-PD-PIPELINE-RELIABILITY-AND-EFFICIENCY-001 §5.2/§5.3 — runner lease
 * heartbeat and stale-commit fencing.
 *
 * Timings are short (tens of ms) so an integration test proves renewal across
 * a lease window without making CI wait minutes.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { BasePeerRunner } from '../base-peer-runner.js';
import type { RuntimeStateManager } from '../../store/runtime-state-manager.js';
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
} = {}) {
  const events: TelemetryEvent[] = [];
  const renewLease = vi.fn(overrides.renewLease ?? (async () => LEASED_TASK));
  const acquireLease = vi.fn(async () => LEASED_TASK);
  const stateManager = {
    acquireLease,
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
  return { deps, events, acquireLease, renewLease, pollRun, stateManager };
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
    const { deps, acquireLease } = createDeps();
    const runner = new LeaseTestRunner(deps, baseOptions());
    await runner.run('task-001');
    expect(acquireLease).toHaveBeenCalledWith(expect.objectContaining({
      owner: 'worker-a',
      durationMs: 60,
    }));
  });

  it('defaults the lease TTL to the timing contract, not the stage timeout', async () => {
    const { deps, acquireLease } = createDeps();
    const runner = new LeaseTestRunner(deps, { owner: 'worker-a', runtimeKind: 'test-double' });
    await runner.run('task-001');
    expect(runner.timing.leaseTtlMs).toBe(120_000);
    expect(runner.timing.stageTimeoutMs).toBe(300_000);
    expect(acquireLease).toHaveBeenCalledWith(expect.objectContaining({ durationMs: 120_000 }));
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
    // Every renewal uses the SAME owner identity as acquisition.
    for (const call of renewLease.mock.calls as unknown as [string, string, number][]) {
      expect(call[1]).toBe('worker-a');
      expect(call[2]).toBe(60);
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
});
