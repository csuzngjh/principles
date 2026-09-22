/**
 * Shared harness for the three Diag runner V-slice suites (Test Diet Phase 2.2-B2).
 *
 * This is deliberately NOT a generic runner mock factory — the three runners are
 * different governance roles whose validation layers must stay distinct:
 *
 *   - 'router'    → NO validator mock is injected. DiagRouterRunner validates
 *                   through the real TypeBox pipeline baked into the class
 *                   (Value.Check on DiagnosticianOutputV1 + predecessor schemas
 *                   in buildContext). Lowering it to a mock validator would
 *                   delete the only runner-level real-schema evidence in the
 *                   region.
 *   - 'rootcause' → mock validator (always-valid stub, exactly as the pre-B2
 *                   suite had it) + contextAssembler mock. Upgrading A/B to the
 *                   real Default validator is Phase 2.2-B3, not here.
 *   - 'distiller' → mock validator (same rationale as rootcause).
 *
 * The harness owns the ~90% identical scaffold: 10-fn stateManager mocks,
 * 8-fn runtimeAdapter mocks, event emitter, predecessor artifact seeding
 * (router: 2, distiller: 1, rootcause: 0), and the runner options that were
 * previously inlined in all 38 its.
 *
 * PRI-pinned regressions (PRI-667, PRI-442 Bug-B-005, EP-07) stay in their
 * stage files — see docs/testing/internalization-test-value-audit.md §Diag
 * Runner Recommendation (plan B).
 */
import { vi } from 'vitest';
import { DiagRouterRunner } from '../../diag-router-runner.js';
import type { DiagRouterRunnerDeps } from '../../diag-router-runner.js';
import { DiagRootCauseRunner } from '../../diag-rootcause-runner.js';
import type { DiagRootCauseRunnerDeps } from '../../diag-rootcause-runner.js';
import { DiagDistillerRunner } from '../../diag-distiller-runner.js';
import type { DiagDistillerRunnerDeps } from '../../diag-distiller-runner.js';
import type { DiagnosticianOutputV1 } from '../../../diagnostician-output.js';
import type { DiagRootCauseOutputV1 } from '../../../diagnostician/diag-rootcause-output.js';
import type { DiagDistillerOutputV1 } from '../../../diagnostician/diag-distiller-output.js';
import type { CommitResult } from '../../../store/commit/diagnostician-committer.js';
import type { RuntimeStateManager } from '../../../store/runtime-state-manager.js';
import type { RunHandle, RunStatus } from '../../../runtime-protocol.js';
import type { StoreEventEmitter } from '../../../store/event-emitter.js';
import type { TaskRecord } from '../../../task-status.js';
import type { PeerRunnerOptions, PeerRunnerResult } from '../../../runner/peer-runner-types.js';
import type { RunnerPhase } from '../../../runner/runner-phase.js';
import { MemoryPIArtifactStore } from '../../pi-artifact-store.js';
import type { PIArtifactRecord } from '../../pi-artifact.js';
import { createPITaskDiagnosticJson } from '../../pitask-metadata.js';
import {
  MOCK_ROOT_CAUSE_OUTPUTS,
  MOCK_DISTILLER_OUTPUTS,
  MOCK_ROUTER_OUTPUTS,
} from './split-pipeline-mock-outputs.js';

export type DiagRunnerRole = 'router' | 'rootcause' | 'distiller';

type MockFn = ReturnType<typeof vi.fn>;

// ── Constants ─────────────────────────────────────────────────────────────────

export const RUNTIME_KIND = 'test-double';

export const ROUTER_TASK_ID = 'diag_router-001';
export const ROOTCAUSE_TASK_ID = 'diag_rootcause-001';
export const DISTILLER_TASK_ID = 'diag_distiller-001';

export const ROUTER_RUN_ID = 'run-router-001';
export const ROOTCAUSE_RUN_ID = 'run-rootcause-001';
export const DISTILLER_RUN_ID = 'run-distiller-001';

/** Router-stage ids for its two predecessor artifacts. */
export const ROUTER_ROOTCAUSE_ARTIFACT_ID = 'pi-art-rc-001';
export const ROUTER_DISTILLER_ARTIFACT_ID = 'pi-art-dist-001';
/** Distiller-stage id for its rootcause predecessor (EP-07 asserts this exact id). */
export const DISTILLER_ROOTCAUSE_ARTIFACT_ID = 'pi-art-diag_rootcause-001-run-rc-001';

