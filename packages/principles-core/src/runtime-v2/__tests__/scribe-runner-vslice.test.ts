import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ScribeRunner } from '../internalization/scribe-runner.js';
import type { ScribeRunnerDeps } from '../internalization/scribe-runner.js';
import type { PIArtifactStore, PIArtifactRecord } from '../internalization/pi-artifact.js';
import { MemoryPIArtifactStore } from '../internalization/pi-artifact-store.js';
import type { RuntimeStateManager } from '../store/runtime-state-manager.js';
import type { PDRuntimeAdapter, RunHandle, RunStatus } from '../runtime-protocol.js';
import type { StoreEventEmitter } from '../store/event-emitter.js';
import type { ScribeOutputV1, ScribeValidator, ScribeValidationResult } from '../internalization/scribe-output.js';
import { DefaultScribeValidator } from '../internalization/scribe-output.js';
import { createPITaskDiagnosticJson } from '../internalization/pitask-metadata.js';
import type { TaskRecord } from '../task-status.js';
import { RunnerPhase } from '../runner/runner-phase.js';

import { PDRuntimeError } from '../error-categories.js';

const PHILOSOPHER_TASK_ID = 'philosopher-001';
const SCRIBE_TASK_ID = 'scribe-001';

function makePhilosopherTask(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    taskId: PHILOSOPHER_TASK_ID,
    taskKind: 'philosopher',
    status: 'succeeded',
    attemptCount: 1,
    maxAttempts: 3,
    resultRef: 'philosopher://run-001',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    diagnosticJson: createPITaskDiagnosticJson({
      dependencyTaskIds: [],
      channel: 'prompt',
      timeoutMs: 300_000,
      inputArtifactRefs: [],
      outputArtifactRefs: [{ artifactType: 'principle', ref: 'pi-art-philosopher-001-run-001' }],
    }),
    ...overrides,
  };
}

function makeScribeTask(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    taskId: SCRIBE_TASK_ID,
    taskKind: 'scribe',
    status: 'pending',
    attemptCount: 0,
    maxAttempts: 3,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    diagnosticJson: createPITaskDiagnosticJson({
      dependencyTaskIds: [PHILOSOPHER_TASK_ID],
      channel: 'prompt',
      timeoutMs: 300_000,
      inputArtifactRefs: [{ artifactType: 'principle', ref: 'pi-art-philosopher-001-run-001' }],
      outputArtifactRefs: [],
    }),
    ...overrides,
  };
}

function makeScribeOutput(): ScribeOutputV1 {
  return {
    taskId: SCRIBE_TASK_ID,
    sourcePhilosopherArtifactId: 'pi-art-philosopher-001-run-001',
    principleDraft: {
      title: 'Systematic Error Handling',
      statement: 'All async operations must include explicit error handling',
      rationale: 'Uncaught errors cascade into system instability',
      applicability: ['All async operations'],
      antiPatterns: ['Ignoring promise rejections'],
      confidence: 0.9,
    },
    sourceTrace: {
      philosopherArtifactId: 'pi-art-philosopher-001-run-001',
    },
    risks: ['May add latency from error checking'],
    generatedAt: new Date().toISOString(),
  };
}

