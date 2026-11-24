/**
 * D4 authority-gate matrix for `pd candidate internalize` —
 * SPEC-PD-PIPELINE-SPINE-001 v0.9 §3.4 (PRI-1291 Phase 1A red-first).
 *
 * Verified defect (origin/main): `handleCandidateInternalize` never calls
 * `resolveCandidatePrincipleIdentity` or `evaluateDreamerSeedSuppression`, so
 * a `principle` candidate that never entered the ledger, a reuse-resolved
 * candidate, or a candidate with a corrupted persisted kind all get a Dreamer
 * task created.
 *
 * Real SQLite workspace + real handler (same harness discipline as
 * candidate-internalize-lineage.test.ts: no mocks of private internals).
 *
 * Matrix (SPEC §3.4.2):
 *   ① principle candidate NOT in ledger      → refused / candidate_not_in_ledger
 *       + nextAction `pd candidate intake --candidate-id <id> --workspace "<path>"`
 *   ② reuse-resolved candidate               → refused (seed suppression)
 *   ③ unbound rule candidate                 → dreamer task CREATED (legal window)
 *   ④ defer candidate                        → no_task_created (unchanged)
 *   ⑤ corrupted persisted raw kind           → refused / candidate_kind_invalid
 *   ⑥ corrupt ledger file                    → refused (fail-closed)
 *   ⑦ an EXISTING dreamer task outranks a later ledger change → status 'existing'
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';
import Database from 'better-sqlite3';
import {
  RuntimeStateManager,
  SqliteDiagnosticianCommitter,
  type DiagnosticianOutputV2,
} from '@principles/core/runtime';
import { handleCandidateInternalize } from '../../src/commands/candidate.js';

let tmpDir = '';
let consoleLogSpy: ReturnType<typeof vi.spyOn>;
let exitSpy: ReturnType<typeof mockProcessExit>;

function mockProcessExit() {
  return vi.spyOn(process, 'exit').mockImplementation((() => undefined) as () => never);
}

/** Exclusive temp directory: mkdtemp creates it atomically with an
 * unguessable suffix (never a predictable Date.now/Math.random name). */
function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'pd-pri1291-d4-'));
}

function diagnosticianDiagnosticJson(painId: string): string {
  return JSON.stringify({
    sourcePainId: painId,
    reasonSummary: 'Deviated from the owner-review contract',
    source: 'test',
    severity: 'high',
    sessionIdHint: null,
    agentIdHint: null,
    provenance: 'automatic_hook',
    provenanceReason: 'automatic hook',
    evidence: [{ sourceRef: 'session://test', note: 'deviated' }],
    workspaceDir: null,
  });
}

function principleOutput(painId: string): DiagnosticianOutputV2 {
  return {
    valid: true,
    diagnosisId: `diag-${painId}`,
    summary: 'Deviation observed',
    rootCause: 'Agent skipped the owner review',
    violatedPrinciples: [],
    evidence: [{ sourceRef: 'session://test', note: 'deviated' }],
    recommendations: [{
      kind: 'principle',
      description: 'Require owner review before destructive actions',
      abstractedPrinciple: 'Never skip the owner review gate for destructive actions',
      recommendationRef: 'principle-1',
    }],
    confidence: 0.9,
    schemaVersion: 'diagnostician-output-v2',
  };
}

function ruleOutput(painId: string): DiagnosticianOutputV2 {
  return {
    valid: true,
    diagnosisId: `diag-${painId}`,
    summary: 'Deviation observed',
    rootCause: 'Agent deleted files without the mandated pattern check',
    violatedPrinciples: [],
    evidence: [{ sourceRef: 'session://test', note: 'deviated' }],
    recommendations: [{
      kind: 'rule',
      description: 'Require pattern check before rm',
      recommendationRef: 'rule-1',
      triggerPattern: 'rm\\s+-rf',
      action: 'require explicit owner confirmation',
      principleAssociation: { status: 'unresolved', reason: 'no_supported_target' },
    }],
    confidence: 0.9,
    schemaVersion: 'diagnostician-output-v2',
  };
}

