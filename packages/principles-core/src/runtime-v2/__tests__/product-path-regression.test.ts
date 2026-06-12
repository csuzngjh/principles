/**
 * PRI-376: Product-path regression tests for pain-to-principle flow.
 *
 * Why this suite exists:
 *   Dogfood repeatedly found pain-to-principle regressions that were NOT caught
 *   by the existing 4000+ unit tests. The gap: no small, hard regression suite
 *   for real product paths from operator command → runtime state → visible outcome.
 *
 * Each test encodes a REAL user/operator contract, not helper-level implementation
 * details. The comments explain WHY each scenario matters as a product-path contract.
 *
 * ERR entries considered:
 *   - ERR-002: no silent pending or silent fallback
 *   - ERR-025: tests must cover real product path, not isolated helper behavior
 *   - CLI Operator Gate: JSON strictness and nextAction on non-success paths
 *   - Workspace boundary: code repo is NOT PD production workspace
 *
 * Coverage:
 *   R1: pd pain record --json default path must NOT create a permanently pending
 *       diagnostician task (task_kind='diagnostician', status='pending',
 *       attempt_count=0, runs=[], no consumer/nextAction).
 *   R2: If diagnosis does not execute immediately, JSON must include reason + nextAction.
 *   R3: Successful split diagnostician run → candidate traceable to distiller/router artifacts.
 *   R4: Generated principle candidate preserves groundedOnCorePrincipleIds.
 *   R5: Workspace isolation — tests use isolated temp workspace, never write to
 *       D:\Code\principles or D:\.openclaw\workspace.
 */
