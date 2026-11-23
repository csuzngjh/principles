/**
 * PRI-435: Pain-to-dreamer lineage repair.
 *
 * Tests that `pd candidate internalize` resolves `sourcePainId` from the
 * canonical diagnostician task/artifact chain and writes it as a top-level
 * key in the dreamer task's diagnosticJson. Uses real SQLite stores and the
 * real CLI handler — no mocks of private internals.
 *
 * ERR refs considered:
 *   - ERR-004: sourcePainId resolved from canonical chain, not invented
 *   - ERR-009: missing/malformed sourcePainId fails loud, no mutation
 *   - ERR-025: tests exercise the real production path, not isolated helpers
 *   - ERR-048: lineage write connected to the read path (findDreamerTaskForPain)
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';
import {
  RuntimeStateManager,
  SqliteDiagnosticianCommitter,
  type DiagnosticianOutputV2,
} from '@principles/core/runtime';
import {
  handleCandidateInternalize,
  handleCandidateInternalizationBackfill,
  resolveSourcePainIdFromDiagnostician,
} from '../../src/commands/candidate.js';

let tmpDir = '';

function makeTmpDir(): string {
  const dir = path.join(os.tmpdir(), `pd-pri435-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function diagnosticianDiagnosticJson(painId: string): string {
  return JSON.stringify({
    sourcePainId: painId,
    reasonSummary: 'Wrote to /etc/passwd without confirmation',
    source: 'test',
    severity: 'high',
    sessionIdHint: null,
    agentIdHint: null,
    provenance: 'automatic_hook',
    provenanceReason: 'automatic hook',
    evidence: [{ sourceRef: 'session://test', note: 'wrote system file' }],
    workspaceDir: null,
  });
}

function diagnosticianOutput(painId: string): DiagnosticianOutputV2 {
  return {
    valid: true,
    diagnosisId: `diag-${painId}`,
    summary: 'Wrote to system path without confirmation',
    rootCause: 'Agent did not block system path writes',
    violatedPrinciples: [],
    evidence: [{ sourceRef: 'session://test', note: 'wrote system file' }],
    recommendations: [{
      kind: 'principle',
      description: 'Block writes to system paths without owner confirmation',
      abstractedPrinciple: 'Never write to OS system paths without explicit owner approval',
      recommendationRef: 'principle-1',
    }],
    confidence: 0.9,
    schemaVersion: 'diagnostician-output-v2',
  };
}

/**
 * Acquire the execution identity the terminal write requires (SPEC §5.3):
 * `runId` addresses the run this acquisition created and the fence proves the
 * caller still owns the lease at write time.
 */
async function acquireExecution(sm: RuntimeStateManager, taskId: string): Promise<{
  runId: string;
  fence: { taskId: string; owner: string; leaseGeneration: number };
}> {
  const owner = 'test-owner';
  const acquisition = await sm.acquireLeaseDetailed({ taskId, owner, durationMs: 60_000, runtimeKind: 'openclaw' });
  return { runId: acquisition.runId, fence: { taskId, owner, leaseGeneration: acquisition.leaseGeneration } };
}

async function seedDiagnosisToCandidate(
  sm: RuntimeStateManager,
  painId: string,
): Promise<{ taskId: string; candidateId: string; artifactId: string }> {
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
  const { runId, fence } = await acquireExecution(sm, taskId);

  const commitResult = await committer.commit({
    runId,
    taskId,
    output: diagnosticianOutput(painId),
    idempotencyKey: `idem-${taskId}`,
  });
  await sm.markTaskSucceeded(taskId, `artifact://${commitResult.artifactId}`, fence, runId);
  // PRI-1267: the admission write gate revalidates each candidate against its
  // OWN source run's persisted DiagnosticianOutputV2 — production runners
  // capture that output on the run, so the fixture must too.
  await sm.updateRunOutput(runId, JSON.stringify(diagnosticianOutput(painId)));

  const candidates = await sm.getCandidatesByTaskId(taskId);
  const [candidate] = candidates;
  if (!candidate) throw new Error('No candidate produced by diagnostician committer');
  return { taskId, candidateId: candidate.candidateId, artifactId: candidate.artifactId };
}

