import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  RuntimeStateManager,
  SqliteDiagnosticianCommitter,
  assertMainlineContract,
} from '../index.js';
import type {
  DiagnosticianOutputV1,
  MainlineSnapshot,
  RuntimeReadinessSnapshot,
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

  it.todo(
    'PRI-B: pd candidate internalize seeds a dreamer task whose dependencyTaskIds ' +
      'includes the diagnosis task and whose inputArtifactRefs reference the diagnostician artifact',
  );

  it.todo('PRI-B: DreamerRunner.buildContext returns contextRefs.length > 0 and contextHash !== "empty"');

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
