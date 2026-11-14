/**
 * DiagRouterRunner — Stage B → Stage C deterministic principle inheritance.
 *
 * SPEC-PD-DIAG-ROUTER-RELIABILITY-001 §4 (P1). Verifies:
 *   1. a model that omits / blanks `abstractedPrinciple` still commits the
 *      Stage B distiller value (the adapter lets it through because the field
 *      is structurally optional on purpose);
 *   2. a model that invents a different principle cannot override Stage B;
 *   3. a Stage B artifact without a usable principle fails loudly as an
 *      upstream data error — never fabricated from model text;
 *   4. more than one `kind: "principle"` entry cannot be mapped onto the single
 *      upstream principle, so it fails instead of duplicating the text;
 *   5. rule / implementation / prompt / defer entries are untouched.
 *
 * ERR entries considered:
 *   - ERR-001 / EP-01: `postFetchTransform` receives `unknown` output; every
 *     entry is narrowed before use.
 *   - ERR-002 / EP-03: overrides and strips emit `diag_router_invariant_override`.
 *   - EP-09: the failure cases assert the exact structured outcome on the real
 *     `run()` boundary (status + errorCategory + persisted mark), not helpers.
 */
import { createHash } from 'node:crypto';
import { describe, it, expect, vi } from 'vitest';
import { DiagRouterRunner } from '../diag-router-runner.js';
import type { DiagRouterRunnerDeps } from '../diag-router-runner.js';
import { mapFailureCategory } from '../../error-categories.js';
import type { DiagnosticianOutputV2 } from '../../diagnostician-output.js';
import type { DiagRootCauseOutputV1 } from '../../diagnostician/diag-rootcause-output.js';
import type { DiagDistillerOutputV1 } from '../../diagnostician/diag-distiller-output.js';
import type { CommitResult } from '../../store/commit/diagnostician-committer.js';
import { fencedStateManager as fenced } from '../../__tests__/fixtures/fenced-state-manager.js';
import { installDiagnosticianCommitMock } from '../../__tests__/fixtures/fenced-state-manager.js';
import type { RunHandle, RunStatus } from '../../runtime-protocol.js';
import { MemoryPIArtifactStore } from '../pi-artifact-store.js';
import type { TaskRecord } from '../../task-status.js';
import { createPITaskDiagnosticJson } from '../pitask-metadata.js';
import { MOCK_ROOT_CAUSE_OUTPUTS, MOCK_DISTILLER_OUTPUTS, MOCK_ROUTER_OUTPUTS } from '../../adapter/split-pipeline-fixtures.js';

// ── Test fixtures ────────────────────────────────────────────────────────────

const ROUTER_TASK_ID = 'diag_router-001';
const ROOTCAUSE_TASK_ID = 'diag_rootcause-001';
const DISTILLER_TASK_ID = 'diag_distiller-001';
const RUN_ID = 'run-router-001';
const OWNER = 'test-router-inherit-owner';
const RUNTIME_KIND = 'test-double';
const ROOTCAUSE_ARTIFACT_ID = 'pi-art-rc-001';
const DISTILLER_ARTIFACT_ID = 'pi-art-dist-001';

const STAGE_B_PRINCIPLE = MOCK_DISTILLER_OUTPUTS.R6.abstractedPrinciple;

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
    ...MOCK_ROOT_CAUSE_OUTPUTS.R6,
    diagnosisId: 'diag-001',
    taskId: ROOTCAUSE_TASK_ID,
  };
}

function makeDistillerOutput(overrides: Partial<DiagDistillerOutputV1> = {}): DiagDistillerOutputV1 {
  return {
    ...MOCK_DISTILLER_OUTPUTS.R6,
    taskId: DISTILLER_TASK_ID,
    sourceRootCauseArtifactId: ROOTCAUSE_ARTIFACT_ID,
    ...overrides,
  };
}

function makeRouterOutput(recommendations: DiagnosticianOutputV2['recommendations']): DiagnosticianOutputV2 {
  return {
    ...MOCK_ROUTER_OUTPUTS.R6,
    diagnosisId: 'diag-001',
    recommendations,
  };
}

function populatePredecessorArtifacts(store: MemoryPIArtifactStore, distillerOutput: DiagDistillerOutputV1): void {
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
    contentJson: JSON.stringify(distillerOutput),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
}

// ── Mock factory ─────────────────────────────────────────────────────────────

type MockField = ReturnType<typeof vi.fn> | Record<string, ReturnType<typeof vi.fn>>;

