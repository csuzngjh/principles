/**
 * SPEC-PD-DIAG-ROUTER-RELIABILITY-001 §7 — failure evidence for runner-level
 * validation rejections.
 *
 * Root cause this protects: a schema-invalid model output that the *runner*
 * rejects leaves `runs.output_payload` NULL, and the adapter's evidence pack
 * only covers adapter-level failures (which now fail earlier). The raw output
 * is in scope only inside the runner, so it must be persisted there — bounded
 * and redacted, in the existing `diagnosticJson.output_failure_details`, never
 * in `runs.output_payload` (consumers treat that column as validated V2
 * output and verify it against the artifact lineage).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BasePeerRunner } from '../base-peer-runner.js';
import type { RuntimeStateManager } from '../../store/runtime-state-manager.js';
import type { PDRuntimeAdapter, RunHandle } from '../../runtime-protocol.js';
import type { StoreEventEmitter } from '../../store/event-emitter.js';
import type { PIArtifactStore } from '../../internalization/pi-artifact.js';
import type { TaskRecord } from '../../task-status.js';
import type { PDErrorCategory } from '../../error-categories.js';
import type { PeerRunnerDeps, PeerRunnerResult, PeerRunnerValidationResult } from '../peer-runner-types.js';

interface TestContext { contextHash: string; }
interface TestOutput { taskId: string; data: string; }

class TestRunner extends BasePeerRunner<TestContext, TestOutput> {
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

  private readonly permanent = new Set<PDErrorCategory>(['output_invalid', 'input_invalid', 'storage_unavailable']);

  get permanentErrorCategories(): ReadonlySet<PDErrorCategory> {
    return this.permanent;
  }
  // eslint-disable-next-line @typescript-eslint/class-methods-use-this
  async buildContext(): Promise<TestContext> { return { contextHash: 'test' }; }
  // eslint-disable-next-line @typescript-eslint/class-methods-use-this
  async invokeRuntime(): Promise<RunHandle> { return { runId: 'run-001', runtimeKind: 'test-double', startedAt: new Date().toISOString() }; }
  // eslint-disable-next-line @typescript-eslint/class-methods-use-this
  async validateOutput(): Promise<PeerRunnerValidationResult> { return { valid: true, errors: [] }; }
  // eslint-disable-next-line @typescript-eslint/class-methods-use-this
  async succeedTask(): Promise<PeerRunnerResult<TestOutput>> {
    return { status: 'succeeded', taskId: 't', runId: 'r', output: { taskId: 't', data: 'ok' }, attemptCount: 1 };
  }

  public async testHandleValidationError(
    ctx: Parameters<BasePeerRunner<TestContext, TestOutput>['handleValidationError']>[0],
  ): Promise<PeerRunnerResult<TestOutput>> {
    return this.handleValidationError(ctx);
  }
}

interface DepsWithMocks extends PeerRunnerDeps {
  _runStoreUpdateRun: ReturnType<typeof vi.fn>;
}

function makeDeps(): DepsWithMocks {
  const runStoreUpdateRun = vi.fn();
  const stateManager = {
    updateTask: vi.fn().mockResolvedValue(undefined),
    markTaskFailed: vi.fn().mockResolvedValue({ taskId: 'task-001', status: 'failed' }),
    markTaskRetryWait: vi.fn(),
    getTask: vi.fn(),
    listTasks: vi.fn(),
    getTaskHistory: vi.fn(),
    invalidateTask: vi.fn(),
    assertInitialized: vi.fn(),
    getRetryPolicy: vi.fn().mockReturnValue({ shouldRetry: () => false }),
    runStore: { updateRun: runStoreUpdateRun },
    _taskStore: {},
    _runStore: {},
    emitter: { on: vi.fn(), emitTelemetry: vi.fn() },
  } as unknown as RuntimeStateManager;

  const eventEmitter = { on: vi.fn(), emitTelemetry: vi.fn() } as unknown as StoreEventEmitter;
  const runtimeAdapter = { start: vi.fn(), supports: vi.fn(), close: vi.fn() } as unknown as PDRuntimeAdapter;
  const artifactStore = { read: vi.fn(), readJson: vi.fn(), write: vi.fn() } as unknown as PIArtifactStore;

  return { stateManager, runtimeAdapter, eventEmitter, artifactStore, _runStoreUpdateRun: runStoreUpdateRun };
}

function makeTask(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    taskId: 'task-001',
    taskKind: 'dreamer',
    status: 'leased',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    attemptCount: 1,
    maxAttempts: 3,
    diagnosticJson: '{"pi_metadata":{"channel":"prompt"}}',
    ...overrides,
  };
}

function lastPersistedDiagnosticJson(deps: DepsWithMocks): Record<string, unknown> {
  const updateTask = deps.stateManager.updateTask as unknown as {
    mock: { calls: [string, Record<string, unknown>][] };
  };
  const [lastTaskId, patch] = updateTask.mock.calls.at(-1) ?? [];
  if (lastTaskId === undefined || patch === undefined) throw new Error('expected updateTask to have been called');
  if (typeof patch.diagnosticJson !== 'string') throw new Error('expected diagnosticJson in patch');
  return JSON.parse(patch.diagnosticJson) as Record<string, unknown>;
}

describe('SPEC §7 — runner validation failure persists the raw output preview', () => {
  let runner: TestRunner;
  let deps: DepsWithMocks;

  beforeEach(() => {
    deps = makeDeps();
    runner = new TestRunner(deps);
  });

  it('stores a rawOutputPreview containing the rejected output in output_failure_details', async () => {
    await runner.testHandleValidationError({
      taskId: 'task-001',
      task: makeTask(),
      errors: ['recommendations[0].kind: Expected union value'],
      errorCategory: 'output_invalid',
      rawOutput: { recommendations: [{ kind: 'principle', recommendationRef: 'principle-1' }] },
    });

    const parsed = lastPersistedDiagnosticJson(deps);
    const details = parsed.output_failure_details as Record<string, unknown> | undefined;
    expect(details).toBeDefined();
    expect(typeof details?.rawOutputPreview).toBe('string');
    expect(String(details?.rawOutputPreview)).toContain('recommendationRef');
    expect(details?.validatorErrors).toEqual(['recommendations[0].kind: Expected union value']);
  });

  it('redacts token-like values and absolute paths in the preview', async () => {
    await runner.testHandleValidationError({
      taskId: 'task-001',
      task: makeTask(),
      errors: ['schema mismatch'],
      errorCategory: 'output_invalid',
      rawOutput: {
        leakedToken: 'sk-abcdefghijklmnopqrstuvwxyz012345',
        configPath: 'D:\\secret\\workspace\\state.db',
      },
    });

    const parsed = lastPersistedDiagnosticJson(deps);
    const preview = String((parsed.output_failure_details as Record<string, unknown>).rawOutputPreview);
    expect(preview).not.toContain('sk-abcdefghijklmnopqrstuvwxyz012345');
    expect(preview).not.toContain('D:\\secret\\workspace\\state.db');
    expect(preview).toContain('[REDACTED]');
  });

  it('bounds the preview instead of copying an arbitrarily large output', async () => {
    await runner.testHandleValidationError({
      taskId: 'task-001',
      task: makeTask(),
      errors: ['schema mismatch'],
      errorCategory: 'output_invalid',
      rawOutput: { blob: 'x'.repeat(50_000) },
    });

    const parsed = lastPersistedDiagnosticJson(deps);
    const preview = String((parsed.output_failure_details as Record<string, unknown>).rawOutputPreview);
    expect(preview.length).toBeLessThanOrEqual(2000);
  });

  it('omits the preview when no raw output was supplied (backward compatible)', async () => {
    await runner.testHandleValidationError({
      taskId: 'task-001',
      task: makeTask(),
      errors: ['not an object'],
      errorCategory: 'output_invalid',
    });

    const parsed = lastPersistedDiagnosticJson(deps);
    const details = parsed.output_failure_details as Record<string, unknown>;
    expect(Object.hasOwn(details, 'rawOutputPreview')).toBe(false);
  });

  it('does not write runs.output_payload and preserves other diagnostic keys', async () => {
    await runner.testHandleValidationError({
      taskId: 'task-001',
      task: makeTask(),
      errors: ['schema mismatch'],
      errorCategory: 'output_invalid',
      rawOutput: { invalid: true },
    });

    // The persisted patch must stay inside diagnosticJson — the run row is not
    // touched from the runner failure path.
    const updateTask = deps.stateManager.updateTask as unknown as {
      mock: { calls: [string, Record<string, unknown>][] };
    };
    const [lastTaskId, patch] = updateTask.mock.calls.at(-1) ?? [];
    if (lastTaskId === undefined || patch === undefined) throw new Error('expected updateTask to have been called');
    expect(Object.keys(patch)).toEqual(['diagnosticJson']);
    expect(deps._runStoreUpdateRun).not.toHaveBeenCalled();

    const parsed = lastPersistedDiagnosticJson(deps);
    expect(parsed.pi_metadata).toEqual({ channel: 'prompt' });
  });

  it('records each attempt from its own output instead of a stale prior iteration (rc-7)', async () => {
    // Attempt 1
    await runner.testHandleValidationError({
      taskId: 'task-001',
      task: makeTask({ attemptCount: 1 }),
      errors: ['attempt-1: recommendations[0].kind is invalid'],
      errorCategory: 'output_invalid',
      rawOutput: { marker: 'attempt-1-payload' },
    });
    const afterAttempt1 = lastPersistedDiagnosticJson(deps);

    // Attempt 2 starts from the persisted attempt-1 diagnostics.
    await runner.testHandleValidationError({
      taskId: 'task-001',
      task: makeTask({ attemptCount: 2, diagnosticJson: JSON.stringify(afterAttempt1) }),
      errors: ['attempt-2: recommendations[0].kind is invalid'],
      errorCategory: 'output_invalid',
      rawOutput: { marker: 'attempt-2-payload' },
    });

    const afterAttempt2 = lastPersistedDiagnosticJson(deps);
    const preview = String((afterAttempt2.output_failure_details as Record<string, unknown>).rawOutputPreview);
    expect(preview).toContain('attempt-2-payload');
    expect(preview).not.toContain('attempt-1-payload');

    const history = afterAttempt2.validator_error_history as { attempt: number; errors: string[] }[];
    expect(history.map((entry) => entry.attempt)).toEqual([1, 2]);
    expect(history[1]?.errors).toEqual(['attempt-2: recommendations[0].kind is invalid']);
  });
});
