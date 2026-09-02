/**
 * PRI-642 SPEC §10/§12.2.5 — mixed candidate decisions stay individually
 * observable, and furthestStage never implies all-success.
 *
 * Exercises PainSignalBridge.onDiagnosisComplete with an in-memory state
 * manager (the SQLite dual-write contract is covered separately in
 * pain-ingress-persistence.test.ts).
 */
import { describe, it, expect } from 'vitest';
import { PainSignalBridge } from '../pain-signal-bridge.js';
import type { DiagnosticianRunnerLike } from '../pain-signal-bridge.js';
import type { RuntimeStateManager } from '../store/runtime-state-manager.js';
import type { CandidateRecord } from '../store/runtime-state-manager.js';
import type { TaskRecord } from '../task-status.js';
import type { DiagnosticianOutputV1 } from '../diagnostician-output.js';

const TASK_ID = 'diagnosis_pain-mixed';

const OUTPUT: DiagnosticianOutputV1 = {
  diagnosisId: 'diag-1',
  painType: 'user_frustration',
  rootCause: 'Tooling: over-engineering',
  evidence: [
    { sourceRef: 'owner_message:t1', note: 'fix it', relevance: 0.9 },
    { sourceRef: 'tool_call_failure:t2', note: 'Tool write failed', relevance: 0.8 },
  ],
  confidence: 0.7,
} as unknown as DiagnosticianOutputV1;

function candidateRecord(
  candidateId: string,
  confidence: number,
  recommendationKind: CandidateRecord['recommendationKind'] = 'prompt',
): CandidateRecord {
  return {
    candidateId,
    artifactId: 'art-1',
    taskId: TASK_ID,
    sourceRunId: 'run-1',
    title: `candidate ${candidateId}`,
    description: 'desc',
    confidence,
    status: 'pending',
    createdAt: '2026-09-02T00:00:00.000Z',
    sourceRecommendationJson: '{}',
    recommendationKind,
  };
}

function makeBridge(): { bridge: PainSignalBridge; createdTasks: TaskRecord[] } {
  // Mixed by recommendation kind: the gate evaluates the diagnostician
  // OUTPUT (one confidence for all candidates), so a genuine mixed outcome
  // comes from a defer-kind candidate alongside an admitted prompt-kind one.
  const candidates = [candidateRecord('cand-strong', 0.7), candidateRecord('cand-weak', 0.3, 'defer')];
  const createdTasks: TaskRecord[] = [];
  const stateManager = {
    getCandidatesByTaskId: async () => candidates,
    getRunsByTask: async () => [],
    getTask: async () => null,
    createTask: async (t: TaskRecord) => { createdTasks.push(t); },
    updateCandidateStatus: async () => true,
  } as unknown as RuntimeStateManager;
  const runner: DiagnosticianRunnerLike = {
    run: async () => ({ status: 'succeeded', taskId: TASK_ID, attemptCount: 1 }),
  };
  const bridge = new PainSignalBridge({
    stateManager,
    runner,
    intakeService: {
      intake: async (candidateId: string) => ({ id: `ledger-${candidateId}` }),
    } as never,
    ledgerAdapter: {
      register: () => undefined,
      existsForCandidate: () => undefined,
      getEntries: () => [],
    } as never,
    autoIntakeEnabled: true,
  });
  return { bridge, createdTasks };
}

describe('PainSignalBridge outcome convergence (PRI-642 §10)', () => {
  it('reports each candidate decision separately with ledger/seed linkage', async () => {
    const { bridge } = makeBridge();
    const result = await bridge.onDiagnosisComplete({
      taskId: TASK_ID,
      diagnosticianOutput: OUTPUT,
      painId: 'pain-mixed',
      provenance: 'host_context_bound',
      inputEvidenceCount: 2,
    });

    // Mixed outcome → degraded, never a clean success.
    expect(result.status).toBe('degraded');
    expect(result.candidateOutcomes).toBeDefined();
    const byId = new Map((result.candidateOutcomes ?? []).map(o => [o.candidateId, o]));
    const strong = byId.get('cand-strong');
    const weak = byId.get('cand-weak');
    expect(strong?.decision).toBe('admitted');
    expect(strong?.ledgerEntryId).toBe('ledger-cand-strong');
    expect(strong?.seededTaskId).toBeTruthy();
    expect(weak?.decision).toBe('deferred');
    expect(weak?.reason).toContain('defer');
    expect(weak?.nextAction).toBeTruthy();
    expect(weak?.ledgerEntryId).toBeUndefined();

    // Progress reflects the aggregate with at-least-one semantics: one
    // candidate seeded ⇒ internalization_seeded even though the other gated.
    if (result.progress === undefined) throw new Error('progress missing on mixed outcome');
    expect(result.progress.admittedCandidateIds).toEqual(['cand-strong']);
    expect(result.progress.generatedCandidateIds).toEqual(['cand-strong', 'cand-weak']);
    expect(result.progress.ledgerEntryIds).toEqual(['ledger-cand-strong']);
    expect(result.progress.furthestStage).toBe('internalization_seeded');

    // Compatibility fields stay derived and intact.
    expect(result.candidateIds).toEqual(['cand-strong', 'cand-weak']);
    expect(result.ledgerEntryIds).toEqual(['ledger-cand-strong']);
    expect(result.admissionResults?.length).toBe(2);
  });

  it('all-gated outcome reports diagnosis_completed without any ledger/seed progress', async () => {
    const { bridge } = makeBridge();
    const result = await bridge.onDiagnosisComplete({
      taskId: TASK_ID,
      // Both candidates defer → all gated, no ledger, no seed.
      diagnosticianOutput: { ...OUTPUT, confidence: 0.3 },
      painId: 'pain-gated',
      provenance: 'host_context_bound',
      inputEvidenceCount: 0,
    });

    expect(result.status).toBe('degraded');
    if (result.progress === undefined) throw new Error('progress missing on gated outcome');
    expect(result.progress.furthestStage).toBe('diagnosis_completed');
    expect(result.progress.admittedCandidateIds).toEqual([]);
    expect(result.progress.seededTaskIds).toEqual([]);
    for (const outcome of result.candidateOutcomes ?? []) {
      expect(outcome.decision).not.toBe('admitted');
      expect(outcome.ledgerEntryId).toBeUndefined();
    }
  });
});