function deferOutput(painId: string): DiagnosticianOutputV2 {
  return {
    valid: true,
    diagnosisId: `diag-${painId}`,
    summary: 'Deviation observed',
    rootCause: 'Agent skipped the owner review',
    violatedPrinciples: [],
    evidence: [{ sourceRef: 'session://test', note: 'deviated' }],
    recommendations: [{
      kind: 'defer',
      description: 'Needs product decision before internalization',
      recommendationRef: 'defer-1',
    }],
    confidence: 0.9,
    schemaVersion: 'diagnostician-output-v2',
  };
}

async function acquireExecution(sm: RuntimeStateManager, taskId: string) {
  const owner = 'test-owner';
  const acquisition = await sm.acquireLeaseDetailed({ taskId, owner, durationMs: 60_000, runtimeKind: 'openclaw' });
  return { runId: acquisition.runId, fence: { taskId, owner, leaseGeneration: acquisition.leaseGeneration } };
}

async function seedCandidate(
  sm: RuntimeStateManager,
  painId: string,
  output: DiagnosticianOutputV2,
): Promise<string> {
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
    output,
    idempotencyKey: `idem-${taskId}`,
  });
  await sm.markTaskSucceeded(taskId, `artifact://${commitResult.artifactId}`, fence, runId);
  await sm.updateRunOutput(runId, JSON.stringify(output));
  const candidates = await sm.getCandidatesByTaskId(taskId);
  const candidate = candidates[0];
  if (!candidate) throw new Error('No candidate produced by diagnostician committer');
  return candidate.candidateId;
}

/** Writes a real ledger file whose reuseEvidence binds `candidateId`
 * (on-disk hybrid shape: `_tree` key + full principle fields). */
