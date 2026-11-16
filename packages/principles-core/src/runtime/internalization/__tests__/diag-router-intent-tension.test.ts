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
import { createHash } from 'node:crypto';
import { describe, it, expect, vi } from 'vitest';
import { DiagRouterRunner } from '../diag-router-runner.js';
import type { DiagRouterRunnerDeps } from '../diag-router-runner.js';
import type { DiagnosticianOutputV2 } from '../../diagnostician-output.js';
import type { DiagRootCauseOutputV1, IntentTension } from '../../diagnostician/diag-rootcause-output.js';
import type { DiagDistillerOutputV1 } from '../../diagnostician/diag-distiller-output.js';
import type { CommitResult } from '../../store/commit/diagnostician-committer.js';
import { fencedStateManager as fenced } from '../../__tests__/fixtures/fenced-state-manager.js';
import { installDiagnosticianCommitMock } from '../../__tests__/fixtures/fenced-state-manager.js';
import type { RunHandle, RunStatus } from '../../runtime-protocol.js';
import { MemoryPIArtifactStore } from '../pi-artifact-store.js';
import type { TaskRecord } from '../../task-status.js';
import { createPITaskDiagnosticJson } from '../pitask-metadata.js';
import { MOCK_ROOT_CAUSE_OUTPUTS, MOCK_DISTILLER_OUTPUTS, MOCK_ROUTER_OUTPUTS } from '../../adapter/split-pipeline-fixtures.js';
import type { IntentSnapshot } from '../../intent/intent-snapshot.js';

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