function makePhilosopherArtifact(): PIArtifactRecord {
  return {
    artifactId: 'pi-art-philosopher-001-run-001',
    artifactKind: 'principle',
    sourceTaskId: PHILOSOPHER_TASK_ID,
    lineageArtifactIds: [],
    validationStatus: 'pending',
    contentJson: JSON.stringify({
      taskId: PHILOSOPHER_TASK_ID,
      sourceDreamerArtifactId: 'pi-art-dreamer-001',
      thesis: 'Error handling should be systematic',
      principleCandidate: {
        title: 'Systematic Error Handling',
        rationale: 'Uncaught errors cascade',
        scope: 'All async operations',
        confidence: 0.9,
      },
      risks: [],
      generatedAt: new Date().toISOString(),
    }),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

describe('ScribeRunner (migrated to BasePeerRunner)', () => {
  let artifactStore: PIArtifactStore = new MemoryPIArtifactStore();

  /** Extract recorded mock calls from a vi.fn() reached through an unknown-typed object. */
  function getMockCalls(holder: unknown, method: string): unknown[][] {
    const record = holder as Record<string, { mock?: { calls?: unknown[][] } }>;
    return record[method]?.mock?.calls ?? [];
  }

  beforeEach(() => {
    artifactStore = new MemoryPIArtifactStore();
  });

  function createMockDeps(overrides: Partial<ScribeRunnerDeps> = {}): ScribeRunnerDeps {
    const scribeTask = makeScribeTask();
    const philosopherTask = makePhilosopherTask();

    const stateManager = {
      acquireLease: vi.fn().mockResolvedValue(scribeTask),
      getTask: vi.fn().mockImplementation((id: string) => {
        if (id === SCRIBE_TASK_ID) return Promise.resolve(scribeTask);
        if (id === PHILOSOPHER_TASK_ID) return Promise.resolve(philosopherTask);
        return Promise.resolve(null);
      }),
      getRunsByTask: vi.fn().mockResolvedValue([{
        runId: 'run-scribe-001',
        taskId: SCRIBE_TASK_ID,
        runtimeKind: 'scribe',
        startedAt: new Date().toISOString(),
      }]),
      getValidRunsByTaskTolerant: vi.fn().mockResolvedValue({
        runs: [{ runId: 'run-scribe-001', taskId: SCRIBE_TASK_ID, runtimeKind: 'scribe', startedAt: new Date().toISOString() }],
        degradedRuns: [],
      }),
      updateRunOutput: vi.fn().mockResolvedValue(undefined),
      markTaskSucceeded: vi.fn().mockResolvedValue(undefined),
      markTaskFailed: vi.fn().mockResolvedValue(undefined),
      markTaskRetryWait: vi.fn().mockResolvedValue(undefined),
      getRetryPolicy: vi.fn().mockReturnValue({ shouldRetry: () => false }),
    } as unknown as RuntimeStateManager;

    const runHandle: RunHandle = { runId: 'run-scribe-001', runtimeKind: 'test-double', startedAt: new Date().toISOString() };
    const succeededStatus: RunStatus = { status: 'succeeded', runId: 'run-scribe-001' };

    const runtimeAdapter = {
      startRun: vi.fn().mockResolvedValue(runHandle),
      pollRun: vi.fn().mockResolvedValue(succeededStatus),
      fetchOutput: vi.fn().mockResolvedValue({
        payload: makeScribeOutput(),
      }),
      cancelRun: vi.fn().mockResolvedValue(undefined),
    } as unknown as PDRuntimeAdapter;

    const eventEmitter = {
      emitTelemetry: vi.fn(),
    } as unknown as StoreEventEmitter;

    const validator = new DefaultScribeValidator();

    return {
      stateManager,
      runtimeAdapter,
      eventEmitter,
      validator,
      artifactStore,
      ...overrides,
    };
  }

  // ── Existing behavior: task kind validation ────────────────────────────────

  it('taskKind not scribe fails closed and releases lease', async () => {
    const wrongKindTask = makeScribeTask({ taskKind: 'dreamer' });
    const deps = createMockDeps();
    (deps.stateManager as unknown as Record<string, unknown>).acquireLease = vi.fn().mockResolvedValue(wrongKindTask);

    const runner = new ScribeRunner(deps, {
      owner: 'test',
      runtimeKind: 'scribe',
      pollIntervalMs: 10,
      timeoutMs: 1000,
    });

    const result = await runner.run(SCRIBE_TASK_ID);
    expect(result.status).toBe('failed');
    expect(result.errorCategory).toBe('input_invalid');
    expect(result.failureReason).toContain("must be 'scribe'");
    expect(deps.stateManager.markTaskFailed).toHaveBeenCalledWith(
      SCRIBE_TASK_ID,
      'input_invalid',
    );
  });

  // ── Existing behavior: lease conflict ──────────────────────────────────────

  it('lease conflict is non-mutating', async () => {
    const deps = createMockDeps();
    const leaseError = new PDRuntimeError('lease_conflict', 'Another runner holds the lease');
    (deps.stateManager as unknown as Record<string, unknown>).acquireLease = vi.fn().mockRejectedValue(leaseError);

    const runner = new ScribeRunner(deps, {
      owner: 'test',
      runtimeKind: 'scribe',
      pollIntervalMs: 10,
      timeoutMs: 1000,
    });

    const result = await runner.run(SCRIBE_TASK_ID);
    expect(result.status).toBe('failed');
    expect(result.errorCategory).toBe('lease_conflict');
    expect(deps.stateManager.markTaskFailed).not.toHaveBeenCalled();
    expect(deps.stateManager.markTaskRetryWait).not.toHaveBeenCalled();
  });

  // ── Existing behavior: missing philosopher dependency ──────────────────────

  it('missing philosopher dependency blocked/failure', async () => {
    const noDepTask = makeScribeTask({
      diagnosticJson: createPITaskDiagnosticJson({
        dependencyTaskIds: [],
        channel: 'prompt',
        timeoutMs: 300_000,
        inputArtifactRefs: [],
        outputArtifactRefs: [],
      }),
    });
    const deps = createMockDeps();
    (deps.stateManager as unknown as Record<string, unknown>).acquireLease = vi.fn().mockResolvedValue(noDepTask);
    (deps.stateManager as unknown as Record<string, unknown>).getTask = vi.fn().mockResolvedValue(noDepTask);

    const runner = new ScribeRunner(deps, {
      owner: 'test',
      runtimeKind: 'scribe',
      pollIntervalMs: 10,
      timeoutMs: 1000,
    });

    const result = await runner.run(SCRIBE_TASK_ID);
    expect(result.status).toBe('failed');
    expect(result.errorCategory).toBe('input_invalid');
  });

  // ── Existing behavior: philosopher not succeeded ───────────────────────────

  it('philosopher dependency not succeeded cannot execute', async () => {
    const pendingPhilosopher = makePhilosopherTask({ status: 'pending' });
    const deps = createMockDeps();
    (deps.stateManager as unknown as Record<string, unknown>).getTask = vi.fn().mockImplementation((id: string) => {
      if (id === SCRIBE_TASK_ID) return Promise.resolve(makeScribeTask());
      if (id === PHILOSOPHER_TASK_ID) return Promise.resolve(pendingPhilosopher);
      return Promise.resolve(null);
    });

    const runner = new ScribeRunner(deps, {
      owner: 'test',
      runtimeKind: 'scribe',
      pollIntervalMs: 10,
      timeoutMs: 1000,
    });

    const result = await runner.run(SCRIBE_TASK_ID);
    expect(result.status).toBe('failed');
    expect(result.errorCategory).toBe('input_invalid');
  });

  // ── Existing behavior: philosopher artifact missing ────────────────────────

  it('philosopher artifact missing goes to retry/fail', async () => {
    const emptyArtifactStore = new MemoryPIArtifactStore();
    const deps = createMockDeps({ artifactStore: emptyArtifactStore });

    const runner = new ScribeRunner(deps, {
      owner: 'test',
      runtimeKind: 'scribe',
      pollIntervalMs: 10,
      timeoutMs: 1000,
    });

    const result = await runner.run(SCRIBE_TASK_ID);
    expect(result.status).toBe('failed');
    expect(result.errorCategory).toBe('input_invalid');
  });

  // ── Existing behavior: valid output writes artifact ────────────────────────

  it('valid runtime output writes scribe PIArtifact', async () => {
    const store = new MemoryPIArtifactStore();
    await store.upsertArtifact(makePhilosopherArtifact());
    const deps = createMockDeps({ artifactStore: store });

    const runner = new ScribeRunner(deps, {
      owner: 'test',
      runtimeKind: 'scribe',
      pollIntervalMs: 10,
      timeoutMs: 1000,
    });

    const result = await runner.run(SCRIBE_TASK_ID);
    expect(result.status).toBe('succeeded');
    expect(result.artifactId).toBeDefined();

    const artifacts = await store.listBySourceTaskId(SCRIBE_TASK_ID);
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0]?.artifactKind).toBe('principle');
  });

  // ── Existing behavior: valid output marks succeeded ────────────────────────

  it('valid runtime output marks task succeeded', async () => {
    const store = new MemoryPIArtifactStore();
    await store.upsertArtifact(makePhilosopherArtifact());
    const deps = createMockDeps({ artifactStore: store });

    const runner = new ScribeRunner(deps, {
      owner: 'test',
      runtimeKind: 'scribe',
      pollIntervalMs: 10,
      timeoutMs: 1000,
    });

    const result = await runner.run(SCRIBE_TASK_ID);
    expect(result.status).toBe('succeeded');
    expect(deps.stateManager.markTaskSucceeded).toHaveBeenCalledWith(
      SCRIBE_TASK_ID,
      expect.stringContaining('scribe://'),
    );
  });

  // ── Existing behavior: invalid output does not write artifact ──────────────

  it('invalid output does not write artifact', async () => {
    const store = new MemoryPIArtifactStore();
    await store.upsertArtifact(makePhilosopherArtifact());
    const deps = createMockDeps({ artifactStore: store });

    const invalidOutput: ScribeOutputV1 = {
      taskId: 'wrong-task-id',
      sourcePhilosopherArtifactId: '',
      principleDraft: {
        title: '',
        statement: '',
        rationale: '',
        applicability: [],
        antiPatterns: [],
        confidence: 1.5,
      },
      sourceTrace: {
        philosopherArtifactId: '',
      },
      risks: 'not-array' as unknown as string[],
      generatedAt: '',
    };

    (deps.runtimeAdapter as unknown as Record<string, unknown>).fetchOutput = vi.fn().mockResolvedValue({
      payload: invalidOutput,
    });

    const runner = new ScribeRunner(deps, {
      owner: 'test',
      runtimeKind: 'scribe',
      pollIntervalMs: 10,
      timeoutMs: 1000,
    });

    const result = await runner.run(SCRIBE_TASK_ID);
    expect(result.status).toBe('failed');

    const artifacts = await store.listBySourceTaskId(SCRIBE_TASK_ID);
    expect(artifacts).toHaveLength(0);
  });

  // ── Existing behavior: artifact write failure ──────────────────────────────

  it('artifact write failure goes to retry/fail, not mark succeeded', async () => {
    const failingStore = {
      listBySourceTaskId: vi.fn().mockResolvedValue([makePhilosopherArtifact()]),
      upsertArtifact: vi.fn().mockRejectedValue(new Error('Disk full')),
    } as unknown as PIArtifactStore;

    const deps = createMockDeps({ artifactStore: failingStore });

    const runner = new ScribeRunner(deps, {
      owner: 'test',
      runtimeKind: 'scribe',
      pollIntervalMs: 10,
      timeoutMs: 1000,
    });

    const result = await runner.run(SCRIBE_TASK_ID);
    expect(result.status).toBe('failed');
    expect(deps.stateManager.markTaskSucceeded).not.toHaveBeenCalled();
  });

  // ── PRI-541: lineage echo reconciliation replaces the old fail-closed contract ─
  //
  // The OLD contract (mismatched sourcePhilosopherArtifactId echo →
  // output_invalid → max_attempts_exceeded) dead-ended candidates in
  // production: LLMs routinely truncate long artifact IDs when echoing them
  // back, and the failure burned all retry attempts. The NEW contract:
  // lineage is runner-owned metadata, postFetchTransform reconciles the echo
  // with the authoritative context value BEFORE validation, and a
  // scribe_lineage_echo_corrected telemetry event is emitted (rc-9).

  it('LLM-echoed truncated lineage is reconciled and succeeds with telemetry', async () => {
    const store = new MemoryPIArtifactStore();
    await store.upsertArtifact(makePhilosopherArtifact());
    const deps = createMockDeps({ artifactStore: store });

    // Simulate the production failure mode: truncated artifact ID echo.
    const echoedOutput = makeScribeOutput();
    (echoedOutput as unknown as Record<string, unknown>).sourcePhilosopherArtifactId = 'pi-art-philosopher-001';
    (echoedOutput.sourceTrace as unknown as Record<string, unknown>).philosopherArtifactId = 'pi-art-philosopher-001';

    (deps.runtimeAdapter as unknown as Record<string, unknown>).fetchOutput = vi.fn().mockResolvedValue({
      payload: echoedOutput,
    });

    const runner = new ScribeRunner(deps, {
      owner: 'test',
      runtimeKind: 'scribe',
      pollIntervalMs: 10,
      timeoutMs: 1000,
    });

    const result = await runner.run(SCRIBE_TASK_ID);
    expect(result.status).toBe('succeeded');
    expect(deps.stateManager.markTaskSucceeded).toHaveBeenCalled();

    // Persisted output carries the authoritative lineage, not the LLM echo.
    const outputCalls = getMockCalls(deps.stateManager, 'updateRunOutput');
    const persistedJson = outputCalls[0]?.[1] as string;
    const persisted = JSON.parse(persistedJson) as Record<string, { philosopherArtifactId?: string }>;
    expect(persisted.sourcePhilosopherArtifactId).toBe('pi-art-philosopher-001-run-001');
    expect(persisted.sourceTrace?.philosopherArtifactId).toBe('pi-art-philosopher-001-run-001');

    // Telemetry makes the correction observable (rc-9).
    const telemetryCalls = getMockCalls(deps.eventEmitter, 'emitTelemetry');
    const correctedEvent = telemetryCalls
      .map((call) => call[0] as { eventType: string; payload: Record<string, unknown> })
      .find((evt) => evt.eventType === 'scribe_lineage_echo_corrected');
    expect(correctedEvent).toBeDefined();
    expect(correctedEvent?.payload.correctedFields).toEqual(
      expect.arrayContaining(['sourcePhilosopherArtifactId', 'sourceTrace.philosopherArtifactId']),
    );
  });

  it('content-field validation failures are NOT reconciled and still fail', async () => {
    const store = new MemoryPIArtifactStore();
    await store.upsertArtifact(makePhilosopherArtifact());
    const deps = createMockDeps({ artifactStore: store });

    // Lineage echoes are correct here, but the draft content is invalid —
    // reconciliation must not mask genuine output_invalid content errors.
    const badContentOutput = makeScribeOutput();
    (badContentOutput.principleDraft as unknown as Record<string, unknown>).confidence = 1.5;

    (deps.runtimeAdapter as unknown as Record<string, unknown>).fetchOutput = vi.fn().mockResolvedValue({
      payload: badContentOutput,
    });

    const runner = new ScribeRunner(deps, {
      owner: 'test',
      runtimeKind: 'scribe',
      pollIntervalMs: 10,
      timeoutMs: 1000,
    });

    const result = await runner.run(SCRIBE_TASK_ID);
    expect(result.status).toBe('failed');
    expect(result.errorCategory).toBe('max_attempts_exceeded');

    const artifacts = await store.listBySourceTaskId(SCRIBE_TASK_ID);
    expect(artifacts).toHaveLength(0);
    expect(deps.stateManager.markTaskSucceeded).not.toHaveBeenCalled();
  });

  // ── PRI-541: present-but-empty taskId is a wrong echo — corrected ──────────
  //
  // Under the OLD inject-only contract, taskId: '' was left untouched to
  // fail loud in the validator. Under the PRI-541 reconciliation contract,
  // an empty string is a corrupted echo of a runner-owned value (same class
  // as a truncated artifact ID) and is overwritten with the authoritative
  // taskId. The ERR-049 fail-loud semantics still hold for fields the gate
  // does not own — the gate only rewrites fields it has authoritative
  // values for.

  it('present-but-empty taskId is reconciled to the authoritative taskId', async () => {
    const store = new MemoryPIArtifactStore();
    await store.upsertArtifact(makePhilosopherArtifact());
    const deps = createMockDeps({ artifactStore: store });

    const emptyTaskIdOutput = makeScribeOutput();
    (emptyTaskIdOutput as unknown as Record<string, unknown>).taskId = '';

    (deps.runtimeAdapter as unknown as Record<string, unknown>).fetchOutput = vi.fn().mockResolvedValue({
      payload: emptyTaskIdOutput,
    });

    const runner = new ScribeRunner(deps, {
      owner: 'test',
      runtimeKind: 'scribe',
      pollIntervalMs: 10,
      timeoutMs: 1000,
    });

    const result = await runner.run(SCRIBE_TASK_ID);
    expect(result.status).toBe('succeeded');

    const outputCalls = getMockCalls(deps.stateManager, 'updateRunOutput');
    const persistedJson = outputCalls[0]?.[1] as string;
    const persisted = JSON.parse(persistedJson) as { taskId?: string };
    expect(persisted.taskId).toBe(SCRIBE_TASK_ID);
  });

  // ── NEW: missing taskId re-injected by postFetchTransform ──────────────────

  it('missing taskId is re-injected by postFetchTransform per stripLineage contract', async () => {
    const store = new MemoryPIArtifactStore();
    await store.upsertArtifact(makePhilosopherArtifact());
    const deps = createMockDeps({ artifactStore: store });

    // Output without taskId — should be re-injected
    const noTaskIdOutput = { ...makeScribeOutput() };
    delete (noTaskIdOutput as unknown as Record<string, unknown>).taskId;

    (deps.runtimeAdapter as unknown as Record<string, unknown>).fetchOutput = vi.fn().mockResolvedValue({
      payload: noTaskIdOutput,
    });

    const runner = new ScribeRunner(deps, {
      owner: 'test',
      runtimeKind: 'scribe',
      pollIntervalMs: 10,
      timeoutMs: 1000,
    });

    const result = await runner.run(SCRIBE_TASK_ID);
    // taskId is re-injected, so validation should pass
    expect(result.status).toBe('succeeded');
    expect(result.artifactId).toBeDefined();
  });

  // ── NEW: invalid validator errorCategory runtime guard ─────────────────────

  it('invalid validator errorCategory is runtime-guarded and does not pass through', async () => {
    const store = new MemoryPIArtifactStore();
    await store.upsertArtifact(makePhilosopherArtifact());

    // Create a validator that returns an invalid errorCategory
    const badValidator: ScribeValidator = {
      validate: async (_output: unknown, _taskId: string): Promise<ScribeValidationResult> => {
        return { valid: false, errors: ['test error'], errorCategory: 'not_a_real_category' };
      },
    };

    const deps = createMockDeps({ artifactStore: store, validator: badValidator });

    const runner = new ScribeRunner(deps, {
      owner: 'test',
      runtimeKind: 'scribe',
      pollIntervalMs: 10,
      timeoutMs: 1000,
    });

    const result = await runner.run(SCRIBE_TASK_ID);
    expect(result.status).toBe('failed');
    // The invalid errorCategory is replaced with 'output_invalid' by validateOutput,
    // which is retriable; after retry exhaustion → max_attempts_exceeded
    expect(result.errorCategory).toBe('max_attempts_exceeded');
  });

  // ── NEW: currentPhase is Completed after success ───────────────────────────

  it('currentPhase is Completed after successful run', async () => {
    const store = new MemoryPIArtifactStore();
    await store.upsertArtifact(makePhilosopherArtifact());
    const deps = createMockDeps({ artifactStore: store });

    const runner = new ScribeRunner(deps, {
      owner: 'test',
      runtimeKind: 'scribe',
      pollIntervalMs: 10,
      timeoutMs: 1000,
    });

    const result = await runner.run(SCRIBE_TASK_ID);
    expect(result.status).toBe('succeeded');
    expect(runner.currentPhase).toBe(RunnerPhase.Completed);
  });

  // ── NEW: currentPhase is Failed after validation failure ───────────────────

  it('currentPhase is Failed after validation failure', async () => {
    const store = new MemoryPIArtifactStore();
    await store.upsertArtifact(makePhilosopherArtifact());
    const deps = createMockDeps({ artifactStore: store });

    const invalidOutput = { wrong: 'shape' };
    (deps.runtimeAdapter as unknown as Record<string, unknown>).fetchOutput = vi.fn().mockResolvedValue({
      payload: invalidOutput,
    });

    const runner = new ScribeRunner(deps, {
      owner: 'test',
      runtimeKind: 'scribe',
      pollIntervalMs: 10,
      timeoutMs: 1000,
    });

    const result = await runner.run(SCRIBE_TASK_ID);
    expect(result.status).toBe('failed');
    expect(runner.currentPhase).toBe(RunnerPhase.Failed);
  });

  // ── NEW: validation failure does not write artifact ────────────────────────

  it('validation failure does not write artifact or mark succeeded', async () => {
    const store = new MemoryPIArtifactStore();
    await store.upsertArtifact(makePhilosopherArtifact());
    const deps = createMockDeps({ artifactStore: store });

    // Malformed output that fails validation
    const malformedOutput = {
      notTheRightShape: true,
    };

    (deps.runtimeAdapter as unknown as Record<string, unknown>).fetchOutput = vi.fn().mockResolvedValue({
      payload: malformedOutput,
    });

    const runner = new ScribeRunner(deps, {
      owner: 'test',
      runtimeKind: 'scribe',
      pollIntervalMs: 10,
      timeoutMs: 1000,
    });

    const result = await runner.run(SCRIBE_TASK_ID);
    expect(result.status).toBe('failed');

    // No artifact written
    const artifacts = await store.listBySourceTaskId(SCRIBE_TASK_ID);
    expect(artifacts).toHaveLength(0);

    // No markTaskSucceeded
    expect(deps.stateManager.markTaskSucceeded).not.toHaveBeenCalled();

    // No updateRunOutput
    expect(deps.stateManager.updateRunOutput).not.toHaveBeenCalled();
  });

  // ── NEW: malformed output (non-object) does not write artifact ─────────────

  it('malformed output (non-object payload) does not write artifact', async () => {
    const store = new MemoryPIArtifactStore();
    await store.upsertArtifact(makePhilosopherArtifact());
    const deps = createMockDeps({ artifactStore: store });

    // Non-object payload
    (deps.runtimeAdapter as unknown as Record<string, unknown>).fetchOutput = vi.fn().mockResolvedValue({
      payload: 'not-an-object',
    });

    const runner = new ScribeRunner(deps, {
      owner: 'test',
      runtimeKind: 'scribe',
      pollIntervalMs: 10,
      timeoutMs: 1000,
    });

    const result = await runner.run(SCRIBE_TASK_ID);
    expect(result.status).toBe('failed');

    // No artifact written
    const artifacts = await store.listBySourceTaskId(SCRIBE_TASK_ID);
    expect(artifacts).toHaveLength(0);
  });

  // ── NEW: succeedTask writes correct artifactKind ───────────────────────────

  it('succeedTask writes artifact with correct artifactKind principle', async () => {
    const store = new MemoryPIArtifactStore();
    await store.upsertArtifact(makePhilosopherArtifact());
    const deps = createMockDeps({ artifactStore: store });

    const runner = new ScribeRunner(deps, {
      owner: 'test',
      runtimeKind: 'scribe',
      pollIntervalMs: 10,
      timeoutMs: 1000,
    });

    const result = await runner.run(SCRIBE_TASK_ID);
    expect(result.status).toBe('succeeded');

    const artifacts = await store.listBySourceTaskId(SCRIBE_TASK_ID);
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0]?.artifactKind).toBe('principle');
  });

  // ── NEW: succeedTask calls markTaskSucceeded ───────────────────────────────

  it('succeedTask calls markTaskSucceeded with scribe:// resultRef', async () => {
    const store = new MemoryPIArtifactStore();
    await store.upsertArtifact(makePhilosopherArtifact());
    const deps = createMockDeps({ artifactStore: store });

    const runner = new ScribeRunner(deps, {
      owner: 'test',
      runtimeKind: 'scribe',
      pollIntervalMs: 10,
      timeoutMs: 1000,
    });

    const result = await runner.run(SCRIBE_TASK_ID);
    expect(result.status).toBe('succeeded');
    expect(deps.stateManager.markTaskSucceeded).toHaveBeenCalledWith(
      SCRIBE_TASK_ID,
      expect.stringMatching(/^scribe:\/\//),
    );
  });

  // ── NEW: succeedTask calls updateRunOutput before markTaskSucceeded ────────

  it('succeedTask calls updateRunOutput before markTaskSucceeded', async () => {
    const store = new MemoryPIArtifactStore();
    await store.upsertArtifact(makePhilosopherArtifact());
    const deps = createMockDeps({ artifactStore: store });

    const callOrder: string[] = [];
    (deps.stateManager.updateRunOutput as ReturnType<typeof vi.fn>).mockImplementation(() => {
      callOrder.push('updateRunOutput');
      return Promise.resolve();
    });
    (deps.stateManager.markTaskSucceeded as ReturnType<typeof vi.fn>).mockImplementation(() => {
      callOrder.push('markTaskSucceeded');
      return Promise.resolve();
    });

    const runner = new ScribeRunner(deps, {
      owner: 'test',
      runtimeKind: 'scribe',
      pollIntervalMs: 10,
      timeoutMs: 1000,
    });

    const result = await runner.run(SCRIBE_TASK_ID);
    expect(result.status).toBe('succeeded');
    expect(callOrder).toEqual(['updateRunOutput', 'markTaskSucceeded']);
  });

  // ── PRI-541: reconciliation runs even before a permissive validator ────────
  //
  // Previously this scenario (permissive validator + mismatched echo) tested
  // the succeedTask lineage check as the last line of defense. With the
  // shared lineage echo gate, postFetchTransform reconciles the echo BEFORE
  // validation, so the succeedTask check no longer fires on this path (it
  // remains in the code as defense in depth). The observable contract:
  // the authoritative value is persisted, never the LLM echo.

  it('lineage echo is reconciled even when the validator is permissive', async () => {
    const store = new MemoryPIArtifactStore();
    await store.upsertArtifact(makePhilosopherArtifact());
    const deps = createMockDeps({ artifactStore: store });

    const permissiveValidator: ScribeValidator = {
      validate: async (): Promise<ScribeValidationResult> => {
        return { valid: true, errors: [] };
      },
    };

    const mismatchedOutput = makeScribeOutput();
    (mismatchedOutput as unknown as Record<string, unknown>).sourcePhilosopherArtifactId = 'wrong-artifact-id';

    (deps.runtimeAdapter as unknown as Record<string, unknown>).fetchOutput = vi.fn().mockResolvedValue({
      payload: mismatchedOutput,
    });

    const depsWithPermissiveValidator = { ...deps, validator: permissiveValidator };

    const runner = new ScribeRunner(depsWithPermissiveValidator, {
      owner: 'test',
      runtimeKind: 'scribe',
      pollIntervalMs: 10,
      timeoutMs: 1000,
    });

    const result = await runner.run(SCRIBE_TASK_ID);
    // The echo was reconciled pre-validation → the run succeeds and the
    // persisted artifact carries the authoritative lineage.
    expect(result.status).toBe('succeeded');

    const outputCalls = getMockCalls(deps.stateManager, 'updateRunOutput');
    const persistedJson = outputCalls[0]?.[1] as string;
    const persisted = JSON.parse(persistedJson) as { sourcePhilosopherArtifactId?: string };
    expect(persisted.sourcePhilosopherArtifactId).toBe('pi-art-philosopher-001-run-001');
  });

  // ── NEW: postFetchTransform operates on unknown, not typed output ──────────

  it('postFetchTransform re-injects taskId on unknown output before validation', async () => {
    const store = new MemoryPIArtifactStore();
    await store.upsertArtifact(makePhilosopherArtifact());
    const deps = createMockDeps({ artifactStore: store });

    // Output without taskId — postFetchTransform should inject it
    const outputWithoutTaskId = { ...makeScribeOutput() };
    delete (outputWithoutTaskId as unknown as Record<string, unknown>).taskId;

    (deps.runtimeAdapter as unknown as Record<string, unknown>).fetchOutput = vi.fn().mockResolvedValue({
      payload: outputWithoutTaskId,
    });

    const runner = new ScribeRunner(deps, {
      owner: 'test',
      runtimeKind: 'scribe',
      pollIntervalMs: 10,
      timeoutMs: 1000,
    });

    const result = await runner.run(SCRIBE_TASK_ID);
    expect(result.status).toBe('succeeded');
  });

  // ── NEW: output_invalid is retriable (not in permanentErrorCategories) ──────

  it('output_invalid is retriable (may retry, not permanent)', async () => {
    const store = new MemoryPIArtifactStore();
    await store.upsertArtifact(makePhilosopherArtifact());
    const deps = createMockDeps({ artifactStore: store });

    const invalidOutput = { wrong: 'shape' };
    (deps.runtimeAdapter as unknown as Record<string, unknown>).fetchOutput = vi.fn().mockResolvedValue({
      payload: invalidOutput,
    });

    const runner = new ScribeRunner(deps, {
      owner: 'test',
      runtimeKind: 'scribe',
      pollIntervalMs: 10,
      timeoutMs: 1000,
    });

    const result = await runner.run(SCRIBE_TASK_ID);
    expect(result.status).toBe('failed');
    // output_invalid is NOT in permanentErrorCategories (matching Dreamer/Philosopher),
    // so it may retry. With retry policy shouldRetry: false, it falls to markTaskFailed.
    expect(deps.stateManager.markTaskFailed).toHaveBeenCalled();
  });

  // ── Telemetry dedup regression test ───────────────────────────────────────

  it('successful run emits exactly 1 scribe_output_validated and 1 scribe_principle_draft_generated', async () => {
    const store = new MemoryPIArtifactStore();
    await store.upsertArtifact(makePhilosopherArtifact());

    const deps = createMockDeps({ artifactStore: store });
    const emitTelemetry = vi.fn();
    (deps.eventEmitter as unknown as Record<string, unknown>).emitTelemetry = emitTelemetry;

    const runner = new ScribeRunner(deps, {
      owner: 'test-dedup',
      runtimeKind: 'scribe',
      pollIntervalMs: 10,
      timeoutMs: 5000,
    });

    const result = await runner.run(SCRIBE_TASK_ID);
    expect(result.status).toBe('succeeded');

    // Count telemetry events by type
    const outputValidatedCalls = emitTelemetry.mock.calls.filter(
      (c: unknown[]) => typeof c[0] === 'object' && c[0] !== null && 'eventType' in c[0] && c[0].eventType === 'scribe_output_validated',
    );
    const draftGeneratedCalls = emitTelemetry.mock.calls.filter(
      (c: unknown[]) => typeof c[0] === 'object' && c[0] !== null && 'eventType' in c[0] && c[0].eventType === 'scribe_principle_draft_generated',
    );

    // Exactly 1 output_validated (from BasePeerRunner), not 2
    expect(outputValidatedCalls).toHaveLength(1);
    // Exactly 1 principle_draft_generated (from emitSuccessTelemetry)
    expect(draftGeneratedCalls).toHaveLength(1);
  });
});