/**
 * Seeds a diagnostician task → candidate but writes diagnosticJson WITHOUT
 * the sourcePainId field. This simulates data corruption or a pre-PRI-435
 * diagnostician task that lacks the lineage key. The candidate internalize
 * path must fail loud and produce no dreamer task side effect.
 */
async function seedDiagnosisToCandidateWithoutLineage(
  sm: RuntimeStateManager,
  painId: string,
): Promise<{ taskId: string; candidateId: string }> {
  const taskId = `diagnostician-nolineage-${painId}`;
  const diagnosticJsonWithoutSourcePainId = JSON.stringify({
    // sourcePainId intentionally omitted
    reasonSummary: 'Wrote to /etc/passwd without confirmation',
    source: 'test',
    severity: 'high',
    sessionIdHint: null,
    agentIdHint: null,
    provenance: 'automatic_hook',
    provenanceReason: 'automatic hook',
    evidence: [{ sourceRef: 'session://test', note: 'wrote system file' }],
    workspaceDir: null,
  });
  await sm.createTask({
    taskId,
    taskKind: 'diagnostician',
    inputRef: painId,
    status: 'pending',
    attemptCount: 0,
    maxAttempts: 3,
    diagnosticJson: diagnosticJsonWithoutSourcePainId,
  });

  const committer = new SqliteDiagnosticianCommitter(sm.connection);
  const { runId, fence } = await acquireExecution(sm, taskId);

  const commitResult = await committer.commit({
    runId,
    taskId,
    output: diagnosticianOutput(painId),
    idempotencyKey: `idem-${taskId}`,
  });
  await sm.markTaskSucceeded(taskId, `artifact://${commitResult.artifactId}`, fence, runId);
  await sm.updateRunOutput(runId, JSON.stringify(diagnosticianOutput(painId)));

  const candidates = await sm.getCandidatesByTaskId(taskId);
  const [candidate] = candidates;
  if (!candidate) throw new Error('No candidate produced by diagnostician committer');
  return { taskId, candidateId: candidate.candidateId };
}

/**
 * SPEC-PD-PIPELINE-SPINE-001 D4: `pd candidate internalize` now refuses a
 * principle candidate that never entered the ledger, so lineage fixtures that
 * expect a Dreamer task must reflect the normally-INTAKED state — the ledger
 * records the candidate as the principle's derivation source.
 */
function writeLedgerWithDerivedCandidate(stateDir: string, candidateId: string): void {
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'principle_training_state.json'), JSON.stringify({
    trainingStore: {},
    _tree: {
      principles: {
        '22222222-3333-4111-8111-111111111111': {
          id: '22222222-3333-4111-8111-111111111111',
          version: 1,
          text: 'Never write to system paths without owner approval',
          triggerPattern: '*',
          action: 'noop',
          status: 'active',
          priority: 'medium',
          scope: 'global',
          evaluability: 'manual_only',
          valueScore: 0,
          adherenceRate: 0,
          painPreventedCount: 0,
          derivedFromPainIds: [candidateId],
          ruleIds: [],
          conflictsWithPrincipleIds: [],
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
      },
      rules: {},
      implementations: {},
      metrics: {},
      ruleCandidateBindings: {},
      lastUpdated: '2026-11-23T00:00:00.000Z',
    },
  }, null, 2));
}