function createMockDeps(
  routerOutput: DiagnosticianOutputV2,
  distillerOutput: DiagDistillerOutputV1 = makeDistillerOutput(),
  options: { retryable?: boolean } = {},
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
    runStore: { updateRun: vi.fn().mockResolvedValue(undefined) },
    markTaskSucceeded: vi.fn().mockResolvedValue(undefined),
    markTaskFailed: vi.fn().mockResolvedValue(undefined),
    markTaskRetryWait: vi.fn().mockResolvedValue(undefined),
    // Model real persistence: persistTerminalFailure re-reads the task, so a
    // mock that drops the write would hide the evidence just persisted.
    updateTask: vi.fn().mockImplementation(async (_taskId: string, patch: Record<string, unknown>) => {
      if (typeof patch.diagnosticJson === 'string') taskRecord.diagnosticJson = patch.diagnosticJson;
    }),
    getRetryPolicy: vi.fn().mockReturnValue({ shouldRetry: () => options.retryable ?? false }),
  };

  const runHandle: RunHandle = { runId: RUN_ID, runtimeKind: RUNTIME_KIND, startedAt: new Date().toISOString() };
  const succeededStatus: RunStatus = { status: 'succeeded', runId: RUN_ID };

  const _runtimeAdapter = {
    kind: vi.fn().mockReturnValue(RUNTIME_KIND),
    getCapabilities: vi.fn(),
    healthCheck: vi.fn(),
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
  populatePredecessorArtifacts(artifactStore, distillerOutput);
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
    trustedPrincipleSource: { readTrustedPrinciples: () => ({ status: 'ok' as const, principles: [] }) },
    _stateManager,
    _runtimeAdapter,
    _committer,
    _eventEmitter,
  };
}

function createRunner(deps: DiagRouterRunnerDeps): DiagRouterRunner {
  return new DiagRouterRunner(deps, {
    owner: OWNER,
    runtimeKind: RUNTIME_KIND,
    pollIntervalMs: 10,
    timeoutMs: 1000,
  });
}

type TelemetryCallArg = { eventType: string; payload?: Record<string, unknown> };
function telemetryEventType(call: readonly unknown[]): string | undefined {
  const event = call[0] as TelemetryCallArg | undefined;
  return event?.eventType;
}
function telemetryPayload(call: readonly unknown[]): Record<string, unknown> | undefined {
  const event = call[0] as TelemetryCallArg | undefined;
  return event?.payload;
}

/** Read the diagnostics the runner persisted for the last attempt. */
function lastPersistedDiagnosticJson(deps: { _stateManager: Record<string, MockField> }): Record<string, unknown> {
  const updateTask = deps._stateManager.updateTask as unknown as {
    mock: { calls: [string, Record<string, unknown>][] };
  };
  const [lastTaskId, patch] = updateTask.mock.calls.at(-1) ?? [];
  if (lastTaskId === undefined || patch === undefined) throw new Error('expected updateTask to have been called');
  if (typeof patch.diagnosticJson !== 'string') throw new Error('expected diagnosticJson in patch');
  return JSON.parse(patch.diagnosticJson) as Record<string, unknown>;
}

/** Read the principle recommendation the runner actually committed. */
function committedPrincipleEntry(deps: { _committer: Record<string, ReturnType<typeof vi.fn>> }): Record<string, unknown> {
  const commitMock = deps._committer.commit;
  if (!commitMock) throw new Error('commit mock not configured');
  const [commitCall] = commitMock.mock.calls;
  const output = commitCall?.[0]?.output as DiagnosticianOutputV2 | undefined;
  const entry = output?.recommendations.find((rec) => rec.kind === 'principle');
  if (!entry) throw new Error('no committed kind:"principle" recommendation');
  return entry;
}