describe('DefaultScribeValidator (PRI-109)', () => {
  const validator = new DefaultScribeValidator();

  it('accepts valid Scribe output', async () => {
    const result = await validator.validate(makeScribeOutput(), SCRIBE_TASK_ID);
    expect(result.valid).toBe(true);
  });

  it('rejects taskId mismatch', async () => {
    const output = makeScribeOutput();
    (output as unknown as Record<string, unknown>).taskId = 'wrong';
    const result = await validator.validate(output, SCRIBE_TASK_ID);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('taskId mismatch'))).toBe(true);
  });

  it('rejects missing sourcePhilosopherArtifactId', async () => {
    const output = makeScribeOutput();
    (output as unknown as Record<string, unknown>).sourcePhilosopherArtifactId = '';
    const result = await validator.validate(output, SCRIBE_TASK_ID);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('sourcePhilosopherArtifactId'))).toBe(true);
  });

  it('rejects confidence as string', async () => {
    const output = makeScribeOutput();
    (output.principleDraft as unknown as Record<string, unknown>).confidence = '0.9';
    const result = await validator.validate(output, SCRIBE_TASK_ID);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('confidence must be number'))).toBe(true);
  });

  it('rejects confidence > 1', async () => {
    const output = makeScribeOutput();
    (output.principleDraft as unknown as Record<string, unknown>).confidence = 1.5;
    const result = await validator.validate(output, SCRIBE_TASK_ID);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('confidence must be in [0, 1]'))).toBe(true);
  });

  it('rejects null output', async () => {
    const result = await validator.validate(null, SCRIBE_TASK_ID);
    expect(result.valid).toBe(false);
  });

  it('rejects missing principleDraft.title', async () => {
    const output = makeScribeOutput();
    (output.principleDraft as unknown as Record<string, unknown>).title = '';
    const result = await validator.validate(output, SCRIBE_TASK_ID);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('principleDraft.title'))).toBe(true);
  });

  it('rejects missing sourceTrace.philosopherArtifactId', async () => {
    const output = makeScribeOutput();
    (output.sourceTrace as unknown as Record<string, unknown>).philosopherArtifactId = '';
    const result = await validator.validate(output, SCRIBE_TASK_ID);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('sourceTrace.philosopherArtifactId'))).toBe(true);
  });

  it('rejects applicability with non-string elements', async () => {
    const output = makeScribeOutput();
    (output.principleDraft as unknown as Record<string, unknown>).applicability = [1, 2];
    const result = await validator.validate(output, SCRIBE_TASK_ID);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('applicability must be an array of strings'))).toBe(true);
  });

  it('rejects antiPatterns with non-string elements', async () => {
    const output = makeScribeOutput();
    (output.principleDraft as unknown as Record<string, unknown>).antiPatterns = [true];
    const result = await validator.validate(output, SCRIBE_TASK_ID);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('antiPatterns must be an array of strings'))).toBe(true);
  });

  it('rejects risks with non-string elements', async () => {
    const output = makeScribeOutput();
    (output as unknown as Record<string, unknown>).risks = [42];
    const result = await validator.validate(output, SCRIBE_TASK_ID);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('risks must be an array of strings'))).toBe(true);
  });

  it('rejects mismatched sourcePhilosopherArtifactId when expected is provided', async () => {
    const output = makeScribeOutput();
    (output as unknown as Record<string, unknown>).sourcePhilosopherArtifactId = 'wrong-artifact-id';
    const result = await validator.validate(output, SCRIBE_TASK_ID, 'pi-art-philosopher-001-run-001');
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('sourcePhilosopherArtifactId mismatch'))).toBe(true);
  });

  it('rejects mismatched sourceTrace.philosopherArtifactId when expected is provided', async () => {
    const output = makeScribeOutput();
    (output.sourceTrace as unknown as Record<string, unknown>).philosopherArtifactId = 'wrong-artifact-id';
    const result = await validator.validate(output, SCRIBE_TASK_ID, 'pi-art-philosopher-001-run-001');
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('sourceTrace.philosopherArtifactId mismatch'))).toBe(true);
  });

  it('accepts valid output with matching expectedSourcePhilosopherArtifactId', async () => {
    const output = makeScribeOutput();
    const result = await validator.validate(output, SCRIBE_TASK_ID, 'pi-art-philosopher-001-run-001');
    expect(result.valid).toBe(true);
  });

  // ── ERR-013: prototype-inherited required fields must be rejected ────────

  it('rejects prototype-inherited taskId (e.g. toString) — ERR-013', async () => {
    const proto = { taskId: 'inherited-task-id' };
    const output = Object.create(proto) as Record<string, unknown>;
    output.sourcePhilosopherArtifactId = 'pi-art-philosopher-001-run-001';
    output.principleDraft = {
      title: 't', statement: 's', rationale: 'r',
      applicability: [], antiPatterns: [], confidence: 0.9,
    };
    output.sourceTrace = { philosopherArtifactId: 'pi-art-philosopher-001-run-001' };
    output.risks = [];
    output.generatedAt = new Date().toISOString();
    // taskId is only on prototype, not own property — must fail
    const result = await validator.validate(output, SCRIBE_TASK_ID);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('taskId'))).toBe(true);
  });

  it('rejects prototype-inherited sourcePhilosopherArtifactId — ERR-013', async () => {
    const output = makeScribeOutput();
    // Delete own property, put on prototype
    const obj = output as unknown as Record<string, unknown>;
    const originalValue = obj.sourcePhilosopherArtifactId;
    delete obj.sourcePhilosopherArtifactId;
    Object.setPrototypeOf(obj, { sourcePhilosopherArtifactId: originalValue });
    const result = await validator.validate(output, SCRIBE_TASK_ID);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('sourcePhilosopherArtifactId'))).toBe(true);
  });

  it('rejects prototype-inherited sourceTrace.philosopherArtifactId — ERR-013', async () => {
    const output = makeScribeOutput();
    const st = output.sourceTrace as unknown as Record<string, unknown>;
    const originalValue = st.philosopherArtifactId;
    delete st.philosopherArtifactId;
    Object.setPrototypeOf(st, { philosopherArtifactId: originalValue });
    const result = await validator.validate(output, SCRIBE_TASK_ID);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('sourceTrace.philosopherArtifactId'))).toBe(true);
  });

  // ── dreamerArtifactId validation ────────────────────────────────────────

  it('accepts valid dreamerArtifactId when present', async () => {
    const output = makeScribeOutput();
    (output.sourceTrace as unknown as Record<string, unknown>).dreamerArtifactId = 'pi-art-dreamer-001';
    const result = await validator.validate(output, SCRIBE_TASK_ID);
    expect(result.valid).toBe(true);
  });

  it('rejects malformed dreamerArtifactId (non-string) — ERR-001', async () => {
    const output = makeScribeOutput();
    (output.sourceTrace as unknown as Record<string, unknown>).dreamerArtifactId = 42;
    const result = await validator.validate(output, SCRIBE_TASK_ID);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('dreamerArtifactId'))).toBe(true);
  });

  it('rejects empty dreamerArtifactId — ERR-001', async () => {
    const output = makeScribeOutput();
    (output.sourceTrace as unknown as Record<string, unknown>).dreamerArtifactId = '';
    const result = await validator.validate(output, SCRIBE_TASK_ID);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('dreamerArtifactId'))).toBe(true);
  });

  it('accepts output without dreamerArtifactId (optional)', async () => {
    const output = makeScribeOutput();
    // makeScribeOutput() doesn't include dreamerArtifactId by default
    const result = await validator.validate(output, SCRIBE_TASK_ID);
    expect(result.valid).toBe(true);
  });
});