describe('PRI-435: candidate internalize resolves sourcePainId from diagnostician chain', () => {
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(async () => {
    consoleLogSpy.mockRestore();
    if (tmpDir) {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
      tmpDir = '';
    }
  });

  it('creates exactly one dreamer task with top-level sourcePainId matching the originating pain', async () => {
    // ── Arrange: pain → diagnostician task (with sourcePainId) → candidate ──
    const painId = 'pain-pri435-001';
    let candidateId = '';

    {
      const sm = new RuntimeStateManager({ workspaceDir: tmpDir });
      await sm.initialize();
      const seeded = await seedDiagnosisToCandidate(sm, painId);
      candidateId = seeded.candidateId;
      await sm.close();
      // D4: reflect the normally-intaked state (ledger records derivation).
      writeLedgerWithDerivedCandidate(path.join(tmpDir, '.state'), candidateId);
    }

    // ── Act: run the real CLI handler (not dry-run → creates the task) ──
    await handleCandidateInternalize({
      candidateId,
      workspace: tmpDir,
      json: true,
    });

    // ── Assert: exactly one dreamer task with top-level sourcePainId ──
    const sm2 = new RuntimeStateManager({ workspaceDir: tmpDir });
    await sm2.initialize();
    const allTasks = await sm2.listTasks();
    const dreamerTasks = allTasks.filter((t) => t.taskKind === 'dreamer');
    expect(dreamerTasks.length, 'exactly one dreamer task').toBe(1);

    const dreamerTask = dreamerTasks[0];
    expect(dreamerTask.diagnosticJson).toBeDefined();
    const parsed: unknown = JSON.parse(dreamerTask.diagnosticJson as string);
    expect(parsed).not.toBeNull();
    expect(typeof parsed).toBe('object');
    expect(Object.hasOwn(parsed, 'sourcePainId'), 'sourcePainId must be a top-level key').toBe(true);
    const storedPainId = Reflect.get(parsed, 'sourcePainId');
    expect(storedPainId).toBe(painId);
    await sm2.close();
  });
});

describe('PRI-435: candidate internalization backfill (consumed) resolves sourcePainId from diagnostician chain', () => {
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(async () => {
    consoleLogSpy.mockRestore();
    if (tmpDir) {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
      tmpDir = '';
    }
  });

  it('backfill --confirm creates dreamer task with top-level sourcePainId for consumed candidate missing dreamer task', async () => {
    // ── Arrange: pain → diagnostician task (with sourcePainId) → candidate ──
    // Then mark candidate as 'consumed' WITHOUT creating a dreamer task,
    // simulating the broken pre-PRI-435 state where backfill had to repair lineage.
    const painId = 'pain-pri435-backfill-consumed-001';
    let candidateId = '';

    {
      const sm = new RuntimeStateManager({ workspaceDir: tmpDir });
      await sm.initialize();
      const seeded = await seedDiagnosisToCandidate(sm, painId);
      candidateId = seeded.candidateId;

      // Mark candidate as consumed without creating a dreamer task — simulates
      // the broken state where consumed candidates lack a dreamer task.
      const updated = await sm.updateCandidateStatus(candidateId, { status: 'consumed' });
      if (!updated) throw new Error(`Failed to mark candidate ${candidateId} as consumed`);
      // D4: reflect the normally-intaked state (ledger records derivation).
      writeLedgerWithDerivedCandidate(path.join(tmpDir, '.state'), candidateId);
      await sm.close();
    }

    // ── Act: run the real backfill handler with --confirm ──
    await handleCandidateInternalizationBackfill({
      workspace: tmpDir,
      confirm: true,
      json: true,
    });

    // ── Assert: exactly one dreamer task with top-level sourcePainId ──
    const sm2 = new RuntimeStateManager({ workspaceDir: tmpDir });
    await sm2.initialize();
    const allTasks = await sm2.listTasks();
    const dreamerTasks = allTasks.filter((t) => t.taskKind === 'dreamer');
    expect(dreamerTasks.length, 'backfill should create exactly one dreamer task').toBe(1);

    const dreamerTask = dreamerTasks[0];
    expect(dreamerTask.diagnosticJson).toBeDefined();
    const parsed: unknown = JSON.parse(dreamerTask.diagnosticJson as string);
    expect(parsed).not.toBeNull();
    expect(typeof parsed).toBe('object');
    expect(Object.hasOwn(parsed, 'sourcePainId'), 'sourcePainId must be a top-level key').toBe(true);
    const storedPainId = Reflect.get(parsed, 'sourcePainId');
    expect(storedPainId).toBe(painId);
    await sm2.close();
  });
});

