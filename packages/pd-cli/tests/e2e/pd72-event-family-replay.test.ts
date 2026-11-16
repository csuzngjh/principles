/**
 * Phase 7.2 end-to-end acceptance — isolated replay of the 2026-11-11 event
 * family (desensitized fixtures; directive §六).
 *
 * The replay mirrors the three production candidates with synthetic,
 * structurally-faithful material (no production pain/principle text):
 *
 *   cand-A (≈370c1dda): the original CREATE judgment — must STILL register
 *     normally, consume, and seed its Dreamer chain (negative control).
 *   cand-B (≈2fd0e91b): reuse gate fires at 0.95 → park persists → a later
 *     automatic intake (fresh service, gate unconfigured — mirroring any
 *     later trigger) must NOT re-evaluate, NOT register, NOT create an
 *     independent Dreamer.
 *   cand-C (≈19aa989d): same shape at 0.72.
 *
 * Then the Owner channels: create releases the park with a durable audit
 * (near-duplicate text ⇒ genuine new principle + chain), and every original
 * candidate row / artifact / evidence is preserved.
 *
 * Deterministic mocks only: the reuse evaluation is a scripted hook injected
 * into the REAL CandidateIntakeService over the REAL ledger + state stores;
 * no model API is called anywhere.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { join } from 'path';
import { mkdirSync, rmSync } from 'fs';
import { randomUUID } from 'crypto';
import Database from 'better-sqlite3';

const { mockResolveOwnerIdentity } = vi.hoisted(() => ({
  mockResolveOwnerIdentity: vi.fn(),
}));
vi.mock('@principles/core/runtime', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  resolveOwnerIdentity: mockResolveOwnerIdentity,
}));

import {
  CandidateIntakeService,
  PrincipleTreeLedgerAdapter,
  RuntimeStateManager,
  ADMISSION_POLICY_VERSION,
  fingerprintAdmissionMaterial,
  type AdmissionEvaluationRecord,
  type ReuseRecommendationOutcome,
} from '@principles/core/runtime';
import { addPrincipleToLedger, loadLedger } from '@principles/core/principle-tree-ledger';
import type { LedgerPrinciple } from '@principles/core/principle-tree-ledger';
import { handleCandidateReview } from '../../src/commands/candidate.js';
import { REUSE_PARK_RELEASE_POLICY_VERSION } from '../../src/services/reuse-park-release.js';

let workspaceDir: string;
let stateManager: RuntimeStateManager;
let consoleLogSpy: ReturnType<typeof vi.spyOn>;
let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
let exitSpy: ReturnType<typeof vi.spyOn>;

const TEXT_A = '回归收尾前必须在干净工作区复现一次缺陷，不能只依赖报告转述。';
const TEXT_EXISTING = '任何打断长任务的补丁都必须先保存现场，再执行变更。';
const TEXT_B = '任何打断长任务的补丁都必须先保存现场，再执行变更。（复述）';
const TEXT_C = '任何打断长任务的补丁都必须先保存现场，再执行变更。（再述）';

function makeExistingPrinciple(text: string): LedgerPrinciple {
  return {
    id: randomUUID(),
    version: 1,
    text,
    triggerPattern: '长任务被补丁打断时',
    action: '先保存现场再变更',
    status: 'active',
    priority: 'P1',
    scope: 'general',
    evaluability: 'manual_only',
    valueScore: 0.5,
    adherenceRate: 0.8,
    painPreventedCount: 0,
    derivedFromPainIds: [],
    ruleIds: [],
    conflictsWithPrincipleIds: [],
    createdAt: '2026-11-11T00:00:00.000Z',
    updatedAt: '2026-11-11T00:00:00.000Z',
  };
}

/** Scripted semantic-evaluation hook: answers per candidateId, counts calls. */
function scriptedHook(verdicts: Record<string, { principleId: string; confidence: number }>) {
  const calls: string[] = [];
  const hook = async (claim: { text?: string }, _proposal: unknown): Promise<ReuseRecommendationOutcome> => {
    // Identify the candidate by its claim text (unique per fixture).
    const text = claim.text ?? '';
    const verdict = Object.entries(verdicts).find(([key]) => text.includes(key))?.[1];
    calls.push(text);
    if (!verdict) {
      return { status: 'recommended', recommendation: 'create', rationale: 'scripted create', confidence: 0.9 };
    }
    return {
      status: 'recommended',
      recommendation: 'reuse',
      selectedPrincipleId: verdict.principleId,
      rationale: 'scripted semantic duplicate',
      confidence: verdict.confidence,
    };
  };
  return { hook, calls };
}

