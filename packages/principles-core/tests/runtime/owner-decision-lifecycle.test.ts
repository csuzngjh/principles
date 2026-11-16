/**
 * Phase 7.2 P1-01 — recoverable Owner decision lifecycle.
 *
 * Directive §2/§7 matrix coverage at three levels:
 *   - document (admission-document.ts pure transitions + parse round-trip);
 *   - store (SQLite recordOwnerDecision / completeOwnerDecision, one
 *     transactional write per Phase C);
 *   - service (CandidateIntakeService ownerDecision execution channel on the
 *     REAL adapter + REAL stores + coordination lock).
 *
 * Crash-recovery rows (P1-R01..R06) are simulated by persisting the exact
 * intermediate durable state a crash would leave, then running the recovery
 * path (re-run of the same verdict) and asserting the single correct end
 * state — no duplicate artifacts, no re-ask, park cleared only in Phase C.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { join } from 'path';
import { mkdirSync, rmSync } from 'fs';
import { randomUUID } from 'crypto';

import {
  buildOwnerDecisionIntent,
  completeOwnerDecision as completeInDocument,
  ownerDecisionId,
  parseAdmissionDocument,
  pendingOwnerDecision,
  appliedOwnerDecision,
  recordOwnerDecision as recordInDocument,
  OWNER_DECISION_POLICY_VERSION,
  type OwnerDecisionRecord,
} from '../../src/runtime/store/candidate/admission-document.js';
import { CandidateIntakeService } from '../../src/runtime/candidate-intake-service.js';
import { CandidateIntakeError } from '../../src/runtime/candidate-intake.js';
import { RuntimeStateManager } from '../../src/runtime/store/runtime-state-manager.js';
import { PrincipleTreeLedgerAdapter } from '../../src/runtime/adapter/principle-tree-ledger-adapter.js';
import { addPrincipleToLedger, appendReuseEvidence, loadLedger } from '../../src/principle-tree-ledger.js';
import type { LedgerPrinciple } from '../../src/runtime/types/ledger-store.js';

const CANDIDATE_TEXT = '任何结论必须由可观察证据背书，无查验则显式降级为推断。';

function makePrinciple(overrides: Partial<LedgerPrinciple> = {}): LedgerPrinciple {
  return {
    id: randomUUID(),
    version: 1,
    text: `${CANDIDATE_TEXT}（既有表述 ${randomUUID().slice(0, 8)}）`,
    triggerPattern: '在没有外部证据就做出确定性结论时',
    action: '先核验可观察状态再断言',
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
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function reuseIntent(candidateId: string, selectedPrincipleId: string, reason = 'owner reuse verdict'): OwnerDecisionRecord {
  return buildOwnerDecisionIntent({
    candidateId,
    decision: 'reuse',
    selectedPrincipleId,
    ownerId: 'owner-lifecycle',
    identitySource: 'env',
    reason,
  });
}

describe('Phase 7.2 P1-01 — Owner decision document transitions (pure)', () => {
  it('parse round-trips ownerDecisions; malformed history fails the WHOLE document (rc-3)', () => {
    const intent = reuseIntent('cand-1', 'p-1');
    const recorded = recordInDocument(null, intent);
    expect(recorded.status).toBe('appended');
    const document = recorded.document;
    const serialized = JSON.stringify(document);
    const parsed = parseAdmissionDocument(serialized);
    expect(parsed.ok).toBe(true);
    expect(parsed.ok && parsed.document?.ownerDecisions).toHaveLength(1);
    expect(parsed.ok && parsed.document?.ownerDecisions?.[0]).toMatchObject({
      decisionId: intent.decisionId,
      decision: 'reuse',
      selectedPrincipleId: 'p-1',
      executionStatus: 'pending',
      policyVersion: OWNER_DECISION_POLICY_VERSION,
    });

    const corrupt = parseAdmissionDocument(JSON.stringify({
      schemaVersion: 1,
      evaluations: [],
      currentEvaluationId: null,
      ownerDecisions: [{ candidateId: 'cand-1' }], // missing the typed lifecycle minimum
    }));
    expect(corrupt.ok).toBe(false);
    if (!corrupt.ok) expect(corrupt.reason).toBe('admission_json_owner_decision_invalid');

    // Old documents without the field still parse (backward compatible).
    const legacy = parseAdmissionDocument(JSON.stringify({
      schemaVersion: 1,
      evaluations: [],
      currentEvaluationId: null,
    }));
    expect(legacy.ok && legacy.document?.ownerDecisions).toBeUndefined();
  });

  it('decisionId is stable across idempotent re-runs and distinct across verdicts', () => {
    const base = { candidateId: 'cand-1', ownerId: 'owner-1', reason: 'r1' };
    expect(ownerDecisionId({ ...base, decision: 'reuse', selectedPrincipleId: 'p-1' }))
      .toBe(ownerDecisionId({ ...base, decision: 'reuse', selectedPrincipleId: 'p-1' }));
    expect(ownerDecisionId({ ...base, decision: 'reuse', selectedPrincipleId: 'p-1' }))
      .not.toBe(ownerDecisionId({ ...base, decision: 'reuse', selectedPrincipleId: 'p-2' }));
    expect(ownerDecisionId({ ...base, decision: 'reuse', selectedPrincipleId: 'p-1' }))
      .not.toBe(ownerDecisionId({ ...base, decision: 'create' }));
  });

  it('record → resume → supersede → complete state machine (P1-R01 intent-only keeps the park)', () => {
    const first = reuseIntent('cand-1', 'p-1', 'first reason');
    const resumed = recordInDocument(recordInDocument(null, first).document, first);
    expect(resumed.status).toBe('resumed'); // same decisionId — no duplicate record

    const other = buildOwnerDecisionIntent({
      candidateId: 'cand-1', decision: 'create', ownerId: 'owner-lifecycle', identitySource: 'env', reason: 'changed my mind',
    });
    const superseded = recordInDocument(recordInDocument(null, first).document, other);
    expect(superseded.status).toBe('superseded');
    expect(superseded.supersededDecisionId).toBe(first.decisionId);
    expect(pendingOwnerDecision(superseded.document)?.decisionId).toBe(other.decisionId);

    // Completing a superseded decision refuses; completing the pending one applies.
    const bad = completeInDocument(superseded.document, first.decisionId, { resultingPrincipleId: 'p-9' });
    expect(bad.status).toBe('refused');
    const done = completeInDocument(superseded.document, other.decisionId, { resultingPrincipleId: 'p-new' });
    expect(done.status).toBe('completed');
    expect(appliedOwnerDecision(done.document)?.resultingPrincipleId).toBe('p-new');
    expect(done.document.processing?.state).toBe('complete');
    // Phase C is idempotent: a re-run reports already_completed, rewrites nothing.
    const again = completeInDocument(done.document, other.decisionId, { resultingPrincipleId: 'p-new' });
    expect(again.status).toBe('already_completed');
  });

  it('a reuse intent without a selection is not buildable (rc-3)', () => {
    expect(() => buildOwnerDecisionIntent({
      candidateId: 'cand-1', decision: 'reuse', ownerId: 'o', identitySource: 'env', reason: 'r',
    })).toThrow(/selectedPrincipleId/);
  });
});

describe('Phase 7.2 P1-01 — Owner decision lifecycle on the real stores + service', () => {
  let workspaceDir: string;
  let stateManager: RuntimeStateManager;
  let adapter: PrincipleTreeLedgerAdapter;
  let existing: LedgerPrinciple;
  let candidateId: string;
  let stateDir: string;

  beforeEach(async () => {
    workspaceDir = join(process.env.TEMP ?? '.', `pd-owner-decision-${randomUUID()}`);
    mkdirSync(join(workspaceDir, '.pd'), { recursive: true });
    stateManager = new RuntimeStateManager({ workspaceDir });
    await stateManager.initialize();
    stateDir = join(workspaceDir, '.state');
    adapter = new PrincipleTreeLedgerAdapter({ stateDir });
    existing = makePrinciple();
    addPrincipleToLedger(stateDir, existing);
    // eslint-disable-next-line @typescript-eslint/no-use-before-define -- seeder is kept beside the describe body it serves
    candidateId = await seedPrincipleCandidate();
  });

  afterEach(() => {
    try { stateManager.close(); } catch { /* best effort */ }
    try { rmSync(workspaceDir, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  async function parkTheCandidate(): Promise<void> {
    const updated = await stateManager.updateAdmissionProcessing(candidateId, {
      state: 'awaiting_owner',
      attempts: 0,
      blockedReason: 'reuse_pending_owner',
    });
    if (!updated) throw new Error('fixture failed to persist the park');
  }

  function ownerExecutionService(): CandidateIntakeService {
    return new CandidateIntakeService({ stateManager, ledgerAdapter: adapter, reuseStateDir: stateDir });
  }

  it('P1-T05: legal Owner reuse — evidence written exactly once, park survives Phase B, Phase C clears it atomically', async () => {
    await parkTheCandidate();
    const recorded = await stateManager.recordOwnerDecision(candidateId, reuseIntent(candidateId, existing.id));
    expect(recorded.status).toBe('appended');
    const decisionId = recorded.status === 'appended' ? recorded.decision.decisionId : '';

    const result = await ownerExecutionService().intake(candidateId, { ownerDecision: { decisionId } });
    expect(result.outcome).toBe('refused');
    if (result.outcome !== 'refused') return;
    expect(result.reason).toBe('reuse_selected');
    expect(result.selectedPrincipleId).toBe(existing.id);
    expect(result.reuseEvidence?.decisionId).toBe(decisionId);
    expect(result.reuseEvidence?.actor).toEqual({ kind: 'owner', id: 'owner-lifecycle' });

    // Phase B durable, park STILL there (only Phase C lifts it).
    const evidenceAfterB = loadLedger(stateDir).tree.principles[existing.id]?.reuseEvidence;
    expect(evidenceAfterB).toHaveLength(1);
    const midDoc = await stateManager.getAdmissionDocument(candidateId);
    expect(midDoc.ok && midDoc.document?.processing?.state).toBe('awaiting_owner');

    // Phase C — one write: applied + release audit + complete.
    const completed = await stateManager.completeOwnerDecision(candidateId, decisionId, {
      resultingPrincipleId: existing.id,
      releaseEvaluation: {
        evaluationId: `ae_${randomUUID().slice(0, 16)}`,
        decision: 'admitted',
        reason: 'reuse-park release (reuse) by Owner — fixture',
        nextAction: 'fixture',
        evaluatedAt: new Date().toISOString(),
        policyVersion: 'reuse-park-release@1',
        provenance: 'fixture',
        inputEvidenceCount: 0,
        ownerStatementPresent: false,
        recommendationKind: 'principle',
        confidence: null,
        materialFingerprint: randomUUID(),
        materialSummary: { inputEvidenceCount: 0, outputEvidenceCount: 0, ownerStatementPresent: false },
      },
    });
    expect(completed.status).toBe('completed');
    const finalDoc = await stateManager.getAdmissionDocument(candidateId);
    expect(finalDoc.ok && finalDoc.document?.processing?.state).toBe('complete');
    const decisions = finalDoc.ok && finalDoc.document ? finalDoc.document.ownerDecisions ?? [] : [];
    expect(decisions[0]?.executionStatus).toBe('applied');
    expect(decisions[0]?.resultingPrincipleId).toBe(existing.id);
    // The release audit evaluation is part of the same document.
    expect(finalDoc.ok && finalDoc.document?.evaluations.some((e) => e.policyVersion === 'reuse-park-release@1')).toBe(true);
    // Evidence written exactly once.
    expect(loadLedger(stateDir).tree.principles[existing.id]?.reuseEvidence).toHaveLength(1);
  });

  it('P1-T09 + P1-R03: crash after the evidence append, before Phase C — re-run resumes without a second entry', async () => {
    await parkTheCandidate();
    const recorded = await stateManager.recordOwnerDecision(candidateId, reuseIntent(candidateId, existing.id));
    const decisionId = recorded.status === 'appended' ? recorded.decision.decisionId : '';
    // Phase B ran (evidence durable), Phase C did NOT.
    await ownerExecutionService().intake(candidateId, { ownerDecision: { decisionId } });
    expect(loadLedger(stateDir).tree.principles[existing.id]?.reuseEvidence).toHaveLength(1);
    expect((await stateManager.getAdmissionDocument(candidateId)).document?.processing?.state).toBe('awaiting_owner');

    // Recovery: re-run the SAME verdict — Phase B replays idempotently (no
    // second evidence entry), then Phase C completes.
    const replay = await ownerExecutionService().intake(candidateId, { ownerDecision: { decisionId } });
    expect(replay.outcome).toBe('refused');
    expect(loadLedger(stateDir).tree.principles[existing.id]?.reuseEvidence).toHaveLength(1);
    const completed = await stateManager.completeOwnerDecision(candidateId, decisionId, { resultingPrincipleId: existing.id });
    expect(completed.status).toBe('completed');
    // P1-R04 shape: completing AGAIN is the idempotent already_completed.
    const again = await stateManager.completeOwnerDecision(candidateId, decisionId, { resultingPrincipleId: existing.id });
    expect(again.status).toBe('already_completed');
  });

  it('P1-T06 + P1-R02: Owner create — entry written, Phase C applied; crash between write and Phase C resumes via the ledger replay', async () => {
    const recorded = await stateManager.recordOwnerDecision(candidateId, buildOwnerDecisionIntent({
      candidateId, decision: 'create', ownerId: 'owner-lifecycle', identitySource: 'env', reason: 'create it',
    }));
    const decisionId = recorded.status === 'appended' ? recorded.decision.decisionId : '';

    const result = await ownerExecutionService().intake(candidateId, { ownerDecision: { decisionId } });
    expect(result.outcome).toBe('ledger_entry');
    const entryId = result.outcome === 'ledger_entry' ? result.entry.id : '';
    expect(result.written).toBe(true);
    // Crash before Phase C: decision still pending.
    expect((await stateManager.getAdmissionDocument(candidateId)).document?.ownerDecisions?.[0]?.executionStatus).toBe('pending');

    // Recovery re-run: the in-lock ledger replay returns the SAME entry, then
    // Phase C applies with the existing id.
    const replay = await ownerExecutionService().intake(candidateId, { ownerDecision: { decisionId } });
    expect(replay.outcome).toBe('ledger_entry');
    if (replay.outcome === 'ledger_entry') {
      expect(replay.written).toBe(false);
      expect(replay.entry.id).toBe(entryId);
    }
    expect(Object.keys(loadLedger(stateDir).tree.principles)).toHaveLength(2);
    const completed = await stateManager.completeOwnerDecision(candidateId, decisionId, { resultingPrincipleId: entryId });
    expect(completed.status).toBe('completed');
  });

  it('P1-T06b: Owner create on BYTE-IDENTICAL text follows the B1 dedup contract — the decision applies with the SURVIVOR id', async () => {
    // Pre-seed a principle with EXACTLY the candidate's text.
    addPrincipleToLedger(stateDir, makePrinciple({ text: CANDIDATE_TEXT }));
    const recorded = await stateManager.recordOwnerDecision(candidateId, buildOwnerDecisionIntent({
      candidateId, decision: 'create', ownerId: 'owner-lifecycle', identitySource: 'env', reason: 'create (duplicate text)',
    }));
    const decisionId = recorded.status === 'appended' ? recorded.decision.decisionId : '';
    const result = await ownerExecutionService().intake(candidateId, { ownerDecision: { decisionId } });
    expect(result.outcome).toBe('ledger_entry');
    if (result.outcome !== 'ledger_entry') return;
    expect(result.written).toBe(false);
    expect(result.deduplicatedAgainst).toBeDefined();
    expect(Object.keys(loadLedger(stateDir).tree.principles)).toHaveLength(2); // no third entry
    // The dedup audit (ai_owner/exact-dedupe-guard) carries the cross-candidate evidence.
    const survivor = loadLedger(stateDir).tree.principles[result.entry.id];
    expect(survivor?.reuseEvidence?.some((e) => e.candidateId === candidateId)).toBe(true);
  });

  it('P1-T07/T08: an execution context that does not verify fails loud — wrong decisionId, applied decision, foreign candidate', async () => {
    await parkTheCandidate();
    const recorded = await stateManager.recordOwnerDecision(candidateId, reuseIntent(candidateId, existing.id));
    const decisionId = recorded.status === 'appended' ? recorded.decision.decisionId : '';

    const wrongId = await ownerExecutionService().intake(candidateId, { ownerDecision: { decisionId: 'od_nonexistent' } })
      .then(() => null, (e: unknown) => e);
    expect(wrongId).toBeInstanceOf(CandidateIntakeError);
    expect((wrongId as CandidateIntakeError).context).toMatchObject({ reason: 'owner_decision_not_found' });

    // Complete the decision, then present it again: already_applied refuses re-execution.
    await ownerExecutionService().intake(candidateId, { ownerDecision: { decisionId } });
    await stateManager.completeOwnerDecision(candidateId, decisionId, { resultingPrincipleId: existing.id });
    const applied = await ownerExecutionService().intake(candidateId, { ownerDecision: { decisionId } })
      .then(() => null, (e: unknown) => e);
    expect(applied).toBeInstanceOf(CandidateIntakeError);
    expect((applied as CandidateIntakeError).context).toMatchObject({ reason: 'owner_decision_already_applied' });
  });

  it('P1-T01: park + recorded reuseEvidence combined — the AUTOMATIC path still refuses on the park', async () => {
    await parkTheCandidate();
    // Simulate the historical inconsistency: evidence ALSO exists.
    appendReuseEvidence(stateDir, existing.id, {
      painId: 'pain-historical', candidateId,
      decision: 'reuse',
      actor: { kind: 'ai_owner', id: 'fixture' },
      reason: 'historical evidence race fixture',
      decidedAt: new Date().toISOString(),
    });
    const auto = new CandidateIntakeService({ stateManager, ledgerAdapter: adapter });
    const result = await auto.intake(candidateId);
    expect(result.outcome).toBe('refused');
    if (result.outcome !== 'refused') return;
    expect(result.reason).toBe('reuse_pending_owner');
    // Park intact, candidate pending.
    expect((await stateManager.getAdmissionDocument(candidateId)).document?.processing?.state).toBe('awaiting_owner');
    expect((await stateManager.getCandidate(candidateId))?.status).toBe('pending');
  });

  it('P1-T02: park + derived ledger entry combined — the AUTOMATIC path refuses, nothing consumed', async () => {
    await parkTheCandidate();
    // The candidate's OWN principle also exists (e.g. created by a racing
    // intake right before the park landed).
    addPrincipleToLedger(stateDir, makePrinciple({ text: CANDIDATE_TEXT, derivedFromPainIds: [candidateId] }));
    const auto = new CandidateIntakeService({ stateManager, ledgerAdapter: adapter });
    const result = await auto.intake(candidateId);
    expect(result.outcome).toBe('refused');
    if (result.outcome !== 'refused') return;
    expect(result.reason).toBe('reuse_pending_owner');
    expect((await stateManager.getCandidate(candidateId))?.status).toBe('pending');
  });

  it('pending Owner decision without a park — the AUTOMATIC path refuses owner_decision_pending and does not override', async () => {
    const recorded = await stateManager.recordOwnerDecision(candidateId, buildOwnerDecisionIntent({
      candidateId, decision: 'create', ownerId: 'owner-lifecycle', identitySource: 'env', reason: 'pending create',
    }));
    expect(recorded.status).toBe('appended');

    const auto = new CandidateIntakeService({ stateManager, ledgerAdapter: adapter });
    const result = await auto.intake(candidateId);
    expect(result.outcome).toBe('refused');
    if (result.outcome !== 'refused') return;
    expect(result.reason).toBe('owner_decision_pending');
    expect(result.message).toContain('pd candidate review');
    // No ledger write happened: only the pre-seeded principle exists.
    expect(Object.keys(loadLedger(stateDir).tree.principles)).toHaveLength(1);
    expect((await stateManager.getCandidate(candidateId))?.status).toBe('pending');
  });

  it('P1-T10 + supersede guard: a differing verdict may only supersede a PROVABLY unexecuted pending decision', async () => {
    // Pending reuse decision that ALREADY executed its evidence (crash before
    // Phase C): superseding must fail closed.
    const reuseRec = await stateManager.recordOwnerDecision(candidateId, reuseIntent(candidateId, existing.id));
    const reuseDecisionId = reuseRec.status === 'appended' ? reuseRec.decision.decisionId : '';
    await ownerExecutionService().intake(candidateId, { ownerDecision: { decisionId: reuseDecisionId } });
    // The store itself is mechanical; the pd-cli service refuses the supersede
    // via its execution probe. Simulate the probe here with the real adapter.
    const executed = adapter.findReuseResolutionForCandidate(candidateId) !== null;
    expect(executed).toBe(true);
    // (The CLI-level guard is covered in pd-cli candidate-review tests; the
    // store-level supersede for an UNEXECUTED pending decision is below.)

    // eslint-disable-next-line @typescript-eslint/no-use-before-define -- seeder is kept beside the describe body it serves
    const secondCandidate = await seedPrincipleCandidate();
    const pendingCreate = buildOwnerDecisionIntent({
      candidateId: secondCandidate, decision: 'create', ownerId: 'owner-lifecycle', identitySource: 'env', reason: 'first thought',
    });
    const rec1 = await stateManager.recordOwnerDecision(secondCandidate, pendingCreate);
    expect(rec1.status).toBe('appended');
    const reuseIntent2 = reuseIntent(secondCandidate, existing.id);
    const rec2 = await stateManager.recordOwnerDecision(secondCandidate, reuseIntent2);
    expect(rec2.status).toBe('superseded');
    const doc = await stateManager.getAdmissionDocument(secondCandidate);
    const decisions = doc.ok && doc.document ? doc.document.ownerDecisions ?? [] : [];
    expect(decisions).toHaveLength(2);
    expect(decisions[0]?.executionStatus).toBe('superseded');
    expect(pendingOwnerDecision(doc.ok ? doc.document ?? null : null)?.decisionId).toBe(reuseIntent2.decisionId);
  });

  it('P1-R05/R06: unreadable admission document fails the execution verification (fail-closed)', async () => {
    const probe = vi.spyOn(stateManager, 'getAdmissionDocument').mockResolvedValue({ ok: false, reason: 'admission_json_unparseable' } as never);
    const rejected = await ownerExecutionService().intake(candidateId, { ownerDecision: { decisionId: 'od_x' } })
      .then(() => null, (e: unknown) => e);
    expect(rejected).toBeInstanceOf(CandidateIntakeError);
    expect((rejected as CandidateIntakeError).context).toMatchObject({ reason: 'admission_unreadable' });
    probe.mockRestore();
  });

  /** Seed a V2-provenance principle candidate on the real stores. */
  async function seedPrincipleCandidate(): Promise<string> {
    const id = randomUUID();
    const artifactId = randomUUID();
    const taskId = randomUUID();
    const now = new Date().toISOString();
    const recommendation = {
      kind: 'principle' as const,
      recommendationRef: 'principle-1',
      description: CANDIDATE_TEXT,
      triggerPattern: '在没有外部证据就做出确定性结论时',
      action: '先核验可观察状态再断言',
    };
    const v2Output = {
      schemaVersion: 'diagnostician-output-v2' as const,
      valid: true,
      diagnosisId: `diag-${id}`,
      summary: 'seeded diagnosis',
      rootCause: 'People: seeded',
      violatedPrinciples: [],
      evidence: [{ sourceRef: 'input', note: 'seeded' }],
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
      inputRef: `pain-seed-${id}`,
      resultRef: '',
      diagnosticJson: JSON.stringify({ sourcePainId: `pain-seed-${id}` }),
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
      painId: `pain-${id}`,
      taskId,
      diagnosisId: `diag-${id}`,
      category: 'People',
      rootCause: 'People: seeded',
      evidence: [],
      confidence: 0.9,
      artifactId,
    });
    const Database = (await import('better-sqlite3')).default;
    const db = new Database(join(workspaceDir, '.pd', 'state.db'));
    try {
      db.prepare('INSERT INTO artifacts (artifact_id, run_id, task_id, artifact_kind, content_json, created_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(artifactId, runId, taskId, 'diagnostician_output', JSON.stringify({ ...v2Output, trustedContextReceipt: { schemaVersion: 'router-context-v2' } }), now);
      db.prepare(`INSERT INTO principle_candidates
        (candidate_id, artifact_id, task_id, source_run_id, title, description, confidence,
         source_recommendation_json, idempotency_key, status, created_at, recommendation_kind)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, 'principle')`)
        .run(id, artifactId, taskId, runId, '测试候选', CANDIDATE_TEXT, 0.9, JSON.stringify(recommendation), `${artifactId}::prompt`, now);
    } finally {
      db.close();
    }
    return id;
  }
});