describe('PRI-435: candidate internalize fails loud when sourcePainId is missing from diagnostician chain', () => {
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as () => never);
  });

  afterEach(async () => {
    consoleLogSpy.mockRestore();
    consoleErrorSpy.mockRestore();
    exitSpy.mockRestore();
    if (tmpDir) {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
      tmpDir = '';
    }
  });

  it('does not create a dreamer task and exits non-zero with reason + nextAction when diagnostician task lacks sourcePainId', async () => {
    // ── Arrange: diagnostician task WITHOUT sourcePainId → candidate ──
    const painId = 'pain-pri435-fail-loud-001';
    let candidateId = '';

    {
      const sm = new RuntimeStateManager({ workspaceDir: tmpDir });
      await sm.initialize();
      const seeded = await seedDiagnosisToCandidateWithoutLineage(sm, painId);
      candidateId = seeded.candidateId;
      await sm.close();
    }

    // ── Act: run the real CLI handler ──
    await handleCandidateInternalize({
      candidateId,
      workspace: tmpDir,
      json: true,
    });

    // ── Assert: process.exit(1) called ──
    expect(exitSpy).toHaveBeenCalledWith(1);

    // ── Assert: NO dreamer task created (no side effects) ──
    const sm2 = new RuntimeStateManager({ workspaceDir: tmpDir });
    await sm2.initialize();
    const allTasks = await sm2.listTasks();
    const dreamerTasks = allTasks.filter((t) => t.taskKind === 'dreamer');
    expect(dreamerTasks.length, 'no dreamer task should be created when sourcePainId is missing').toBe(0);
    await sm2.close();

    // ── Assert: JSON output contains reason and nextAction ──
    const jsonOutput = consoleLogSpy.mock.calls
      .map((c) => String(c[0]))
      .find((s) => s.includes('"candidateId"') && s.includes('"reason"'));
    expect(jsonOutput, 'JSON error result must be printed').toBeDefined();
    // PRI-435 (CodeRabbit P2): no `as` bypass; strict null check before Object.hasOwn
    expect(typeof jsonOutput).toBe('string');
    if (typeof jsonOutput !== 'string') throw new Error('JSON error result must be a string');
    const parsed: unknown = JSON.parse(jsonOutput);
    const isRecord = parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed);
    expect(isRecord, 'JSON error result must be an object').toBe(true);
    if (!isRecord) throw new Error('Malformed JSON error result');
    expect(Object.hasOwn(parsed, 'reason'), 'reason field must be present').toBe(true);
    expect(Object.hasOwn(parsed, 'nextAction'), 'nextAction field must be present').toBe(true);
    const reason = Reflect.get(parsed, 'reason');
    expect(typeof reason).toBe('string');
    expect(reason.length, 'reason must not be empty').toBeGreaterThan(0);
    const nextAction = Reflect.get(parsed, 'nextAction');
    expect(typeof nextAction).toBe('string');
    expect(nextAction.length, 'nextAction must not be empty').toBeGreaterThan(0);
  });
});

