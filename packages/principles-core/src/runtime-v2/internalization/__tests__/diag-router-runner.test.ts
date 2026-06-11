/**
 * DiagRouterRunner — Stage C V-slice tests (PRI-372).
 *
 * Tests:
 *   1. lease → succeed → commits candidates via DiagnosticianCommitter
 *   2. succeedTask triggers onDiagnosisComplete callback
 *   3. dependency not succeeded → blocked
 *   4. requires both rootcause and distiller predecessor dependencies
 *   5. commit failure → task fails, no markTaskSucceeded
 *   6. onDiagnosisComplete callback failure does not prevent task success
 *   7. invalid output fails TypeBox schema validation
 *   8. wrong taskKind fails closed
 *   9. currentPhase transitions
 *
 * ERR entries considered:
 *   - ERR-001: Treat parsed JSON / LLM output as unknown
 *   - ERR-004: Lineage fields must be internally consistent
 *   - ERR-009: Required fields fail loud — TypeBox schema + semantic checks
 */
import { describe, it, expect, vi } from 'vitest';
import { DiagRouterRunner } from '../diag-router-runner.js';
import type { DiagRouterRunnerDeps, OnDiagnosisComplete } from '../diag-router-runner.js';
import type { DiagnosticianOutputV1 } from '../../diagnostician-output.js';
import type { DiagRootCauseOutputV1 } from '../../diagnostician/diag-rootcause-output.js';
import type { DiagDistillerOutputV1 } from '../../diagnostician/diag-distiller-output.js';
import type { DiagnosticianCommitter, CommitResult } from '../../store/commit/diagnostician-committer.js';
import type { RuntimeStateManager } from '../../store/runtime-state-manager.js';
import type { PDRuntimeAdapter, RunHandle, RunStatus } from '../../runtime-protocol.js';
import type { StoreEventEmitter } from '../../store/event-emitter.js';
import { MemoryPIArtifactStore } from '../pi-artifact-store.js';
import type { TaskRecord } from '../../task-status.js';
import { createPITaskDiagnosticJson } from '../pitask-metadata.js';
import { RunnerPhase } from '../../runner/runner-phase.js';

// ── Test fixtures ──────────────────────────────────────────────────────────────

const ROUTER_TASK_ID = 'diag_router-001';
const ROOTCAUSE_TASK_ID = 'diag_rootcause-001';
const DISTILLER_TASK_ID = 'diag_distiller-001';
const RUN_ID = 'run-router-001';
const OWNER = 'test-router-owner';
const RUNTIME_KIND = 'test-double';
const ROOTCAUSE_ARTIFACT_ID = 'pi-art-rc-001';
const DISTILLER_ARTIFACT_ID = 'pi-art-dist-001';

function makeRootCauseTask(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    taskId: ROOTCAUSE_TASK_ID,
    taskKind: 'diag_rootcause',
    status: 'succeeded',
    attemptCount: 1,
    maxAttempts: 3,
    resultRef: 'diag-rootcause://run-rc-001',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    diagnosticJson: '{}',
    ...overrides,
  };
}

function makeDistillerTask(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    taskId: DISTILLER_TASK_ID,
    taskKind: 'diag_distiller',
    status: 'succeeded',
    attemptCount: 1,
    maxAttempts: 3,
    resultRef: 'diag-distiller://run-dist-001',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    diagnosticJson: '{}',
    ...overrides,
  };
}

function makeRouterTask(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    taskId: ROUTER_TASK_ID,
    taskKind: 'diag_router',
    status: 'pending',
    attemptCount: 0,
    maxAttempts: 3,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    diagnosticJson: createPITaskDiagnosticJson({
      dependencyTaskIds: [ROOTCAUSE_TASK_ID, DISTILLER_TASK_ID],
      channel: 'prompt',
      timeoutMs: 300_000,
      inputArtifactRefs: [],
      outputArtifactRefs: [],
    }),
    ...overrides,
  };
}

function makeRootCauseOutput(): DiagRootCauseOutputV1 {
  return {
    valid: true,
    diagnosisId: 'diag-001',
    taskId: ROOTCAUSE_TASK_ID,
    summary: 'Root cause analysis summary',
    causalChain: [
      { why: 1, statement: 'First why', evidenceRefs: ['ref-1'] },
    ],
    rootCause: 'Design: Missing error handling',
    rootCauseCategory: 'Design',
    evidence: [{ sourceRef: 'ref-1', note: 'Evidence note' }],
    confidence: 0.85,
  };
}

