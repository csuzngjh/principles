/**
 * DiagRouterRunner — PRI-468 Stage C intentTension additive passthrough tests.
 *
 * Verifies SPEC §18 requirements:
 *   1. Stage A has intentTension → Stage C passes it through
 *   2. Stage A has NO intentTension → Stage C does NOT generate one
 *   3. Stage A has NO intentTension + LLM hallucinated one → Stage C strips it
 *   4. Stage A has intentTension + LLM also produced one → Stage A wins (source of truth)
 *
 * ERR entries considered:
 *   - EP-01 / ERR-001: context.rootCauseOutput is schema-validated before reaching here
 *   - EP-01 / ERR-013: Object.hasOwn used for field presence check (not `in`)
 *   - EP-02 / ERR-009: fail-loud on missing required fields via schema validation
 *   - EP-03 / ERR-002: stripping hallucinated intentTension emits telemetry (observable)
 */
import { describe, it, expect, vi } from 'vitest';
import { DiagRouterRunner } from '../diag-router-runner.js';
import type { DiagRouterRunnerDeps } from '../diag-router-runner.js';
import type { DiagnosticianOutputV1 } from '../../diagnostician-output.js';
import type { DiagRootCauseOutputV1, IntentTension } from '../../diagnostician/diag-rootcause-output.js';
import type { DiagDistillerOutputV1 } from '../../diagnostician/diag-distiller-output.js';
import type { CommitResult } from '../../store/commit/diagnostician-committer.js';
import type { RuntimeStateManager } from '../../store/runtime-state-manager.js';
import type { RunHandle, RunStatus } from '../../runtime-protocol.js';
import type { StoreEventEmitter } from '../../store/event-emitter.js';
import { MemoryPIArtifactStore } from '../pi-artifact-store.js';
import type { TaskRecord } from '../../task-status.js';
import { createPITaskDiagnosticJson } from '../pitask-metadata.js';
import { MOCK_ROOT_CAUSE_OUTPUTS, MOCK_DISTILLER_OUTPUTS, MOCK_ROUTER_OUTPUTS } from './__fixtures__/split-pipeline-mock-outputs.js';

// ── Test fixtures ────────────────────────────────────────────────────────────

const ROUTER_TASK_ID = 'diag_router-001';
const ROOTCAUSE_TASK_ID = 'diag_rootcause-001';
const DISTILLER_TASK_ID = 'diag_distiller-001';
const RUN_ID = 'run-router-001';
const OWNER = 'test-router-intent-owner';
const RUNTIME_KIND = 'test-double';
const ROOTCAUSE_ARTIFACT_ID = 'pi-art-rc-001';
const DISTILLER_ARTIFACT_ID = 'pi-art-dist-001';

const VALID_INTENT_TENSION: IntentTension = {
  source: 'action_drift',
  evidenceStrength: 'moderate',
  relatedIntentFields: ['current_strategic_focus', 'non_negotiables'],
  evidence: [
    'INTENT says current focus is validating the smallest Pain → Principle loop.',
    'Agent designed a heavy dashboard.',
    'Owner correction says the result increased review burden.',
  ],
  explanation:
    'The work may be useful later, but it optimized presentation completeness before validating the current learning loop.',
  suggestedOwnerAction: 'confirm_drift',
  intentDocHash: 'sha256:abc123',
};

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

function makeRootCauseOutput(intentTension?: IntentTension): DiagRootCauseOutputV1 {
  const base = {
    ...MOCK_ROOT_CAUSE_OUTPUTS.R6,
    diagnosisId: 'diag-001',
    taskId: ROOTCAUSE_TASK_ID,
  };
  return intentTension ? { ...base, intentTension } : base;
}

function makeDistillerOutput(): DiagDistillerOutputV1 {
  return {
    ...MOCK_DISTILLER_OUTPUTS.R6,
    taskId: DISTILLER_TASK_ID,
    sourceRootCauseArtifactId: ROOTCAUSE_ARTIFACT_ID,
  };
}

function makeRouterOutput(intentTension?: unknown): DiagnosticianOutputV1 {
  const base: DiagnosticianOutputV1 = {
    ...MOCK_ROUTER_OUTPUTS.R6,
    diagnosisId: 'diag-001',
  };
  if (intentTension !== undefined) {
    return { ...base, intentTension: intentTension as IntentTension };
  }
  return base;
}