function makeRouterOutput(intentTension?: unknown): DiagnosticianOutputV2 {
  const base: DiagnosticianOutputV2 = {
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

// A mocked dependency member is usually a single `vi.fn()`; the state manager
// also exposes the nested `runStore.updateRun` collaborator the runner calls.
type MockField = ReturnType<typeof vi.fn> | Record<string, ReturnType<typeof vi.fn>>;

function createMockDeps(
  rootCauseOutput: DiagRootCauseOutputV1,
  routerOutput: DiagnosticianOutputV2,
  overrides: Partial<DiagRouterRunnerDeps> = {},
): DiagRouterRunnerDeps & {
  _stateManager: Record<string, MockField>;
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
    // PRI-1146 P2-01: exact input payload persisted for post-restart receipt verification.
    runStore: { updateRun: vi.fn().mockResolvedValue(undefined) },
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
    // PRI-1146 P1-02: this double merges no prompt layers, so the submitted
    // system prompt IS the effective one the provider would receive.
    startRun: vi.fn().mockImplementation(async (input: { systemPrompt?: string }) => ({
      ...runHandle,
      ...(typeof input?.systemPrompt === 'string' ? { systemPromptDigest: createHash('sha256').update(input.systemPrompt).digest('hex') } : {}),
    })),
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
  // SPEC §5.3: the router commits through the state manager's atomic fenced unit.
  installDiagnosticianCommitMock(_stateManager, {
    commit: _committer.commit,
    artifactStore,
    runId: RUN_ID,
  });

  return {
    stateManager: fenced(_stateManager),
    runtimeAdapter: _runtimeAdapter,
    eventEmitter: _eventEmitter,
    artifactStore,
    committer: _committer,
    // PRI-1146: proven-empty trusted exposure (harness default).
    trustedPrincipleSource: { readTrustedPrinciples: () => ({ status: 'ok' as const, principles: [] }) },
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
    const committedOutput = commitCall?.[0]?.output as DiagnosticianOutputV2;
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
    const committedOutput = commitCall?.[0]?.output as DiagnosticianOutputV2;
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
    const committedOutput = commitCall?.[0]?.output as DiagnosticianOutputV2;
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
    const committedOutput = commitCall?.[0]?.output as DiagnosticianOutputV2;
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

// ── P1-3: Stage B owns abstractedPrinciple ───────────────────────────────────
// Authority split: the abstracted principle is Stage B's artifact (deterministic
// system data). Stage C must not be asked to re-derive it, and the adapter's
// structural Value.Check runs BEFORE postFetchTransform — so the field stays
// schema-optional and is injected here, with DefaultDiagnosticianValidator as
// the final non-empty gate.
describe('DiagRouterRunner — P1-3 Stage B abstractedPrinciple inheritance', () => {
  it('fills a missing abstractedPrinciple from the Stage B artifact and passes the validator', async () => {
    const distillerOutput = makeDistillerOutput();
    const modelOutput: DiagnosticianOutputV2 = {
      ...makeRouterOutput(),
      recommendations: [
        { kind: 'principle', description: 'Stay inside the explicitly approved scope.', recommendationRef: 'principle-1' },
      ],
    };
    // The raw model output (what the adapter would structurally accept) has NO
    // abstractedPrinciple.
    const rawRecommendation: Record<string, unknown> = { ...modelOutput.recommendations[0] };
    expect(Object.hasOwn(rawRecommendation, 'abstractedPrinciple')).toBe(false);

    const deps = createMockDeps(makeRootCauseOutput(), modelOutput);
    const runner = new DiagRouterRunner(deps, {
      owner: OWNER,
      runtimeKind: RUNTIME_KIND,
      pollIntervalMs: 10,
      timeoutMs: 1000,
    });

    const result = await runner.run(ROUTER_TASK_ID);

    expect(result.status).toBe('succeeded');
    const commitMock = deps._committer.commit as ReturnType<typeof vi.fn>;
    const commitArgs = commitMock.mock.calls[0]?.[0] as
      | { output: DiagnosticianOutputV2 }
      | undefined;
    expect(commitArgs).toBeDefined();
    const committed = commitArgs?.output.recommendations.find((rec) => rec.kind === 'principle');
    expect(committed?.abstractedPrinciple).toBe(distillerOutput.abstractedPrinciple);
  });
});

// ── SIA v1.2 (PRI-1216): Stage A intentSnapshot additive passthrough ─────────
//
// SPEC §9.1: the captured snapshot must reach the peer-runners unchanged. Stage
// C never generates one, and a corrupted upstream snapshot fails closed (rc-3)
// instead of being silently dropped or re-captured.

const VALID_SNAPSHOT: IntentSnapshot = {
  schemaVersion: 1,
  contentHash: 'sha256:stage-a-hash',
  capturedAt: '2026-11-14T00:00:00.000Z',
  lang: 'en',
  sections: [{ key: 'why', text: 'protect owner intent' }],
};

function committedEnvelopes(deps: ReturnType<typeof createMockDeps>): Record<string, unknown>[] {
  const finalize = deps._stateManager.commitDiagnosticianAndFinalize as { mock?: { calls?: unknown[][] } };
  return (finalize.mock?.calls ?? []).map((call) => {
    const input = call[0] as { piArtifact?: { contentJson?: string } } | undefined;
    return JSON.parse(input?.piArtifact?.contentJson ?? '{}') as Record<string, unknown>;
  });
}

describe('DiagRouterRunner — SIA v1.2 intentSnapshot passthrough', () => {
  it('passes the Stage A snapshot through into the committed envelope', async () => {
    const rootCause: DiagRootCauseOutputV1 = { ...makeRootCauseOutput(VALID_INTENT_TENSION), intentSnapshot: VALID_SNAPSHOT };
    const deps = createMockDeps(rootCause, makeRouterOutput());

    const runner = new DiagRouterRunner(deps, {
      owner: OWNER,
      runtimeKind: RUNTIME_KIND,
      pollIntervalMs: 10,
      timeoutMs: 1000,
    });
    expect((await runner.run(ROUTER_TASK_ID)).status).toBe('succeeded');

    const [envelope] = committedEnvelopes(deps);
    expect(envelope?.intentSnapshot).toEqual(VALID_SNAPSHOT);
    expect(envelope?.intentTension).toEqual(VALID_INTENT_TENSION);
  });

  it('does not invent a snapshot when Stage A captured none', async () => {
    const deps = createMockDeps(makeRootCauseOutput(), makeRouterOutput());
    const runner = new DiagRouterRunner(deps, {
      owner: OWNER,
      runtimeKind: RUNTIME_KIND,
      pollIntervalMs: 10,
      timeoutMs: 1000,
    });
    expect((await runner.run(ROUTER_TASK_ID)).status).toBe('succeeded');

    const [envelope] = committedEnvelopes(deps);
    expect(Object.hasOwn(envelope ?? {}, 'intentSnapshot')).toBe(false);
  });

  it('fails closed on a corrupted Stage A snapshot without committing', async () => {
    const corrupted = { contentHash: 'sha256:stage-a-hash' } as unknown as IntentSnapshot;
    const rootCause: DiagRootCauseOutputV1 = { ...makeRootCauseOutput(), intentSnapshot: corrupted };
    const deps = createMockDeps(rootCause, makeRouterOutput());

    const runner = new DiagRouterRunner(deps, {
      owner: OWNER,
      runtimeKind: RUNTIME_KIND,
      pollIntervalMs: 10,
      timeoutMs: 1000,
    });
    const result = await runner.run(ROUTER_TASK_ID);

    expect(result.status).toBe('failed');
    expect(result.errorCategory).toBe('input_invalid');
    expect(committedEnvelopes(deps)).toHaveLength(0);
  });
});
