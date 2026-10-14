/**
 * SPEC-CODEX-PAIN-CLOSURE-001: the in-memory CandidateStore had NO dedicated
 * unit test — every branch of its admission surface was unexercised, so a
 * change to the shared admission document helpers could regress it silently.
 *
 * This covers the whole contract the SQLite store is held to:
 *   - lookup + filtering by taskId;
 *   - status updates (plain and compare-and-swap);
 *   - admission document reads (absent row vs. present-with-no-document);
 *   - append / reuse / refusal semantics;
 *   - processing updates;
 *   - the post-processing backlog query (terminal skip, retry-window gating,
 *     ordering and the limit).
 */
import { describe, it, expect } from 'vitest';
import { MemoryCandidateStore } from './memory-candidate-store.js';
import type { CandidateRecord } from './candidate-store.js';
import type { AdmissionEvaluationRecord } from './admission-document.js';

const NOW = '2026-10-14T12:00:00.000Z';

function candidate(overrides: Partial<CandidateRecord> = {}): CandidateRecord {
  return {
    candidateId: 'cand-1',
    artifactId: 'art-1',
    taskId: 'task-1',
    sourceRunId: 'run-1',
    title: 'T',
    description: 'D',
    confidence: 0.9,
    sourceRecommendationJson: '{}',
    recommendationKind: 'principle',
    rawRecommendationKind: 'principle',
    status: 'pending',
    createdAt: NOW,
    ...overrides,
  };
}

function evaluation(overrides: Partial<AdmissionEvaluationRecord> = {}): AdmissionEvaluationRecord {
  return {
    evaluationId: 'eval-1',
    decision: 'admitted',
    reason: 'evidence_sufficient',
    nextAction: 'none',
    evaluatedAt: NOW,
    policyVersion: 'admission-gate@cr-03',
    provenance: 'owner_reported_no_host_trace',
    inputEvidenceCount: 1,
    ownerStatementPresent: false,
    recommendationKind: 'principle',
    confidence: 0.9,
    materialFingerprint: 'fp-1',
    materialSummary: { inputEvidenceCount: 1, outputEvidenceCount: 1, ownerStatementPresent: false },
    ...overrides,
  };
}