// ── Task factories ────────────────────────────────────────────────────────────

/** Stage A self task: pending, standalone (no dependencies — first stage). */
export function makeRootCauseSelfTask(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    taskId: ROOTCAUSE_TASK_ID,
    taskKind: 'diag_rootcause',
    status: 'pending',
    attemptCount: 0,
    maxAttempts: 3,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    diagnosticJson: createPITaskDiagnosticJson({
      dependencyTaskIds: [],
      channel: 'prompt',
      timeoutMs: 300_000,
      inputArtifactRefs: [],
      outputArtifactRefs: [],
    }),
    ...overrides,
  };
}

/** Stage B self task: pending, requires the rootcause predecessor. */
export function makeDistillerSelfTask(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    taskId: DISTILLER_TASK_ID,
    taskKind: 'diag_distiller',
    status: 'pending',
    attemptCount: 0,
    maxAttempts: 3,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    diagnosticJson: createPITaskDiagnosticJson({
      dependencyTaskIds: [ROOTCAUSE_TASK_ID],
      channel: 'prompt',
      timeoutMs: 300_000,
      inputArtifactRefs: [],
      outputArtifactRefs: [],
    }),
    ...overrides,
  };
}

/** Stage C self task: pending, requires BOTH predecessors. */
export function makeRouterSelfTask(overrides: Partial<TaskRecord> = {}): TaskRecord {
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

/** Succeeded rootcause task as seen from a downstream stage's getTask routing. */
export function makeRootCausePredecessorTask(overrides: Partial<TaskRecord> = {}): TaskRecord {
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

/** Succeeded distiller task as seen from the router's getTask routing. */
export function makeDistillerPredecessorTask(overrides: Partial<TaskRecord> = {}): TaskRecord {
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

// ── Output factories (cached real LLM data, test-local ids) ─────────────────

export function makeRootCauseOutput(
  overrides: Partial<DiagRootCauseOutputV1> = {},
): DiagRootCauseOutputV1 {
  return {
    ...MOCK_ROOT_CAUSE_OUTPUTS.R6,
    diagnosisId: 'diag-001',
    taskId: ROOTCAUSE_TASK_ID,
    ...overrides,
  };
}

export function makeDistillerOutput(
  overrides: Partial<DiagDistillerOutputV1> = {},
  sourceRootCauseArtifactId: string = DISTILLER_ROOTCAUSE_ARTIFACT_ID,
): DiagDistillerOutputV1 {
  return {
    ...MOCK_DISTILLER_OUTPUTS.R6,
    taskId: DISTILLER_TASK_ID,
    sourceRootCauseArtifactId,
    ...overrides,
  };
}

export function makeRouterOutput(overrides: Partial<DiagnosticianOutputV1> = {}): DiagnosticianOutputV1 {
  return {
    ...MOCK_ROUTER_OUTPUTS.R6,
    diagnosisId: 'diag-001',
    ...overrides,
  };
}

// ── Predecessor artifact store ────────────────────────────────────────────────

/** Each predecessor slot: seeded valid, seeded corrupt, or absent. */
export interface PredecessorStoreScenario {
  rootcause?: 'valid' | 'corrupt' | 'absent';
  distiller?: 'valid' | 'corrupt' | 'absent';
}

const CORRUPTED_ARTIFACT_CONTENT = JSON.stringify({ invalid: true, missing: 'required fields' });

function artifactRecord(overrides: Partial<PIArtifactRecord> & { artifactId: string; sourceTaskId: string; contentJson: string }): PIArtifactRecord {
  return {
    artifactKind: 'principle',
    lineageArtifactIds: [],
    validationStatus: 'pending',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

/**
 * Build a MemoryPIArtifactStore seeded with predecessor artifacts per scenario.
 * Defaults to both slots absent (i.e. an empty store).
 */
export function makePredecessorStore(
  scenario: PredecessorStoreScenario = {},
  ids: { rootCauseArtifactId?: string; distillerArtifactId?: string } = {},
): MemoryPIArtifactStore {
  const rootCauseArtifactId = ids.rootCauseArtifactId ?? ROUTER_ROOTCAUSE_ARTIFACT_ID;
  const distillerArtifactId = ids.distillerArtifactId ?? ROUTER_DISTILLER_ARTIFACT_ID;
  const store = new MemoryPIArtifactStore();

  if (scenario.rootcause && scenario.rootcause !== 'absent') {
    store.upsertArtifact(
      artifactRecord({
        artifactId: rootCauseArtifactId,
        sourceTaskId: ROOTCAUSE_TASK_ID,
        contentJson:
          scenario.rootcause === 'corrupt'
            ? CORRUPTED_ARTIFACT_CONTENT
            : JSON.stringify(makeRootCauseOutput()),
      }),
    );
  }
  if (scenario.distiller && scenario.distiller !== 'absent') {
    store.upsertArtifact(
      artifactRecord({
        artifactId: distillerArtifactId,
        sourceTaskId: DISTILLER_TASK_ID,
        lineageArtifactIds: [rootCauseArtifactId],
        contentJson:
          scenario.distiller === 'corrupt'
            ? CORRUPTED_ARTIFACT_CONTENT
            : JSON.stringify(makeDistillerOutput({}, rootCauseArtifactId)),
      }),
    );
  }
  return store;
}

/**
 * Store whose artifact *writes* always reject while reads stay real —
 * injects a storage-layer failure for the A/B runners (the router's write
 * failure lives at the committer layer and is NOT modeled here). Pass a
 * `reads` scenario so predecessor resolution still succeeds and the run
 * actually reaches the failing write.
 */
export function makeFailingArtifactStore(
  reads: PredecessorStoreScenario = {},
  ids: { rootCauseArtifactId?: string; distillerArtifactId?: string } = {},
): MemoryPIArtifactStore {
  const store = makePredecessorStore(reads, ids);
  store.upsertArtifact = vi.fn().mockRejectedValue(new Error('Disk full'));
  return store;
}

// ── Shared mock scaffold ──────────────────────────────────────────────────────

function makeStateManagerMock(
  selfTask: TaskRecord,
  runId: string,
  taskMap: Record<string, TaskRecord>,
) {
  return {
    acquireLease: vi.fn().mockResolvedValue(selfTask),
    getTask: vi.fn().mockImplementation((id: string) => Promise.resolve(taskMap[id])),
    getRunsByTask: vi.fn().mockResolvedValue([{ runId, taskId: selfTask.taskId }]),
    getValidRunsByTaskTolerant: vi.fn().mockResolvedValue({
      runs: [{ runId, taskId: selfTask.taskId }],
      degradedRuns: [],
    }),
    updateRunOutput: vi.fn().mockResolvedValue(undefined),
    markTaskSucceeded: vi.fn().mockResolvedValue(undefined),
    markTaskFailed: vi.fn().mockResolvedValue(undefined),
    markTaskRetryWait: vi.fn().mockResolvedValue(undefined),
    getRetryPolicy: vi.fn().mockReturnValue({ shouldRetry: () => false }),
  };
}

function makeRuntimeAdapterMock(runId: string, output: unknown) {
  const runHandle: RunHandle = { runId, runtimeKind: RUNTIME_KIND, startedAt: new Date().toISOString() };
  const succeededStatus: RunStatus = { status: 'succeeded', runId };
  return {
    kind: vi.fn().mockReturnValue(RUNTIME_KIND),
    getCapabilities: vi.fn(),
    healthCheck: vi.fn(),
    startRun: vi.fn().mockResolvedValue(runHandle),
    pollRun: vi.fn().mockResolvedValue(succeededStatus),
    fetchOutput: vi.fn().mockResolvedValue({ payload: output }),
    cancelRun: vi.fn().mockResolvedValue(undefined),
    fetchArtifacts: vi.fn(),
  };
}

function makeEventEmitterMock() {
  return {
    emitTelemetry: vi.fn(),
    on: vi.fn(),
    emit: vi.fn(),
  };
}

function makeOptions(owner: string): PeerRunnerOptions {
  return {
    owner,
    runtimeKind: RUNTIME_KIND,
    pollIntervalMs: 10,
    timeoutMs: 1000,
  };
}

function castStateManager(_sm: Record<string, MockFn>): RuntimeStateManager {
  // runtime-contract-exempt: ERR-001 test-double DI wiring of a partial mock, not untrusted runtime data
  return _sm as unknown as RuntimeStateManager;
}

function castEventEmitter(_ee: Record<string, MockFn>): StoreEventEmitter {
  // runtime-contract-exempt: ERR-001 test-double DI wiring of a partial mock, not untrusted runtime data
  return _ee as unknown as StoreEventEmitter;
}

// ── Harness interface ─────────────────────────────────────────────────────────

/** Structural view of the three runners for shared contract assertions. */
export interface DiagRunnerUnderTest {
  run(taskId: string): Promise<PeerRunnerResult<unknown>>;
  readonly currentPhase: RunnerPhase;
}

interface SharedMocks {
  _stateManager: Record<string, MockFn>;
  _runtimeAdapter: Record<string, MockFn>;
  _eventEmitter: Record<string, MockFn>;
}

export type DiagRouterMocks = SharedMocks & {
  _committer: { commit: MockFn };
};

export type DiagRootCauseMocks = SharedMocks & {
  _validator: { validate: MockFn };
  _contextAssembler: { assemble: MockFn };
};

export type DiagDistillerMocks = SharedMocks & {
  _validator: { validate: MockFn };
};

export interface DiagRunnerHarness<D, M extends SharedMocks> {
  role: DiagRunnerRole;
  taskId: string;
  runId: string;
  options: PeerRunnerOptions;
  /** Deps object with the underlying vi.fn() mocks exposed as `_`-prefixed fields. */
  deps: D & M;
  /** Runner constructed with the standard options against `deps`. */
  runner: DiagRunnerUnderTest;
  /** Fresh self task for this role (pending, role-default dependencies). */
  makeTask: (overrides?: Partial<TaskRecord>) => TaskRecord;
  /** Fresh happy-path output for this role. */
  makeOutput: (overrides?: Record<string, unknown>) => Record<string, unknown>;
}

export type DiagRouterHarness = DiagRunnerHarness<DiagRouterRunnerDeps, DiagRouterMocks>;
export type DiagRootCauseHarness = DiagRunnerHarness<DiagRootCauseRunnerDeps, DiagRootCauseMocks>;
export type DiagDistillerHarness = DiagRunnerHarness<DiagDistillerRunnerDeps, DiagDistillerMocks>;
export type AnyDiagRunnerHarness = DiagRouterHarness | DiagRootCauseHarness | DiagDistillerHarness;

function createRouterHarness(overrides: Record<string, unknown> = {}): DiagRouterHarness {
  const taskRecord = makeRouterSelfTask();
  const output = makeRouterOutput();

  const _stateManager = makeStateManagerMock(taskRecord, ROUTER_RUN_ID, {
    [ROUTER_TASK_ID]: taskRecord,
    [ROOTCAUSE_TASK_ID]: makeRootCausePredecessorTask(),
    [DISTILLER_TASK_ID]: makeDistillerPredecessorTask(),
  });
  const _runtimeAdapter = makeRuntimeAdapterMock(ROUTER_RUN_ID, output);
  const _eventEmitter = makeEventEmitterMock();

  const commitResult: CommitResult = {
    commitId: 'commit-001',
    artifactId: 'art-001',
    candidateCount: 1,
  };
  const _committer = { commit: vi.fn().mockResolvedValue(commitResult) };

  const artifactStore = makePredecessorStore(
    { rootcause: 'valid', distiller: 'valid' },
    { rootCauseArtifactId: ROUTER_ROOTCAUSE_ARTIFACT_ID, distillerArtifactId: ROUTER_DISTILLER_ARTIFACT_ID },
  );

  const deps = {
    stateManager: castStateManager(_stateManager),
    runtimeAdapter: _runtimeAdapter,
    eventEmitter: castEventEmitter(_eventEmitter),
    artifactStore,
    committer: _committer,
    _stateManager,
    _runtimeAdapter,
    _eventEmitter,
    _committer,
    ...overrides,
  } as DiagRouterHarness['deps'];

  const options = makeOptions('test-router-owner');
  return {
    role: 'router',
    taskId: ROUTER_TASK_ID,
    runId: ROUTER_RUN_ID,
    options,
    deps,
    runner: new DiagRouterRunner(deps, options),
    makeTask: makeRouterSelfTask,
    makeOutput: (o = {}) => ({ ...makeRouterOutput(), ...o }),
  };
}

function createRootCauseHarness(overrides: Record<string, unknown> = {}): DiagRootCauseHarness {
  const taskRecord = makeRootCauseSelfTask();
  const output = makeRootCauseOutput();

  const _stateManager = makeStateManagerMock(taskRecord, ROOTCAUSE_RUN_ID, {
    [ROOTCAUSE_TASK_ID]: taskRecord,
  });
  const _runtimeAdapter = makeRuntimeAdapterMock(ROOTCAUSE_RUN_ID, output);
  const _eventEmitter = makeEventEmitterMock();

  // Mock validator — always-valid stub (pre-B2 semantics; realism upgrade is B3).
  const _validator = {
    validate: vi.fn().mockResolvedValue({ valid: true, errors: [] }),
  };
  const _contextAssembler = {
    assemble: vi.fn().mockResolvedValue({
      sourceRefs: ['ref-1', 'ref-2'],
      conversationWindow: [],
      trajectorySummary: '',
      painSignal: { painId: 'pain-001', painType: 'tool_failure', source: 'test', reason: 'test reason', score: 70 },
    }),
  };

  const deps = {
    stateManager: castStateManager(_stateManager),
    runtimeAdapter: _runtimeAdapter,
    eventEmitter: castEventEmitter(_eventEmitter),
    artifactStore: new MemoryPIArtifactStore(),
    validator: _validator,
    contextAssembler: _contextAssembler,
    _stateManager,
    _runtimeAdapter,
    _eventEmitter,
    _validator,
    _contextAssembler,
    ...overrides,
  } as DiagRootCauseHarness['deps'];

  const options = makeOptions('test-rootcause-owner');
  return {
    role: 'rootcause',
    taskId: ROOTCAUSE_TASK_ID,
    runId: ROOTCAUSE_RUN_ID,
    options,
    deps,
    runner: new DiagRootCauseRunner(deps, options),
    makeTask: makeRootCauseSelfTask,
    makeOutput: (o = {}) => ({ ...makeRootCauseOutput(), ...o }),
  };
}

function createDistillerHarness(overrides: Record<string, unknown> = {}): DiagDistillerHarness {
  const taskRecord = makeDistillerSelfTask();
  const output = makeDistillerOutput();

  const _stateManager = makeStateManagerMock(taskRecord, DISTILLER_RUN_ID, {
    [DISTILLER_TASK_ID]: taskRecord,
    [ROOTCAUSE_TASK_ID]: makeRootCausePredecessorTask(),
  });
  const _runtimeAdapter = makeRuntimeAdapterMock(DISTILLER_RUN_ID, output);
  const _eventEmitter = makeEventEmitterMock();

  // Mock validator — always-valid stub (pre-B2 semantics; realism upgrade is B3).
  const _validator = {
    validate: vi.fn().mockResolvedValue({ valid: true, errors: [] }),
  };

  const artifactStore = makePredecessorStore(
    { rootcause: 'valid' },
    { rootCauseArtifactId: DISTILLER_ROOTCAUSE_ARTIFACT_ID },
  );

  const deps = {
    stateManager: castStateManager(_stateManager),
    runtimeAdapter: _runtimeAdapter,
    eventEmitter: castEventEmitter(_eventEmitter),
    artifactStore,
    validator: _validator,
    _stateManager,
    _runtimeAdapter,
    _eventEmitter,
    _validator,
    ...overrides,
  } as DiagDistillerHarness['deps'];

  const options = makeOptions('test-distiller-owner');
  return {
    role: 'distiller',
    taskId: DISTILLER_TASK_ID,
    runId: DISTILLER_RUN_ID,
    options,
    deps,
    runner: new DiagDistillerRunner(deps, options),
    makeTask: makeDistillerSelfTask,
    makeOutput: (o = {}) => ({ ...makeDistillerOutput(), ...o }),
  };
}

export function createDiagRunnerHarness(
  role: 'router',
  overrides?: Partial<DiagRouterRunnerDeps>,
): DiagRouterHarness;
export function createDiagRunnerHarness(
  role: 'rootcause',
  overrides?: Partial<DiagRootCauseRunnerDeps>,
): DiagRootCauseHarness;
export function createDiagRunnerHarness(
  role: 'distiller',
  overrides?: Partial<DiagDistillerRunnerDeps>,
): DiagDistillerHarness;
export function createDiagRunnerHarness(
  role: DiagRunnerRole,
  overrides: Record<string, unknown> = {},
): DiagRouterHarness | DiagRootCauseHarness | DiagDistillerHarness {
  switch (role) {
    case 'router':
      return createRouterHarness(overrides);
    case 'rootcause':
      return createRootCauseHarness(overrides);
    case 'distiller':
      return createDistillerHarness(overrides);
    default: {
      const exhaustive: never = role;
      throw new Error(`Unknown diag runner role: ${String(exhaustive)}`);
    }
  }
}