/** Pre-populate a MemoryPIArtifactStore with both predecessor artifacts. */
function populatePredecessorArtifacts(store: MemoryPIArtifactStore, rootCauseOutput: DiagRootCauseOutputV1): void {
  store.upsertArtifact({
    artifactId: ROOTCAUSE_ARTIFACT_ID,
    artifactKind: 'principle',
    sourceTaskId: ROOTCAUSE_TASK_ID,
    lineageArtifactIds: [],
    validationStatus: 'pending',
    contentJson: JSON.stringify(rootCauseOutput),
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

// ── Mock factory ─────────────────────────────────────────────────────────────

function createMockDeps(
  rootCauseOutput: DiagRootCauseOutputV1,
  routerOutput: DiagnosticianOutputV1,
  overrides: Partial<DiagRouterRunnerDeps> = {},
): DiagRouterRunnerDeps & {
  _stateManager: Record<string, ReturnType<typeof vi.fn>>;
  _runtimeAdapter: Record<string, ReturnType<typeof vi.fn>>;
  _committer: Record<string, ReturnType<typeof vi.fn>>;
  _eventEmitter: { emitTelemetry: ReturnType<typeof vi.fn> };
} {
  const taskRecord = makeRouterTask();

  const _stateManager = {
    acquireLease: vi.fn().mockResolvedValue(taskRecord),
    getTask: vi.fn().mockImplementation((id: string) => {
      if (id === ROUTER_TASK_ID) return Promise.resolve(taskRecord);
      if (id === ROOTCAUSE_TASK_ID) return Promise.resolve(makeRootCauseTask());
      if (id === DISTILLER_TASK_ID) return Promise.resolve(makeDistillerTask());
      return Promise.resolve(undefined);
    }),
    getRunsByTask: vi.fn().mockResolvedValue([{ runId: RUN_ID, taskId: ROUTER_TASK_ID }]),
    getValidRunsByTaskTolerant: vi.fn().mockResolvedValue({
      runs: [{ runId: RUN_ID, taskId: ROUTER_TASK_ID }],
      degradedRuns: [],
    }),
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
    fetchOutput: vi.fn().mockResolvedValue({ payload: routerOutput }),
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

  const _eventEmitter = {
    emitTelemetry: vi.fn(),
    on: vi.fn(),
    emit: vi.fn(),
  };

  const artifactStore = new MemoryPIArtifactStore();
  populatePredecessorArtifacts(artifactStore, rootCauseOutput);

  return {
    stateManager: _stateManager as unknown as RuntimeStateManager,
    runtimeAdapter: _runtimeAdapter,
    eventEmitter: _eventEmitter as unknown as StoreEventEmitter,
    artifactStore,
    committer: _committer,
    _stateManager,
    _runtimeAdapter,
    _committer,
    _eventEmitter,
    ...overrides,
  };
}

// ── Telemetry mock helper ───────────────────────────────────────────────────
// `noUncheckedIndexedAccess` makes Record<string, X>[key] return X | undefined,
// and `unknown` has no `.eventType`. This helper narrows mock call args safely
// (test-only — mirrors the pattern in diag-distiller-runner.test.ts).
type TelemetryCallArg = { eventType: string; payload?: Record<string, unknown> };
function telemetryEventType(call: readonly unknown[]): string | undefined {
  const event = call[0] as TelemetryCallArg | undefined;
  return event?.eventType;
}
function telemetryPayload(call: readonly unknown[]): Record<string, unknown> | undefined {
  const event = call[0] as TelemetryCallArg | undefined;
  return event?.payload;
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('DiagRouterRunner — PRI-468 Stage C intentTension passthrough', () => {
  it('Stage A has intentTension → Stage C passes it through', async () => {
    const rootCause = makeRootCauseOutput(VALID_INTENT_TENSION);
    const routerOut = makeRouterOutput(); // LLM did NOT produce intentTension
    const deps = createMockDeps(rootCause, routerOut);

    const runner = new DiagRouterRunner(deps, {
      owner: OWNER,
      runtimeKind: RUNTIME_KIND,
      pollIntervalMs: 10,
      timeoutMs: 1000,
    });

    const result = await runner.run(ROUTER_TASK_ID);

    expect(result.status).toBe('succeeded');

    // Verify the committed output has intentTension from Stage A
    const commitMock = deps._committer.commit;
    if (!commitMock) throw new Error('commit mock not configured');
    const [commitCall] = commitMock.mock.calls;
    const committedOutput = commitCall?.[0]?.output as DiagnosticianOutputV1;
    expect(committedOutput.intentTension).toBeDefined();
    expect(committedOutput.intentTension).toEqual(VALID_INTENT_TENSION);
  });

  it('Stage A has NO intentTension → Stage C does NOT generate one', async () => {
    const rootCause = makeRootCauseOutput(); // No intentTension
    const routerOut = makeRouterOutput(); // LLM also did not produce one
    const deps = createMockDeps(rootCause, routerOut);

    const runner = new DiagRouterRunner(deps, {
      owner: OWNER,
      runtimeKind: RUNTIME_KIND,
      pollIntervalMs: 10,
      timeoutMs: 1000,
    });

    const result = await runner.run(ROUTER_TASK_ID);

    expect(result.status).toBe('succeeded');

    // Verify the committed output does NOT have intentTension
    const commitMock = deps._committer.commit;
    if (!commitMock) throw new Error('commit mock not configured');
    const [commitCall] = commitMock.mock.calls;
    const committedOutput = commitCall?.[0]?.output as DiagnosticianOutputV1;
    expect(committedOutput.intentTension).toBeUndefined();
  });

  it('Stage A has NO intentTension + LLM hallucinated one → Stage C strips it with telemetry', async () => {
    const rootCause = makeRootCauseOutput(); // No intentTension
    // LLM hallucinated an intentTension
    const hallucinatedTension: IntentTension = {
      source: 'healthy_tension',
      evidenceStrength: 'weak',
      relatedIntentFields: ['why'],
      evidence: ['fake evidence'],
      explanation: 'hallucinated',
      suggestedOwnerAction: 'dismiss',
    };
    const routerOut = makeRouterOutput(hallucinatedTension);
    const deps = createMockDeps(rootCause, routerOut);

    const runner = new DiagRouterRunner(deps, {
      owner: OWNER,
      runtimeKind: RUNTIME_KIND,
      pollIntervalMs: 10,
      timeoutMs: 1000,
    });

    const result = await runner.run(ROUTER_TASK_ID);

    expect(result.status).toBe('succeeded');

    // Verify the committed output does NOT have intentTension (stripped)
    const commitMock = deps._committer.commit;
    if (!commitMock) throw new Error('commit mock not configured');
    const [commitCall] = commitMock.mock.calls;
    const committedOutput = commitCall?.[0]?.output as DiagnosticianOutputV1;
    expect(committedOutput.intentTension).toBeUndefined();

    // Verify telemetry was emitted for the strip (EP-03 / ERR-002: observable)
    const telemetryCalls = deps._eventEmitter.emitTelemetry.mock.calls.filter(
      (call: readonly unknown[]) => telemetryEventType(call) === 'diag_router_invariant_override',
    );
    const intentTensionCall = telemetryCalls.find(
      (call: readonly unknown[]) => telemetryPayload(call)?.field === 'intentTension',
    );
    expect(intentTensionCall).toBeDefined();
    if (!intentTensionCall) return; // type narrowing after assertion
    const payload = telemetryPayload(intentTensionCall);
    expect(payload?.field).toBe('intentTension');
    expect(payload?.reason).toContain('stripped');
  });

  it('Stage A has intentTension + LLM also produced one → Stage A wins (source of truth)', async () => {
    const rootCause = makeRootCauseOutput(VALID_INTENT_TENSION);
    // LLM produced a DIFFERENT intentTension
    const llmTension: IntentTension = {
      source: 'none',
      evidenceStrength: 'weak',
      relatedIntentFields: ['why'],
      evidence: ['llm evidence'],
      explanation: 'llm explanation',
      suggestedOwnerAction: 'observe',
    };
    const routerOut = makeRouterOutput(llmTension);
    const deps = createMockDeps(rootCause, routerOut);

    const runner = new DiagRouterRunner(deps, {
      owner: OWNER,
      runtimeKind: RUNTIME_KIND,
      pollIntervalMs: 10,
      timeoutMs: 1000,
    });

    const result = await runner.run(ROUTER_TASK_ID);

    expect(result.status).toBe('succeeded');

    // Verify the committed output has Stage A's intentTension (not LLM's)
    const commitMock = deps._committer.commit;
    if (!commitMock) throw new Error('commit mock not configured');
    const [commitCall] = commitMock.mock.calls;
    const committedOutput = commitCall?.[0]?.output as DiagnosticianOutputV1;
    expect(committedOutput.intentTension).toEqual(VALID_INTENT_TENSION);
    expect(committedOutput.intentTension).not.toEqual(llmTension);

    // Verify telemetry was emitted for the override (filter to intentTension field —
    // `evidence` is always overridden in postFetchTransform, so find() would match it first)
    const telemetryCalls = deps._eventEmitter.emitTelemetry.mock.calls.filter(
      (call: readonly unknown[]) => telemetryEventType(call) === 'diag_router_invariant_override',
    );
    const intentTensionCall = telemetryCalls.find(
      (call: readonly unknown[]) => telemetryPayload(call)?.field === 'intentTension',
    );
    expect(intentTensionCall).toBeDefined();
    if (!intentTensionCall) return; // type narrowing after assertion
    const payload = telemetryPayload(intentTensionCall);
    expect(payload?.field).toBe('intentTension');
    expect(payload?.reason).toContain('overridden');
  });
});
