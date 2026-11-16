import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'path';
import { mkdirSync, rmSync } from 'fs';
import { randomUUID } from 'crypto';

import {
} from '../../src/runtime/store/candidate/admission-document.js';
import { CandidateIntakeService } from '../../src/runtime/candidate-intake-service.js';
import { CandidateIntakeError } from '../../src/runtime/candidate-intake.js';
import { RuntimeStateManager } from '../../src/runtime/store/runtime-state-manager.js';
import { PrincipleTreeLedgerAdapter } from '../../src/runtime/adapter/principle-tree-ledger-adapter.js';
import { addPrincipleToLedger, loadLedger } from '../../src/principle-tree-ledger.js';
import type { LedgerPrinciple } from '../../src/runtime/types/ledger-store.js';
import {
  recordOwnerDecisionIntent,
  completeOwnerDecisionExecution,
} from '../../../pd-cli/src/services/reuse-park-release.js';

const CANDIDATE_TEXT = '复核修复验证：并发与组合态必须 fail-closed。';

function makePrinciple(overrides: Partial<LedgerPrinciple> = {}): LedgerPrinciple {
  return {
    id: randomUUID(),
    version: 1,
    text: `${CANDIDATE_TEXT}（既有表述 ${randomUUID().slice(0, 8)}）`,
    triggerPattern: '复核时',
    action: '拒绝冲突',
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

describe('P1 review round 3 — coordination serialization + reuse-vs-derived-entry', () => {
  let workspaceDir: string;
  let stateManager: RuntimeStateManager;
  let adapter: PrincipleTreeLedgerAdapter;
  let stateDir: string;
  let existing: LedgerPrinciple;
  let candidateId: string;

  beforeEach(async () => {
    workspaceDir = join(process.env.TEMP ?? '.', `pd-p1r3-${randomUUID()}`);
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
    const ok = await stateManager.updateAdmissionProcessing(candidateId, {
      state: 'awaiting_owner', attempts: 0, blockedReason: 'reuse_pending_owner',
    });
    if (!ok) throw new Error('park fixture failed');
  }

  function cliPhaseA(decide: 'reuse' | 'create', selectedPrincipleId?: string) {
    return recordOwnerDecisionIntent({
      stateManager,
      executionProbe: adapter,
      coordination: adapter,
      candidateId,
      decide,
      reason: `p1r3 ${decide}`,
      ownerId: 'owner-p1r3',
      identitySource: 'env',
      rawRecommendationKind: 'principle',
      ...(decide === 'reuse' ? { selectedPrincipleId } : {}),
    });
  }

  function executionService(): CandidateIntakeService {
    return new CandidateIntakeService({ stateManager, ledgerAdapter: adapter, reuseStateDir: stateDir });
  }

  it('P1-2: park + derived own entry + Owner REUSE fails closed — park intact, decision pending, no consumption', async () => {
    await parkTheCandidate();
    // The historical anomaly shape: the candidate ALREADY has its own ledger
    // principle (derived entry) while parked as a suspected duplicate.
    const derivedId = randomUUID();
    addPrincipleToLedger(stateDir, makePrinciple({
      id: derivedId,
      text: 'P1-2 组合态：候选自己的 derived 原则。',
      derivedFromPainIds: [candidateId],
    }));

    const phaseA = await cliPhaseA('reuse', existing.id);
    expect(phaseA.status).toBe('recorded');

    const rejected = await executionService()
      .intake(candidateId, { ownerDecision: { decisionId: phaseA.decision.decisionId } })
      .then(() => null, (e: unknown) => e);
    expect(rejected).toBeInstanceOf(CandidateIntakeError);
    expect((rejected as CandidateIntakeError).context).toMatchObject({ reason: 'reuse_conflicts_derived_entry' });

    // Nothing changed: park intact, decision pending, no evidence anywhere,
    // candidate NOT consumed, exactly the two pre-existing principles.
    const admission = await stateManager.getAdmissionDocument(candidateId);
    expect(admission.document?.processing).toMatchObject({ state: 'awaiting_owner', blockedReason: 'reuse_pending_owner' });
    expect(admission.document?.ownerDecisions?.[0]).toMatchObject({ executionStatus: 'pending', decision: 'reuse' });
    const ledger = loadLedger(stateDir).tree.principles;
    expect(Object.keys(ledger)).toHaveLength(2);
    expect(ledger[existing.id]?.reuseEvidence ?? []).toHaveLength(0);
    expect(ledger[derivedId]?.reuseEvidence ?? []).toHaveLength(0);
    expect((await stateManager.getCandidate(candidateId))?.status).toBe('pending');
  });

  it('P1-1: a differing decision submitted while Phase B executes cannot supersede an executed intent — both orders keep ONE governing verdict', async () => {
    await parkTheCandidate();

    // Genuine concurrency: A records the reuse intent, then A's Phase B
    // execution and B's OPPOSITE create recording race through the SAME
    // candidate lock. Run the pair repeatedly so both lock orderings occur.
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const phaseA = await cliPhaseA('reuse', existing.id);
      expect(phaseA.status).toBe('recorded');
      const [executed, recorded] = await Promise.all([
        // Phase B+C for A: real locks, real SQLite, real ledger (evidence lands).
        (async () => {
          let result;
          try {
            result = await executionService()
              .intake(candidateId, { ownerDecision: { decisionId: phaseA.decision.decisionId } });
          } catch (err: unknown) {
            // owner_decision_superseded IS the correct protection when B
            // superseded the pending intent before A verified (fail-closed,
            // zero ledger effects).
            if (err instanceof CandidateIntakeError
              && err.context?.reason === 'owner_decision_superseded') {
              return { phase: 'B' as const, outcome: 'refused' };
            }
            throw err;
          }
          if (result.outcome === 'refused' && result.reason === 'reuse_selected') {
            const phaseC = await completeOwnerDecisionExecution({
              stateManager,
              coordination: adapter,
              candidateId,
              decision: phaseA.decision,
              resultingPrincipleId: result.selectedPrincipleId ?? existing.id,
              ownerId: 'owner-p1r3',
              identitySource: 'env',
              rawRecommendationKind: 'principle',
            });
            return { phase: 'C' as const, outcome: phaseC.status };
          }
          return { phase: 'B' as const, outcome: result.outcome };
        })(),
        // B: the OPPOSITE verdict's Phase A (same candidate lock now).
        cliPhaseA('create'),
      ]);

      const admission = await stateManager.getAdmissionDocument(candidateId);
      const decisions = admission.document?.ownerDecisions ?? [];
      const applied = decisions.filter((d) => d.executionStatus === 'applied');
      const pending = decisions.filter((d) => d.executionStatus === 'pending');
      const evidence = loadLedger(stateDir).tree.principles[existing.id]?.reuseEvidence ?? [];

      if (recorded.status === 'failed') {
        // B arrived AFTER A's evidence landed: supersede refused.
        expect(recorded.reason).toContain('conflicting authorities');
        expect(evidence.length).toBe(1);
        expect(applied).toHaveLength(1);
        expect(applied[0]?.decision).toBe('reuse');
      } else {
        // B superseded A's still-pending intent FIRST (recorded superseded or
        // resumed-noop); A's Phase B must then have refused the superseded
        // decision — a superseded decision may NEVER leave ledger effects.
        expect(executed.phase === 'B' && executed.outcome !== 'refused'
          ? false : true).toBe(true);
        expect(evidence.filter((e) => e.decisionId === phaseA.decision.decisionId)).toHaveLength(0);
        if (executed.phase === 'B' && executed.outcome !== 'refused') {
          throw new Error('a superseded decision executed — P1-1 violation');
        }
        expect(applied.filter((d) => d.decisionId === phaseA.decision.decisionId)).toHaveLength(0);
        expect(pending.some((d) => d.decision === 'create')).toBe(true);
      }
      // Invariants for BOTH orders: no conflicting applied verdicts; evidence
      // exists exactly when the reuse verdict is the applied one.
      const verdicts = new Set(applied.map((d) => d.decision));
      expect(verdicts.size).toBeLessThanOrEqual(1);
      expect(evidence.length).toBeLessThanOrEqual(1);

      // Reset per attempt: start a fresh candidate so orders re-randomize.
      // eslint-disable-next-line @typescript-eslint/no-use-before-define -- seeder is kept beside the describe body it serves
      candidateId = await seedPrincipleCandidate();
      await parkTheCandidate();
    }
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
      triggerPattern: '复核时',
      action: '拒绝冲突',
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
      taskId, taskKind: 'diagnostician', status: 'succeeded', attemptCount: 1, maxAttempts: 3,
      leaseOwner: undefined, leaseExpiresAt: undefined, lastError: undefined,
      inputRef: `pain-seed-${id}`, resultRef: '',
      diagnosticJson: JSON.stringify({ sourcePainId: `pain-seed-${id}` }),
    });
    const runId = randomUUID();
    await stateManager.runStore.createRun({
      runId, taskId, runtimeKind: 'openclaw', attemptNumber: 1, executionStatus: 'succeeded',
      startedAt: now, endedAt: now, outputPayload: JSON.stringify(v2Output),
    });
    await stateManager.recordPainDiagnosis({
      painId: `pain-${id}`, taskId, diagnosisId: `diag-${id}`,
      category: 'People', rootCause: 'People: seeded', evidence: [], confidence: 0.9, artifactId,
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