/** A structurally valid principle entry with the field under test controlled. */
function principleRecommendation(abstractedPrinciple?: unknown): DiagnosticianOutputV2['recommendations'][number] {
  const base: Record<string, unknown> = {
    kind: 'principle',
    description: 'Refactor core contracts only after a full impact and compatibility assessment.',
    recommendationRef: 'principle-1',
  };
  if (abstractedPrinciple !== undefined) base.abstractedPrinciple = abstractedPrinciple;
  return base as unknown as DiagnosticianOutputV2['recommendations'][number];
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('DiagRouterRunner — Stage B abstractedPrinciple inheritance (SPEC §4)', () => {
  it('fills a missing abstractedPrinciple from the Stage B artifact', async () => {
    const deps = createMockDeps(makeRouterOutput([principleRecommendation()]));
    const result = await createRunner(deps).run(ROUTER_TASK_ID);

    expect(result.status).toBe('succeeded');
    expect(committedPrincipleEntry(deps).abstractedPrinciple).toBe(STAGE_B_PRINCIPLE);
  });

  it('fills an empty-string abstractedPrinciple from the Stage B artifact', async () => {
    const deps = createMockDeps(makeRouterOutput([principleRecommendation('')]));
    const result = await createRunner(deps).run(ROUTER_TASK_ID);

    expect(result.status).toBe('succeeded');
    expect(committedPrincipleEntry(deps).abstractedPrinciple).toBe(STAGE_B_PRINCIPLE);
  });

  it('fills a whitespace-only abstractedPrinciple from the Stage B artifact', async () => {
    const deps = createMockDeps(makeRouterOutput([principleRecommendation('   ')]));
    const result = await createRunner(deps).run(ROUTER_TASK_ID);

    expect(result.status).toBe('succeeded');
    expect(committedPrincipleEntry(deps).abstractedPrinciple).toBe(STAGE_B_PRINCIPLE);
  });

  it('Stage B wins over a model-generated principle and records the override', async () => {
    const deps = createMockDeps(makeRouterOutput([principleRecommendation('A model-invented principle that must not win.')]));
    const result = await createRunner(deps).run(ROUTER_TASK_ID);

    expect(result.status).toBe('succeeded');
    expect(committedPrincipleEntry(deps).abstractedPrinciple).toBe(STAGE_B_PRINCIPLE);

    const overrideCall = deps._eventEmitter.emitTelemetry.mock.calls.find(
      (call: readonly unknown[]) => telemetryEventType(call) === 'diag_router_invariant_override'
        && telemetryPayload(call)?.field === 'abstractedPrinciple',
    );
    expect(overrideCall).toBeDefined();
  });

  it('fails with input_invalid when the Stage B principle is blank (no fabrication)', async () => {
    const deps = createMockDeps(
      makeRouterOutput([principleRecommendation()]),
      // Whitespace satisfies the distiller schema's minLength, so this reaches
      // postFetchTransform — the guard, not the schema, must reject it.
      makeDistillerOutput({ abstractedPrinciple: '   ' }),
    );
    const result = await createRunner(deps).run(ROUTER_TASK_ID);

    expect(result.status).toBe('failed');
    expect(result.errorCategory).toBe('input_invalid');
    expect(result.failureReason).toContain(DISTILLER_ARTIFACT_ID);
    expect(deps._stateManager.markTaskFailed).toHaveBeenCalledWith(
      ROUTER_TASK_ID,
      'input_invalid',
      expect.any(String),
      expect.objectContaining({ taskId: ROUTER_TASK_ID, leaseGeneration: 1 }),
      expect.any(String),
    );
  });

  it('rejects a Stage B artifact whose principle is empty at context assembly (upstream guard)', async () => {
    const deps = createMockDeps(
      makeRouterOutput([principleRecommendation()]),
      makeDistillerOutput({ abstractedPrinciple: '' }),
    );
    const result = await createRunner(deps).run(ROUTER_TASK_ID);

    expect(result.status).toBe('failed');
    expect(result.errorCategory).toBe('input_invalid');
    expect(result.failureReason).toContain('Distiller artifact content failed schema validation');
  });

  it('reports more than one principle recommendation as a retryable output_invalid', async () => {
    const deps = createMockDeps(
      makeRouterOutput([
        principleRecommendation(),
        {
          kind: 'principle',
          description: 'A second principle that has no Stage B counterpart.',
          recommendationRef: 'principle-2',
        } as unknown as DiagnosticianOutputV2['recommendations'][number],
      ]),
      makeDistillerOutput(),
      { retryable: true },
    );
    const result = await createRunner(deps).run(ROUTER_TASK_ID);

    // Model-output contract violation → retryable, not a permanent input error.
    expect(result.status).toBe('retried');
    expect(result.errorCategory).toBe('output_invalid');
    expect(result.failureReason).toContain('at most one');
    expect(deps._stateManager.markTaskRetryWait).toHaveBeenCalledWith(
      ROUTER_TASK_ID,
      'output_invalid',
      expect.stringContaining('at most one kind:"principle"'),
      expect.objectContaining({ taskId: ROUTER_TASK_ID, leaseGeneration: 1 }),
      expect.any(String),
    );

    // The constraint travels as repair feedback for the next attempt.
    const persisted = lastPersistedDiagnosticJson(deps);
    const feedback = persisted.lastValidatorErrors as { errors: string[] };
    expect(feedback.errors[0]).toContain('at most one kind:"principle"');
  });

  it('surfaces an exhausted multi-principle failure as output_invalid, never config_missing', async () => {
    const deps = createMockDeps(
      makeRouterOutput([
        principleRecommendation(),
        {
          kind: 'principle',
          description: 'A second principle that has no Stage B counterpart.',
          recommendationRef: 'principle-2',
        } as unknown as DiagnosticianOutputV2['recommendations'][number],
      ]),
      makeDistillerOutput(),
      { retryable: false },
    );
    const result = await createRunner(deps).run(ROUTER_TASK_ID);

    expect(result.status).toBe('failed');
    expect(result.errorCategory).toBe('output_invalid');
    expect(mapFailureCategory(result.errorCategory ?? 'output_invalid')).toBe('output_invalid');
    expect(deps._stateManager.markTaskFailed).toHaveBeenCalledWith(
      ROUTER_TASK_ID,
      'output_invalid',
      expect.any(String),
      expect.objectContaining({ taskId: ROUTER_TASK_ID, leaseGeneration: 1 }),
      expect.any(String),
    );
  });

  it('previews what the model produced, not the Stage B value the transform wrote in', async () => {
    const modelPrinciple = 'MODEL-PRINCIPLE-A-MUST-SURVIVE-IN-EVIDENCE';
    const stageBPrinciple = 'STAGE-B-INHERITED-PRINCIPLE-B';
    const deps = createMockDeps(
      makeRouterOutput([
        principleRecommendation(modelPrinciple),
        // Structurally invalid rule → validation fails after the transform.
        {
          kind: 'rule',
          description: 'Malformed rule with no trigger pattern or action.',
          recommendationRef: 'rule-bad',
        } as unknown as DiagnosticianOutputV2['recommendations'][number],
      ]),
      makeDistillerOutput({ abstractedPrinciple: stageBPrinciple }),
    );
    const result = await createRunner(deps).run(ROUTER_TASK_ID);

    expect(result.status).toBe('failed');
    expect(result.errorCategory).toBe('output_invalid');

    const persisted = lastPersistedDiagnosticJson(deps);
    const preview = String((persisted.output_failure_details as Record<string, unknown>).rawOutputPreview);
    expect(preview).toContain(modelPrinciple);
    expect(preview).not.toContain(stageBPrinciple);
  });

  it('leaves rule / implementation / prompt / defer entries untouched', async () => {
    const rule = MOCK_ROUTER_OUTPUTS.R6.recommendations.find((rec) => rec.kind === 'rule');
    const implementation = MOCK_ROUTER_OUTPUTS.R6.recommendations.find((rec) => rec.kind === 'implementation');
    if (!rule || !implementation) throw new Error('fixture is missing rule/implementation entries');

    const promptEntry = {
      kind: 'prompt',
      description: 'Add a compatibility checklist to the refactor prompt.',
      recommendationRef: 'prompt-1',
    } as unknown as DiagnosticianOutputV2['recommendations'][number];
    const deferEntry = {
      kind: 'defer',
      description: 'Defer enforcement until the compatibility layer lands.',
      recommendationRef: 'defer-1',
    } as unknown as DiagnosticianOutputV2['recommendations'][number];

    const deps = createMockDeps(makeRouterOutput([principleRecommendation(), rule, implementation, promptEntry, deferEntry]));
    const result = await createRunner(deps).run(ROUTER_TASK_ID);

    expect(result.status).toBe('succeeded');

    const commitMock = deps._committer.commit;
    if (!commitMock) throw new Error('commit mock not configured');
    const [commitCall] = commitMock.mock.calls;
    const committed = commitCall?.[0]?.output as DiagnosticianOutputV2;
    const find = (kind: string): Record<string, unknown> | undefined =>
      committed.recommendations.find((rec) => rec.kind === kind);

    expect(find('rule')).toEqual(rule);
    expect(find('implementation')).toEqual(implementation);
    expect(find('prompt')).toEqual(promptEntry);
    expect(find('defer')).toEqual(deferEntry);
    expect(committed.recommendations.find((rec) => rec.kind === 'principle')?.abstractedPrinciple).toBe(STAGE_B_PRINCIPLE);
  });
});
