/**
 * Phase 7.2 B2 — durable reuse-park persistence + automatic-intake
 * idempotency (LEDGER_WRITE_SAFETY_SPEC §4.2, matrix T-P1..T-P4 core half).
 *
 * Production evidence this file pins against (2026-11-11): candidate 2fd0e91b
 * was parked by the reuse gate at confidence 0.95 and consumed 33 seconds
 * later by a second intake that re-rolled the evaluation — the park existed
 * only in the returned result and a losable telemetry event.
 *
 * Contract under test:
 *   - the park is persisted on principle_candidates.admission_json.processing
 *     (awaiting_owner / reuse_pending_owner) INSIDE the intake service — the
 *     single chokepoint every automatic path (bridge / diagnose / pain-retry /
 *     candidate intake·repair·backfill) goes through (T-P1);
 *   - a repeated automatic intake REPLAYS the persisted park: no second LLM
 *     evaluation (hook not called again), no ledger write, no candidate state
 *     change — same process (T-P3), across a restart (fresh service + fresh
 *     adapter, T-P2), and even with the gate entirely unconfigured (T-P4:
 *     the park outlives the gate configuration that produced it);
 *   - the Owner verdict channel (injected reuseDecision) is the ONLY path
 *     that passes a parked candidate through;
 *   - a park that cannot be persisted fails the intake (never reported as a
 *     successful park without durability).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { join } from 'path';
import { mkdirSync, rmSync } from 'fs';
import { randomUUID } from 'crypto';
import { buildOwnerDecisionIntent } from '../../src/runtime/store/candidate/admission-document.js';

import { CandidateIntakeService } from '../../src/runtime/candidate-intake-service.js';
import type { ReuseRecommendationOutcome } from '../../src/runtime/candidate-intake-service.js';
import { RuntimeStateManager } from '../../src/runtime/store/runtime-state-manager.js';
import { PrincipleTreeLedgerAdapter } from '../../src/runtime/adapter/principle-tree-ledger-adapter.js';
import { addPrincipleToLedger, loadLedger } from '../../src/principle-tree-ledger.js';
import type { LedgerPrinciple } from '../../src/runtime/types/ledger-store.js';

const CANDIDATE_TEXT = '任何结论必须由可观察证据背书，无查验则显式降级为推断。';

function makePrinciple(overrides: Partial<LedgerPrinciple> = {}): LedgerPrinciple {
  return {
    id: randomUUID(),
    version: 1,
    // Near-identical (credible shortlist), never byte-equal (Phase 7.2 B1
    // exact-duplicate guard) — see the B1 test file for that contract.
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

/** Scripted auto-path recommendation hook: counts invocations, answers reuse. */
function reuseHook(targetPrincipleId: string) {
  const calls = { count: 0 };
  const hook = vi.fn(async (): Promise<ReuseRecommendationOutcome> => {
    calls.count += 1;
    return {
      status: 'recommended',
      recommendation: 'reuse',
      selectedPrincipleId: targetPrincipleId,
      rationale: 'scripted semantic duplicate',
      confidence: 0.95,
    };
  });
  return { hook, calls };
}

