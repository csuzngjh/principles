import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  RuntimeStateManager,
  SqliteDiagnosticianCommitter,
  assertMainlineContract,
  buildDreamerSeedFromCandidate,
  DreamerRunner,
  PassThroughDreamerValidator,
  parsePITaskMetadata,
} from '../index.js';
import type {
  DiagnosticianOutputV1,
  MainlineSnapshot,
  RuntimeReadinessSnapshot,
  PDRuntimeAdapter,
  StoreEventEmitter,
  PIArtifactStore,
  PeerRunnerOptions,
} from '../index.js';

/**
 * Mainline product-path test — THE LOAD-BEARING WALL of the convergence sprint.
 *
 * Goal: one default-run (NO real LLM) test that drives the REAL production path
 *
 *   pain row
 *     -> diagnosis task + diagnostician artifact (stub runtime output)
 *     -> candidate (via CandidateIntakeService)
 *     -> dreamer task (via the REAL intake-to-internalization bridge / `pd candidate internalize`)
 *     -> dreamer context (via the REAL DreamerRunner.buildContext)
 *   then assembles a MainlineSnapshot from the live SQLite state and asserts
 *   `assertMainlineContract(...).overall === 'ok'`.
 *
 * Why `it.todo` for now: the live assertions are RED until the convergence work
 * lands. Per EP-09 (Test Reality Gap) we do NOT fake a pass — these stay as
 * explicit todos so CI is green but the contract is documented and ungameable.
 * Each `it.todo` becomes a real `it(...)` as its dependency merges.
 *
 * Implementation order this test gates (see convergence plan):
 *   PRI-C  unify runtime config resolver  -> readiness.config_source_alignment ok
 *   PRI-A  this file + assertMainlineContract (DONE: validator + unit tests)
 *   PRI-B  candidate->dreamer lineage fix  -> dreamer_task_lineage + dreamer_context ok
 *   PRI-D  integrity-repair completeness   -> diagnosis_task / auto_consumption ok on real workspace
 *
 * Hard rules for the eventual implementation:
 *   - Use a real SqliteStateManager against a temp workspace (NOT createMockStateManager).
 *   - Seed the diagnostician artifact via a STUB runtime adapter, not a real LLM,
 *     so this runs on every CI. (Real-LLM coverage stays in *-real-llm.test.ts.)
 *   - Create the dreamer task through `seedIntakeTask` / `handleCandidateInternalize`,
 *     never by hand-writing dependencyTaskIds (that is what full-chain-real-llm.test.ts
 *     does and why it never caught the severed-lineage bug).
 *   - Assemble the snapshot with the shared reader in
 *     `packages/pd-cli/src/services/mainline-snapshot-assembler.ts` (or equivalent
 *     I/O-boundary reader) so integrity/smoke/Console share one source of truth.
 */

function createTempWorkspace(): string {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pri-394-product-path-'));
  return tmpDir;
}

function removeTempWorkspace(dir: string): void {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
}

function alignedReadiness(): RuntimeReadinessSnapshot {
  return {
    configDoctorProfile: 'openclaw.default',
    runtimeProbeProfile: 'openclaw.default',
    configSource: '.pd/config.yaml',
    probeConfigSource: '.pd/config.yaml',
    diagnosticianReady: true,
  };
}

function diagnosticianDiagnosticJson(painId: string): string {
  return JSON.stringify({
    sourcePainId: painId,
    reasonSummary: 'Repeated edits without reading instructions first',
    source: 'test',
    severity: 'high',
    sessionIdHint: null,
    agentIdHint: null,
    provenance: 'automatic_hook',
    provenanceReason: 'automatic hook',
    evidence: [{ sourceRef: 'session://test', note: 'edited README before reading' }],
    workspaceDir: null,
  });
}

function validDiagnosticianOutput(painId: string): DiagnosticianOutputV1 {
  return {
    valid: true,
    diagnosisId: `diag-${painId}`,
    summary: 'Repeated edits without reading instructions first',
    rootCause: 'Assumption: agent assumes it knows the workspace conventions',
    violatedPrinciples: [],
    evidence: [{ sourceRef: 'session://test', note: 'edited README before reading' }],
    recommendations: [{
      kind: 'principle',
      description: 'Read AGENTS.md and PLAN.md before editing protected files',
      abstractedPrinciple: 'Read workspace instructions before protected edits',
    }],
    confidence: 0.9,
  };
}