function makeDistillerOutput(): DiagDistillerOutputV1 {
  return {
    valid: true,
    taskId: DISTILLER_TASK_ID,
    sourceRootCauseArtifactId: ROOTCAUSE_ARTIFACT_ID,
    abstractedPrinciple: 'Always handle async errors',
    rationale: 'Root cause shows missing async error handling',
    groundedOnCorePrincipleIds: ['T-01'],
    scope: 'general',
    confidence: 0.9,
  };
}

function makeRouterOutput(): DiagnosticianOutputV1 {
  return {
    valid: true,
    diagnosisId: 'diag-001',
    summary: 'Missing runtime validation on untrusted input',
    rootCause: 'Design: Missing runtime validation on untrusted input',
    violatedPrinciples: [],
    evidence: [
      { sourceRef: 'ref-1', note: 'Input passed directly to business logic' },
    ],
    recommendations: [
      {
        kind: 'principle',
        description: 'Add runtime type guards before processing untrusted input',
        abstractedPrinciple: 'Always validate untrusted input before processing',
      },
    ],
    confidence: 0.88,
  };
}

/** Pre-populate a MemoryPIArtifactStore with both predecessor artifacts. */
function populatePredecessorArtifacts(store: MemoryPIArtifactStore): void {
  store.upsertArtifact({
    artifactId: ROOTCAUSE_ARTIFACT_ID,
    artifactKind: 'principle',
    sourceTaskId: ROOTCAUSE_TASK_ID,
    lineageArtifactIds: [],
    validationStatus: 'pending',
    contentJson: JSON.stringify(makeRootCauseOutput()),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  store.upsertArtifact({
    artifactId: DISTILLER_ARTIFACT_ID,
    artifactKind: 'principle',
    sourceTaskId: DISTILLER_TASK_ID,
    lineageArtifactIds: [ROOTCAUSE_ARTIFACT_ID],
    validationStatus: 'pending',
    contentJson: JSON.stringify(makeDistillerOutput()),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
}

// ── Mock factory ───────────────────────────────────────────────────────────────

function createMockDeps(overrides: Partial<DiagRouterRunnerDeps> = {}): DiagRouterRunnerDeps & {
  _stateManager: Record<string, ReturnType<typeof vi.fn>>;
  _runtimeAdapter: Record<string, ReturnType<typeof vi.fn>>;
  _committer: Record<string, ReturnType<typeof vi.fn>>;
  _onDiagnosisComplete: ReturnType<typeof vi.fn>;
} {
  const taskRecord = makeRouterTask();
  const output = makeRouterOutput();

  const _stateManager = {
    acquireLease: vi.fn().mockResolvedValue(taskRecord),
    getTask: vi.fn().mockImplementation((id: string) => {
      if (id === ROUTER_TASK_ID) return Promise.resolve(taskRecord);
      if (id === ROOTCAUSE_TASK_ID) return Promise.resolve(makeRootCauseTask());
      if (id === DISTILLER_TASK_ID) return Promise.resolve(makeDistillerTask());
      return Promise.resolve(undefined);
    }),
    getRunsByTask: vi.fn().mockResolvedValue([{ runId: RUN_ID, taskId: ROUTER_TASK_ID }]),
    updateRunOutput: vi.fn().mockResolvedValue(undefined),
    markTaskSucceeded: vi.fn().mockResolvedValue(undefined),
    markTaskFailed: vi.fn().mockResolvedValue(undefined),
    markTaskRetryWait: vi.fn().mockResolvedValue(undefined),
    getRetryPolicy: vi.fn().mockReturnValue({ shouldRetry: () => false }),
  };

  const runHandle: RunHandle = { runId: RUN_ID, runtimeKind: RUNTIME_KIND, startedAt: new Date().toISOString() };
  const succeededStatus: RunStatus = { status: 'succeeded', runId: RUN_ID };

  const _runtimeAdapter = {
    kind: vi.fn().mockReturnValue(RUNTIME_KIND),
    getCapabilities: vi.fn(),
    healthCheck: vi.fn(),
    startRun: vi.fn().mockResolvedValue(runHandle),
    pollRun: vi.fn().mockResolvedValue(succeededStatus),
    fetchOutput: vi.fn().mockResolvedValue({ payload: output }),
    cancelRun: vi.fn().mockResolvedValue(undefined),
    fetchArtifacts: vi.fn(),
  };

  const commitResult: CommitResult = {
    commitId: 'commit-001',
    artifactId: 'art-001',
    candidateCount: 1,
  };

  const _committer = {
    commit: vi.fn().mockResolvedValue(commitResult),
  };

  const _onDiagnosisComplete = vi.fn().mockResolvedValue(undefined);

  const mockEventEmitter = {
    emitTelemetry: vi.fn(),
    on: vi.fn(),
    emit: vi.fn(),
  };

  // Create store with predecessor artifacts pre-populated
  const artifactStore = new MemoryPIArtifactStore();
  populatePredecessorArtifacts(artifactStore);

  return {
    stateManager: _stateManager as unknown as RuntimeStateManager,
    runtimeAdapter: _runtimeAdapter as unknown as PDRuntimeAdapter,
    eventEmitter: mockEventEmitter as unknown as StoreEventEmitter,
    artifactStore,
    committer: _committer as unknown as DiagnosticianCommitter,
    onDiagnosisComplete: _onDiagnosisComplete as OnDiagnosisComplete,
    _stateManager,
    _runtimeAdapter,
    _committer,
    _onDiagnosisComplete,
    ...overrides,
  };
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('DiagRouterRunner V-slice', () => {
  it('lease → succeed → commits candidates via DiagnosticianCommitter', async () => {
    const deps = createMockDeps();
    const runner = new DiagRouterRunner(deps, {
      owner: OWNER,
      runtimeKind: RUNTIME_KIND,
      pollIntervalMs: 10,
      timeoutMs: 1000,
    });

    const result = await runner.run(ROUTER_TASK_ID);

    expect(result.status).toBe('succeeded');
    expect(result.taskId).toBe(ROUTER_TASK_ID);

    // Verify committer was called
    expect(deps._committer.commit).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: RUN_ID,
        taskId: ROUTER_TASK_ID,
      }),
    );

    // Verify markTaskSucceeded called with commit:// resultRef
    expect(deps._stateManager.markTaskSucceeded).toHaveBeenCalledWith(
      ROUTER_TASK_ID,
      expect.stringContaining('commit://'),
    );
  });

  it('succeedTask triggers onDiagnosisComplete callback', async () => {
    const deps = createMockDeps();
    const runner = new DiagRouterRunner(deps, {
      owner: OWNER,
      runtimeKind: RUNTIME_KIND,
      pollIntervalMs: 10,
      timeoutMs: 1000,
    });

    const result = await runner.run(ROUTER_TASK_ID);

    expect(result.status).toBe('succeeded');

    // Verify onDiagnosisComplete callback was called with (taskId, output)
    expect(deps._onDiagnosisComplete).toHaveBeenCalledWith(
      ROUTER_TASK_ID,
      expect.objectContaining({
        valid: true,
        diagnosisId: 'diag-001',
      }),
    );
  });

  it('dependency not succeeded → blocked', async () => {
    // Empty artifact store — no distiller artifact
    const emptyStore = new MemoryPIArtifactStore();
    // Still need rootcause artifact
    emptyStore.upsertArtifact({
      artifactId: ROOTCAUSE_ARTIFACT_ID,
      artifactKind: 'principle',
      sourceTaskId: ROOTCAUSE_TASK_ID,
      lineageArtifactIds: [],
      validationStatus: 'pending',
      contentJson: JSON.stringify(makeRootCauseOutput()),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    const deps = createMockDeps({ artifactStore: emptyStore });
    // Make the distiller task still pending (not succeeded)
    const pendingDistillerTask = makeDistillerTask({ status: 'pending', resultRef: undefined });
    (deps._stateManager.getTask as ReturnType<typeof vi.fn>).mockImplementation((id: string) => {
      if (id === ROUTER_TASK_ID) return Promise.resolve(makeRouterTask());
      if (id === ROOTCAUSE_TASK_ID) return Promise.resolve(makeRootCauseTask());
      if (id === DISTILLER_TASK_ID) return Promise.resolve(pendingDistillerTask);
      return Promise.resolve(undefined);
    });

    const runner = new DiagRouterRunner(deps, {
      owner: OWNER,
      runtimeKind: RUNTIME_KIND,
      pollIntervalMs: 10,
      timeoutMs: 1000,
    });

    const result = await runner.run(ROUTER_TASK_ID);

    // Should fail because distiller artifact is missing
    expect(result.status).toBe('failed');
  });

  it('requires both rootcause and distiller predecessor dependencies', async () => {
    const deps = createMockDeps();
    // Create a router task with only one dependency
    const singleDepTask = makeRouterTask({
      diagnosticJson: createPITaskDiagnosticJson({
        dependencyTaskIds: [ROOTCAUSE_TASK_ID],
        channel: 'prompt',
        timeoutMs: 300_000,
        inputArtifactRefs: [],
        outputArtifactRefs: [],
      }),
    });
    (deps._stateManager.acquireLease as ReturnType<typeof vi.fn>).mockResolvedValue(singleDepTask);
    (deps._stateManager.getTask as ReturnType<typeof vi.fn>).mockImplementation((id: string) => {
      if (id === ROUTER_TASK_ID) return Promise.resolve(singleDepTask);
      if (id === ROOTCAUSE_TASK_ID) return Promise.resolve(makeRootCauseTask());
      return Promise.resolve(undefined);
    });

    const runner = new DiagRouterRunner(deps, {
      owner: OWNER,
      runtimeKind: RUNTIME_KIND,
      pollIntervalMs: 10,
      timeoutMs: 1000,
    });

    const result = await runner.run(ROUTER_TASK_ID);

    // Should fail because only one predecessor dependency
    expect(result.status).toBe('failed');
  });

  it('commit failure → task fails, no markTaskSucceeded', async () => {
    const deps = createMockDeps();
    (deps._committer.commit as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('Commit failed: DB error'));

    const runner = new DiagRouterRunner(deps, {
      owner: OWNER,
      runtimeKind: RUNTIME_KIND,
      pollIntervalMs: 10,
      timeoutMs: 1000,
    });

    const result = await runner.run(ROUTER_TASK_ID);

    expect(result.status).toBe('failed');
    expect(deps._stateManager.markTaskSucceeded).not.toHaveBeenCalled();
  });

  it('onDiagnosisComplete callback failure does not prevent task success', async () => {
    const deps = createMockDeps();
    // Make the callback throw
    deps._onDiagnosisComplete.mockRejectedValue(new Error('Callback failed'));

    const runner = new DiagRouterRunner(deps, {
      owner: OWNER,
      runtimeKind: RUNTIME_KIND,
      pollIntervalMs: 10,
      timeoutMs: 1000,
    });

    const result = await runner.run(ROUTER_TASK_ID);

    // Task should still succeed even if callback fails
    expect(result.status).toBe('succeeded');
    expect(deps._stateManager.markTaskSucceeded).toHaveBeenCalled();
  });

  it('invalid output fails TypeBox schema validation', async () => {
    const deps = createMockDeps();
    // Return invalid output that fails TypeBox validation
    (deps._runtimeAdapter.fetchOutput as ReturnType<typeof vi.fn>).mockResolvedValue({
      payload: { invalid: true },
    });

    const runner = new DiagRouterRunner(deps, {
      owner: OWNER,
      runtimeKind: RUNTIME_KIND,
      pollIntervalMs: 10,
      timeoutMs: 1000,
    });

    const result = await runner.run(ROUTER_TASK_ID);
    expect(result.status).toBe('failed');
  });

  it('currentPhase is Completed after successful run', async () => {
    const deps = createMockDeps();
    const runner = new DiagRouterRunner(deps, {
      owner: OWNER,
      runtimeKind: RUNTIME_KIND,
      pollIntervalMs: 10,
      timeoutMs: 1000,
    });

    const result = await runner.run(ROUTER_TASK_ID);
    expect(result.status).toBe('succeeded');
    expect(runner.currentPhase).toBe(RunnerPhase.Completed);
  });

  it('currentPhase is Failed after validation failure', async () => {
    const deps = createMockDeps();
    // Return invalid output that fails TypeBox validation
    (deps._runtimeAdapter.fetchOutput as ReturnType<typeof vi.fn>).mockResolvedValue({
      payload: { invalid: true },
    });

    const runner = new DiagRouterRunner(deps, {
      owner: OWNER,
      runtimeKind: RUNTIME_KIND,
      pollIntervalMs: 10,
      timeoutMs: 1000,
    });

    const result = await runner.run(ROUTER_TASK_ID);
    expect(result.status).toBe('failed');
    expect(runner.currentPhase).toBe(RunnerPhase.Failed);
  });

  it('wrong taskKind fails closed', async () => {
    const wrongKindTask = makeRouterTask({ taskKind: 'dreamer' });
    const deps = createMockDeps();
    (deps._stateManager.acquireLease as ReturnType<typeof vi.fn>).mockResolvedValue(wrongKindTask);

    const runner = new DiagRouterRunner(deps, {
      owner: OWNER,
      runtimeKind: RUNTIME_KIND,
      pollIntervalMs: 10,
      timeoutMs: 1000,
    });

    const result = await runner.run(ROUTER_TASK_ID);
    expect(result.status).toBe('failed');
    expect(result.errorCategory).toBe('input_invalid');
  });

  it('succeedTask calls updateRunOutput before commit', async () => {
    const deps = createMockDeps();
    const callOrder: string[] = [];
    (deps._stateManager.updateRunOutput as ReturnType<typeof vi.fn>).mockImplementation(() => {
      callOrder.push('updateRunOutput');
      return Promise.resolve();
    });
    (deps._committer.commit as ReturnType<typeof vi.fn>).mockImplementation(() => {
      callOrder.push('commit');
      return Promise.resolve({ commitId: 'commit-001', artifactId: 'art-001', candidateCount: 1 });
    });

    const runner = new DiagRouterRunner(deps, {
      owner: OWNER,
      runtimeKind: RUNTIME_KIND,
      pollIntervalMs: 10,
      timeoutMs: 1000,
    });

    const result = await runner.run(ROUTER_TASK_ID);
    expect(result.status).toBe('succeeded');
    expect(callOrder.indexOf('updateRunOutput')).toBeLessThan(callOrder.indexOf('commit'));
  });

  it('corrupted rootcause artifact content fails schema validation (EP-01)', async () => {
    // Write a corrupted rootcause artifact (missing required fields)
    const corruptedStore = new MemoryPIArtifactStore();
    corruptedStore.upsertArtifact({
      artifactId: ROOTCAUSE_ARTIFACT_ID,
      artifactKind: 'principle',
      sourceTaskId: ROOTCAUSE_TASK_ID,
      lineageArtifactIds: [],
      validationStatus: 'pending',
      contentJson: JSON.stringify({ invalid: true, missing: 'required fields' }),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    // Valid distiller artifact
    corruptedStore.upsertArtifact({
      artifactId: DISTILLER_ARTIFACT_ID,
      artifactKind: 'principle',
      sourceTaskId: DISTILLER_TASK_ID,
      lineageArtifactIds: [ROOTCAUSE_ARTIFACT_ID],
      validationStatus: 'pending',
      contentJson: JSON.stringify(makeDistillerOutput()),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    const deps = createMockDeps({ artifactStore: corruptedStore });

    const runner = new DiagRouterRunner(deps, {
      owner: OWNER,
      runtimeKind: RUNTIME_KIND,
      pollIntervalMs: 10,
      timeoutMs: 1000,
    });

    const result = await runner.run(ROUTER_TASK_ID);

    expect(result.status).toBe('failed');
    expect(result.errorCategory).toBe('input_invalid');
  });

  it('corrupted distiller artifact content fails schema validation (EP-01)', async () => {
    // Valid rootcause artifact
    const corruptedStore = new MemoryPIArtifactStore();
    corruptedStore.upsertArtifact({
      artifactId: ROOTCAUSE_ARTIFACT_ID,
      artifactKind: 'principle',
      sourceTaskId: ROOTCAUSE_TASK_ID,
      lineageArtifactIds: [],
      validationStatus: 'pending',
      contentJson: JSON.stringify(makeRootCauseOutput()),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    // Corrupted distiller artifact
    corruptedStore.upsertArtifact({
      artifactId: DISTILLER_ARTIFACT_ID,
      artifactKind: 'principle',
      sourceTaskId: DISTILLER_TASK_ID,
      lineageArtifactIds: [ROOTCAUSE_ARTIFACT_ID],
      validationStatus: 'pending',
      contentJson: JSON.stringify({ invalid: true, missing: 'required fields' }),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    const deps = createMockDeps({ artifactStore: corruptedStore });

    const runner = new DiagRouterRunner(deps, {
      owner: OWNER,
      runtimeKind: RUNTIME_KIND,
      pollIntervalMs: 10,
      timeoutMs: 1000,
    });

    const result = await runner.run(ROUTER_TASK_ID);

    expect(result.status).toBe('failed');
    expect(result.errorCategory).toBe('input_invalid');
  });
});
