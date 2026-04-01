import test from 'node:test';
import assert from 'node:assert/strict';
import { decideStage, normalizeVerdict, extractBullets, buildStageMetrics, hasExplicitVerdict } from '../lib/decision.mjs';

test('normalizeVerdict extracts explicit verdict', () => {
  assert.equal(normalizeVerdict('VERDICT: approve'), 'APPROVE');
  assert.equal(normalizeVerdict('VERDICT: BLOCK'), 'BLOCK');
});

test('hasExplicitVerdict rejects non-standard verdicts', () => {
  assert.equal(hasExplicitVerdict('VERDICT: APPROVE'), true);
  assert.equal(hasExplicitVerdict('VERDICT: PARTIAL_APPROVE'), false);
});

test('extractBullets reads bullet lines from section', () => {
  const text = [
    'VERDICT: REVISE',
    'BLOCKERS:',
    '- blocker one',
    '- blocker two',
    'FINDINGS:',
    '- finding',
  ].join('\n');
  assert.deepEqual(extractBullets(text, 'BLOCKERS'), ['blocker one', 'blocker two']);
});

test('decideStage advances only when both reviewers approve', () => {
  const result = decideStage({
    stageCriteria: {
      requiredApprovals: 2,
      requiredProducerSections: ['SUMMARY', 'EVIDENCE'],
      requiredReviewerSections: ['VERDICT', 'BLOCKERS'],
    },
    producer: 'SUMMARY:\nDone\nEVIDENCE:\nDone',
    reviewerA: 'VERDICT: APPROVE\nBLOCKERS:\n- None.',
    reviewerB: 'VERDICT: APPROVE\nBLOCKERS:\n- None.',
    currentRound: 1,
    maxRoundsPerStage: 3,
  });
  assert.equal(result.outcome, 'advance');
});

test('decideStage halts when max rounds reached without approval', () => {
  const result = decideStage({
    stageCriteria: {
      requiredApprovals: 2,
      requiredProducerSections: ['SUMMARY'],
      requiredReviewerSections: ['VERDICT', 'BLOCKERS'],
    },
    producer: 'SUMMARY:\nDone',
    reviewerA: 'VERDICT: REVISE\nBLOCKERS:\n- one',
    reviewerB: 'VERDICT: BLOCK\nBLOCKERS:\n- two',
    currentRound: 3,
    maxRoundsPerStage: 3,
  });
  assert.equal(result.outcome, 'halt');
  assert.deepEqual(result.blockers, ['one', 'two']);
});

test('buildStageMetrics tracks section and approval counts', () => {
  const metrics = buildStageMetrics({
    stageCriteria: {
      requiredProducerSections: ['SUMMARY', 'CHECKS'],
      requiredReviewerSections: ['VERDICT', 'CHECKS'],
    },
    producer: 'SUMMARY:\nDone\nCHECKS: evidence=ok',
    reviewerA: 'VERDICT: APPROVE\nBLOCKERS:\n- None.\nCHECKS: criteria=met',
    reviewerB: 'VERDICT: APPROVE\nBLOCKERS:\n- None.\nCHECKS: criteria=met',
  });

  assert.equal(metrics.approvalCount, 2);
  assert.equal(metrics.producerSectionChecks.SUMMARY, true);
  assert.equal(metrics.producerSectionChecks.CHECKS, true);
  assert.equal(metrics.reviewerSectionChecks.VERDICT, true);
  assert.equal(metrics.reviewerSectionChecks.CHECKS, true);
});

test('decideStage does not advance with invalid reviewer verdict syntax', () => {
  const result = decideStage({
    stageCriteria: {
      requiredApprovals: 2,
      requiredProducerSections: ['SUMMARY'],
      requiredReviewerSections: ['VERDICT', 'BLOCKERS'],
    },
    producer: 'SUMMARY:\nDone',
    reviewerA: 'VERDICT: PARTIAL_APPROVE\nBLOCKERS:\n- None.',
    reviewerB: 'VERDICT: APPROVE\nBLOCKERS:\n- None.',
    currentRound: 1,
    maxRoundsPerStage: 3,
  });

  assert.equal(result.outcome, 'revise');
  assert.equal(result.blockers[0], 'One or more reviewers did not emit a strict VERDICT: APPROVE|REVISE|BLOCK line.');
});

test('decideStage does not advance when reviewers list real blockers despite APPROVE', () => {
  const result = decideStage({
    stageCriteria: {
      requiredApprovals: 2,
      requiredProducerSections: ['SUMMARY'],
      requiredReviewerSections: ['VERDICT', 'BLOCKERS'],
    },
    producer: 'SUMMARY:\nDone',
    reviewerA: 'VERDICT: APPROVE\nBLOCKERS:\n- Missing test for edge case',
    reviewerB: 'VERDICT: APPROVE\nBLOCKERS:\n- None.',
    currentRound: 1,
    maxRoundsPerStage: 3,
  });

  assert.equal(result.outcome, 'revise');
  assert.equal(result.metrics.blockerCount, 1);
});