describe('PRI-435: backfill fails loud per-candidate when sourcePainId is missing', () => {
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(async () => {
    consoleLogSpy.mockRestore();
    if (tmpDir) {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
      tmpDir = '';
    }
  });

  it('backfill --confirm does not create dreamer task for consumed candidate lacking sourcePainId and reports error with nextAction', async () => {
    // ── Arrange: diagnostician task WITHOUT sourcePainId → candidate (consumed) ──
    const painId = 'pain-pri435-backfill-fail-loud-001';
    let candidateId = '';

    {
      const sm = new RuntimeStateManager({ workspaceDir: tmpDir });
      await sm.initialize();
      const seeded = await seedDiagnosisToCandidateWithoutLineage(sm, painId);
      candidateId = seeded.candidateId;
      const updated = await sm.updateCandidateStatus(candidateId, { status: 'consumed' });
      if (!updated) throw new Error(`Failed to mark candidate ${candidateId} as consumed`);
      await sm.close();
    }

    // ── Act: run the real backfill handler with --confirm ──
    await handleCandidateInternalizationBackfill({
      workspace: tmpDir,
      confirm: true,
      json: true,
    });

    // ── Assert: NO dreamer task created (no side effects) ──
    const sm2 = new RuntimeStateManager({ workspaceDir: tmpDir });
    await sm2.initialize();
    const allTasks = await sm2.listTasks();
    const dreamerTasks = allTasks.filter((t) => t.taskKind === 'dreamer');
    expect(dreamerTasks.length, 'no dreamer task should be created when sourcePainId is missing').toBe(0);

    // ── Assert: JSON output contains an error result with reason + nextAction ──
    const jsonOutput = consoleLogSpy.mock.calls
      .map((c) => String(c[0]))
      .find((s) => s.includes('"results"') && s.includes('"errors"'));
    expect(jsonOutput, 'backfill JSON result must be printed').toBeDefined();
    // PRI-435 (CodeRabbit P2): no `as` bypass; strict null check before Object.hasOwn
    expect(typeof jsonOutput).toBe('string');
    if (typeof jsonOutput !== 'string') throw new Error('backfill JSON result must be a string');
    const parsed: unknown = JSON.parse(jsonOutput);
    const isRecord = parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed);
    expect(isRecord, 'backfill JSON result must be an object').toBe(true);
    if (!isRecord) throw new Error('Malformed backfill JSON result');
    // The backfill JSON shape is { ...remediation, details: { errors, created, results, ... } }
    expect(Object.hasOwn(parsed, 'details'), 'details field must be present').toBe(true);
    const details = Reflect.get(parsed, 'details');
    expect(details).not.toBeNull();
    expect(typeof details).toBe('object');
    expect(Object.hasOwn(details, 'errors'), 'errors count must be present in details').toBe(true);
    const errors = Reflect.get(details, 'errors');
    expect(errors, 'at least one error must be recorded').toBeGreaterThanOrEqual(1);
    expect(Object.hasOwn(details, 'created'), 'created count must be present in details').toBe(true);
    const created = Reflect.get(details, 'created');
    expect(created, 'no dreamer task should be created').toBe(0);

    const results = Reflect.get(details, 'results');
    expect(Array.isArray(results), 'results must be an array').toBe(true);
    const errorResult = (results as Array<Record<string, unknown>>).find(
      (r) => r.status === 'error' || r.seedDecision === 'skipped',
    );
    expect(errorResult, 'an error/skipped result for the missing-lineage candidate must exist').toBeDefined();
    expect(Object.hasOwn(errorResult as object, 'reason'), 'reason field must be present').toBe(true);
    expect(Object.hasOwn(errorResult as object, 'nextAction'), 'nextAction field must be present').toBe(true);
    const reason = Reflect.get(errorResult as object, 'reason');
    expect(typeof reason).toBe('string');
    expect(reason.length, 'reason must not be empty').toBeGreaterThan(0);
    const nextAction = Reflect.get(errorResult as object, 'nextAction');
    expect(typeof nextAction).toBe('string');
    expect(nextAction.length, 'nextAction must not be empty').toBeGreaterThan(0);

    await sm2.close();
  });
});

/**
 * PRI-435 (CodeRabbit P1 regression): Verify that resolveSourcePainIdFromDiagnostician
 * rejects tasks whose taskKind is not 'diagnostician'. This prevents cross-task-chain
 * lineage contamination when candidate.taskId points to a non-diagnostician task.
 */
