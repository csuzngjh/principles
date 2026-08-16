/**
 * Bridge Result Shaper Tests — Core Package
 *
 * Direct unit tests for the pure shapeBridgeResult() function.
 *
 * This module centralizes the status decision tree for PainSignalBridge,
 * used by both the fresh diagnosis path and the existing-task idempotent path.
 *
 * Tests verify every branch in the decision tree:
 * - Fresh path: no candidates → failed
 * - Fresh path: admitted but no ledger → failed
 * - Fresh path: all gated → degraded
 * - Fresh path: partial admission → degraded
 * - Fresh path: success with seed failure note → degraded
 * - Fresh path: clean success → succeeded
 * - Existing path: no candidates → failed
 * - Existing path: no ledger → failed
 * - Existing path: clean success → succeeded
 *
 * ERR checklist:
 * - ERR-007 / EP-02: single source for status decision (unit test proves all branches)
 * - ERR-002 / EP-03: every degraded/failed branch carries a structured message
 * - ERR-004 / ERR-008 / EP-07: lineage fields pass through untouched
 */

import { describe, it, expect } from 'vitest';
import { shapeBridgeResult } from '../bridge-result-shaper.js';
import type { ShapeBridgeResultFreshInput, ShapeBridgeResultExistingInput } from '../bridge-result-shaper.js';
import type { CandidateAdmissionResult } from '../admission-gate.js';

const PAIN_ID = 'pain-test-001';
const TASK_ID = 'diagnosis_pain-test-001';
const RUN_ID = 'run-test-1';
const ARTIFACT_ID = 'artifact-test-1';

function makeAdmissionResult(
  candidateId: string,
  decision: 'admitted' | 'needs_evidence' | 'deferred',
): CandidateAdmissionResult {
  return {
    candidateId,
    recommendationKind: 'principle',
    admission: {
      decision,
      reason: decision === 'admitted' ? 'evidence_sufficient' : 'input_evidence_empty',
      nextAction: decision === 'admitted' ? 'none' : 'collect_evidence_before_diagnosis',
      evidenceStatus: 'automatic_hook',
    },
  };
}