function writeLedgerWithReuse(stateDir: string, candidateId: string, principleId = '11111111-2222-4111-8111-111111111111'): void {
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'principle_training_state.json'), JSON.stringify({
    trainingStore: {},
    _tree: {
      principles: {
        [principleId]: {
          id: principleId,
          version: 1,
          text: 'Never skip the owner review gate',
          triggerPattern: '*',
          action: 'noop',
          status: 'active',
          priority: 'medium',
          scope: 'global',
          evaluability: 'manual_only',
          valueScore: 0,
          adherenceRate: 0,
          painPreventedCount: 0,
          derivedFromPainIds: [],
          ruleIds: [],
          conflictsWithPrincipleIds: [],
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
          reuseEvidence: [{ painId: 'pain-reuse-1', candidateId, decision: 'reuse', actor: { kind: 'owner', id: 'owner-test' }, reason: 'duplicate of the existing principle', decidedAt: '2026-11-23T00:00:00.000Z', decisionId: 'dec-1' }],
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

async function listDreamerTasks(workspace: string): Promise<{ taskId: string }[]> {
  const sm = new RuntimeStateManager({ workspaceDir: workspace });
  await sm.initialize();
  try {
    const all = await sm.listTasks();
    return all.filter((t) => t.taskKind === 'dreamer').map((t) => ({ taskId: t.taskId }));
  } finally {
    await sm.close();
  }
}

beforeEach(() => {
  tmpDir = makeTmpDir();
  consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  exitSpy = mockProcessExit();
});

afterEach(() => {
  consoleLogSpy.mockRestore();
  exitSpy.mockRestore();
  fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

describe('D4 — pd candidate internalize authority gate matrix', () => {
  it('① principle candidate NOT in ledger → refused / candidate_not_in_ledger with the real intake nextAction', async () => {
    const sm = new RuntimeStateManager({ workspaceDir: tmpDir });
    await sm.initialize();
    const candidateId = await seedCandidate(sm, 'pain-d4-a', principleOutput('pain-d4-a'));
    await sm.close();

    await handleCandidateInternalize({ candidateId, workspace: tmpDir, json: true });

    const lines = consoleLogSpy.mock.calls.map((c) => String(c[0])).filter((l) => l.trim().startsWith('{'));
    expect(lines.length).toBeGreaterThanOrEqual(1);
    const result = JSON.parse(lines[lines.length - 1]) as Record<string, unknown>;
    expect(result.status).toBe('refused');
    expect(result.reason).toBe('candidate_not_in_ledger');
    expect(result.nextAction).toBe(`pd candidate intake --candidate-id ${candidateId} --workspace "${tmpDir}"`);
    expect(await listDreamerTasks(tmpDir)).toEqual([]);
  });

  it('② reuse-resolved candidate (ledger reuseEvidence) → refused, zero dreamer tasks', async () => {
    const sm = new RuntimeStateManager({ workspaceDir: tmpDir });
    await sm.initialize();
    const candidateId = await seedCandidate(sm, 'pain-d4-b', principleOutput('pain-d4-b'));
    await sm.close();
    writeLedgerWithReuse(path.join(tmpDir, '.state'), candidateId);

    await handleCandidateInternalize({ candidateId, workspace: tmpDir, json: true });

    const lines = consoleLogSpy.mock.calls.map((c) => String(c[0])).filter((l) => l.trim().startsWith('{'));
    const result = JSON.parse(lines[lines.length - 1]) as Record<string, unknown>;
    expect(result.status).toBe('refused');
    expect(String(result.reason)).toContain('dreamer_seed_suppressed');
    expect(await listDreamerTasks(tmpDir)).toEqual([]);
  });

  it('③ unbound rule candidate → dreamer task CREATED (legal seeding window preserved)', async () => {
    const sm = new RuntimeStateManager({ workspaceDir: tmpDir });
    await sm.initialize();
    const candidateId = await seedCandidate(sm, 'pain-d4-c', ruleOutput('pain-d4-c'));
    await sm.close();

    await handleCandidateInternalize({ candidateId, workspace: tmpDir, json: true });

    const dreamers = await listDreamerTasks(tmpDir);
    expect(dreamers.length).toBe(1);
    expect(dreamers[0].taskId).toContain(candidateId);
  });

  it('④ defer candidate → never internalized (unchanged behavior: the PRI-1267 admission gate already refuses defer kinds)', async () => {
    const sm = new RuntimeStateManager({ workspaceDir: tmpDir });
    await sm.initialize();
    const candidateId = await seedCandidate(sm, 'pain-d4-d', deferOutput('pain-d4-d'));
    await sm.close();

    await handleCandidateInternalize({ candidateId, workspace: tmpDir, json: true });

    const lines = consoleLogSpy.mock.calls.map((c) => String(c[0])).filter((l) => l.trim().startsWith('{'));
    const result = JSON.parse(lines[lines.length - 1]) as Record<string, unknown>;
    // Pre-D4 reality: the admission write gate refuses defer candidates
    // (recommendation_kind_defer_not_actionable) BEFORE routing; without the
    // gate the route would report no_task_created. Either way: never created,
    // and the D4 identity gate must not change this outcome.
    expect(['no_task_created', 'refused']).toContain(result.status);
    expect(await listDreamerTasks(tmpDir)).toEqual([]);
  });

  it('⑤ corrupted persisted raw kind → refused / candidate_kind_invalid, zero dreamer tasks', async () => {
    const sm = new RuntimeStateManager({ workspaceDir: tmpDir });
    await sm.initialize();
    const candidateId = await seedCandidate(sm, 'pain-d4-e', principleOutput('pain-d4-e'));
    await sm.close();
    // Simulate persisted-kind corruption: the COLUMN is the raw authority the
    // write boundary must validate (the normalized read view folds this to
    // 'principle', which is exactly the D4 bypass).
    const db = new Database(path.join(tmpDir, '.pd', 'state.db'));
    db.prepare('UPDATE principle_candidates SET recommendation_kind = ? WHERE candidate_id = ?').run('wizardry', candidateId);
    db.close();

    await handleCandidateInternalize({ candidateId, workspace: tmpDir, json: true });

    const lines = consoleLogSpy.mock.calls.map((c) => String(c[0])).filter((l) => l.trim().startsWith('{'));
    const result = JSON.parse(lines[lines.length - 1]) as Record<string, unknown>;
    expect(result.status).toBe('refused');
    expect(String(result.reason)).toContain('candidate_kind_invalid');
    expect(await listDreamerTasks(tmpDir)).toEqual([]);
  });

  it('⑥ corrupt ledger file → fail-closed refused, zero dreamer tasks', async () => {
    const sm = new RuntimeStateManager({ workspaceDir: tmpDir });
    await sm.initialize();
    const candidateId = await seedCandidate(sm, 'pain-d4-f', principleOutput('pain-d4-f'));
    await sm.close();
    fs.mkdirSync(path.join(tmpDir, '.state'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, '.state', 'principle_training_state.json'), '{not-json');

    await handleCandidateInternalize({ candidateId, workspace: tmpDir, json: true });

    const lines = consoleLogSpy.mock.calls.map((c) => String(c[0])).filter((l) => l.trim().startsWith('{'));
    const result = JSON.parse(lines[lines.length - 1]) as Record<string, unknown>;
    expect(result.status).toBe('refused');
    expect(result.reason).toBe('ledger_identity_ledger_corrupt');
    expect(await listDreamerTasks(tmpDir)).toEqual([]);
  });

  it('⑦ an EXISTING dreamer task outranks a later identity change → status existing', async () => {
    const sm = new RuntimeStateManager({ workspaceDir: tmpDir });
    await sm.initialize();
    const candidateId = await seedCandidate(sm, 'pain-d4-g', principleOutput('pain-d4-g'));
    // The pre-existing Dreamer task comes from an EARLIER automatic entry
    // (bridge/diagnose seed) — the D4 gate now refuses a not-in-ledger
    // principle candidate on `internalize`, so the task is seeded directly,
    // exactly the state a prior automatic run leaves behind.
    await sm.createTask({
      taskId: `dreamer-${candidateId}-prompt`,
      taskKind: 'dreamer',
      inputRef: '',
      status: 'pending',
      attemptCount: 0,
      maxAttempts: 3,
      diagnosticJson: JSON.stringify({ candidateId }),
    });
    await sm.close();

    // The ledger LATER resolves the candidate onto an existing principle —
    // the already-created task must NOT be re-reported as a refusal.
    writeLedgerWithReuse(path.join(tmpDir, '.state'), candidateId);
    await handleCandidateInternalize({ candidateId, workspace: tmpDir, json: true });

    const lines = consoleLogSpy.mock.calls.map((c) => String(c[0])).filter((l) => l.trim().startsWith('{'));
    const result = JSON.parse(lines[lines.length - 1]) as Record<string, unknown>;
    expect(result.status).toBe('existing');
    expect(await listDreamerTasks(tmpDir)).toHaveLength(1);
  });  it('repaired raw kind does not bypass an existing invalid-kind Owner park', async () => {
    const sm = new RuntimeStateManager({ workspaceDir: tmpDir });
    await sm.initialize();
    const candidateId = await seedCandidate(sm, 'pain-d4-invalid-park', principleOutput('pain-d4-invalid-park'));
    const parked = await sm.updateAdmissionProcessing(candidateId, {
      state: 'awaiting_owner',
      attempts: 0,
      lastFailure: {
        reason: 'candidate_kind_invalid',
        nextAction: 'repair the raw kind and request Owner recovery',
        at: new Date().toISOString(),
      },
      blockedReason: 'candidate_kind_invalid:wizardry',
    });
    expect(parked).toBe(true);
    const dbPath = path.join(tmpDir, '.pd', 'state.db');
    await sm.close();

    const db = new Database(dbPath);
    db.prepare('UPDATE principle_candidates SET recommendation_kind = ? WHERE candidate_id = ?').run('principle', candidateId);
    db.close();

    await handleCandidateInternalize({ candidateId, workspace: tmpDir, json: true });

    const lines = consoleLogSpy.mock.calls.map((c) => String(c[0])).filter((l) => l.trim().startsWith('{'));
    const result = JSON.parse(lines[lines.length - 1]) as Record<string, unknown>;
    expect(result.status).toBe('refused');
    expect(result.reason).toBe('candidate_kind_recovery_required');
    expect(String(result.nextAction)).toContain('pd candidate resume-post-processing');
    expect(await listDreamerTasks(tmpDir)).toEqual([]);
  });


});