async function seedDiagnosisToCandidate(
  sm: RuntimeStateManager,
  painId: string,
): Promise<{ taskId: string; candidateId: string }> {
  const taskId = `diagnostician-${painId}`;
  await sm.createTask({
    taskId,
    taskKind: 'diagnostician',
    inputRef: painId,
    status: 'pending',
    attemptCount: 0,
    maxAttempts: 3,
    diagnosticJson: diagnosticianDiagnosticJson(painId),
  });

  const committer = new SqliteDiagnosticianCommitter(sm.connection);
  await sm.acquireLease({ taskId, owner: 'test-owner', durationMs: 60_000, runtimeKind: 'openclaw' });
  const runs = await sm.getRunsByTask(taskId);
  const runId = runs[0]?.runId;
  if (!runId) throw new Error(`No run created for task ${taskId}`);

  const commitResult = await committer.commit({
    runId,
    taskId,
    output: validDiagnosticianOutput(painId),
    idempotencyKey: `idem-${taskId}`,
  });
  await sm.markTaskSucceeded(taskId, `artifact://${commitResult.artifactId}`);

  const candidates = await sm.getCandidatesByTaskId(taskId);
  const [candidate] = candidates;
  if (!candidate) throw new Error('No candidate produced by diagnostician committer');
  return { taskId, candidateId: candidate.candidateId };
}

