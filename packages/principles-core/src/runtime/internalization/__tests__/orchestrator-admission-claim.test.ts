/**
 * PRI-1267: claim-time admission gate in InternalizationOrchestrator.wakeOnce.
 *
 * A dreamer task already in the queue for a candidate the admission gate has
 * REFUSED must never be leased/executed — the claim path is the last line of
 * defense for tasks enqueued before the internalize-side write gate existed.
 * Refusal is a governed stop reported as `no_ready_tasks /
 * all_admission_refused` with per-candidate, queryable reasons; an ADMITTED
 * candidate still leases normally.
 */
import { describe, it, expect } from 'vitest';
import type { TaskRecord } from '../../task-status.js';
import { InternalizationOrchestrator } from '../internalization-orchestrator.js';

const CANDIDATE_ID = '3f6b8a2e-1111-4222-8333-444455556666';
const DREAMER_TASK_ID = `dreamer-cand-${CANDIDATE_ID}-prompt`;

function dreamerTask(): TaskRecord {
  return {
    taskId: DREAMER_TASK_ID,
    taskKind: 'dreamer',
    status: 'pending',
    attemptCount: 0,
    createdAt: '2026-11-17T00:00:00.000Z',
    updatedAt: '2026-11-17T00:00:00.000Z',
    diagnosticJson: JSON.stringify({
      candidateId: CANDIDATE_ID,
      pi_metadata: {
        dependencyTaskIds: [],
        channel: 'prompt',
        timeoutMs: 1000,
        inputArtifactRefs: [],
        outputArtifactRefs: [],
      },
    }),
  } as unknown as TaskRecord;
}

function makeHarness(options: {
  admissionDocument: unknown;
  lease?: { taskId: string; attemptCount: number } | null;
}) {
  const tasks = new Map<string, TaskRecord>([[DREAMER_TASK_ID, dreamerTask()]]);
  const leased: string[] = [];
  const stateManager = {
    async listTasks(filter?: { status?: string }) {
      // One bucket only: the task appears in the list whose status was asked for.
      if (filter?.status === undefined || filter.status === 'pending') return [...tasks.values()];
      return [];
    },
    async getTask(id: string) { return tasks.get(id) ?? null; },
    async getAdmissionDocument() { return options.admissionDocument; },
    async getCandidate() {
      return { candidateId: CANDIDATE_ID, taskId: 'diagnostician-1', recommendationKind: 'principle', confidence: 0.45 };
    },
    async acquireLease() {
      leased.push(DREAMER_TASK_ID);
      return { taskId: DREAMER_TASK_ID, attemptCount: 1 } as unknown as TaskRecord;
    },
  };
  const orchestrator = new InternalizationOrchestrator(
    { stateManager: stateManager as never },
    { owner: 'test-claim', runtimeKind: 'test' },
  );
  return { orchestrator, leased };
}

const REFUSED_DOCUMENT = {
  ok: true,
  document: {
    schemaVersion: 1,
    evaluations: [{
      evaluationId: 'e1',
      decision: 'needs_evidence',
      reason: 'confidence_below_threshold:0.45<0.50',
      nextAction: 'provide_additional_evidence_or_manual_review',
      evaluatedAt: '2026-11-17T00:01:00.000Z',
      policyVersion: 'admission-gate@cr-03',
      provenance: 'automatic_hook',
      inputEvidenceCount: 1,
      ownerStatementPresent: false,
      recommendationKind: 'principle',
      confidence: 0.45,
      materialFingerprint: 'f'.repeat(64),
      materialSummary: { inputEvidenceCount: 1, outputEvidenceCount: 1, ownerStatementPresent: false },
    }],
    currentEvaluationId: 'e1',
    processing: null,
  },
};

const ADMITTED_DOCUMENT = {
  ok: true,
  document: {
    schemaVersion: 1,
    evaluations: [{
      evaluationId: 'e1',
      decision: 'admitted',
      reason: 'evidence_sufficient',
      nextAction: 'none',
      evaluatedAt: '2026-11-17T00:01:00.000Z',
      policyVersion: 'admission-gate@cr-03',
      provenance: 'automatic_hook',
      inputEvidenceCount: 1,
      ownerStatementPresent: false,
      recommendationKind: 'principle',
      confidence: 0.9,
      materialFingerprint: 'f'.repeat(64),
      materialSummary: { inputEvidenceCount: 1, outputEvidenceCount: 1, ownerStatementPresent: false },
    }],
    currentEvaluationId: 'e1',
    processing: { state: 'complete', attempts: 1 },
  },
};

describe('PRI-1267: wakeOnce claim-time admission gate', () => {
  it('refused candidate → no_ready_tasks / all_admission_refused with queryable per-candidate reasons, zero leases', async () => {
    const { orchestrator, leased } = makeHarness({ admissionDocument: REFUSED_DOCUMENT });
    const result = await orchestrator.wakeOnce('dreamer');
    expect(result.decision).toBe('no_ready_tasks');
    if (result.decision !== 'no_ready_tasks') throw new Error('unreachable');
    expect(result.reason).toBe('all_admission_refused');
    expect(result.admissionRefusals).toEqual([{
      taskId: DREAMER_TASK_ID,
      candidateId: CANDIDATE_ID,
      decision: 'needs_evidence',
      reason: 'confidence_below_threshold:0.45<0.50',
      nextAction: 'provide_additional_evidence_or_manual_review',
    }]);
    expect(leased).toEqual([]);
  });

  it('admitted candidate → leases normally (gate never blocks admitted chains)', async () => {
    const { orchestrator, leased } = makeHarness({ admissionDocument: ADMITTED_DOCUMENT });
    const result = await orchestrator.wakeOnce('dreamer');
    expect(result.decision).toBe('leased');
    expect(leased).toEqual([DREAMER_TASK_ID]);
  });

  it('unreadable admission document → fail-closed refusal (never counts as admitted)', async () => {
    const { orchestrator } = makeHarness({ admissionDocument: { ok: false, reason: 'admission_json_unparseable' } });
    const result = await orchestrator.wakeOnce('dreamer');
    expect(result.decision).toBe('no_ready_tasks');
    if (result.decision !== 'no_ready_tasks') throw new Error('unreachable');
    expect(result.reason).toBe('all_admission_refused');
    expect(result.admissionRefusals?.[0]?.reason).toBe('admission_document_unreadable:admission_json_unparseable');
  });
});