describe('shapeBridgeResult — fresh path', () => {
  it('returns failed when no candidates produced', () => {
    const input: ShapeBridgeResultFreshInput = {
      path: 'fresh',
      painId: PAIN_ID,
      taskId: TASK_ID,
      runId: RUN_ID,
      candidateIds: [],
      ledgerEntryIds: [],
      admissionResults: [],
      seedFailureNote: '',
      autoIntakeEnabled: true,
    };

    const result = shapeBridgeResult(input);

    expect(result.status).toBe('failed');
    expect(result.painId).toBe(PAIN_ID);
    expect(result.taskId).toBe(TASK_ID);
    expect(result.runId).toBe(RUN_ID);
    expect(result.candidateIds).toEqual([]);
    expect(result.ledgerEntryIds).toEqual([]);
    expect(result.admissionResults).toEqual([]);
    expect(result.message).toBe('Diagnostician succeeded but produced no principle candidates');
  });

  it('returns failed when candidates admitted but intake produced no ledger entries', () => {
    const admissionResults = [
      makeAdmissionResult('cand-1', 'admitted'),
      makeAdmissionResult('cand-2', 'admitted'),
    ];

    const input: ShapeBridgeResultFreshInput = {
      path: 'fresh',
      painId: PAIN_ID,
      taskId: TASK_ID,
      runId: RUN_ID,
      artifactId: ARTIFACT_ID,
      candidateIds: ['cand-1', 'cand-2'],
      ledgerEntryIds: [],
      admissionResults,
      seedFailureNote: '',
      autoIntakeEnabled: true,
    };

    const result = shapeBridgeResult(input);

    expect(result.status).toBe('failed');
    expect(result.painId).toBe(PAIN_ID);
    expect(result.artifactId).toBe(ARTIFACT_ID);
    expect(result.candidateIds).toEqual(['cand-1', 'cand-2']);
    expect(result.ledgerEntryIds).toEqual([]);
    expect(result.message).toBe('Candidate intake did not produce a ledger entry');
  });

  it('does NOT fail on no-ledger when autoIntake is disabled', () => {
    const admissionResults = [
      makeAdmissionResult('cand-1', 'admitted'),
    ];

    const input: ShapeBridgeResultFreshInput = {
      path: 'fresh',
      painId: PAIN_ID,
      taskId: TASK_ID,
      runId: RUN_ID,
      artifactId: ARTIFACT_ID,
      candidateIds: ['cand-1'],
      ledgerEntryIds: [],
      admissionResults,
      seedFailureNote: '',
      autoIntakeEnabled: false,
    };

    const result = shapeBridgeResult(input);

    expect(result.status).toBe('succeeded');
    expect(result.ledgerEntryIds).toEqual([]);
  });

  it('returns degraded when all candidates are gated (none admitted)', () => {
    const admissionResults = [
      makeAdmissionResult('cand-1', 'needs_evidence'),
      makeAdmissionResult('cand-2', 'deferred'),
    ];

    const input: ShapeBridgeResultFreshInput = {
      path: 'fresh',
      painId: PAIN_ID,
      taskId: TASK_ID,
      runId: RUN_ID,
      artifactId: ARTIFACT_ID,
      candidateIds: ['cand-1', 'cand-2'],
      ledgerEntryIds: [],
      admissionResults,
      seedFailureNote: '',
      autoIntakeEnabled: true,
    };

    const result = shapeBridgeResult(input);

    expect(result.status).toBe('degraded');
    expect(result.message).toContain('all_candidates_gated');
    expect(result.message).toContain('cand-1=needs_evidence');
    expect(result.message).toContain('cand-2=deferred');
  });

  it('returns degraded with seed failure note appended when all gated + seed failed', () => {
    const admissionResults = [
      makeAdmissionResult('cand-1', 'needs_evidence'),
    ];

    const input: ShapeBridgeResultFreshInput = {
      path: 'fresh',
      painId: PAIN_ID,
      taskId: TASK_ID,
      runId: RUN_ID,
      artifactId: ARTIFACT_ID,
      candidateIds: ['cand-1'],
      ledgerEntryIds: [],
      admissionResults,
      seedFailureNote: 'dreamer seed failed: timeout',
      autoIntakeEnabled: true,
    };

    const result = shapeBridgeResult(input);

    expect(result.status).toBe('degraded');
    expect(result.message).toContain('all_candidates_gated');
    expect(result.message).toContain('dreamer seed failed: timeout');
  });

  it('returns degraded when partial admission (some admitted, some gated)', () => {
    const admissionResults = [
      makeAdmissionResult('cand-1', 'admitted'),
      makeAdmissionResult('cand-2', 'needs_evidence'),
      makeAdmissionResult('cand-3', 'deferred'),
    ];

    const input: ShapeBridgeResultFreshInput = {
      path: 'fresh',
      painId: PAIN_ID,
      taskId: TASK_ID,
      runId: RUN_ID,
      artifactId: ARTIFACT_ID,
      candidateIds: ['cand-1', 'cand-2', 'cand-3'],
      ledgerEntryIds: ['ledger-1'],
      admissionResults,
      seedFailureNote: '',
      autoIntakeEnabled: true,
    };

    const result = shapeBridgeResult(input);

    expect(result.status).toBe('degraded');
    expect(result.message).toContain('partial_admission');
    expect(result.message).toContain('1_admitted_2_gated');
  });

  it('returns degraded with seed failure note on partial admission', () => {
    const admissionResults = [
      makeAdmissionResult('cand-1', 'admitted'),
      makeAdmissionResult('cand-2', 'needs_evidence'),
    ];

    const input: ShapeBridgeResultFreshInput = {
      path: 'fresh',
      painId: PAIN_ID,
      taskId: TASK_ID,
      runId: RUN_ID,
      artifactId: ARTIFACT_ID,
      candidateIds: ['cand-1', 'cand-2'],
      ledgerEntryIds: ['ledger-1'],
      admissionResults,
      seedFailureNote: 'some seeds failed: rate limit',
      autoIntakeEnabled: true,
    };

    const result = shapeBridgeResult(input);

    expect(result.status).toBe('degraded');
    expect(result.message).toContain('partial_admission');
    expect(result.message).toContain('some seeds failed: rate limit');
  });

  it('returns succeeded when all candidates admitted and ledger produced', () => {
    const admissionResults = [
      makeAdmissionResult('cand-1', 'admitted'),
      makeAdmissionResult('cand-2', 'admitted'),
    ];

    const input: ShapeBridgeResultFreshInput = {
      path: 'fresh',
      painId: PAIN_ID,
      taskId: TASK_ID,
      runId: RUN_ID,
      artifactId: ARTIFACT_ID,
      candidateIds: ['cand-1', 'cand-2'],
      ledgerEntryIds: ['ledger-1', 'ledger-2'],
      admissionResults,
      seedFailureNote: '',
      autoIntakeEnabled: true,
    };

    const result = shapeBridgeResult(input);

    expect(result.status).toBe('succeeded');
    expect(result.painId).toBe(PAIN_ID);
    expect(result.taskId).toBe(TASK_ID);
    expect(result.runId).toBe(RUN_ID);
    expect(result.artifactId).toBe(ARTIFACT_ID);
    expect(result.candidateIds).toEqual(['cand-1', 'cand-2']);
    expect(result.ledgerEntryIds).toEqual(['ledger-1', 'ledger-2']);
    expect(result.admissionResults).toEqual(admissionResults);
    expect(result.message).toBeUndefined();
  });

  it('returns degraded when seed failure note is present (even with full admission)', () => {
    const admissionResults = [
      makeAdmissionResult('cand-1', 'admitted'),
    ];

    const input: ShapeBridgeResultFreshInput = {
      path: 'fresh',
      painId: PAIN_ID,
      taskId: TASK_ID,
      runId: RUN_ID,
      artifactId: ARTIFACT_ID,
      candidateIds: ['cand-1'],
      ledgerEntryIds: ['ledger-1'],
      admissionResults,
      seedFailureNote: 'dreamer seed failed: LLM error',
      autoIntakeEnabled: true,
    };

    const result = shapeBridgeResult(input);

    expect(result.status).toBe('degraded');
    expect(result.message).toBe('dreamer seed failed: LLM error');
  });

  it('returns degraded with notInternalizable populated when a candidate is MVP-disabled', () => {
    const admissionResults = [
      makeAdmissionResult('cand-1', 'admitted'),
    ];

    const input: ShapeBridgeResultFreshInput = {
      path: 'fresh',
      painId: PAIN_ID,
      taskId: TASK_ID,
      runId: RUN_ID,
      artifactId: ARTIFACT_ID,
      candidateIds: ['cand-1'],
      ledgerEntryIds: ['ledger-1'],
      admissionResults,
      seedFailureNote: '',
      notInternalizable: [
        { candidateId: 'cand-1', reason: 'Channel "skill" for route "implementation-candidate" is MVP-disabled' },
      ],
      autoIntakeEnabled: true,
    };

    const result = shapeBridgeResult(input);

    expect(result.status).toBe('degraded');
    expect(result.notInternalizable).toEqual(input.notInternalizable);
    expect(result.message).toBe('not_internalizable:cand-1=Channel "skill" for route "implementation-candidate" is MVP-disabled');
  });

  it('returns degraded with notInternalizable AND seed failure note combined', () => {
    const admissionResults = [
      makeAdmissionResult('cand-1', 'admitted'),
    ];

    const input: ShapeBridgeResultFreshInput = {
      path: 'fresh',
      painId: PAIN_ID,
      taskId: TASK_ID,
      runId: RUN_ID,
      artifactId: ARTIFACT_ID,
      candidateIds: ['cand-1'],
      ledgerEntryIds: ['ledger-1'],
      admissionResults,
      seedFailureNote: 'dreamer seed failed: LLM error',
      notInternalizable: [
        { candidateId: 'cand-2', reason: 'Channel "skill" is MVP-disabled' },
      ],
      autoIntakeEnabled: true,
    };

    const result = shapeBridgeResult(input);

    expect(result.status).toBe('degraded');
    expect(result.message).toContain('not_internalizable:cand-2=Channel "skill" is MVP-disabled');
    expect(result.message).toContain('dreamer seed failed: LLM error');
  });

  it('passes through lineage fields untouched (fresh path)', () => {
    const admissionResults = [makeAdmissionResult('cand-1', 'admitted')];
    const input: ShapeBridgeResultFreshInput = {
      path: 'fresh',
      painId: PAIN_ID,
      taskId: TASK_ID,
      runId: RUN_ID,
      artifactId: ARTIFACT_ID,
      candidateIds: ['cand-1'],
      ledgerEntryIds: ['ledger-1'],
      admissionResults,
      seedFailureNote: '',
      autoIntakeEnabled: true,
    };

    const result = shapeBridgeResult(input);

    expect(result.painId).toBe(PAIN_ID);
    expect(result.taskId).toBe(TASK_ID);
    expect(result.runId).toBe(RUN_ID);
    expect(result.artifactId).toBe(ARTIFACT_ID);
    expect(result.candidateIds).toBe(input.candidateIds);
    expect(result.ledgerEntryIds).toBe(input.ledgerEntryIds);
    expect(result.admissionResults).toBe(input.admissionResults);
  });
});

