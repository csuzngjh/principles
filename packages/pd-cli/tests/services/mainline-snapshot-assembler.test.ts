/**
 * MainlineSnapshot assembler tests (PRI-394)
 *
 * These tests seed real SQLite temp workspaces through RuntimeStateManager and
 * the production DiagnosticianCommitter, then call `assembleMainlineSnapshot`
 * and judge the result with core's `assertMainlineContract`.
 *
 * Hard rule: no hand-filled snapshots. Every test exercises the real read path.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  RuntimeStateManager,
  SqliteDiagnosticianCommitter,
  serializePITaskMetadata,
  assertMainlineContract,
  EMPTY_CONTEXT_SENTINEL,
} from '@principles/core/runtime-v2';
import type {
  DiagnosticianOutputV1,
  RuntimeReadinessSnapshot,
} from '@principles/core/runtime-v2';
import { assembleMainlineSnapshot } from '../../src/services/mainline-snapshot-assembler.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

function mkTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'pri-394-assembler-test-'));
}

function rmTmpDir(dir: string): void {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
}

function healthyReadiness(): RuntimeReadinessSnapshot {
  return {
    configDoctorProfile: 'openclaw.default',
    runtimeProbeProfile: 'openclaw.default',
    configSource: '.pd/config.yaml',
    probeConfigSource: '.pd/config.yaml',
    diagnosticianReady: true,
  };
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

async function seedDiagnosisTask(sm: RuntimeStateManager, painId: string): Promise<string> {
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
  return taskId;
}

async function runDiagnosisToSucceeded(
  sm: RuntimeStateManager,
  taskId: string,
  output: DiagnosticianOutputV1,
): Promise<{ runId: string; artifactId: string }> {
  const committer = new SqliteDiagnosticianCommitter(sm.connection);
  await sm.acquireLease({ taskId, owner: 'test-owner', durationMs: 60_000, runtimeKind: 'openclaw' });
  const runs = await sm.getRunsByTask(taskId);
  const runId = runs[0]?.runId;
  if (!runId) throw new Error(`No run created for task ${taskId}`);
  const commitResult = await committer.commit({
    runId,
    taskId,
    output,
    idempotencyKey: `idem-${taskId}`,
  });
  await sm.markTaskSucceeded(taskId, `artifact://${commitResult.artifactId}`);
  return { runId, artifactId: commitResult.artifactId };
}

async function seedDreamerTask(
  sm: RuntimeStateManager,
  candidateId: string,
  dependencyTaskId: string,
  inputArtifactRef: string,
): Promise<string> {
  const taskId = `dreamer-${candidateId}-prompt`;
  const piEnvelope = JSON.parse(serializePITaskMetadata({
    dependencyTaskIds: [dependencyTaskId],
    channel: 'prompt',
    timeoutMs: 300_000,
    inputArtifactRefs: [{ artifactType: 'diagnostician_output', ref: inputArtifactRef }],
    outputArtifactRefs: [],
  }));
  const diagnosticJson = JSON.stringify({ ...piEnvelope, candidateId });
  await sm.createTask({
    taskId,
    taskKind: 'dreamer',
    status: 'pending',
    attemptCount: 0,
    maxAttempts: 3,
    diagnosticJson,
  });
  return taskId;
}

async function seedPhilosopherTask(sm: RuntimeStateManager, dreamerTaskId: string): Promise<string> {
  const taskId = `philosopher-${dreamerTaskId}`;
  const diagnosticJson = serializePITaskMetadata({
    dependencyTaskIds: [dreamerTaskId],
    channel: 'prompt',
    timeoutMs: 300_000,
    inputArtifactRefs: [{ artifactType: 'principle', ref: `pi-artifact://${dreamerTaskId}` }],
    outputArtifactRefs: [],
  });
  await sm.createTask({
    taskId,
    taskKind: 'philosopher',
    status: 'pending',
    attemptCount: 0,
    maxAttempts: 3,
    diagnosticJson,
  });
  return taskId;
}

async function seedPhilosopherPiArtifact(
  sm: RuntimeStateManager,
  philosopherTaskId: string,
): Promise<void> {
  await sm.acquireLease({ taskId: philosopherTaskId, owner: 'test-owner', durationMs: 60_000, runtimeKind: 'openclaw' });
  const runs = await sm.getRunsByTask(philosopherTaskId);
  const runId = runs[0]?.runId;
  if (!runId) throw new Error(`No run created for task ${philosopherTaskId}`);
  await sm.piArtifactStore.upsertArtifact({
    artifactId: `pi-art-${philosopherTaskId}-${runId}`,
    artifactKind: 'principle',
    sourceTaskId: philosopherTaskId,
    lineageArtifactIds: [],
    validationStatus: 'pending',
    contentJson: JSON.stringify({
      principleCandidate: {
        principleId: `prin-${philosopherTaskId}`,
        title: 'Read workspace instructions first',
        confidence: 0.9,
      },
    }),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  await sm.markTaskSucceeded(philosopherTaskId, `pi-artifact://${philosopherTaskId}`);
}

async function seedFullChain(sm: RuntimeStateManager, painId: string): Promise<void> {
  const taskId = await seedDiagnosisTask(sm, painId);
  const { artifactId } = await runDiagnosisToSucceeded(sm, taskId, validDiagnosticianOutput(painId));
  const candidates = await sm.getCandidatesByTaskId(taskId);
  expect(candidates.length).toBeGreaterThan(0);
  const candidate = candidates[0];
  expect(candidate).toBeDefined();

  const dreamerTaskId = await seedDreamerTask(sm, candidate!.candidateId, taskId, `artifact://${artifactId}`);
  await sm.acquireLease({ taskId: dreamerTaskId, owner: 'test-owner', durationMs: 60_000, runtimeKind: 'openclaw' });
  await sm.markTaskSucceeded(dreamerTaskId, `dreamer://${dreamerTaskId}`);

  const philosopherTaskId = await seedPhilosopherTask(sm, dreamerTaskId);
  await seedPhilosopherPiArtifact(sm, philosopherTaskId);
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('assembleMainlineSnapshot', () => {
  let workspaceDir = '';
  let sm: RuntimeStateManager;

  beforeEach(() => {
    workspaceDir = mkTmpDir();
    sm = new RuntimeStateManager({ workspaceDir });
  });

  afterEach(async () => {
    try { await sm.close(); } catch { /* ignore */ }
    rmTmpDir(workspaceDir);
  });

  it('returns a snapshot with default readiness when no readiness snapshot is provided', async () => {
    await sm.initialize();
    const painId = 'pain-empty';
    await seedDiagnosisTask(sm, painId);

    const { snapshot, warnings } = await assembleMainlineSnapshot({ workspaceDir, painId });

    // Default config resolves a diagnostician profile, so readiness is "configured"
    // (actual connectivity is unknown without probe, but config alignment is satisfied)
    expect(snapshot.readiness.diagnosticianReady).toBe(true);
    expect(warnings.length).toBe(0);
    const verdict = assertMainlineContract(snapshot);
    // diagnosis_task should be a violation since the task has no succeeded run
    expect(verdict.stages.some((s) => s.stage === 'diagnosis_task' && s.status === 'violation')).toBe(true);
  });

  it('malformed artifact content_json does not crash; contract reports violation with reason + nextAction', async () => {
    await sm.initialize();
    const painId = 'pain-malformed-artifact';
    const taskId = await seedDiagnosisTask(sm, painId);
    await sm.acquireLease({ taskId, owner: 'test-owner', durationMs: 60_000, runtimeKind: 'openclaw' });
    const runs = await sm.getRunsByTask(taskId);
    const runId = runs[0]?.runId;
    if (!runId) throw new Error(`No run created for task ${taskId}`);
    await sm.markTaskSucceeded(taskId);

    // Directly insert an artifact with malformed content_json (bypasses committer validation).
    const artifactId = 'malformed-artifact-001';
    sm.connection.getDb().prepare(
      `INSERT INTO artifacts (artifact_id, run_id, task_id, artifact_kind, content_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(artifactId, runId, taskId, 'diagnostician_output', 'not-json{{{', new Date().toISOString());

    const { snapshot, warnings } = await assembleMainlineSnapshot({ workspaceDir, painId, readiness: healthyReadiness() });

    expect(warnings.some((w) => w.includes('malformed'))).toBe(true);
    const verdict = assertMainlineContract(snapshot);
    expect(verdict.overall).toBe('violation');
    const violationStages = verdict.stages.filter((s) => s.status === 'violation');
    expect(violationStages.length).toBeGreaterThan(0);
    for (const s of violationStages) {
      expect(s.reason.length).toBeGreaterThan(0);
      expect(s.nextAction && s.nextAction.length > 0).toBe(true);
    }
  });

  it('missing succeeded run reports diagnosis_task violation', async () => {
    await sm.initialize();
    const painId = 'pain-no-run';
    const taskId = await seedDiagnosisTask(sm, painId);
    // Task marked succeeded but no run exists.
    await sm.updateTask(taskId, { status: 'succeeded' });

    const { snapshot } = await assembleMainlineSnapshot({ workspaceDir, painId, readiness: healthyReadiness() });

    const verdict = assertMainlineContract(snapshot);
    expect(verdict.overall).toBe('violation');
    expect(verdict.stages.some((s) => s.stage === 'diagnosis_task' && s.status === 'violation')).toBe(true);
  });

  it('missing dreamer task reports dreamer_task_lineage violation', async () => {
    await sm.initialize();
    const painId = 'pain-no-dreamer';
    const taskId = await seedDiagnosisTask(sm, painId);
    await runDiagnosisToSucceeded(sm, taskId, validDiagnosticianOutput(painId));

    const { snapshot } = await assembleMainlineSnapshot({ workspaceDir, painId, readiness: healthyReadiness() });

    const verdict = assertMainlineContract(snapshot);
    expect(verdict.overall).toBe('violation');
    expect(verdict.stages.some((s) => s.stage === 'dreamer_task_lineage' && s.status === 'violation')).toBe(true);
  });

  it('empty dreamer context reports dreamer_context violation', async () => {
    await sm.initialize();
    const painId = 'pain-empty-context';
    const taskId = await seedDiagnosisTask(sm, painId);
    const { artifactId } = await runDiagnosisToSucceeded(sm, taskId, validDiagnosticianOutput(painId));
    const candidates = await sm.getCandidatesByTaskId(taskId);
    const candidate = candidates[0];
    expect(candidate).toBeDefined();

    // Sever the diagnosis task resultRef so the dreamer cannot build context,
    // while keeping lineage intact so dreamer_task_lineage passes.
    await sm.updateTask(taskId, { resultRef: null, outputRef: undefined });

    const dreamerTaskId = `dreamer-${candidate!.candidateId}-prompt`;
    const piEnvelope = JSON.parse(serializePITaskMetadata({
      dependencyTaskIds: [taskId],
      channel: 'prompt',
      timeoutMs: 300_000,
      inputArtifactRefs: [{ artifactType: 'diagnostician_output', ref: `artifact://${artifactId}` }],
      outputArtifactRefs: [],
    }));
    const diagnosticJson = JSON.stringify({ ...piEnvelope, candidateId: candidate!.candidateId });
    await sm.createTask({
      taskId: dreamerTaskId,
      taskKind: 'dreamer',
      status: 'pending',
      attemptCount: 0,
      maxAttempts: 3,
      diagnosticJson,
    });

    const { snapshot } = await assembleMainlineSnapshot({ workspaceDir, painId, readiness: healthyReadiness() });

    expect(snapshot.chain.dreamerContext?.contextHash).toBe(EMPTY_CONTEXT_SENTINEL);
    const verdict = assertMainlineContract(snapshot);
    expect(verdict.stages.some((s) => s.stage === 'dreamer_context' && s.status === 'violation')).toBe(true);
  });

  it('valid seeded temp SQLite product path generates snapshot that passes assertMainlineContract', async () => {
    await sm.initialize();
    const painId = 'pain-ok';
    await seedFullChain(sm, painId);

    const { snapshot, warnings } = await assembleMainlineSnapshot({ workspaceDir, painId, readiness: healthyReadiness() });

    expect(warnings).toEqual([]);
    expect(snapshot.chain.painId).toBe(painId);
    expect(snapshot.chain.diagnosisTask).not.toBeNull();
    expect(snapshot.chain.diagnosticianArtifact).not.toBeNull();
    expect(snapshot.chain.candidate).not.toBeNull();
    expect(snapshot.chain.dreamerTask).not.toBeNull();
    expect(snapshot.chain.dreamerContext).not.toBeNull();
    expect(snapshot.chain.successor).not.toBeNull();
    expect(snapshot.chain.principle).not.toBeNull();

    const verdict = assertMainlineContract(snapshot);
    expect(verdict.overall).toBe('ok');
    expect(verdict.stages.every((s) => s.status === 'ok')).toBe(true);
  });

  it('consumed candidate without dreamer task reports auto_consumption violation', async () => {
    await sm.initialize();
    const painId = 'pain-consumed-orphan';
    const taskId = await seedDiagnosisTask(sm, painId);
    await runDiagnosisToSucceeded(sm, taskId, validDiagnosticianOutput(painId));
    const candidates = await sm.getCandidatesByTaskId(taskId);
    const candidate = candidates[0];
    expect(candidate).toBeDefined();
    await sm.updateCandidateStatus(candidate!.candidateId, { status: 'consumed' });

    const { snapshot } = await assembleMainlineSnapshot({ workspaceDir, painId, readiness: healthyReadiness() });

    expect(snapshot.consumedCandidatesMissingDreamer).toContain(candidate!.candidateId);
    const verdict = assertMainlineContract(snapshot);
    expect(verdict.stages.some((s) => s.stage === 'auto_consumption' && s.status === 'violation')).toBe(true);
  });

  it('malformed artifact row (missing content_json) does not crash; warnings include reason', async () => {
    await sm.initialize();
    const painId = 'pain-malformed-artifact-row';
    const taskId = await seedDiagnosisTask(sm, painId);
    await sm.acquireLease({ taskId, owner: 'test-owner', durationMs: 60_000, runtimeKind: 'openclaw' });
    const runs = await sm.getRunsByTask(taskId);
    const runId = runs[0]?.runId;
    if (!runId) throw new Error(`No run created for task ${taskId}`);
    await sm.markTaskSucceeded(taskId);

    const artifactId = 'malformed-row-artifact';
    sm.connection.getDb().prepare(
      `INSERT INTO artifacts (artifact_id, run_id, task_id, artifact_kind, content_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(artifactId, runId, taskId, 'diagnostician_output', '', new Date().toISOString());

    const { snapshot, warnings } = await assembleMainlineSnapshot({ workspaceDir, painId, readiness: healthyReadiness() });

    expect(warnings.some((w) => w.includes('Malformed diagnostician artifact row'))).toBe(true);
    expect(snapshot.chain.diagnosticianArtifact).toBeNull();
    const verdict = assertMainlineContract(snapshot);
    expect(verdict.overall).toBe('violation');
  });

  it('malformed consumed candidate row (missing candidate_id) does not produce undefined orphan; warnings include reason', async () => {
    await sm.initialize();
    const painId = 'pain-consumed-malformed';
    const taskId = await seedDiagnosisTask(sm, painId);
    await runDiagnosisToSucceeded(sm, taskId, validDiagnosticianOutput(painId));
    const candidates = await sm.getCandidatesByTaskId(taskId);
    const candidate = candidates[0];
    expect(candidate).toBeDefined();
    await sm.updateCandidateStatus(candidate!.candidateId, { status: 'consumed' });

    // Insert a row with empty candidate_id to exercise the malformed-row path.
    // F13 (PRI-442): include consumed_at so the row satisfies the schema
    // CHECK constraint (status='consumed' → consumed_at IS NOT NULL). The
    // malformation under test is the empty candidate_id, not the timestamp.
    const db = sm.connection.getDb();
    db.prepare(
      `INSERT INTO principle_candidates (candidate_id, task_id, artifact_id, source_run_id, title, description, idempotency_key, status, created_at, consumed_at, recommendation_kind)
       VALUES ('', ?, ?, ?, 'malformed', '', ?, 'consumed', ?, ?, 'principle')`,
    ).run(taskId, candidate!.artifactId, candidate!.sourceRunId, `idemp-${Date.now()}`, new Date().toISOString(), new Date().toISOString());

    const { snapshot, warnings } = await assembleMainlineSnapshot({ workspaceDir, painId, readiness: healthyReadiness() });

    expect(warnings.some((w) => w.includes('Malformed consumed candidate row'))).toBe(true);
    for (const id of snapshot.consumedCandidatesMissingDreamer) {
      expect(typeof id).toBe('string');
      expect(id.length).toBeGreaterThan(0);
    }
  });

  it('resolves painId from latest diagnostician task when not provided', async () => {
    await sm.initialize();
    const painId = 'pain-latest';
    await seedFullChain(sm, painId);

    const { resolvedPainId } = await assembleMainlineSnapshot({ workspaceDir, readiness: healthyReadiness() });

    expect(resolvedPainId).toBe(painId);
  });

  // ── PRI-411: Split pipeline artifact fallback ─────────────────────────────

  it('finds diagnostician artifact stored under diag_router child task (split pipeline layout)', async () => {
    await sm.initialize();
    const painId = 'pain-split-pipeline';
    const parentTaskId = `diagnosis_${painId}`;
    const routerTaskId = `diag_router-${parentTaskId}`;

    // Create the parent diagnosis task (split pipeline parent)
    await sm.createTask({
      taskId: parentTaskId,
      taskKind: 'diagnostician',
      inputRef: painId,
      status: 'pending',
      attemptCount: 0,
      maxAttempts: 3,
      diagnosticJson: diagnosticianDiagnosticJson(painId),
    });

    // Create the diag_router child task
    await sm.createTask({
      taskId: routerTaskId,
      taskKind: 'diag_router',
      inputRef: painId,
      status: 'pending',
      attemptCount: 0,
      maxAttempts: 3,
      diagnosticJson: diagnosticianDiagnosticJson(painId),
    });

    // Commit the artifact under the diag_router child task (not the parent)
    const output = validDiagnosticianOutput(painId);
    const committer = new SqliteDiagnosticianCommitter(sm.connection);
    await sm.acquireLease({ taskId: routerTaskId, owner: 'test-owner', durationMs: 60_000, runtimeKind: 'openclaw' });
    const runs = await sm.getRunsByTask(routerTaskId);
    const runId = runs[0]?.runId;
    if (!runId) throw new Error(`No run created for task ${routerTaskId}`);
    const commitResult = await committer.commit({
      runId,
      taskId: routerTaskId,
      output,
      idempotencyKey: `idem-${routerTaskId}`,
    });
    await sm.markTaskSucceeded(routerTaskId, `artifact://${commitResult.artifactId}`);
    // Also mark parent as succeeded
    await sm.markTaskSucceeded(parentTaskId, `artifact://${commitResult.artifactId}`);

    const { snapshot, warnings } = await assembleMainlineSnapshot({ workspaceDir, painId, readiness: healthyReadiness() });

    // PRI-411: fallback should find the artifact under diag_router-*
    expect(snapshot.chain.diagnosticianArtifact).not.toBeNull();
    expect(snapshot.chain.diagnosticianArtifact?.artifactId).toBe(commitResult.artifactId);
    expect(snapshot.chain.diagnosticianArtifact?.sourcePainId).toBe(painId);
    // No mismatch warning since lineage is consistent
    expect(warnings.some((w) => w.includes('mismatches'))).toBe(false);
  });

  it('split pipeline artifact with mismatched sourcePainId emits lineage warning (EP-07)', async () => {
    await sm.initialize();
    const painId = 'pain-split-mismatch';
    const wrongPainId = 'pain-wrong-lineage';
    const parentTaskId = `diagnosis_${painId}`;
    const routerTaskId = `diag_router-${parentTaskId}`;

    await sm.createTask({
      taskId: parentTaskId,
      taskKind: 'diagnostician',
      inputRef: painId,
      status: 'pending',
      attemptCount: 0,
      maxAttempts: 3,
      diagnosticJson: diagnosticianDiagnosticJson(painId),
    });

    await sm.createTask({
      taskId: routerTaskId,
      taskKind: 'diag_router',
      inputRef: painId,
      status: 'pending',
      attemptCount: 0,
      maxAttempts: 3,
      diagnosticJson: diagnosticianDiagnosticJson(painId),
    });

    // Acquire lease + run for the router task (needed for artifact insertion)
    await sm.acquireLease({ taskId: routerTaskId, owner: 'test-owner', durationMs: 60_000, runtimeKind: 'openclaw' });
    const runs = await sm.getRunsByTask(routerTaskId);
    const runId = runs[0]?.runId;
    if (!runId) throw new Error(`No run created for task ${routerTaskId}`);

    // Directly insert artifact with a DIFFERENT painId in content_json
    // (simulates lineage mismatch — committer stores DiagnosticianOutputV1
    // which doesn't have painId, but the assembler reads it for lineage checks)
    const artifactId = 'mismatch-artifact-001';
    const contentJson = JSON.stringify({
      ...validDiagnosticianOutput(painId),
      painId: wrongPainId, // mismatched lineage
    });
    sm.connection.getDb().prepare(
      `INSERT INTO artifacts (artifact_id, run_id, task_id, artifact_kind, content_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(artifactId, runId, routerTaskId, 'diagnostician_output', contentJson, new Date().toISOString());

    await sm.markTaskSucceeded(routerTaskId, `artifact://${artifactId}`);
    await sm.markTaskSucceeded(parentTaskId, `artifact://${artifactId}`);

    const { snapshot, warnings } = await assembleMainlineSnapshot({ workspaceDir, painId, readiness: healthyReadiness() });

    // Artifact should still be found via fallback
    expect(snapshot.chain.diagnosticianArtifact).not.toBeNull();
    // EP-07: lineage mismatch warning must be emitted
    expect(warnings.some((w) => w.includes('mismatches') && w.includes(wrongPainId))).toBe(true);
  });

  it('monolithic diagnostician artifact lookup still works (no regression)', async () => {
    await sm.initialize();
    const painId = 'pain-monolithic-regression';
    const taskId = `diagnostician-${painId}`;

    // Monolithic layout: artifact stored directly under the parent task
    await sm.createTask({
      taskId,
      taskKind: 'diagnostician',
      inputRef: painId,
      status: 'pending',
      attemptCount: 0,
      maxAttempts: 3,
      diagnosticJson: diagnosticianDiagnosticJson(painId),
    });

    const output = validDiagnosticianOutput(painId);
    const { artifactId } = await runDiagnosisToSucceeded(sm, taskId, output);

    const { snapshot, warnings } = await assembleMainlineSnapshot({ workspaceDir, painId, readiness: healthyReadiness() });

    expect(snapshot.chain.diagnosticianArtifact).not.toBeNull();
    expect(snapshot.chain.diagnosticianArtifact?.artifactId).toBe(artifactId);
    expect(snapshot.chain.diagnosticianArtifact?.sourcePainId).toBe(painId);
    expect(warnings.some((w) => w.includes('mismatches'))).toBe(false);
  });
});