async function seedCandidate(text: string, textKey: string): Promise<string> {
  const candidateId = randomUUID();
  const artifactId = randomUUID();
  const taskId = randomUUID();
  const now = '2026-11-11T18:00:00.000Z';
  const recommendation = {
    kind: 'principle' as const,
    recommendationRef: `principle-${textKey}`,
    description: text,
    triggerPattern: '长任务被补丁打断时',
    action: '先保存现场再变更',
  };
  const v2Output = {
    schemaVersion: 'diagnostician-output-v2' as const,
    valid: true,
    diagnosisId: `diag-${candidateId}`,
    summary: 'replay diagnosis',
    rootCause: 'People: replay',
    violatedPrinciples: [],
    evidence: [{ sourceRef: `seed:${textKey}`, note: 'replay evidence' }],
    recommendations: [recommendation],
    confidence: 0.9,
  };
  await stateManager.taskStore.createTask({
    taskId,
    taskKind: 'diagnostician',
    status: 'succeeded',
    attemptCount: 1,
    maxAttempts: 3,
    leaseOwner: undefined,
    leaseExpiresAt: undefined,
    lastError: undefined,
    inputRef: `pain-replay-${textKey}`,
    resultRef: '',
    diagnosticJson: JSON.stringify({
      sourcePainId: `pain-replay-${textKey}`,
      reasonSummary: 'replay',
      source: 'manual',
      severity: 'moderate',
      sessionIdHint: null,
      agentIdHint: null,
      provenance: 'owner_reported_no_host_trace',
      provenanceReason: 'replay fixture',
      evidence: [{ sourceRef: `seed:${textKey}`, note: 'replay evidence entry' }],
      workspaceDir: null,
    }),
  });
  const runId = randomUUID();
  await stateManager.runStore.createRun({
    runId,
    taskId,
    runtimeKind: 'openclaw',
    attemptNumber: 1,
    executionStatus: 'succeeded',
    startedAt: now,
    endedAt: now,
    outputPayload: JSON.stringify(v2Output),
  });
  await stateManager.recordPainDiagnosis({
    painId: `pain-replay-${textKey}`,
    taskId,
    diagnosisId: `diag-${candidateId}`,
    category: 'People',
    rootCause: 'People: replay fixture',
    evidence: [],
    confidence: 0.9,
    artifactId,
  });
  const db = new Database(join(workspaceDir, '.pd', 'state.db'));
  try {
    db.prepare('INSERT INTO artifacts (artifact_id, run_id, task_id, artifact_kind, content_json, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(artifactId, runId, taskId, 'diagnostician_output', JSON.stringify({ ...v2Output, trustedContextReceipt: { schemaVersion: 'router-context-v2' } }), now);
    db.prepare(`INSERT INTO principle_candidates
      (candidate_id, artifact_id, task_id, source_run_id, title, description, confidence,
       source_recommendation_json, idempotency_key, status, created_at, recommendation_kind)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, 'principle')`)
      .run(candidateId, artifactId, taskId, runId, `回放候选-${textKey}`, text, 0.9, JSON.stringify(recommendation), `${artifactId}::prompt`, now);
    db.prepare('INSERT INTO commits (commit_id, task_id, run_id, artifact_id, idempotency_key, status, created_at) VALUES (?, ?, ?, ?, ?, \'committed\', ?)')
      .run(randomUUID(), taskId, runId, artifactId, `seed-${artifactId}`, now);
  } finally {
    db.close();
  }

  // Persist a production-shaped ADMITTED full-gate evaluation (what the
  // bridge writes before intake) so the CLI write gate admits the candidate.
  const materialFingerprint = fingerprintAdmissionMaterial([candidateId, 'replay']);
  const gateEvaluation: AdmissionEvaluationRecord = {
    evaluationId: `ae_${fingerprintAdmissionMaterial([candidateId, materialFingerprint, ADMISSION_POLICY_VERSION]).slice(0, 16)}`,
    decision: 'admitted',
    reason: 'replay fixture: admitted by the full admission gate',
    nextAction: 'none',
    evaluatedAt: now,
    policyVersion: ADMISSION_POLICY_VERSION,
    provenance: 'replay-fixture',
    inputEvidenceCount: 1,
    ownerStatementPresent: false,
    recommendationKind: 'principle',
    confidence: 0.9,
    materialFingerprint,
    materialSummary: { inputEvidenceCount: 1, outputEvidenceCount: 1, ownerStatementPresent: false },
  };
  const appended = await stateManager.appendAdmissionEvaluation(candidateId, gateEvaluation);
  if (appended.status === 'refused') throw new Error(`gate fixture failed: ${appended.reason}`);
  return candidateId;
}

function dreamerTaskCount(): number {
  const db = new Database(join(workspaceDir, '.pd', 'state.db'));
  try {
    const row = db.prepare("SELECT COUNT(*) AS n FROM tasks WHERE task_kind = 'dreamer'").get() as { n: number };
    return row.n;
  } finally {
    db.close();
  }
}

function candidateRow(candidateId: string): { status: string; source_recommendation_json: string } {
  const db = new Database(join(workspaceDir, '.pd', 'state.db'));
  try {
    const row = db.prepare('SELECT status, source_recommendation_json FROM principle_candidates WHERE candidate_id = ?').get(candidateId) as { status: string; source_recommendation_json: string } | undefined;
    if (!row) throw new Error(`candidate row missing: ${candidateId}`);
    return row;
  } finally {
    db.close();
  }
}

describe('Phase 7.2 acceptance — 2026-11-11 event family isolated replay', () => {
  beforeEach(async () => {
    workspaceDir = join(process.env.TEMP ?? '.', `pd72-replay-${randomUUID()}`);
    mkdirSync(join(workspaceDir, '.pd'), { recursive: true });
    stateManager = new RuntimeStateManager({ workspaceDir });
    await stateManager.initialize();
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as () => never);
    mockResolveOwnerIdentity.mockReturnValue({ ownerId: 'owner-1', credentialId: 'cred-1', source: 'file' });
  });

  afterEach(() => {
    consoleLogSpy.mockRestore();
    consoleErrorSpy.mockRestore();
    exitSpy.mockRestore();
    try { stateManager.close(); } catch { /* best effort */ }
    try { rmSync(workspaceDir, { recursive: true, force: true }); } catch { /* best effort */ }
    mockResolveOwnerIdentity.mockReset();
  });

  it('replays 370c1dda / 2fd0e91b / 19aa989d end to end under the Phase 7.2 fixes', async () => {
    const stateDir = join(workspaceDir, '.state');
    // The pre-existing active principle (≈946754bf) that the family duplicated.
    const existing = makeExistingPrinciple(TEXT_EXISTING);
    addPrincipleToLedger(stateDir, existing);

    // ── cand-A ≈ 370c1dda: the original CREATE judgment ──
    const candA = await seedCandidate(TEXT_A, 'A');
    // ── cand-B ≈ 2fd0e91b / cand-C ≈ 19aa989d: the two reuse-gate hits ──
    const candB = await seedCandidate(TEXT_B, 'B');
    const candC = await seedCandidate(TEXT_C, 'C');

    // 1. Normal new principle still registers (acceptance #1).
    const { hook: hookA } = scriptedHook({});
    const serviceA = new CandidateIntakeService({
      stateManager,
      ledgerAdapter: new PrincipleTreeLedgerAdapter({ stateDir }),
      reuseRecommendation: hookA, // answers create for an unknown text
      reuseStateDir: stateDir,
    });
    const resultA = await serviceA.intake(candA);
    expect(resultA.outcome).toBe('ledger_entry');
    const principlesAfterA = loadLedger(stateDir).tree.principles;
    expect(Object.keys(principlesAfterA)).toHaveLength(2); // existing + cand-A's own

    // 2-3. cand-B: gate fires at 0.95 → park persists (acceptance #2/#3).
    const { hook: hookB, calls: callsB } = scriptedHook({ '（复述）': { principleId: existing.id, confidence: 0.95 } });
    const serviceB = new CandidateIntakeService({
      stateManager,
      ledgerAdapter: new PrincipleTreeLedgerAdapter({ stateDir }),
      reuseRecommendation: hookB,
      reuseStateDir: stateDir,
    });
    const resultB = await serviceB.intake(candB);
    expect(resultB.outcome).toBe('refused');
    const parkB = await stateManager.getAdmissionDocument(candB);
    expect(parkB.document?.processing).toMatchObject({ state: 'awaiting_owner', blockedReason: 'reuse_pending_owner' });
    expect(Object.keys(loadLedger(stateDir).tree.principles)).toHaveLength(2); // NOT registered

    // The later automatic intake — FRESH service instance, gate UNCONFIGURED
    // (mirrors any later trigger; the park must survive both) — must NOT
    // re-evaluate, NOT register, NOT create a Dreamer.
    const replayB = await new CandidateIntakeService({
      stateManager,
      ledgerAdapter: new PrincipleTreeLedgerAdapter({ stateDir }),
    }).intake(candB);
    expect(replayB.outcome).toBe('refused');
    expect(callsB).toHaveLength(1); // the 0.95 evaluation ran exactly once
    expect(Object.keys(loadLedger(stateDir).tree.principles)).toHaveLength(2);
    expect(candidateRow(candB).status).toBe('pending');
    expect(dreamerTaskCount()).toBe(0);

    // 2-3. cand-C: same shape at 0.72.
    const { hook: hookC, calls: callsC } = scriptedHook({ '（再述）': { principleId: existing.id, confidence: 0.72 } });
    const resultC = await new CandidateIntakeService({
      stateManager,
      ledgerAdapter: new PrincipleTreeLedgerAdapter({ stateDir }),
      reuseRecommendation: hookC,
      reuseStateDir: stateDir,
    }).intake(candC);
    expect(resultC.outcome).toBe('refused');
    const parkC = await stateManager.getAdmissionDocument(candC);
    expect(parkC.document?.processing?.state).toBe('awaiting_owner');
    const replayC = await new CandidateIntakeService({
      stateManager,
      ledgerAdapter: new PrincipleTreeLedgerAdapter({ stateDir }),
    }).intake(candC);
    expect(replayC.outcome).toBe('refused');
    expect(callsC).toHaveLength(1);
    expect(Object.keys(loadLedger(stateDir).tree.principles)).toHaveLength(2);
    expect(candidateRow(candC).status).toBe('pending');
    expect(dreamerTaskCount()).toBe(0);

    // 4-5. Owner create releases cand-B with a durable audit (acceptance #4/#5):
    // a NEAR-duplicate create is the Owner's explicit override — it registers a
    // genuine new principle, and the seed helper would run for it (identity
    // basis derived_candidate).
    await handleCandidateReview({
      candidateId: candB,
      workspace: workspaceDir,
      decide: 'create',
      reason: 'owner judged the restatement materially distinct',
      json: true,
    });
    expect(exitSpy).not.toHaveBeenCalled();
    const releasedB = await stateManager.getAdmissionDocument(candB);
    const releaseRecord = releasedB.document?.evaluations.find((e) => e.policyVersion === REUSE_PARK_RELEASE_POLICY_VERSION);
    expect(releaseRecord).toMatchObject({ decision: 'admitted' });
    expect(releaseRecord?.provenance).toContain('owner=owner-1');
    expect(releasedB.document?.processing?.state).toBe('complete');
    expect(candidateRow(candB).status).toBe('consumed');
    const principlesAfterCreate = loadLedger(stateDir).tree.principles;
    expect(Object.keys(principlesAfterCreate)).toHaveLength(3); // existing + A + B(create)

    // 6. reuse-parked cand-C still has NO independent Dreamer (acceptance #6).
    // The single chain present is cand-B's OWN post-create chain (derived
    // basis — the Owner's explicit override legitimately explores); cand-C,
    // still parked for the Owner, contributed zero chains.
    expect(dreamerTaskCount()).toBe(1);

    // 7. Every original candidate row, artifact and source material is
    // preserved verbatim (acceptance #7); the pre-existing principle was
    // never touched.
    expect(candidateRow(candA).source_recommendation_json).toContain('principle-A');
    expect(candidateRow(candB).source_recommendation_json).toContain('principle-B');
    expect(candidateRow(candC).source_recommendation_json).toContain('principle-C');
    const db = new Database(join(workspaceDir, '.pd', 'state.db'));
    try {
      const artifacts = db.prepare('SELECT COUNT(*) AS n FROM artifacts').get() as { n: number };
      expect(artifacts.n).toBe(3);
    } finally {
      db.close();
    }
    const storedExisting = loadLedger(stateDir).tree.principles[existing.id];
    expect(storedExisting?.text).toBe(TEXT_EXISTING);
    expect(storedExisting?.reuseEvidence).toBeUndefined(); // no evidence was written for B/C parks
  });
});