describe('shapeBridgeResult — existing path', () => {
  it('returns failed when no candidates', () => {
    const input: ShapeBridgeResultExistingInput = {
      path: 'existing',
      painId: PAIN_ID,
      taskId: TASK_ID,
      runId: RUN_ID,
      candidateIds: [],
      ledgerEntryIds: [],
      autoIntakeEnabled: true,
    };

    const result = shapeBridgeResult(input);

    expect(result.status).toBe('failed');
    expect(result.message).toBe('Task has no principle candidates — treating as failed');
    expect(result.admissionResults).toBeUndefined();
  });

  it('returns failed when candidates exist but no ledger entries (autoIntake enabled)', () => {
    const input: ShapeBridgeResultExistingInput = {
      path: 'existing',
      painId: PAIN_ID,
      taskId: TASK_ID,
      runId: RUN_ID,
      artifactId: ARTIFACT_ID,
      candidateIds: ['cand-1', 'cand-2'],
      ledgerEntryIds: [],
      autoIntakeEnabled: true,
    };

    const result = shapeBridgeResult(input);

    expect(result.status).toBe('failed');
    expect(result.message).toBe('Candidate intake did not produce a ledger entry — treating as failed');
  });

  it('returns succeeded when candidates exist but no ledger (autoIntake disabled)', () => {
    const input: ShapeBridgeResultExistingInput = {
      path: 'existing',
      painId: PAIN_ID,
      taskId: TASK_ID,
      runId: RUN_ID,
      artifactId: ARTIFACT_ID,
      candidateIds: ['cand-1'],
      ledgerEntryIds: [],
      autoIntakeEnabled: false,
    };

    const result = shapeBridgeResult(input);

    expect(result.status).toBe('succeeded');
    expect(result.message).toBe('Task already succeeded');
  });

  it('returns succeeded when candidates and ledger entries exist', () => {
    const input: ShapeBridgeResultExistingInput = {
      path: 'existing',
      painId: PAIN_ID,
      taskId: TASK_ID,
      runId: RUN_ID,
      artifactId: ARTIFACT_ID,
      candidateIds: ['cand-1', 'cand-2'],
      ledgerEntryIds: ['ledger-1', 'ledger-2'],
      autoIntakeEnabled: true,
    };

    const result = shapeBridgeResult(input);

    expect(result.status).toBe('succeeded');
    expect(result.message).toBe('Task already succeeded');
    expect(result.admissionResults).toBeUndefined();
  });

  it('passes through lineage fields untouched (existing path)', () => {
    const input: ShapeBridgeResultExistingInput = {
      path: 'existing',
      painId: PAIN_ID,
      taskId: TASK_ID,
      runId: RUN_ID,
      artifactId: ARTIFACT_ID,
      candidateIds: ['cand-1'],
      ledgerEntryIds: ['ledger-1'],
      autoIntakeEnabled: true,
    };

    const result = shapeBridgeResult(input);

    expect(result.painId).toBe(PAIN_ID);
    expect(result.taskId).toBe(TASK_ID);
    expect(result.runId).toBe(RUN_ID);
    expect(result.artifactId).toBe(ARTIFACT_ID);
    expect(result.candidateIds).toBe(input.candidateIds);
    expect(result.ledgerEntryIds).toBe(input.ledgerEntryIds);
  });
});

