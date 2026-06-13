import { describe, it, expect } from 'vitest';
import {
  assembleEvidenceChain,
  determineState,
  determineNextAction,
  normalizeDiagnosticianTaskId,
} from '../types/evidence-chain-contract.js';
import { GOLDEN_FIXTURES } from '../internalization/golden-dogfood-fixtures.js';

/* eslint-disable @typescript-eslint/no-non-null-assertion -- test fixtures are typed Record<string,T> with known keys */
const fixtureOf = (key: keyof typeof GOLDEN_FIXTURES) => GOLDEN_FIXTURES[key]!;
const firstRecordOf = (key: keyof typeof GOLDEN_FIXTURES) => {
  const res = assembleEvidenceChain(fixtureOf(key));
  expect(res.records.length).toBeGreaterThan(0);
  return { res, record: res.records[0]! };
};
/* eslint-enable @typescript-eslint/no-non-null-assertion */

describe('Pain Evidence Chain Contract (PRI-385)', () => {
  // 1. normalizeDiagnosticianTaskId sub-run normalization tests
  describe('TaskId Normalization', () => {
    it('normalizes diag_router-diagnosis_* sub-run task ID to canonical diagnosis_*', () => {
      const res = normalizeDiagnosticianTaskId('diag_router-diagnosis_manual_2');
      expect(res.success).toBe(true);
      expect(res.normalized).toBe('diagnosis_manual_2');
    });

    it('normalizes multi-segment prefixes stage1-stage2-diagnosis_*', () => {
      const res = normalizeDiagnosticianTaskId('stage1-stage2-diagnosis_manual_2');
      expect(res.success).toBe(true);
      expect(res.normalized).toBe('diagnosis_manual_2');
    });

    it('retains canonical diagnosis_* unchanged', () => {
      const res = normalizeDiagnosticianTaskId('diagnosis_manual_1');
      expect(res.success).toBe(true);
      expect(res.normalized).toBe('diagnosis_manual_1');
    });

    it('rejects malformed task ID with invalid prefix separator', () => {
      const res = normalizeDiagnosticianTaskId('diag_router_diagnosis_manual_2');
      expect(res.success).toBe(false);
      expect(res.reason).toContain('Malformed');
    });
  });

  // 2. determineState logic checks
  describe('determineState', () => {
    it('returns recorded-only when no task or candidate exists', () => {
      const state = determineState({
        sourceKind: 'manual',
        hasCandidate: false,
      });
      expect(state).toBe('recorded-only');
    });

    it('returns diagnosis-queued when task is pending', () => {
      const state = determineState({
        sourceKind: 'manual',
        taskStatus: 'pending',
        hasCandidate: false,
      });
      expect(state).toBe('diagnosis-queued');
    });

    it('returns diagnosis-retry-wait when task is retry_wait', () => {
      const state = determineState({
        sourceKind: 'manual',
        taskStatus: 'retry_wait',
        hasCandidate: false,
      });
      expect(state).toBe('diagnosis-retry-wait');
    });

    it('returns internalization-missing when candidate exists but dreamer has no task', () => {
      const state = determineState({
        sourceKind: 'manual',
        taskStatus: 'succeeded',
        hasCandidate: true,
      });
      expect(state).toBe('internalization-missing');
    });

    it('returns internalization-running when dreamer status is running', () => {
      const state = determineState({
        sourceKind: 'manual',
        taskStatus: 'succeeded',
        hasCandidate: true,
        dreamerStatus: 'running',
      });
      expect(state).toBe('internalization-running');
    });

    it('returns owner-reviewable when ledger status is candidate', () => {
      const state = determineState({
        sourceKind: 'manual',
        taskStatus: 'succeeded',
        hasCandidate: true,
        dreamerStatus: 'succeeded',
        ledgerPrincipleStatus: 'candidate',
      });
      expect(state).toBe('owner-reviewable');
    });
  });

  // 3. determineNextAction workspace safety checks
  describe('determineNextAction workspace safety', () => {
    const ws = '/workspace/test';

    it('includes workspace path in diagnosis-retry-wait action command', () => {
      const action = determineNextAction('diagnosis-retry-wait', ws);
      expect(action).toContain(`--workspace "${ws}"`);
      expect(action).toContain('pd pain retry');
    });

    it('includes workspace path in diagnosis-failed action command', () => {
      const action = determineNextAction('diagnosis-failed', ws);
      expect(action).toContain(`--workspace "${ws}"`);
      expect(action).toContain('pd pain retry');
    });

    it('includes workspace path in candidate-generated / internalization-missing command', () => {
      const action = determineNextAction('candidate-generated', ws);
      expect(action).toContain(`--workspace "${ws}"`);
      expect(action).toContain('pd runtime internalization run-once');
    });
  });

  // 4. assembleEvidenceChain on static Golden Dogfood Fixtures
  describe('assembleEvidenceChain with Golden Fixtures', () => {
    it('canonicalDiagnosis: maps diagnosis_task to pain_event successfully', () => {
      const { record } = firstRecordOf('canonicalDiagnosis');
      expect(record.id).toBe('pain_1');
      expect(record.linkedTaskId).toBe('diagnosis_manual_1');
      expect(record.state).toBe('diagnosis-succeeded');
    });

    it('subRunDiagnosis: normalizes and links subrun task and candidate successfully', () => {
      const { record } = firstRecordOf('subRunDiagnosis');
      expect(record.id).toBe('pain_2');
      expect(record.linkedTaskId).toBe('diag_router-diagnosis_manual_2');
      expect(record.linkedCandidateId).toBe('cand-subrun-2');
      expect(record.state).toBe('internalization-missing');
    });

    it('asyncPendingWithoutConsumer: returns reason and nextAction for pending task', () => {
      const { record } = firstRecordOf('asyncPendingWithoutConsumer');
      expect(record.state).toBe('diagnosis-queued');
      expect(record.nextAction).toBeUndefined(); // diagnosis-queued nextAction is undefined in contract defaults
    });

    it('candidateGeneratedNoDreamer: maps to internalization-missing with recovery command', () => {
      const { record } = firstRecordOf('candidateGeneratedNoDreamer');
      expect(record.state).toBe('internalization-missing');
      expect(record.nextAction).toContain('pd runtime internalization run-once');
      expect(record.nextAction).toContain('--workspace "/workspace/dogfood"');
    });

    it('dreamerPending: links dreamer status to pending state', () => {
      const { record } = firstRecordOf('dreamerPending');
      expect(record.state).toBe('internalization-pending');
      expect(record.internalizationTaskId).toBe('dreamer-cand-5-prompt');
      expect(record.dreamerTaskStatus).toBe('pending');
    });

    it('dreamerRunning: links dreamer status to running state', () => {
      const { record } = firstRecordOf('dreamerRunning');
      expect(record.state).toBe('internalization-running');
      expect(record.internalizationTaskId).toBe('dreamer-cand-6-prompt');
      expect(record.dreamerTaskStatus).toBe('running');
    });

    it('dreamerFailed: maps to internalization-failed with recovery command', () => {
      const { record } = firstRecordOf('dreamerFailed');
      expect(record.state).toBe('internalization-failed');
      expect(record.nextAction).toContain('pd runtime internalization run-once');
      expect(record.nextAction).toContain('--workspace "/workspace/dogfood"');
    });

    it('dreamerSucceeded: links to active or owner-reviewable principle state', () => {
      const { record } = firstRecordOf('dreamerSucceeded');
      expect(record.state).toBe('owner-reviewable');
      expect(record.linkedPrincipleId).toBe('principle-8');
    });

    it('malformedLedgerDegradedJson: flags invalid JSON as degradedReason per-record', () => {
      const { res, record } = firstRecordOf('malformedLedgerDegradedJson');
      expect(record.degradedReason).toBe('Diagnostic data for this record could not be parsed');
      // Response-level degradedReason should NOT be polluted
      expect(res.degradedReason).toBeUndefined();
    });

    it('workspaceMismatchWarning: warns about unmatched pain signals', () => {
      const { res } = firstRecordOf('workspaceMismatchWarning');
      expect(res.records).toHaveLength(2);
      const record = res.records.find(r => r.id === 'pain_10');
      expect(record).toBeDefined();
      expect(record?.state).toBe('recorded-only');
      expect(record?.degradedReason).toContain('Could not link this pain event to a diagnostician task');
      expect(res.degradedReason).toContain('Pain event pain_10 could not be linked');
    });

    it('autoConsumerSuccess: links success to internalization-succeeded state', () => {
      const { record } = firstRecordOf('autoConsumerSuccess');
      expect(record.state).toBe('internalization-succeeded');
      expect(record.linkedPrincipleId).toBe('principle-11');
      expect(record.internalizationTaskId).toBe('dreamer-cand-11-prompt');
    });

    it('autoConsumerFailure: links failure to internalization-failed state', () => {
      const { record } = firstRecordOf('autoConsumerFailure');
      expect(record.state).toBe('internalization-failed');
      expect(record.internalizationTaskId).toBe('dreamer-cand-12-prompt');
    });
  });
});