describe('PRI-435: candidate internalize rejects non-diagnostician task for lineage resolution', () => {
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as () => never);
  });

  afterEach(async () => {
    consoleLogSpy.mockRestore();
    consoleErrorSpy.mockRestore();
    exitSpy.mockRestore();
    if (tmpDir) {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
      tmpDir = '';
    }
  });

  it('does not create a dreamer task when candidate.taskId points to a non-diagnostician task', async () => {
    const painId = 'pain-pri435-wrong-taskkind-001';
    let candidateId = '';

    {
      const sm = new RuntimeStateManager({ workspaceDir: tmpDir });
      await sm.initialize();

      // Seed through the normal diagnostician path (creates diagnostician task + candidate)
      const seeded = await seedDiagnosisToCandidate(sm, painId);
      candidateId = seeded.candidateId;

      // Corrupt the task's task_kind to simulate cross-task-chain pollution.
      // The resolver must reject this even though diagnosticJson has sourcePainId.
      sm.connection
        .getDb()
        .prepare('UPDATE tasks SET task_kind = ? WHERE task_id = ?')
        .run('dreamer', seeded.taskId);

      await sm.close();
    }

    // Act: run the real CLI handler
    await handleCandidateInternalize({
      candidateId,
      workspace: tmpDir,
      json: true,
    });

    // Assert: process.exit(1) called (fail loud)
    expect(exitSpy).toHaveBeenCalledWith(1);

    // Assert: NO dreamer task created (no side effects)
    const sm2 = new RuntimeStateManager({ workspaceDir: tmpDir });
    await sm2.initialize();
    const allTasks = await sm2.listTasks();
    // The original diagnostician task was corrupted to 'dreamer' kind, but no NEW
    // dreamer task should be created by the internalize handler.
    const newDreamerTasks = allTasks.filter(
      (t) => t.taskKind === 'dreamer' && !t.taskId.startsWith('diagnostician-'),
    );
    expect(newDreamerTasks.length, 'no new dreamer task should be created when taskKind is wrong').toBe(0);
    await sm2.close();

    // Assert: JSON output contains reason and nextAction
    const jsonOutput = consoleLogSpy.mock.calls
      .map((c) => String(c[0]))
      .find((s) => s.includes('"candidateId"') && s.includes('"reason"'));
    expect(jsonOutput, 'JSON error result must be printed').toBeDefined();
    // PRI-435 (CodeRabbit P2): no `as` bypass; strict null check before Object.hasOwn
    expect(typeof jsonOutput).toBe('string');
    if (typeof jsonOutput !== 'string') throw new Error('JSON error result must be a string');
    const parsed: unknown = JSON.parse(jsonOutput);
    const isRecord = parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed);
    expect(isRecord, 'JSON error result must be an object').toBe(true);
    if (!isRecord) throw new Error('Malformed JSON error result');
    expect(Object.hasOwn(parsed, 'reason'), 'reason field must be present').toBe(true);
    expect(Object.hasOwn(parsed, 'nextAction'), 'nextAction field must be present').toBe(true);
  });
});