describe('shapeBridgeResult — cross-path consistency', () => {
  it('fresh and existing paths use different messages for same semantic state', () => {
    const freshNoCandidates = shapeBridgeResult({
      path: 'fresh',
      painId: PAIN_ID,
      taskId: TASK_ID,
      candidateIds: [],
      ledgerEntryIds: [],
      admissionResults: [],
      seedFailureNote: '',
      autoIntakeEnabled: true,
    });

    const existingNoCandidates = shapeBridgeResult({
      path: 'existing',
      painId: PAIN_ID,
      taskId: TASK_ID,
      candidateIds: [],
      ledgerEntryIds: [],
      autoIntakeEnabled: true,
    });

    expect(freshNoCandidates.status).toBe('failed');
    expect(existingNoCandidates.status).toBe('failed');
    expect(freshNoCandidates.message).not.toBe(existingNoCandidates.message);
  });

  it('fresh path includes admissionResults, existing path does not', () => {
    const admissionResults = [makeAdmissionResult('cand-1', 'admitted')];

    const freshSuccess = shapeBridgeResult({
      path: 'fresh',
      painId: PAIN_ID,
      taskId: TASK_ID,
      candidateIds: ['cand-1'],
      ledgerEntryIds: ['ledger-1'],
      admissionResults,
      seedFailureNote: '',
      autoIntakeEnabled: true,
    });

    const existingSuccess = shapeBridgeResult({
      path: 'existing',
      painId: PAIN_ID,
      taskId: TASK_ID,
      candidateIds: ['cand-1'],
      ledgerEntryIds: ['ledger-1'],
      autoIntakeEnabled: true,
    });

    expect(freshSuccess.admissionResults).toBeDefined();
    expect(existingSuccess.admissionResults).toBeUndefined();
  });
});
