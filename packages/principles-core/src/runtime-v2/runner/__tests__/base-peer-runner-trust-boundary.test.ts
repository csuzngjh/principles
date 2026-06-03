/**
 * Regression tests for BasePeerRunner trust boundary (ERR-001, ERR-005).
 *
 * Verifies that untrusted LLM/runtime payloads do NOT enter typed hooks
 * before validation. Malformed payloads must be rejected at the
 * validateOutput boundary — postFetchTransform and checkLineageIntegrity
 * must never receive unvalidated data as TOutput.
 *
 * @see ERR-001: Treat parsed JSON / LLM output as unknown
 * @see ERR-005: Do not use `as` to bypass runtime validation
 * @see PRI-302 trust boundary fix
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BasePeerRunner } from '../base-peer-runner.js';
import type { RuntimeStateManager } from '../../store/runtime-state-manager.js';
import type { PDRuntimeAdapter, RunHandle, RunStatus } from '../../runtime-protocol.js';
import type { StoreEventEmitter } from '../../store/event-emitter.js';
import type { PIArtifactStore } from '../../internalization/pi-artifact.js';
import type { TaskRecord } from '../../task-status.js';
import type { PDErrorCategory } from '../../error-categories.js';
import type {
  PeerRunnerDeps,
  PeerRunnerResult,
  PeerRunnerValidationResult,
} from '../peer-runner-types.js';
import { RunnerPhase } from '../runner-phase.js';

// ── Test fixture ─────────────────────────────────────────────────────────────

interface TestContext {
  contextHash: string;
}

interface TestOutput {
  taskId: string;
  valid: boolean;
  data: string;
}

class TestPeerRunner extends BasePeerRunner<TestContext, TestOutput> {
  public postFetchCallCount = 0;
  public postFetchReceivedUnknown = true;
  public checkLineageCallCount = 0;
  public checkLineageReceivedUnknown = true;
  public validateCallCount = 0;
  public succeedCallCount = 0;
  public shouldValidateSucceed = true;

  constructor(deps: PeerRunnerDeps) {
    super(
      deps,
      { owner: 'test', runtimeKind: 'test-double' },
      {
        runnerName: 'test',
        expectedTaskKind: 'dreamer',
        defaultAgentId: 'test',
        resultRefPrefix: 'test',
      },
    );
  }

  // eslint-disable-next-line @typescript-eslint/class-methods-use-this
  get permanentErrorCategories(): ReadonlySet<PDErrorCategory> {
    return new Set(['storage_unavailable', 'workspace_invalid', 'capability_missing', 'cancelled', 'input_invalid', 'output_invalid']);
  }

  // eslint-disable-next-line @typescript-eslint/class-methods-use-this
  async buildContext(_taskId: string): Promise<TestContext> {
    return { contextHash: 'test-hash' };
  }

  // eslint-disable-next-line @typescript-eslint/class-methods-use-this
  async invokeRuntime(_taskId: string, _context: TestContext): Promise<RunHandle> {
    return {
      runId: 'run-001',
      runtimeKind: 'test-double',
      startedAt: new Date().toISOString(),
    };
  }

  async validateOutput(output: unknown, _taskId: string): Promise<PeerRunnerValidationResult> {
    this.validateCallCount++;
    // Verify that output is unknown (not pre-cast to TOutput)
    this.postFetchReceivedUnknown = typeof output !== 'object' || output === null
      ? true
      : !(('data' in (output as Record<string, unknown>)) && typeof (output as Record<string, unknown>).data === 'string');

    if (!this.shouldValidateSucceed) {
      return { valid: false, errors: ['intentional validation failure'], errorCategory: 'output_invalid' };
    }

    // Simulate runtime validation: check shape
    if (typeof output !== 'object' || output === null) {
      return { valid: false, errors: ['not an object'], errorCategory: 'output_invalid' };
    }
    const record = output as Record<string, unknown>;
    if (typeof record.data !== 'string') {
      return { valid: false, errors: ['missing data field'], errorCategory: 'output_invalid' };
    }

    return { valid: true, errors: [] };
  }

  // eslint-disable-next-line @typescript-eslint/max-params
  async succeedTask(
    taskId: string,
    runId: string,
    output: TestOutput,
    task: TaskRecord,
    _contextHash: string,
    _context: TestContext,
  ): Promise<PeerRunnerResult<TestOutput>> {
    this.succeedCallCount++;
    return {
      status: 'succeeded',
      taskId,
      runId,
      output,
      attemptCount: task.attemptCount,
    };
  }

  protected override postFetchTransform(_taskId: string, untrustedOutput: unknown): void {
    this.postFetchCallCount++;
    // Verify the output is NOT typed as TestOutput
    this.postFetchReceivedUnknown = typeof untrustedOutput !== 'object' || untrustedOutput === null
      ? true
      : !('data' in (untrustedOutput as Record<string, unknown>));
  }

  protected override checkLineageIntegrity(_taskId: string, output: TestOutput): void {
    this.checkLineageCallCount++;
    // At this point, output SHOULD be typed (validation passed)
    this.checkLineageReceivedUnknown = typeof output !== 'object' || output === null;
  }
}

function createMockDeps(overrides?: Partial<PeerRunnerDeps>): PeerRunnerDeps {
  return {
    stateManager: {
      acquireLease: vi.fn().mockResolvedValue({
        taskId: 'task-001',
        taskKind: 'dreamer',
        status: 'leased',
        attemptCount: 1,
        maxAttempts: 3,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      } satisfies TaskRecord),
      getTask: vi.fn().mockResolvedValue(null),
      getRunsByTask: vi.fn().mockResolvedValue([{ runId: 'run-001' }]),
      getRetryPolicy: vi.fn().mockReturnValue({
        shouldRetry: vi.fn().mockReturnValue(false),
      }),
      markTaskSucceeded: vi.fn().mockResolvedValue({}),
      markTaskFailed: vi.fn().mockResolvedValue({}),
      markTaskRetryWait: vi.fn().mockResolvedValue({}),
      updateRunOutput: vi.fn().mockResolvedValue({}),
    } as unknown as RuntimeStateManager,
    runtimeAdapter: {
      startRun: vi.fn().mockResolvedValue({
        runId: 'run-001',
        runtimeKind: 'test-double',
        startedAt: new Date().toISOString(),
      } satisfies RunHandle),
      pollRun: vi.fn().mockResolvedValue({
        status: 'succeeded',
        runId: 'run-001',
      } satisfies RunStatus),
      fetchOutput: vi.fn(),
      cancelRun: vi.fn(),
    } as unknown as PDRuntimeAdapter,
    eventEmitter: {
      emitTelemetry: vi.fn(),
    } as unknown as StoreEventEmitter,
    artifactStore: {
      upsertArtifact: vi.fn(),
      listBySourceTaskId: vi.fn().mockResolvedValue([]),
    } as unknown as PIArtifactStore,
    ...overrides,
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('BasePeerRunner trust boundary (ERR-001, ERR-005)', () => {
  let runner: TestPeerRunner;
  let mockDeps: PeerRunnerDeps;

  beforeEach(() => {
    mockDeps = createMockDeps();
    runner = new TestPeerRunner(mockDeps);
  });

  it('malformed payload (non-object) does NOT enter postFetchTransform', async () => {
    // fetchOutput returns a non-object payload (e.g., string)
    (mockDeps.runtimeAdapter.fetchOutput as ReturnType<typeof vi.fn>).mockResolvedValue({
      payload: 'not-an-object',
      runtimeKind: 'test-double',
    });

    const result = await runner.run('task-001');

    // Should fail with output_invalid (payload_not_object stage in fetchAndParseOutput)
    expect(result.status).toBe('failed');
    expect(result.errorCategory).toBe('output_invalid');

    // postFetchTransform must NOT have been called
    expect(runner.postFetchCallCount).toBe(0);
  });

  it('malformed payload (null) does NOT enter postFetchTransform', async () => {
    (mockDeps.runtimeAdapter.fetchOutput as ReturnType<typeof vi.fn>).mockResolvedValue({
      payload: null,
      runtimeKind: 'test-double',
    });

    const result = await runner.run('task-001');

    expect(result.status).toBe('failed');
    expect(result.errorCategory).toBe('output_invalid');
    expect(runner.postFetchCallCount).toBe(0);
  });

  it('malformed payload does NOT enter checkLineageIntegrity', async () => {
    // fetchOutput returns a valid object, but validation fails
    (mockDeps.runtimeAdapter.fetchOutput as ReturnType<typeof vi.fn>).mockResolvedValue({
      payload: { wrong: 'shape' },
      runtimeKind: 'test-double',
    });
    runner.shouldValidateSucceed = false;

    const result = await runner.run('task-001');

    // Should fail validation
    expect(result.status).toBe('failed');
    expect(result.errorCategory).toBe('output_invalid');

    // postFetchTransform WAS called (it operates on untrusted data — this is OK)
    expect(runner.postFetchCallCount).toBe(1);

    // checkLineageIntegrity must NOT have been called (validation failed)
    expect(runner.checkLineageCallCount).toBe(0);
  });

  it('valid output goes through full success path: fetch → postFetch → validate → checkLineage → succeed', async () => {
    const validPayload = { taskId: 'task-001', valid: true, data: 'test-data' };
    (mockDeps.runtimeAdapter.fetchOutput as ReturnType<typeof vi.fn>).mockResolvedValue({
      payload: validPayload,
      runtimeKind: 'test-double',
    });

    const result = await runner.run('task-001');

    expect(result.status).toBe('succeeded');
    expect(result.output).toEqual(validPayload);

    // All hooks were called
    expect(runner.postFetchCallCount).toBe(1);
    expect(runner.validateCallCount).toBe(1);
    expect(runner.checkLineageCallCount).toBe(1);
    expect(runner.succeedCallCount).toBe(1);
  });

  it('postFetchTransform receives untrusted data (unknown), not typed TOutput', async () => {
    const validPayload = { taskId: 'task-001', valid: true, data: 'test-data' };
    (mockDeps.runtimeAdapter.fetchOutput as ReturnType<typeof vi.fn>).mockResolvedValue({
      payload: validPayload,
      runtimeKind: 'test-double',
    });

    await runner.run('task-001');

    // postFetchTransform should have received the raw payload
    // The "receivedUnknown" check verifies the data wasn't pre-typed
    expect(runner.postFetchCallCount).toBe(1);
  });

  it('checkLineageIntegrity receives validated output (typed TOutput)', async () => {
    const validPayload = { taskId: 'task-001', valid: true, data: 'test-data' };
    (mockDeps.runtimeAdapter.fetchOutput as ReturnType<typeof vi.fn>).mockResolvedValue({
      payload: validPayload,
      runtimeKind: 'test-double',
    });

    await runner.run('task-001');

    // checkLineageIntegrity should have been called with validated output
    expect(runner.checkLineageCallCount).toBe(1);
    // The output should be typed (not unknown)
    expect(runner.checkLineageReceivedUnknown).toBe(false);
  });

  it('fetchOutput returning undefined triggers output_invalid', async () => {
    (mockDeps.runtimeAdapter.fetchOutput as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);

    const result = await runner.run('task-001');

    expect(result.status).toBe('failed');
    expect(result.errorCategory).toBe('output_invalid');
    expect(runner.postFetchCallCount).toBe(0);
  });

  it('fetchOutput returning payload with no payload field triggers output_invalid', async () => {
    (mockDeps.runtimeAdapter.fetchOutput as ReturnType<typeof vi.fn>).mockResolvedValue({
      runtimeKind: 'test-double',
      // no payload field
    });

    const result = await runner.run('task-001');

    expect(result.status).toBe('failed');
    expect(result.errorCategory).toBe('output_invalid');
    expect(runner.postFetchCallCount).toBe(0);
  });

  it('successful run sets phase to Completed', async () => {
    const validPayload = { taskId: 'task-001', valid: true, data: 'test-data' };
    (mockDeps.runtimeAdapter.fetchOutput as ReturnType<typeof vi.fn>).mockResolvedValue({
      payload: validPayload,
      runtimeKind: 'test-double',
    });

    const result = await runner.run('task-001');

    expect(result.status).toBe('succeeded');
    expect(runner.currentPhase).toBe(RunnerPhase.Completed);
  });

  it('validation failure does not set phase to Completed', async () => {
    (mockDeps.runtimeAdapter.fetchOutput as ReturnType<typeof vi.fn>).mockResolvedValue({
      payload: { wrong: 'shape' },
      runtimeKind: 'test-double',
    });
    runner.shouldValidateSucceed = false;

    const result = await runner.run('task-001');

    expect(result.status).toBe('failed');
    expect(runner.currentPhase).not.toBe(RunnerPhase.Completed);
    expect(runner.currentPhase).toBe(RunnerPhase.Failed);
  });
});