describe('candidate internalize resolves the production diag_router candidate chain', () => {
  it('follows the router run diagnosisId back to the originating diagnostician task', async () => {
    tmpDir = makeTmpDir();
    const sm = new RuntimeStateManager({ workspaceDir: tmpDir });
    await sm.initialize();
    const painId = 'pain-router-lineage-001';
    const seeded = await seedDiagnosisToCandidate(sm, painId);
    // D4: reflect the normally-intaked state (ledger records derivation).
    writeLedgerWithDerivedCandidate(path.join(tmpDir, '.state'), seeded.candidateId);
    const routerTaskId = `diag_router-${seeded.taskId}`;
    await sm.createTask({
      taskId: routerTaskId, taskKind: 'diag_router', status: 'pending',
      // PRI-1267: production diag_router subtasks carry inputRef = the parent
      // diagnostician task id — the admission gate's split-pipeline lineage
      // check requires it.
      inputRef: seeded.taskId,
      attemptCount: 0, maxAttempts: 3, diagnosticJson: JSON.stringify({ pi_metadata: {
        dependencyTaskIds: [], channel: 'prompt', timeoutMs: 1000,
        inputArtifactRefs: [], outputArtifactRefs: [],
      } }),
    });
    await sm.acquireLease({ taskId: routerTaskId, owner: 'test', durationMs: 60_000, runtimeKind: 'openclaw' });
    const [routerRun] = await sm.getRunsByTask(routerTaskId);
    if (!routerRun) throw new Error('router run not created');
    // PRI-1267: the router run must carry a full DiagnosticianOutputV2 (with
    // diagnosisId pointing back at the parent task) — the admission write gate
    // revalidates the candidate against THIS output, and the lineage resolver
    // follows the same diagnosisId field.
    await sm.updateRunOutput(routerRun.runId, JSON.stringify({
      ...diagnosticianOutput(painId),
      diagnosisId: seeded.taskId,
    }));
    sm.connection.getDb().prepare(
      'UPDATE principle_candidates SET task_id = ?, source_run_id = ? WHERE candidate_id = ?',
    ).run(routerTaskId, routerRun.runId, seeded.candidateId);
    // PRI-1267: the candidate's artifact must belong to its (repointed) source
    // run AND task — the admission gate's round binding cross-checks
    // artifact↔run and artifact↔task.
    sm.connection.getDb().prepare(
      'UPDATE artifacts SET run_id = ?, task_id = ? WHERE artifact_id = ?',
    ).run(routerRun.runId, routerTaskId, seeded.artifactId);
    await sm.close();

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await handleCandidateInternalize({ candidateId: seeded.candidateId, workspace: tmpDir, json: true });
    } finally {
      logSpy.mockRestore();
    }

    const verify = new RuntimeStateManager({ workspaceDir: tmpDir });
    await verify.initialize();
    const dreamer = (await verify.listTasks()).find((task) => task.taskKind === 'dreamer');
    expect(dreamer).toBeDefined();
    const diagnostic: unknown = JSON.parse(dreamer?.diagnosticJson ?? '{}');
    if (diagnostic === null || typeof diagnostic !== 'object' || Array.isArray(diagnostic)) {
      throw new Error('dreamer diagnosticJson must be an object');
    }
    expect(Reflect.get(diagnostic, 'sourcePainId')).toBe(painId);
    await verify.close();
  });
});

// ── PRI-866: reader convergence characterization ─────────────────────────────
// resolveSourcePainIdFromDiagnostician now delegates the field parse to the
// core canonical reader (parseSeedSourcePainId). Value semantics were already
// identical; this pins the contract at the pd-cli public boundary so the
// convergence cannot silently regress.
describe('PRI-866: resolveSourcePainIdFromDiagnostician canonical value semantics', () => {
  it('returns the trimmed sourcePainId for a historical row with surrounding whitespace', async () => {
    const dir = makeTmpDir();
    const sm = new RuntimeStateManager({ workspaceDir: dir });
    await sm.initialize();
    try {
      await sm.createTask({
        taskId: 'diagnostician-p866-ws',
        taskKind: 'diagnostician',
        status: 'pending',
        attemptCount: 0,
        maxAttempts: 3,
        diagnosticJson: diagnosticianDiagnosticJson(' pain-p866-ws '),
      });
      expect(await resolveSourcePainIdFromDiagnostician(sm, { taskId: 'diagnostician-p866-ws' }))
        .toBe('pain-p866-ws');
    } finally {
      await sm.close();
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });

  it('returns null for blank or absent sourcePainId (fail-loud contract, no invention)', async () => {
    const dir = makeTmpDir();
    const sm = new RuntimeStateManager({ workspaceDir: dir });
    await sm.initialize();
    try {
      await sm.createTask({
        taskId: 'diagnostician-p866-blank',
        taskKind: 'diagnostician',
        status: 'pending',
        attemptCount: 0,
        maxAttempts: 3,
        diagnosticJson: diagnosticianDiagnosticJson('   '),
      });
      await sm.createTask({
        taskId: 'diagnostician-p866-none',
        taskKind: 'diagnostician',
        status: 'pending',
        attemptCount: 0,
        maxAttempts: 3,
        diagnosticJson: JSON.stringify({ reasonSummary: 'no lineage key here' }),
      });
      expect(await resolveSourcePainIdFromDiagnostician(sm, { taskId: 'diagnostician-p866-blank' }))
        .toBeNull();
      expect(await resolveSourcePainIdFromDiagnostician(sm, { taskId: 'diagnostician-p866-none' }))
        .toBeNull();
    } finally {
      await sm.close();
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });
});
