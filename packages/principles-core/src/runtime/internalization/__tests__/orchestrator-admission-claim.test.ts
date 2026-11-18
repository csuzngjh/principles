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
  candidate?: unknown;
  dryRun?: boolean;
  stateManagerExtra?: Record<string, unknown>;
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
      return options.candidate !== undefined
        ? options.candidate
        : { candidateId: CANDIDATE_ID, taskId: 'diagnostician-1', recommendationKind: 'principle', confidence: 0.45 };
    },
    async acquireLease() {
      leased.push(DREAMER_TASK_ID);
      return { taskId: DREAMER_TASK_ID, attemptCount: 1 } as unknown as TaskRecord;
    },
    ...options.stateManagerExtra,
  };
  const orchestrator = new InternalizationOrchestrator(
    { stateManager: stateManager as never },
    { owner: 'test-claim', runtimeKind: 'test', dryRun: options.dryRun ?? false },
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

  // ── No evaluation on record (pre-CR-03 task): the claim path re-derives ──
  // the admission verdict — read-only in dry-run, persisted re-evaluation
  // otherwise — and never substitutes a missing candidate for an admitted one.

  const EMPTY_DOCUMENT = {
    ok: true,
    document: { schemaVersion: 1, evaluations: [], currentEvaluationId: null, processing: null },
  };

  it('no evaluation on record + candidate gone → candidate_not_found_at_claim', async () => {
    const { orchestrator, leased } = makeHarness({ admissionDocument: EMPTY_DOCUMENT, candidate: null });
    const result = await orchestrator.wakeOnce('dreamer');
    expect(result.decision).toBe('no_ready_tasks');
    if (result.decision !== 'no_ready_tasks') throw new Error('unreachable');
    expect(result.admissionRefusals?.[0]?.reason).toBe('candidate_not_found_at_claim');
    expect(leased).toEqual([]);
  });

  it('no evaluation on record + dry-run → read-only partial refusal, nothing persisted', async () => {
    // Weak-confidence candidate: the partial check refuses and the reason
    // carries the no_admission_document prefix — a preview must not write a
    // new admission version to claim its task.
    const { orchestrator } = makeHarness({ admissionDocument: EMPTY_DOCUMENT, dryRun: true });
    const result = await orchestrator.wakeOnce('dreamer');
    expect(result.decision).toBe('no_ready_tasks');
    if (result.decision !== 'no_ready_tasks') throw new Error('unreachable');
    expect(result.admissionRefusals?.[0]?.reason).toMatch(/^no_admission_document:/);
  });

  it('no evaluation on record + dry-run + strong candidate → would_lease (preview never writes)', async () => {
    const { orchestrator } = makeHarness({
      admissionDocument: EMPTY_DOCUMENT,
      dryRun: true,
      candidate: { candidateId: CANDIDATE_ID, taskId: 'diagnostician-1', recommendationKind: 'principle', confidence: 0.9 },
    });
    const result = await orchestrator.wakeOnce('dreamer');
    expect(result.decision).toBe('would_lease');
  });

  it('no evaluation on record + revalidation store failure → admission_revalidation_failed', async () => {
    // getTask('diagnostician-1') resolves nothing in this harness — the
    // persisted re-evaluation cannot find the diagnosis task and fails
    // closed with task_missing, surfaced as a governed refusal.
    const { orchestrator } = makeHarness({ admissionDocument: EMPTY_DOCUMENT });
    const result = await orchestrator.wakeOnce('dreamer');
    expect(result.decision).toBe('no_ready_tasks');
    if (result.decision !== 'no_ready_tasks') throw new Error('unreachable');
    expect(result.admissionRefusals?.[0]?.reason).toBe('admission_revalidation_failed:task_missing');
  });

  const DIAGNOSTICIAN_TASK = {
    taskId: 'diagnostician-1',
    taskKind: 'diagnostician',
    inputRef: 'pain-1',
    status: 'succeeded',
    diagnosticJson: JSON.stringify({
      sourcePainId: 'pain-1',
      reasonSummary: 'original pain input',
      source: 'manual',
      severity: 'moderate',
      sessionIdHint: null,
      agentIdHint: null,
      provenance: 'owner_reported_no_host_trace',
      provenanceReason: 'seeded',
      evidence: [{ sourceRef: 'trace-parent', note: 'original evidence' }],
      workspaceDir: null,
    }),
  };

  function revalidationStore(outputConfidence: number) {
    const output = {
      schemaVersion: 'diagnostician-output-v2',
      valid: true,
      diagnosisId: 'diag-1',
      summary: 'summary',
      rootCause: 'root cause',
      violatedPrinciples: [],
      evidence: [{ sourceRef: 'trace-1', note: 'evidence' }],
      recommendations: [{ kind: 'principle', description: 'P', abstractedPrinciple: 'P', recommendationRef: 'principle-1' }],
      confidence: outputConfidence,
    };
    const persisted: unknown[] = [];
    const extra = {
      async getTask(id: string) { return id === 'diagnostician-1' ? DIAGNOSTICIAN_TASK : id === DREAMER_TASK_ID ? dreamerTask() : null; },
      async getCandidatesByTaskId(taskId: string) {
        return taskId === 'diagnostician-1'
          ? [{ candidateId: CANDIDATE_ID, taskId: 'diagnostician-1', sourceRunId: 'run-1', rawRecommendationKind: 'principle' }]
          : [];
      },
      async getRun(runId: string) {
        return runId === 'run-1'
          ? { runId: 'run-1', taskId: 'diagnostician-1', executionStatus: 'succeeded', outputPayload: JSON.stringify(output) }
          : null;
      },
      async getArtifact() { return null; },
      async appendAdmissionEvaluation(_candidateId: string, evaluation: unknown) {
        persisted.push(evaluation);
        return { status: 'appended' };
      },
      async getRunsByTask() { return []; },
    };
    return { extra, persisted };
  }

  it('no evaluation on record + revalidated REFUSED → refused with (revalidated at claim)', async () => {
    const { extra, persisted } = revalidationStore(0.2);
    const { orchestrator, leased } = makeHarness({ admissionDocument: EMPTY_DOCUMENT, stateManagerExtra: extra });
    const result = await orchestrator.wakeOnce('dreamer');
    expect(result.decision).toBe('no_ready_tasks');
    if (result.decision !== 'no_ready_tasks') throw new Error('unreachable');
    expect(result.reason).toBe('all_admission_refused');
    expect(result.admissionRefusals?.[0]?.reason).toContain('(revalidated at claim)');
    expect(persisted).toHaveLength(1);
    expect(leased).toEqual([]);
  });

  it('no evaluation on record + revalidated ADMITTED → leases normally', async () => {
    const { extra } = revalidationStore(0.9);
    const { orchestrator, leased } = makeHarness({ admissionDocument: EMPTY_DOCUMENT, stateManagerExtra: extra });
    const result = await orchestrator.wakeOnce('dreamer');
    expect(result.decision).toBe('leased');
    expect(leased).toEqual([DREAMER_TASK_ID]);
  });
});