describe('Phase 7.2 B2 — durable reuse park + automatic intake idempotency', () => {
  let workspaceDir: string;
  let stateManager: RuntimeStateManager;
  let existing: LedgerPrinciple;
  let candidateId: string;

  beforeEach(async () => {
    workspaceDir = join(process.env.TEMP ?? '.', `pd-park-persist-${randomUUID()}`);
    mkdirSync(join(workspaceDir, '.pd'), { recursive: true });
    stateManager = new RuntimeStateManager({ workspaceDir });
    await stateManager.initialize();
    existing = makePrinciple();
    addPrincipleToLedger(join(workspaceDir, '.state'), existing);
    // eslint-disable-next-line @typescript-eslint/no-use-before-define -- seeder is kept beside the describe body it serves
    candidateId = await seedPrincipleCandidate();
  });

  afterEach(() => {
    try { stateManager.close(); } catch { /* best effort */ }
    try { rmSync(workspaceDir, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  it('T-P1: the park is persisted on admission processing — telemetry-independent, candidate stays pending, nothing else written', async () => {
    const { hook } = reuseHook(existing.id);
    const service = new CandidateIntakeService({
      stateManager,
      ledgerAdapter: new PrincipleTreeLedgerAdapter({ stateDir: join(workspaceDir, '.state') }),
      reuseRecommendation: hook,
      reuseStateDir: join(workspaceDir, '.state'),
    });

    const result = await service.intake(candidateId);

    expect(result.outcome).toBe('refused');
    if (result.outcome !== 'refused') return;
    expect(result.reason).toBe('reuse_pending_owner');

    const admission = await stateManager.getAdmissionDocument(candidateId);
    expect(admission.ok).toBe(true);
    expect(admission.document?.processing).toMatchObject({
      state: 'awaiting_owner',
      blockedReason: 'reuse_pending_owner',
    });

    const candidate = await stateManager.getCandidate(candidateId);
    expect(candidate && candidate.status).toBe('pending');
    // No ledger write, no evidence: the pre-seeded principle is untouched.
    const principles = loadLedger(join(workspaceDir, '.state')).tree.principles;
    expect(Object.keys(principles)).toHaveLength(1);
    expect(principles[existing.id]?.reuseEvidence).toBeUndefined();
  });

  it('T-P3: a repeated intake in the SAME process replays the persisted park — the hook is NOT called again', async () => {
    const { hook, calls } = reuseHook(existing.id);
    const service = new CandidateIntakeService({
      stateManager,
      ledgerAdapter: new PrincipleTreeLedgerAdapter({ stateDir: join(workspaceDir, '.state') }),
      reuseRecommendation: hook,
      reuseStateDir: join(workspaceDir, '.state'),
    });

    await service.intake(candidateId);
    expect(calls.count).toBe(1);

    const replay = await service.intake(candidateId);
    expect(calls.count).toBe(1); // no re-evaluation
    expect(replay.outcome).toBe('refused');
    if (replay.outcome !== 'refused') return;
    expect(replay.reason).toBe('reuse_pending_owner');
    // The replay shape carries NO proposal/recommendation payload — the
    // original recommendation is not reconstructed from telemetry.
    expect(replay.reuseProposal).toBeUndefined();
    expect(replay.reuseRecommendation).toBeUndefined();
    expect(replay.message).toContain('PERSISTED reuse gate decision');

    const candidate = await stateManager.getCandidate(candidateId);
    expect(candidate && candidate.status).toBe('pending');
    expect(Object.keys(loadLedger(join(workspaceDir, '.state')).tree.principles)).toHaveLength(1);
  });

  it('T-P2: after a restart (fresh service + fresh adapter) the park still replays — restart-recoverable by construction', async () => {
    const first = reuseHook(existing.id);
    await new CandidateIntakeService({
      stateManager,
      ledgerAdapter: new PrincipleTreeLedgerAdapter({ stateDir: join(workspaceDir, '.state') }),
      reuseRecommendation: first.hook,
      reuseStateDir: join(workspaceDir, '.state'),
    }).intake(candidateId);
    expect(first.calls.count).toBe(1);

    // "Restart": a brand-new adapter and service instance over the same
    // persisted workspace — the ONLY thing carried over is on-disk state.
    const second = reuseHook(existing.id);
    const replay = await new CandidateIntakeService({
      stateManager,
      ledgerAdapter: new PrincipleTreeLedgerAdapter({ stateDir: join(workspaceDir, '.state') }),
      reuseRecommendation: second.hook,
      reuseStateDir: join(workspaceDir, '.state'),
    }).intake(candidateId);

    expect(second.calls.count).toBe(0); // never re-asked
    expect(replay.outcome).toBe('refused');
    expect(Object.keys(loadLedger(join(workspaceDir, '.state')).tree.principles)).toHaveLength(1);
  });

  it('T-P4: the park replays even with the gate UNCONFIGURED — it outlives the gate configuration that produced it', async () => {
    const { hook } = reuseHook(existing.id);
    await new CandidateIntakeService({
      stateManager,
      ledgerAdapter: new PrincipleTreeLedgerAdapter({ stateDir: join(workspaceDir, '.state') }),
      reuseRecommendation: hook,
      reuseStateDir: join(workspaceDir, '.state'),
    }).intake(candidateId);

    // The T11 rollback switch (reuseEvaluation.enabled=false) removes the
    // hook — but a candidate parked while the gate WAS on must never become
    // createable again by that configuration change.
    const gateOff = new CandidateIntakeService({
      stateManager,
      ledgerAdapter: new PrincipleTreeLedgerAdapter({ stateDir: join(workspaceDir, '.state') }),
    });
    const replay = await gateOff.intake(candidateId);

    expect(replay.outcome).toBe('refused');
    if (replay.outcome !== 'refused') return;
    expect(replay.reason).toBe('reuse_pending_owner');
    expect(Object.keys(loadLedger(join(workspaceDir, '.state')).tree.principles)).toHaveLength(1);
    // The persisted terminal processing state is exactly what the worker
    // continuation backlog (listDiagnosisPostProcessingBacklog) excludes —
    // the bridge will not rescan it either.
    const admission = await stateManager.getAdmissionDocument(candidateId);
    expect(admission.document?.processing?.state).toBe('awaiting_owner');
  });

  it('Owner P1: recorded reuseEvidence + persisted park — the park WINS (the evidence replay cannot bypass it)', async () => {
    // The combined state the Owner's P1 finding describes: the ledger
    // records a reuse resolution AND the candidate still carries an
    // unreleased park. Step 2b's evidence replay ran FIRST before the fix
    // and returned reuse_selected, which downstream paths treated as a
    // terminal resolution — consuming the candidate and clearing the park
    // without an Owner decision. Now the step-1b park check precedes BOTH
    // idempotency replays.
    const adapter = new PrincipleTreeLedgerAdapter({ stateDir: join(workspaceDir, '.state') });
    adapter.appendReuseEvidence(existing.id, {
      painId: `pain-${candidateId}`,
      candidateId,
      decision: 'reuse',
      actor: { kind: 'owner', id: 'owner-1' },
      reason: 'recorded resolution that must NOT outrank the park',
      decidedAt: '2026-11-16T00:00:00.000Z',
    });
    expect(adapter.findReuseResolutionForCandidate(candidateId)).not.toBeNull(); // evidence IS there
    const parked = await stateManager.updateAdmissionProcessing(candidateId, {
      state: 'awaiting_owner',
      attempts: 0,
      blockedReason: 'reuse_pending_owner',
    });
    expect(parked).toBe(true);

    const { hook, calls } = reuseHook(existing.id);
    const result = await new CandidateIntakeService({
      stateManager,
      ledgerAdapter: adapter,
      reuseRecommendation: hook,
      reuseStateDir: join(workspaceDir, '.state'),
    }).intake(candidateId);

    expect(calls.count).toBe(0); // no evaluation ran
    expect(result.outcome).toBe('refused');
    if (result.outcome !== 'refused') return;
    expect(result.reason).toBe('reuse_pending_owner'); // the PARK answer, not reuse_selected
    expect(result.message).toContain('outranks');
    expect(result.reuseEvidence).toBeUndefined(); // the evidence replay was not used
    const candidate = await stateManager.getCandidate(candidateId);
    expect(candidate && candidate.status).toBe('pending');
    expect(Object.keys(loadLedger(join(workspaceDir, '.state')).tree.principles)).toHaveLength(1);
  });

  it('CodeRabbit race: a park persisted DURING the evaluation window blocks the CREATE path (post-gate re-check)', async () => {
    // Simulates the exact interleaving the step-2c check alone cannot see:
    // a concurrent automatic intake parks this candidate while OUR evaluation
    // is in flight — and the evaluation answers create. The post-gate re-check
    // (2c') must return the persisted park instead of minting the duplicate.
    const hook = vi.fn(async (): Promise<ReuseRecommendationOutcome> => {
      const parked = await stateManager.updateAdmissionProcessing(candidateId, {
        state: 'awaiting_owner',
        attempts: 0,
        blockedReason: 'reuse_pending_owner',
      });
      if (!parked) throw new Error('fixture failed to persist the mid-flight park');
      return {
        status: 'recommended',
        recommendation: 'create',
        rationale: 'late create answer',
        confidence: 0.9,
      };
    });
    const service = new CandidateIntakeService({
      stateManager,
      ledgerAdapter: new PrincipleTreeLedgerAdapter({ stateDir: join(workspaceDir, '.state') }),
      reuseRecommendation: hook,
      reuseStateDir: join(workspaceDir, '.state'),
    });

    const result = await service.intake(candidateId);

    expect(hook).toHaveBeenCalledTimes(1); // the evaluation DID run (and answered create)
    expect(result.outcome).toBe('refused');
    if (result.outcome !== 'refused') return;
    expect(result.reason).toBe('reuse_pending_owner');
    // The in-lock re-verification (2c″) answers with the persisted park —
    // the automatic path never mints over it.
    expect(result.message).toContain('PERSISTED reuse gate decision');
    // No duplicate was minted: the ledger still holds only the pre-seeded
    // principle, and the candidate stays pending for the Owner.
    expect(Object.keys(loadLedger(join(workspaceDir, '.state')).tree.principles)).toHaveLength(1);
    const candidate = await stateManager.getCandidate(candidateId);
    expect(candidate && candidate.status).toBe('pending');
  });

  it('P1-03: a bare injected reuseDecision callback does NOT pass a parked candidate — only a persisted Owner decision may', async () => {
    const { hook } = reuseHook(existing.id);
    await new CandidateIntakeService({
      stateManager,
      ledgerAdapter: new PrincipleTreeLedgerAdapter({ stateDir: join(workspaceDir, '.state') }),
      reuseRecommendation: hook,
      reuseStateDir: join(workspaceDir, '.state'),
    }).intake(candidateId);
    // The candidate is now durably parked.

    // (a) The legacy callback channel is NOT Owner authorization: the park
    // must hold even when a caller injects a create-verdict callback.
    const callbackService = new CandidateIntakeService({
      stateManager,
      ledgerAdapter: new PrincipleTreeLedgerAdapter({ stateDir: join(workspaceDir, '.state') }),
      reuseDecision: () => ({ decision: 'create' }),
      reuseStateDir: join(workspaceDir, '.state'),
    });
    const refused = await callbackService.intake(candidateId);
    expect(refused.outcome).toBe('refused');
    if (refused.outcome !== 'refused') return;
    expect(refused.reason).toBe('reuse_pending_owner');
    expect(Object.keys(loadLedger(join(workspaceDir, '.state')).tree.principles)).toHaveLength(1);

    // (b) The persisted-decision execution channel (P1-01 Phase B) DOES pass:
    // a typed pending Owner decision authorizes the park crossing, the park
    // itself stays until Phase C completes.
    const recorded = await stateManager.recordOwnerDecision(candidateId, buildOwnerDecisionIntent({
      candidateId,
      decision: 'create',
      ownerId: 'owner-test',
      identitySource: 'env',
      reason: 'P1-03 channel test',
    }));
    expect(recorded.status).toBe('appended');

    const decisionService = new CandidateIntakeService({
      stateManager,
      ledgerAdapter: new PrincipleTreeLedgerAdapter({ stateDir: join(workspaceDir, '.state') }),
      reuseStateDir: join(workspaceDir, '.state'),
    });
    const decisionId = recorded.status === 'appended' ? recorded.decision.decisionId : '';
    const executed = await decisionService.intake(candidateId, { ownerDecision: { decisionId } });
    expect(executed.outcome).toBe('ledger_entry');
    expect(Object.keys(loadLedger(join(workspaceDir, '.state')).tree.principles)).toHaveLength(2);

    // The park SURVIVED Phase B — only Phase C (completeOwnerDecision) lifts it.
    const afterB = await stateManager.getAdmissionDocument(candidateId);
    expect(afterB.ok && afterB.document?.processing?.state).toBe('awaiting_owner');
    const completed = await stateManager.completeOwnerDecision(candidateId, decisionId, {
      resultingPrincipleId: executed.outcome === 'ledger_entry' ? executed.entry.id : '',
    });
    expect(completed.status).toBe('completed');
    const afterC = await stateManager.getAdmissionDocument(candidateId);
    expect(afterC.ok && afterC.document?.processing?.state).toBe('complete');
    const decisions = afterC.ok && afterC.document ? afterC.document.ownerDecisions ?? [] : [];
    expect(decisions).toHaveLength(1);
    expect(decisions[0]?.executionStatus).toBe('applied');
  });

  it('a park that cannot be persisted fails the intake — no park is reported without durability', async () => {
    const { hook } = reuseHook(existing.id);
    const adapter = new PrincipleTreeLedgerAdapter({ stateDir: join(workspaceDir, '.state') });
    vi.spyOn(stateManager, 'updateAdmissionProcessing').mockImplementation(async () => {
      throw new Error('simulated admission write failure');
    });

    const service = new CandidateIntakeService({
      stateManager,
      ledgerAdapter: adapter,
      reuseRecommendation: hook,
      reuseStateDir: join(workspaceDir, '.state'),
    });

    await expect(service.intake(candidateId)).rejects.toMatchObject({
      name: 'CandidateIntakeError',
      code: 'reuse_check_failed',
      context: { reason: 'reuse_park_persistence_failed' },
    });
    vi.restoreAllMocks();

    const candidate = await stateManager.getCandidate(candidateId);
    expect(candidate && candidate.status).toBe('pending');
    expect(Object.keys(loadLedger(join(workspaceDir, '.state')).tree.principles)).toHaveLength(1);

    // Retry once the write path works: the park lands, replay engages.
    const retry = await new CandidateIntakeService({
      stateManager,
      ledgerAdapter: adapter,
      reuseRecommendation: hook,
      reuseStateDir: join(workspaceDir, '.state'),
    }).intake(candidateId);
    expect(retry.outcome).toBe('refused');
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
    // Direct row seeding via the store's connection is not exposed; reuse the
    // manager's own commit surface instead — the diagnostician committer path
    // is heavier than this fixture needs, so write the three rows through the
    // same sqlite file the manager owns (it is closed after the test).
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