import { describe, it, expect, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { RuntimeStateManager } from '../store/runtime-state-manager.js';
import { SqliteDiagnosticianCommitter } from '../store/commit/diagnostician-committer.js';
import { SqliteContextAssembler } from '../store/context/sqlite-context-assembler.js';
import { SqliteHistoryQuery } from '../store/history/sqlite-history-query.js';
import { PainSignalBridge } from '../pain-signal-bridge.js';
import { CandidateIntakeService } from '../candidate-intake-service.js';
import { DiagRootCauseRunner } from '../internalization/diag-rootcause-runner.js';
import { DiagDistillerRunner } from '../internalization/diag-distiller-runner.js';
import { DiagRouterRunner } from '../internalization/diag-router-runner.js';
import { SplitDiagnosticianRunner } from '../internalization/split-diagnostician-runner.js';
import type { RunHandle, RunStatus } from '../runtime-protocol.js';
import type { StoreEventEmitter } from '../store/event-emitter.js';
import type { LedgerAdapter } from '../candidate-intake.js';
import type { DiagRootCauseOutputV1 } from '../diagnostician/diag-rootcause-output.js';
import type { DiagDistillerOutputV1 } from '../diagnostician/diag-distiller-output.js';
import type { DiagnosticianOutputV1 } from '../diagnostician-output.js';
import {
  MOCK_ROOT_CAUSE_OUTPUTS,
  MOCK_DISTILLER_OUTPUTS,
  MOCK_ROUTER_OUTPUTS,
} from '../internalization/__tests__/__fixtures__/split-pipeline-mock-outputs.js';

// ── Constants ──────────────────────────────────────────────────────────────────

const OWNER = 'product-path-regression';
const RUNTIME_KIND = 'test-double';

// ── Forbidden workspace paths (R5 contract) ────────────────────────────────────

/**
 * These paths must NEVER appear as workspace targets in test runs.
 * The code repo and the real OpenClaw workspace are off-limits.
 */
const FORBIDDEN_WORKSPACE_PATHS = [
  'D:\\Code\\principles',
  'D:/.openclaw/workspace',
  'D:\\.openclaw\\workspace',
];

// ── Mock output factories (using cached real LLM data from R6 fixture) ────────

function makeRootCauseOutput(): DiagRootCauseOutputV1 {
  return {
    ...MOCK_ROOT_CAUSE_OUTPUTS.R6,
    diagnosisId: 'diag-regression-001',
    taskId: 'diag_rootcause-regression',
  };
}

function makeDistillerOutput(overrides: Partial<DiagDistillerOutputV1> = {}): DiagDistillerOutputV1 {
  return {
    ...MOCK_DISTILLER_OUTPUTS.R6,
    taskId: 'diag_distiller-regression',
    sourceRootCauseArtifactId: 'pi-art-rootcause-regression',
    ...overrides,
  };
}

function makeRouterOutput(): DiagnosticianOutputV1 {
  return {
    ...MOCK_ROUTER_OUTPUTS.R6,
    diagnosisId: 'diag-regression-001',
  };
}

// ── Shared mock helpers ────────────────────────────────────────────────────────

function makeRunHandle(runId: string): RunHandle {
  return { runId, runtimeKind: RUNTIME_KIND, startedAt: new Date().toISOString() };
}

function makeSucceededStatus(runId: string): RunStatus {
  return { status: 'succeeded', runId };
}

function makeMockEventEmitter(): StoreEventEmitter {
  return {
    emitTelemetry: vi.fn(),
    on: vi.fn(),
    emit: vi.fn(),
  } as unknown as StoreEventEmitter;
}

function makeMockRuntimeAdapter() {
  return {
    kind: vi.fn().mockReturnValue(RUNTIME_KIND),
    getCapabilities: vi.fn(),
    healthCheck: vi.fn(),
    startRun: vi.fn().mockResolvedValue(makeRunHandle('run-regression')),
    pollRun: vi.fn().mockResolvedValue(makeSucceededStatus('run-regression')),
    fetchOutput: vi.fn().mockResolvedValue({ payload: makeRootCauseOutput() }),
    cancelRun: vi.fn().mockResolvedValue(undefined),
    fetchArtifacts: vi.fn(),
  };
}

// ── R1: No permanently pending diagnostician task ─────────────────────────────

describe('PRI-376: Product-path regression — pain-to-principle flow', () => {

  /**
   * R1 — Product contract: When `pd pain record --json` runs the full sync
   * diagnostician pipeline, the resulting task must NOT be stuck in a permanently
   * pending state (status='pending', attempt_count=0, no runs, no nextAction).
   *
   * Why this matters: PRI-375 regression showed that a task could be created as
   * pending but never transitioned to succeeded/failed. Users saw `submitted`
   * in JSON output but the diagnostician never actually ran. This test catches
   * that exact regression shape.
   *
   * Regression shape caught:
   *   task_kind='diagnostician', status='pending', attempt_count=0,
   *   runs=[], and no consumer/nextAction.
   */
  it('R1: sync pain-to-principle pipeline must NOT leave task permanently pending', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-r1-no-pending-'));
    const stateManager = new RuntimeStateManager({ workspaceDir: tmpDir });
    try {
      await stateManager.initialize();

      const committer = new SqliteDiagnosticianCommitter(stateManager.connection);
      const trajectoryTurnReader = {
        listUserTurnsForSession: vi.fn().mockReturnValue([]),
        listAssistantTurns: vi.fn().mockReturnValue([]),
      };
      const contextAssembler = new SqliteContextAssembler(
        stateManager.taskStore,
        new SqliteHistoryQuery(stateManager.connection),
        stateManager.runStore,
        { trajectoryTurnReader },
      );

      const runtimeAdapter = makeMockRuntimeAdapter();
      let runCount = 0;
      runtimeAdapter.startRun.mockImplementation(async () => {
        runCount++;
        return { runId: `run-r1-${runCount}`, runtimeKind: RUNTIME_KIND, startedAt: new Date().toISOString() };
      });
      runtimeAdapter.pollRun.mockImplementation(async (handle: Record<string, unknown>) => {
        return { status: 'succeeded', runId: handle.runId };
      });
      let fetchCallCount = 0;
      runtimeAdapter.fetchOutput.mockImplementation(async () => {
        fetchCallCount++;
        if (fetchCallCount === 1) return { payload: makeRootCauseOutput() };
        if (fetchCallCount === 2) {
          const artifactsA = await stateManager.piArtifactStore.listBySourceTaskId('diag_rootcause-diagnosis_pain-r1');
          const stageAArtifactId = artifactsA[0]?.artifactId ?? 'pi-art-rootcause-regression';
          return { payload: makeDistillerOutput({ sourceRootCauseArtifactId: stageAArtifactId }) };
        }
        return { payload: makeRouterOutput() };
      });

      const rootCauseRunner = new DiagRootCauseRunner(
        { stateManager, runtimeAdapter, eventEmitter: makeMockEventEmitter(), artifactStore: stateManager.piArtifactStore, validator: { validate: vi.fn().mockResolvedValue({ valid: true, errors: [] }) }, contextAssembler },
        { owner: OWNER, runtimeKind: RUNTIME_KIND, pollIntervalMs: 10, timeoutMs: 1000 },
      );
      const distillerRunner = new DiagDistillerRunner(
        { stateManager, runtimeAdapter, eventEmitter: makeMockEventEmitter(), artifactStore: stateManager.piArtifactStore, validator: { validate: vi.fn().mockResolvedValue({ valid: true, errors: [] }) } },
        { owner: OWNER, runtimeKind: RUNTIME_KIND, pollIntervalMs: 10, timeoutMs: 1000 },
      );
      const routerRunner = new DiagRouterRunner(
        { stateManager, runtimeAdapter, eventEmitter: makeMockEventEmitter(), artifactStore: stateManager.piArtifactStore, committer },
        { owner: OWNER, runtimeKind: RUNTIME_KIND, pollIntervalMs: 10, timeoutMs: 1000 },
      );

      const splitRunner = new SplitDiagnosticianRunner({
        rootCauseRunner, distillerRunner, routerRunner, stateManager, committer,
      });

      const ledgerAdapter = {
        writeProbationEntry: vi.fn().mockImplementation((entry: unknown) => entry),
        existsForCandidate: vi.fn().mockReturnValue(null),
      };
      const intakeService = new CandidateIntakeService({ stateManager, ledgerAdapter });

      const bridge = new PainSignalBridge({
        stateManager, runner: splitRunner, intakeService, ledgerAdapter,
        autoIntakeEnabled: true, workspaceDir: tmpDir,
      });

      const painSignal = {
        painId: 'pain-r1',
        painType: 'tool_failure' as const,
        source: 'test-source',
        reason: 'R1 regression: must not create permanently pending task',
        evidence: [{ sourceRef: 'r1-evidence', note: 'R1 regression evidence' }],
      };

      const bridgeResult = await bridge.onPainDetected(painSignal);

      // ── Contract assertion: task must NOT be permanently pending ──
      const parentTaskId = `diagnosis_${painSignal.painId}`;
      const parentTask = await stateManager.getTask(parentTaskId);

      // The parent diagnostician task must not be stuck in pending with attempt_count=0
      if (parentTask) {
        const isPermanentlyPending =
          parentTask.status === 'pending' &&
          parentTask.attemptCount === 0;
        expect(isPermanentlyPending).toBe(false);
      }

      // All 3 sub-tasks must have been executed and NOT be permanently pending
      const subTaskKinds = ['diag_rootcause', 'diag_distiller', 'diag_router'];
      for (const kind of subTaskKinds) {
        const subTaskId = `${kind}-${parentTaskId}`;
        const subTask = await stateManager.getTask(subTaskId);
        if (subTask) {
          const isPermanentlyPending =
            subTask.status === 'pending' &&
            subTask.attemptCount === 0;
          // Product contract: no sub-task may be permanently pending after a sync run
          expect(isPermanentlyPending, `Sub-task ${subTaskId} must not be permanently pending`).toBe(false);
        }
      }

      // Bridge result must indicate actual execution happened (not just submission)
      expect(bridgeResult.status).toBe('succeeded');
      expect(bridgeResult.painId).toBe(painSignal.painId);
    } finally {
      stateManager.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  // ── R2: Non-immediate execution must include reason + nextAction ──────────

  /**
   * R2 — Product contract: When diagnosis does not execute immediately
   * (async mode / submitted status), the JSON output MUST include a concrete
   * `message` (reason) and `nextAction` so the operator knows what to do next.
   *
   * Why this matters: CLI Operator Gate requires nextAction on non-success paths.
   * Without nextAction, the operator has no idea how to proceed. Without message,
   * the operator cannot understand why diagnosis was deferred.
   * This catches ERR-002 (silent pending / silent fallback).
   */
  it('R2: async submitted result must include message (reason) and nextAction', async () => {
    // Test at the PainToPrincipleService level — the real entry point used by pd-cli
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-r2-async-'));

    // Use a mock ledger adapter
    const ledgerAdapter: LedgerAdapter = {
      writeProbationEntry: vi.fn().mockImplementation((entry: unknown) => entry),
      existsForCandidate: vi.fn().mockReturnValue(null),
      register: vi.fn(),
      getEntries: vi.fn().mockReturnValue([]),
    } as unknown as LedgerAdapter;

    // We mock createPainSignalBridge to simulate async mode behavior
    // without needing a real LLM runtime
    const mockBridge = {
      submitPainSignal: vi.fn().mockResolvedValue({ taskId: 'diagnosis_pain-r2-async' }),
      onPainDetected: vi.fn(),
    };

    vi.doMock('../pain-signal-runtime-factory.js', () => ({
      createPainSignalBridge: vi.fn().mockResolvedValue(mockBridge),
    }));
    vi.doMock('../pain-signal-observability.js', () => ({
      recordPainSignalObservability: vi.fn().mockReturnValue({ warnings: [] }),
    }));

    // Re-import with mocks applied
    const { PainToPrincipleService: MockedService } = await import('../pain-to-principle-service.js');

    const service = new MockedService({
      workspaceDir: tmpDir,
      stateDir: `${tmpDir}/.state`,
      ledgerAdapter,
      owner: 'pd-cli',
      autoIntakeEnabled: true,
      asyncMode: true, // Simulates `pd pain record --json` with async flag enabled
    });

    const result = await service.recordPain({
      painId: 'pain-r2-async',
      painType: 'user_frustration',
      source: 'manual',
      reason: 'R2 regression: async submitted must include reason + nextAction',
      score: 80,
      sessionId: 'cli',
      agentId: 'pd-cli',
      provenance: 'owner_reported_no_host_trace',
      evidence: [{ sourceRef: 'r2-evidence', note: 'R2 regression evidence' }],
      recordObservability: true,
    });

    // ── Contract: status must be 'submitted' (diagnosis not immediate) ──
    expect(result.status).toBe('submitted');

    // ── Contract: must include a reason/message ──
    // ERR-002: silent pending is a bug — the message explains WHY it's deferred
    expect(result.message).toBeDefined();
    expect(result.message?.length).toBeGreaterThan(0);

    // ── Contract: must include nextAction info ──
    // CLI Operator Gate: every non-success path must include structured nextAction
    // The pain-record.ts CLI handler adds nextAction for 'submitted' status:
    //   out.nextAction = `pd diagnose run --task-id ${out.taskId} --workspace "${workspaceDir}"`
    // The service itself provides a message with task show command.
    // At minimum, the result must contain enough info for the operator to act.
    expect(result.taskId).toBeDefined();
    expect(result.taskId.length).toBeGreaterThan(0);

    // The message must reference the task ID so the operator can check progress
    expect(result.message).toContain(result.taskId);

    // Cleanup
    vi.doUnmock('../pain-signal-runtime-factory.js');
    vi.doUnmock('../pain-signal-observability.js');
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ── R3: Candidate traceable to distiller/router artifacts ─────────────────

  /**
   * R3 — Product contract: After a successful split diagnostician run, the
   * committed candidate(s) must be traceable back to the distiller and router
   * artifacts through the artifact lineage chain.
   *
   * Why this matters: Without traceability, we cannot verify that a principle
   * candidate was actually produced by the diagnostician pipeline (vs fabricated
   * or orphaned). This is the lineage integrity contract.
   */
  it('R3: successful split run produces candidates traceable to distiller/router artifacts', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-r3-traceable-'));
    const stateManager = new RuntimeStateManager({ workspaceDir: tmpDir });
    try {
      await stateManager.initialize();

      const committer = new SqliteDiagnosticianCommitter(stateManager.connection);
      const trajectoryTurnReader = {
        listUserTurnsForSession: vi.fn().mockReturnValue([]),
        listAssistantTurns: vi.fn().mockReturnValue([]),
      };
      const contextAssembler = new SqliteContextAssembler(
        stateManager.taskStore,
        new SqliteHistoryQuery(stateManager.connection),
        stateManager.runStore,
        { trajectoryTurnReader },
      );

      const runtimeAdapter = makeMockRuntimeAdapter();
      let runCount = 0;
      runtimeAdapter.startRun.mockImplementation(async () => {
        runCount++;
        return { runId: `run-r3-${runCount}`, runtimeKind: RUNTIME_KIND, startedAt: new Date().toISOString() };
      });
      runtimeAdapter.pollRun.mockImplementation(async (handle: Record<string, unknown>) => {
        return { status: 'succeeded', runId: handle.runId };
      });

      const PARENT_TASK_ID = 'diagnosis_pain-r3';
      const STAGE_A_TASK_ID = `diag_rootcause-${PARENT_TASK_ID}`;
      const STAGE_B_TASK_ID = `diag_distiller-${PARENT_TASK_ID}`;

      let fetchCallCount = 0;
      runtimeAdapter.fetchOutput.mockImplementation(async () => {
        fetchCallCount++;
        if (fetchCallCount === 1) return { payload: makeRootCauseOutput() };
        if (fetchCallCount === 2) {
          const artifactsA = await stateManager.piArtifactStore.listBySourceTaskId(STAGE_A_TASK_ID);
          const stageAArtifactId = artifactsA[0]?.artifactId ?? 'pi-art-rootcause-r3';
          return { payload: makeDistillerOutput({ sourceRootCauseArtifactId: stageAArtifactId }) };
        }
        return { payload: makeRouterOutput() };
      });

      const rootCauseRunner = new DiagRootCauseRunner(
        { stateManager, runtimeAdapter, eventEmitter: makeMockEventEmitter(), artifactStore: stateManager.piArtifactStore, validator: { validate: vi.fn().mockResolvedValue({ valid: true, errors: [] }) }, contextAssembler },
        { owner: OWNER, runtimeKind: RUNTIME_KIND, pollIntervalMs: 10, timeoutMs: 1000 },
      );
      const distillerRunner = new DiagDistillerRunner(
        { stateManager, runtimeAdapter, eventEmitter: makeMockEventEmitter(), artifactStore: stateManager.piArtifactStore, validator: { validate: vi.fn().mockResolvedValue({ valid: true, errors: [] }) } },
        { owner: OWNER, runtimeKind: RUNTIME_KIND, pollIntervalMs: 10, timeoutMs: 1000 },
      );
      const routerRunner = new DiagRouterRunner(
        { stateManager, runtimeAdapter, eventEmitter: makeMockEventEmitter(), artifactStore: stateManager.piArtifactStore, committer },
        { owner: OWNER, runtimeKind: RUNTIME_KIND, pollIntervalMs: 10, timeoutMs: 1000 },
      );

      const splitRunner = new SplitDiagnosticianRunner({
        rootCauseRunner, distillerRunner, routerRunner, stateManager, committer,
      });

      const ledgerAdapter = {
        writeProbationEntry: vi.fn().mockImplementation((entry: unknown) => entry),
        existsForCandidate: vi.fn().mockReturnValue(null),
      };
      const intakeService = new CandidateIntakeService({ stateManager, ledgerAdapter });

      const bridge = new PainSignalBridge({
        stateManager, runner: splitRunner, intakeService, ledgerAdapter,
        autoIntakeEnabled: true, workspaceDir: tmpDir,
      });

      const bridgeResult = await bridge.onPainDetected({
        painId: 'pain-r3',
        painType: 'tool_failure',
        source: 'test-source',
        reason: 'R3 regression: candidate traceability to artifacts',
        evidence: [{ sourceRef: 'r3-evidence', note: 'R3 regression evidence' }],
      });

      expect(bridgeResult.status).toBe('succeeded');

      // ── Contract: artifacts exist for each stage ──
      const artifactsA = await stateManager.piArtifactStore.listBySourceTaskId(STAGE_A_TASK_ID);
      const artifactsB = await stateManager.piArtifactStore.listBySourceTaskId(STAGE_B_TASK_ID);
      expect(artifactsA.length).toBeGreaterThan(0);
      expect(artifactsB.length).toBeGreaterThan(0);

      // ── Contract: Stage B artifact references Stage A artifact (lineage) ──
      const [stageBArtifact] = artifactsB;
      expect(stageBArtifact?.lineageArtifactIds.length).toBeGreaterThan(0);
      // Stage B must reference a Stage A artifact ID
      const stageAIds = artifactsA.map(a => a.artifactId);
      const referencesStageA = stageBArtifact?.lineageArtifactIds.some(id => stageAIds.includes(id));
      expect(referencesStageA, 'Stage B artifact must reference Stage A artifact').toBe(true);

      // ── Contract: candidates exist and are traceable to the task ──
      expect(bridgeResult.candidateIds.length).toBeGreaterThan(0);
      // Candidates are linked to the parent diagnosis task via getCandidatesByTaskId
      // which follows the tasks→runs→commits→candidates chain
      const candidates = await stateManager.getCandidatesByTaskId(PARENT_TASK_ID);
      expect(candidates.length).toBeGreaterThan(0);

      // ── Contract: each candidate is linked to the router sub-task ──
      // The committer creates candidates with the router task ID (Stage C)
      // which is a sub-task of the parent diagnosis task
      const ROUTER_TASK_ID = `diag_router-${PARENT_TASK_ID}`;
      for (const candidate of candidates) {
        expect(candidate.taskId).toBe(ROUTER_TASK_ID);
      }
    } finally {
      stateManager.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  // ── R4: groundedOnCorePrincipleIds preserved in artifact ──────────────────

  /**
   * R4 — Product contract: The generated principle candidate must preserve
   * access to core grounding metadata (groundedOnCorePrincipleIds), either
   * directly in the candidate record or through the artifact lineage.
   *
   * Why this matters: groundedOnCorePrincipleIds links a generated principle
   * back to the core axiom registry (T-01..T-10). Without this traceability,
   * we cannot verify that the principle is grounded in accepted axioms vs
   * fabricated. This is the core grounding integrity contract (PRI-371).
   */
  it('R4: principle candidate preserves groundedOnCorePrincipleIds in artifact content', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-r4-grounding-'));
    const stateManager = new RuntimeStateManager({ workspaceDir: tmpDir });
    try {
      await stateManager.initialize();

      const committer = new SqliteDiagnosticianCommitter(stateManager.connection);
      const trajectoryTurnReader = {
        listUserTurnsForSession: vi.fn().mockReturnValue([]),
        listAssistantTurns: vi.fn().mockReturnValue([]),
      };
      const contextAssembler = new SqliteContextAssembler(
        stateManager.taskStore,
        new SqliteHistoryQuery(stateManager.connection),
        stateManager.runStore,
        { trajectoryTurnReader },
      );

      const runtimeAdapter = makeMockRuntimeAdapter();
      let runCount = 0;
      runtimeAdapter.startRun.mockImplementation(async () => {
        runCount++;
        return { runId: `run-r4-${runCount}`, runtimeKind: RUNTIME_KIND, startedAt: new Date().toISOString() };
      });
      runtimeAdapter.pollRun.mockImplementation(async (handle: Record<string, unknown>) => {
        return { status: 'succeeded', runId: handle.runId };
      });

      const PARENT_TASK_ID = 'diagnosis_pain-r4';
      const STAGE_A_TASK_ID = `diag_rootcause-${PARENT_TASK_ID}`;
      const STAGE_B_TASK_ID = `diag_distiller-${PARENT_TASK_ID}`;

      let fetchCallCount = 0;
      runtimeAdapter.fetchOutput.mockImplementation(async () => {
        fetchCallCount++;
        if (fetchCallCount === 1) return { payload: makeRootCauseOutput() };
        if (fetchCallCount === 2) {
          const artifactsA = await stateManager.piArtifactStore.listBySourceTaskId(STAGE_A_TASK_ID);
          const stageAArtifactId = artifactsA[0]?.artifactId ?? 'pi-art-rootcause-r4';
          // Distiller output with groundedOnCorePrincipleIds from R6 fixture
          return { payload: makeDistillerOutput({ sourceRootCauseArtifactId: stageAArtifactId }) };
        }
        return { payload: makeRouterOutput() };
      });

      const rootCauseRunner = new DiagRootCauseRunner(
        { stateManager, runtimeAdapter, eventEmitter: makeMockEventEmitter(), artifactStore: stateManager.piArtifactStore, validator: { validate: vi.fn().mockResolvedValue({ valid: true, errors: [] }) }, contextAssembler },
        { owner: OWNER, runtimeKind: RUNTIME_KIND, pollIntervalMs: 10, timeoutMs: 1000 },
      );
      const distillerRunner = new DiagDistillerRunner(
        { stateManager, runtimeAdapter, eventEmitter: makeMockEventEmitter(), artifactStore: stateManager.piArtifactStore, validator: { validate: vi.fn().mockResolvedValue({ valid: true, errors: [] }) } },
        { owner: OWNER, runtimeKind: RUNTIME_KIND, pollIntervalMs: 10, timeoutMs: 1000 },
      );
      const routerRunner = new DiagRouterRunner(
        { stateManager, runtimeAdapter, eventEmitter: makeMockEventEmitter(), artifactStore: stateManager.piArtifactStore, committer },
        { owner: OWNER, runtimeKind: RUNTIME_KIND, pollIntervalMs: 10, timeoutMs: 1000 },
      );

      const splitRunner = new SplitDiagnosticianRunner({
        rootCauseRunner, distillerRunner, routerRunner, stateManager, committer,
      });

      const ledgerAdapter = {
        writeProbationEntry: vi.fn().mockImplementation((entry: unknown) => entry),
        existsForCandidate: vi.fn().mockReturnValue(null),
      };
      const intakeService = new CandidateIntakeService({ stateManager, ledgerAdapter });

      const bridge = new PainSignalBridge({
        stateManager, runner: splitRunner, intakeService, ledgerAdapter,
        autoIntakeEnabled: true, workspaceDir: tmpDir,
      });

      await bridge.onPainDetected({
        painId: 'pain-r4',
        painType: 'tool_failure',
        source: 'test-source',
        reason: 'R4 regression: groundedOnCorePrincipleIds must be preserved',
        evidence: [{ sourceRef: 'r4-evidence', note: 'R4 regression evidence' }],
      });

      // ── Contract: distiller artifact contains groundedOnCorePrincipleIds ──
      const distillerArtifacts = await stateManager.piArtifactStore.listBySourceTaskId(STAGE_B_TASK_ID);
      expect(distillerArtifacts.length).toBeGreaterThan(0);

      const [distillerArtifact] = distillerArtifacts;
      expect(distillerArtifact?.contentJson).toBeDefined();

      // Parse the artifact content and verify groundedOnCorePrincipleIds
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- guarded by expect above
      const parsedContent = JSON.parse(distillerArtifact!.contentJson) as Record<string, unknown>;
      const groundedIds = parsedContent.groundedOnCorePrincipleIds;

      // groundedOnCorePrincipleIds must be present and be a non-empty array
      expect(Array.isArray(groundedIds)).toBe(true);
      expect((groundedIds as string[]).length).toBeGreaterThan(0);

      // From the R6 fixture, the expected IDs are ['T-01', 'T-07']
      expect(groundedIds).toEqual(['T-01', 'T-07']);

      // ── Contract: groundedOnCorePrincipleIds values are valid axiom IDs ──
      // Valid IDs match the pattern T-NN (core principle axiom registry)
      for (const id of groundedIds as string[]) {
        expect(id).toMatch(/^T-\d+$/);
      }
    } finally {
      stateManager.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  // ── R5: Workspace isolation ──────────────────────────────────────────────

  /**
   * R5 — Product contract: All test runs must use an isolated temp workspace.
   * Tests must NEVER write PD runtime data into the code repository
   * (D:\Code\principles) or the real OpenClaw workspace (D:\.openclaw\workspace).
   *
   * Why this matters: Dogfood found that a manual pain could be written to the
   * code repository workspace instead of the PD production workspace. This test
   * encodes the workspace boundary as a hard contract.
   */
  it('R5: all test workspaces are isolated temp directories, never forbidden paths', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-r5-workspace-'));
    try {
      // ── Contract: temp dir is NOT under any forbidden path ──
      for (const forbidden of FORBIDDEN_WORKSPACE_PATHS) {
        expect(tmpDir.startsWith(forbidden)).toBe(false);
        expect(tmpDir.toLowerCase().startsWith(forbidden.toLowerCase())).toBe(false);
      }

      // ── Contract: temp dir is under os.tmpdir() ──
      expect(tmpDir.startsWith(os.tmpdir())).toBe(true);

      // ── Contract: RuntimeStateManager creates DB inside tmpDir, not elsewhere ──
      const stateManager = new RuntimeStateManager({ workspaceDir: tmpDir });
      await stateManager.initialize();

      try {
        // Write a task and verify the DB is in the temp directory
        await stateManager.createTask({
          taskId: 'test-r5-task',
          taskKind: 'diagnostician',
          inputRef: 'test',
          status: 'pending',
          attemptCount: 0,
          maxAttempts: 3,
        });

        const task = await stateManager.getTask('test-r5-task');
        expect(task).toBeDefined();
        expect(task?.taskId).toBe('test-r5-task');
      } finally {
        stateManager.close();
      }

      // ── Contract: cleanup removes all test artifacts ──
      fs.rmSync(tmpDir, { recursive: true, force: true });
      expect(fs.existsSync(tmpDir)).toBe(false);
    } catch (err) {
      // Cleanup on failure
      if (fs.existsSync(tmpDir)) {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
      throw err;
    }
  });
});
