import { describe, it, expect } from 'vitest';
import {
  assembleEvidenceChain,
  determineState,
  determineNextAction,
  normalizeDiagnosticianTaskId,
  normalizeSummaryForDedupe,
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

  // 1b. normalizeSummaryForDedupe Unicode-aware normalization tests (reviewer P1 round 3)
  //
  // The previous implementation used `/[^\w\s]/g` which only retains
  // `[A-Za-z0-9_]`. That pattern DROPS CJK ideographs entirely, so every
  // Chinese pain summary collapsed to whatever ASCII prefix it had (often the
  // empty string), making content-hash dedupe silently wrong for non-ASCII
  // owners. The Unicode-aware pipeline (NFKC + \p{L}\p{N} + u flag) keeps
  // letters and digits across every script.
  describe('Summary Normalization for Dedupe (Unicode-aware)', () => {
    it('lowercases ASCII and strips punctuation but keeps the words', () => {
      // Baseline behavior — must still hold after the Unicode fix.
      expect(normalizeSummaryForDedupe('Agent modified config!'))
        .toBe('agent modified config');
      expect(normalizeSummaryForDedupe('Agent modified config'))
        .toBe('agent modified config');
      // Both must hash to the SAME key (regression assertion).
      expect(normalizeSummaryForDedupe('Agent modified config!'))
        .toBe(normalizeSummaryForDedupe('agent modified config'));
    });

    it('preserves CJK ideographs (the P1 round-3 regression)', () => {
      // Pre-fix, `/[^\w\s]/g` reduced this to 'agent' — losing the Chinese
      // content entirely and collapsing every Chinese pain to one hash.
      expect(normalizeSummaryForDedupe('Agent 未经批准修改了配置'))
        .toBe('agent 未经批准修改了配置');
      // Punctuation (CJK fullwidth exclamation) is stripped but the words stay.
      expect(normalizeSummaryForDedupe('Agent 未经批准修改了配置！'))
        .toBe('agent 未经批准修改了配置');
      // Both variants must hash to the same key — the core dedupe guarantee.
      expect(normalizeSummaryForDedupe('Agent 未经批准修改了配置！'))
        .toBe(normalizeSummaryForDedupe('Agent 未经批准修改了配置'));
    });

    it('collapses fullwidth forms via NFKC', () => {
      // Fullwidth Latin letters + fullwidth space (U+3000) must fold to their
      // ASCII counterparts before content-hash comparison. Different owners
      // using different input methods (or copy-pasted text) should still match.
      expect(normalizeSummaryForDedupe('Ａｇｅｎｔ　修改'))
        .toBe(normalizeSummaryForDedupe('Agent 修改'));
      // Fullwidth digits fold too.
      expect(normalizeSummaryForDedupe('配置错误 １２３'))
        .toBe(normalizeSummaryForDedupe('配置错误 123'));
    });

    it('preserves Cyrillic and Arabic letters, not just ASCII + CJK', () => {
      // \p{L} is script-agnostic; we don't want a CJK-only patch that silently
      // breaks again for the next non-ASCII script.
      expect(normalizeSummaryForDedupe('Агент изменил конфиг!'))
        .toBe('агент изменил конфиг');
      // Arabic letters are preserved. Combining marks (\p{M}, e.g. Arabic
      // shadda ّ U+0651) are intentionally stripped — they are pronunciation
      // guides rather than lexical content, and stripping them gives better
      // dedupe: the same word written with/without shadda hashes to the same
      // key. (The fix here is \p{L}\p{N}; we deliberately do NOT include
      // \p{M}.)
      expect(normalizeSummaryForDedupe('الوكيل عدّل الإعدادات'))
        .toBe('الوكيل عدل الإعدادات');
    });

    it('collapses runs of whitespace (incl. CJK fullwidth space) to a single space', () => {
      expect(normalizeSummaryForDedupe('Agent   modified\tconfig'))
        .toBe('agent modified config');
      // U+3000 fullwidth space folds to ' ' via NFKC, then collapses.
      expect(normalizeSummaryForDedupe('Agent　　modified'))
        .toBe('agent modified');
    });

    it('returns the empty string for whitespace/punctuation-only input', () => {
      // Important: the dedupe code uses `if (!normalized) continue;` to skip
      // empty keys. This MUST stay falsy after the Unicode change so we never
      // build a wildcard "match everything" key.
      expect(normalizeSummaryForDedupe('')).toBe('');
      expect(normalizeSummaryForDedupe('   ')).toBe('');
      expect(normalizeSummaryForDedupe('！！！')).toBe('');
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

    it('returns evidence-only for tool_call observations (evidence_only admission)', () => {
      // Observations that never entered the governance chain must NOT collapse into
      // recorded-only/active_chain (PRI-385 P1-2).
      expect(determineState({ sourceKind: 'tool_call', hasCandidate: false })).toBe('evidence-only');
      expect(determineState({ sourceKind: 'rulehost', hasCandidate: false })).toBe('evidence-only');
    });

    it('keeps manual/review as recorded-only (store_signal admission)', () => {
      expect(determineState({ sourceKind: 'manual', hasCandidate: false })).toBe('recorded-only');
      expect(determineState({ sourceKind: 'review', hasCandidate: false })).toBe('recorded-only');
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

  // 3. determineNextAction recovery command correctness (PRI-385 P1-1)
  describe('determineNextAction recovery commands', () => {
    const ws = '/workspace/test';

    it('diagnosis-failed with canonical task id emits pd pain retry with --pain-id and --workspace', () => {
      // Convention: task_id = diagnosis_<painId>; the safe painId is the suffix that
      // round-trips. diagnosis_manual_1 → painId manual_1 (NOT the record id pain_*).
      const action = determineNextAction({
        state: 'diagnosis-failed',
        workspaceDir: ws,
        recordId: 'pain_1',
        linkedTaskId: 'diagnosis_manual_1',
      });
      expect(action).toBeDefined();
      expect(action).toContain('pd pain retry');
      expect(action).toContain('--pain-id manual_1');
      expect(action).toContain(`--workspace "${ws}"`);
      // record id must NOT leak into --pain-id (format mismatch with diagnosis_<painId>).
      expect(action).not.toContain('--pain-id pain_1');
    });

    it('diagnosis-retry-wait with canonical task id emits pd pain retry with --pain-id and --workspace', () => {
      const action = determineNextAction({
        state: 'diagnosis-retry-wait',
        workspaceDir: ws,
        linkedTaskId: 'diagnosis_pain_42',
      });
      expect(action).toBeDefined();
      expect(action).toContain('pd pain retry');
      expect(action).toContain('--pain-id pain_42');
      expect(action).toContain(`--workspace "${ws}"`);
    });

    it('falls back to pd diagnose run --task-id for sub-run task ids (no blind strip)', () => {
      // diag_router-diagnosis_* does NOT start with diagnosis_, so it cannot be retried
      // via pd pain retry. Fall back to the exact task id (PRI-385 P1-1).
      const action = determineNextAction({
        state: 'diagnosis-failed',
        workspaceDir: ws,
        linkedTaskId: 'diag_router-diagnosis_manual_2',
      });
      expect(action).toBeDefined();
      expect(action).toContain('pd diagnose run --task-id diag_router-diagnosis_manual_2');
      expect(action).toContain(`--workspace "${ws}"`);
      expect(action).not.toContain('pd pain retry');
    });

    it('emits a reason-style nextAction (no command) when no task id is linked', () => {
      const action = determineNextAction({
        state: 'diagnosis-failed',
        workspaceDir: ws,
      });
      expect(action).toBeDefined();
      expect(action).not.toContain('pd pain retry');
      expect(action).not.toContain('pd diagnose run');
    });

    it('keeps --workspace in candidate-generated / internalization-missing command', () => {
      const action = determineNextAction({
        state: 'candidate-generated',
        workspaceDir: ws,
      });
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

    it('workspaceMismatchWarning: unmatched tool_call observation is evidence-only, not active chain', () => {
      // PRI-385 P1-2: a hook/tool_call observation that could not be linked to a
      // diagnostician task must surface as `evidence-only`, never `recorded-only`
      // (which groups into active_chain). This is the real unmatched assembly path.
      const { res } = firstRecordOf('workspaceMismatchWarning');
      expect(res.records).toHaveLength(2);
      const record = res.records.find(r => r.id === 'pain_10');
      expect(record).toBeDefined();
      expect(record?.state).toBe('evidence-only');
      expect(record?.admissionDecision).toBe('evidence_only');
      expect(record?.degradedReason).toContain('Could not link this pain event to a diagnostician task');
      expect(res.degradedReason).toContain('Pain event pain_10 could not be linked');
    });

    it('diagnosis-failed record (real assembleEvidenceChain path) emits retry command with --pain-id and --workspace', () => {
      // PRI-385 P1-1 / ERR-025: prove the executable nextAction flows through the real
      // assembly mapper, not just the isolated determineNextAction helper.
      const res = assembleEvidenceChain({
        workspaceDir: '/workspace/dogfood',
        painEvents: [
          { id: 21, source: 'manual', reason: 'Failed diagnosis', created_at: '2026-06-13T10:30:00.000Z', score: 90 },
        ],
        tasks: [
          {
            task_id: 'diagnosis_manual_21',
            task_kind: 'diagnostician',
            status: 'failed',
            created_at: '2026-06-13T10:31:00.000Z',
            input_ref: 'pain_21',
            last_error: 'LLM timed out',
          },
        ],
        candidates: [],
        dreamerTasks: [],
        ledgerPrinciples: [],
        trajectoryDbAvailable: true,
        stateDbAvailable: true,
      });
      const record = res.records.find(r => r.id === 'pain_21');
      expect(record).toBeDefined();
      expect(record?.state).toBe('diagnosis-failed');
      expect(record?.linkedTaskId).toBe('diagnosis_manual_21');
      expect(record?.nextAction).toContain('pd pain retry');
      expect(record?.nextAction).toContain('--pain-id manual_21');
      expect(record?.nextAction).toContain('--workspace "/workspace/dogfood"');
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