describe('MemoryCandidateStore', () => {
  it('filters by taskId and reads a single candidate, returning null when absent', async () => {
    const store = new MemoryCandidateStore();
    store.insert(candidate({ candidateId: 'a', taskId: 'task-1' }));
    store.insert(candidate({ candidateId: 'b', taskId: 'task-2' }));

    expect((await store.getCandidatesByTaskId('task-1')).map((c) => c.candidateId)).toEqual(['a']);
    expect(await store.getCandidatesByTaskId('task-none')).toEqual([]);

    expect((await store.getCandidate('a'))?.candidateId).toBe('a');
    expect(await store.getCandidate('ghost')).toBeNull();
  });

  it('updateCandidateStatus writes only for an existing row', async () => {
    const store = new MemoryCandidateStore();
    store.insert(candidate({ candidateId: 'a' }));

    expect(await store.updateCandidateStatus('a', { status: 'consumed' })).toBe(true);
    expect((await store.getCandidate('a'))?.status).toBe('consumed');
    expect(await store.updateCandidateStatus('ghost', { status: 'consumed' })).toBe(false);
  });

  it('transitionCandidateStatus is a compare-and-swap: mismatch and absence both refuse', async () => {
    const store = new MemoryCandidateStore();
    store.insert(candidate({ candidateId: 'a', status: 'pending' }));

    expect(await store.transitionCandidateStatus('a', 'consumed', 'expired')).toBe(false);
    expect((await store.getCandidate('a'))?.status).toBe('pending');
    expect(await store.transitionCandidateStatus('a', 'pending', 'consumed')).toBe(true);
    expect((await store.getCandidate('a'))?.status).toBe('consumed');
    expect(await store.transitionCandidateStatus('ghost', 'pending', 'consumed')).toBe(false);
  });

  it('getAdmissionDocument distinguishes a missing row from a row with no document yet', async () => {
    const store = new MemoryCandidateStore();
    store.insert(candidate({ candidateId: 'a' }));

    const missing = await store.getAdmissionDocument('ghost');
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.reason).toBe('candidate_not_found');

    const noDoc = await store.getAdmissionDocument('a');
    expect(noDoc.ok).toBe(true);
    if (noDoc.ok) expect(noDoc.document).toBeNull();
  });

  it('appendAdmissionEvaluation refuses an unknown candidate, appends once, then reuses', async () => {
    const store = new MemoryCandidateStore();
    store.insert(candidate({ candidateId: 'a' }));

    const refused = await store.appendAdmissionEvaluation('ghost', evaluation());
    expect(refused.status).toBe('refused');
    if (refused.status === 'refused') expect(refused.reason).toBe('candidate_not_found');

    const first = await store.appendAdmissionEvaluation('a', evaluation({ evaluationId: 'e1' }));
    expect(first.status).toBe('appended');
    if (first.status !== 'refused') expect(first.document.currentEvaluationId).toBe('e1');

    // Same material fingerprint ⇒ REUSED, not re-appended.
    const second = await store.appendAdmissionEvaluation('a', evaluation({ evaluationId: 'e2', materialFingerprint: 'fp-1' }));
    expect(second.status).toBe('reused');
    if (second.status !== 'refused') expect(second.document.evaluations).toHaveLength(1);

    const third = await store.appendAdmissionEvaluation('a', evaluation({ evaluationId: 'e3', materialFingerprint: 'fp-2' }));
    expect(third.status).toBe('appended');
    if (third.status !== 'refused') expect(third.document.evaluations).toHaveLength(2);

    const read = await store.getAdmissionDocument('a');
    expect(read.ok && read.document?.currentEvaluationId).toBe('e3');
  });

  it('updateAdmissionProcessing creates the document when absent and refuses unknown candidates', async () => {
    const store = new MemoryCandidateStore();
    store.insert(candidate({ candidateId: 'a' }));

    expect(await store.updateAdmissionProcessing('ghost', { state: 'in_progress', attempts: 1 })).toBe(false);
    expect(await store.updateAdmissionProcessing('a', { state: 'in_progress', attempts: 1 })).toBe(true);

    const doc = await store.getAdmissionDocument('a');
    expect(doc.ok && doc.document?.processing?.state).toBe('in_progress');
    expect(doc.ok && doc.document?.processing?.attempts).toBe(1);
  });

  it('listDiagnosisPostProcessingBacklog: no-document rows are eligible only when pending/consumed, and expired is excluded', () => {
    const store = new MemoryCandidateStore();
    store.insert(candidate({ candidateId: 'pending', status: 'pending', createdAt: '2026-10-14T00:00:00.000Z' }));
    store.insert(candidate({ candidateId: 'consumed', status: 'consumed', createdAt: '2026-10-14T01:00:00.000Z' }));
    store.insert(candidate({ candidateId: 'expired', status: 'expired', createdAt: '2026-10-14T02:00:00.000Z' }));

    const backlog = store.listDiagnosisPostProcessingBacklog({ limit: 10 });
    // oldest-first ordering proves the sort, not just membership.
    expect(backlog.eligible.map((e) => e.candidateId)).toEqual(['pending', 'consumed']);
    expect(backlog.eligible.every((e) => e.processingState === null)).toBe(true);
    expect(backlog.corrupt).toEqual([]);
  });

  it('listDiagnosisPostProcessingBacklog: terminal processing states are skipped, retry windows gate the rest', async () => {
    const store = new MemoryCandidateStore();
    store.insert(candidate({ candidateId: 'complete' }));
    store.insert(candidate({ candidateId: 'awaiting' }));
    store.insert(candidate({ candidateId: 'exhausted' }));
    store.insert(candidate({ candidateId: 'retry-later' }));
    store.insert(candidate({ candidateId: 'retry-due' }));

    await store.updateAdmissionProcessing('complete', { state: 'complete', attempts: 1 });
    await store.updateAdmissionProcessing('awaiting', { state: 'awaiting_owner', attempts: 1 });
    await store.updateAdmissionProcessing('exhausted', { state: 'exhausted', attempts: 3 });
    // nextRetryAt in the FUTURE ⇒ not yet eligible.
    await store.updateAdmissionProcessing('retry-later', { state: 'in_progress', attempts: 1, nextRetryAt: '2099-01-01T00:00:00.000Z' });
    // nextRetryAt in the PAST ⇒ eligible again.
    await store.updateAdmissionProcessing('retry-due', { state: 'in_progress', attempts: 2, nextRetryAt: '2026-10-13T00:00:00.000Z' });

    const backlog = store.listDiagnosisPostProcessingBacklog({ limit: 10, nowIso: NOW });
    expect(backlog.eligible.map((e) => e.candidateId)).toEqual(['retry-due']);
    expect(backlog.eligible[0]!.processingState).toBe('in_progress');
  });

  it('listDiagnosisPostProcessingBacklog honours the limit', () => {
    const store = new MemoryCandidateStore();
    for (let i = 0; i < 5; i += 1) {
      store.insert(candidate({ candidateId: `c${i}`, createdAt: `2026-10-14T0${i}:00:00.000Z` }));
    }
    expect(store.listDiagnosisPostProcessingBacklog({ limit: 2 }).eligible).toHaveLength(2);
    expect(store.listDiagnosisPostProcessingBacklog({ limit: 2 }).eligible.map((e) => e.candidateId)).toEqual(['c0', 'c1']);
  });

  it('clear() empties both the candidate and admission maps', async () => {
    const store = new MemoryCandidateStore();
    store.insert(candidate({ candidateId: 'a' }));
    await store.appendAdmissionEvaluation('a', evaluation());

    store.clear();

    expect(await store.getCandidate('a')).toBeNull();
    const doc = await store.getAdmissionDocument('a');
    expect(doc.ok).toBe(false);
  });
});