describe('mainline product-path (load-bearing wall)', () => {
  let workspaceDir = '';
  let sm: RuntimeStateManager;

  beforeEach(() => {
    workspaceDir = createTempWorkspace();
    sm = new RuntimeStateManager({ workspaceDir });
  });

  afterEach(async () => {
    try { await sm.close(); } catch { /* ignore */ }
    removeTempWorkspace(workspaceDir);
  });

  it.todo('PRI-C: config doctor and probe resolve the same profile from .pd/config.yaml');

  it.todo('seeds a real pain row and runs the diagnostician via a stub runtime adapter');

  it.todo('intake produces a candidate carrying sourceTaskId/sourceArtifactId/sourceRunId lineage');

  // ── PRI-B: candidate → dreamer lineage preservation ──────────────────────────

  it('PRI-B: buildDreamerSeedFromCandidate preserves diagnosis taskId and artifact in dreamer seed', async () => {
    await sm.initialize();
    const painId = 'pain-pri-b-001';
    const { taskId: diagTaskId, candidateId } = await seedDiagnosisToCandidate(sm, painId);

    const candidate = await sm.getCandidate(candidateId);
    expect(candidate).not.toBeNull();
    if (!candidate) throw new Error('Candidate not found');

    // Exercise the REAL factory — NOT a hand-written dependencyTaskIds array
    const seed = buildDreamerSeedFromCandidate(candidate, { route: 'principle-ledger', ready: true });
    expect('decision' in seed).toBe(false);
    if ('decision' in seed) throw new Error(`Unexpected decision: ${(seed as { decision: string }).decision}`);

    // Verify the PI metadata carries real lineage
    const meta = parsePITaskMetadata(seed.diagnosticJson);
    expect(meta).not.toBeNull();
    if (meta) {
      expect(meta.dependencyTaskIds).toContain(diagTaskId);
      expect(meta.dependencyTaskIds.length).toBe(1);
      expect(meta.inputArtifactRefs.length).toBeGreaterThanOrEqual(2);
      expect(meta.inputArtifactRefs.some((a) => a.artifactType === 'candidate')).toBe(true);
      expect(meta.inputArtifactRefs.some((a) => a.artifactType === 'diagnostician_output')).toBe(true);
      expect(meta.inputArtifactRefs.some((a) => a.ref.includes(candidate.artifactId))).toBe(true);
    }

    // Top-level diagObj has both candidateId and sourceTaskId
    const diagObj = JSON.parse(seed.diagnosticJson);
    expect(diagObj.candidateId).toBe(candidateId);
    expect(diagObj.sourceTaskId).toBe(diagTaskId);
    expect(diagObj.sourceArtifactId).toBe(candidate.artifactId);

    // Now persist the dreamer task through the REAL createTask path
    const taskRecord = await sm.createTask({
      taskId: seed.taskId,
      taskKind: seed.taskKind,
      status: seed.status,
      attemptCount: seed.attemptCount,
      maxAttempts: seed.maxAttempts,
      diagnosticJson: seed.diagnosticJson,
    });
    expect(taskRecord.taskId).toBe(seed.taskId);

    // Read back — verify the task's diagnosticJson is stored and hydratable
    const storedTask = await sm.getTask(seed.taskId);
    expect(storedTask).not.toBeNull();
    if (storedTask) {
      const storedMeta = parsePITaskMetadata(storedTask.diagnosticJson || '');
      expect(storedMeta).not.toBeNull();
      if (storedMeta) {
        expect(storedMeta.dependencyTaskIds).toContain(diagTaskId);
      }
    }
  });

  it('PRI-B: DreamerRunner.buildContext returns non-empty context for seeded dreamer task', async () => {
    await sm.initialize();
    const painId = 'pain-pri-b-002';
    const { candidateId } = await seedDiagnosisToCandidate(sm, painId);

    const candidate = await sm.getCandidate(candidateId);
    if (!candidate) throw new Error('Candidate not found');

    // Seed dreamer through factory
    const seed = buildDreamerSeedFromCandidate(candidate, { route: 'principle-ledger', ready: true });
    if ('decision' in seed) throw new Error(`Unexpected decision: ${(seed as { decision: string }).decision}`);
    await sm.createTask({
      taskId: seed.taskId,
      taskKind: seed.taskKind,
      status: seed.status,
      attemptCount: seed.attemptCount,
      maxAttempts: seed.maxAttempts,
      diagnosticJson: seed.diagnosticJson,
    });

    // Minimal mock deps — only stateManager matters for buildContext
    const mockRuntimeAdapter = {
      startRun: () => Promise.reject(new Error('not needed')),
      pollRun: () => Promise.reject(new Error('not needed')),
      cancelRun: () => Promise.reject(new Error('not needed')),
      fetchOutput: () => Promise.reject(new Error('not needed')),
      kind: () => 'test-double',
    };
    const mockEventEmitter = {
      // eslint-disable-next-line @typescript-eslint/no-empty-function
      emitTelemetry: () => {},
    } as unknown as StoreEventEmitter;
    const mockArtifactStore: PIArtifactStore = {
      listBySourceTaskId: async () => [],
      createArtifact: () => Promise.reject(new Error('not needed')),
      upsertArtifact: () => Promise.reject(new Error('not needed')),
      getArtifactById: () => Promise.resolve(null),
      listLineage: () => Promise.resolve([]),
      updateValidationStatus: () => Promise.resolve(false),
    };

    const runner = new DreamerRunner(
      {
        stateManager: sm,
        runtimeAdapter: mockRuntimeAdapter as unknown as PDRuntimeAdapter,
        eventEmitter: mockEventEmitter,
        artifactStore: mockArtifactStore,
        validator: new PassThroughDreamerValidator(),
      },
      { owner: 'test', runtimeKind: 'test-double' } as PeerRunnerOptions,
    );

    const context = await runner.buildContext(seed.taskId);

    // The core assertions — lineage must flow into context
    expect(context.contextHash, 'contextHash must not be "empty" (lineage present)')
      .not.toBe('empty');
    expect(context.contextRefs.length, 'contextRefs must be > 0 (diagnostician artifact)')
      .toBeGreaterThan(0);
  });

  it.todo(
    'shared reader + assertMainlineContract → overall "ok" ' +
      'with zero violations across all stages',
  );

  it('a consumed candidate left without a dreamer task makes the contract report auto_consumption violation', async () => {
    await sm.initialize();
    const painId = 'pain-auto-consumption';
    const { candidateId } = await seedDiagnosisToCandidate(sm, painId);
    await sm.updateCandidateStatus(candidateId, { status: 'consumed' });

    const snapshot: MainlineSnapshot = {
      readiness: alignedReadiness(),
      chain: {
        painId,
        diagnosisTask: null,
        diagnosticianArtifact: null,
        candidate: null,
        dreamerTask: null,
        dreamerContext: null,
        successor: null,
        principle: null,
      },
      consumedCandidatesMissingDreamer: [candidateId],
    };

    const verdict = assertMainlineContract(snapshot);
    expect(verdict.stages.some((s) => s.stage === 'auto_consumption' && s.status === 'violation')).toBe(true);
    const autoConsumption = verdict.stages.find((s) => s.stage === 'auto_consumption');
    expect(autoConsumption?.reason).toContain(candidateId);
    expect(autoConsumption?.nextAction).toBeTruthy();
  });
});
