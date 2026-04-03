import test from 'node:test';
import assert from 'node:assert/strict';
import {
  validateProducerReport,
  validateReviewerReport,
  validateGlobalReviewerReport,
  validateStageReports,
  validateVerdict,
  validateChecks,
  hasSectionStrict,
  extractSectionContent,
  determineOutputQuality,
  determineNextRunRecommendation,
  OUTPUT_QUALITY,
  NEXT_RUN_TYPE,
  PRODUCER_SCHEMA,
  REVIEWER_SCHEMA,
  GLOBAL_REVIEWER_SCHEMA,
} from '../lib/contract-enforcement.mjs';

// ============================================================================
// Schema Definition Tests
// ============================================================================

test('PRODUCER_SCHEMA defines required sections', () => {
  assert.ok(PRODUCER_SCHEMA.requiredSections.includes('SUMMARY'));
  assert.ok(PRODUCER_SCHEMA.requiredSections.includes('CHECKS'));
  assert.ok(PRODUCER_SCHEMA.requiredSections.includes('CODE_EVIDENCE'));
});

test('REVIEWER_SCHEMA defines VERDICT allowed values', () => {
  assert.deepEqual(REVIEWER_SCHEMA.requiredFields.VERDICT.allowedValues, ['APPROVE', 'REVISE', 'BLOCK']);
});

test('GLOBAL_REVIEWER_SCHEMA requires MACRO_ANSWERS', () => {
  assert.ok(GLOBAL_REVIEWER_SCHEMA.requiredSections.includes('MACRO_ANSWERS'));
});

// ============================================================================
// Section Detection Tests
// ============================================================================

test('hasSectionStrict detects SECTION: format', () => {
  const text = 'SUMMARY:\nThis is a summary.';
  assert.equal(hasSectionStrict(text, 'SUMMARY'), true);
});

test('hasSectionStrict detects ## SECTION markdown format', () => {
  const text = '## SUMMARY\n\nThis is a summary.';
  assert.equal(hasSectionStrict(text, 'SUMMARY'), true);
});

test('hasSectionStrict returns false for missing section', () => {
  const text = 'SUMMARY:\nThis is a summary.';
  assert.equal(hasSectionStrict(text, 'CONTRACT'), false);
});

test('hasSectionStrict is case-insensitive', () => {
  const text = '## summary\n\nContent';
  assert.equal(hasSectionStrict(text, 'SUMMARY'), true);
});

test('extractSectionContent returns content between sections', () => {
  const text = 'SUMMARY:\nThis is the summary.\n\nCHANGES:\nNo changes.';
  const content = extractSectionContent(text, 'SUMMARY');
  assert.equal(content, 'This is the summary.');
});

test('extractSectionContent returns null for missing section', () => {
  const text = 'SUMMARY:\nContent';
  assert.equal(extractSectionContent(text, 'MISSING'), null);
});

// ============================================================================
// VERDICT Validation Tests
// ============================================================================

test('validateVerdict accepts APPROVE', () => {
  const result = validateVerdict('VERDICT: APPROVE');
  assert.equal(result.valid, true);
  assert.equal(result.value, 'APPROVE');
});

test('validateVerdict accepts REVISE', () => {
  const result = validateVerdict('VERDICT: REVISE');
  assert.equal(result.valid, true);
  assert.equal(result.value, 'REVISE');
});

test('validateVerdict accepts BLOCK', () => {
  const result = validateVerdict('VERDICT: BLOCK');
  assert.equal(result.valid, true);
  assert.equal(result.value, 'BLOCK');
});

test('validateVerdict rejects invalid verdict', () => {
  const result = validateVerdict('VERDICT: PARTIAL_APPROVE');
  assert.equal(result.valid, false);
  assert.ok(result.error.includes('Invalid VERDICT'));
});

test('validateVerdict rejects missing verdict', () => {
  const result = validateVerdict('No verdict here');
  assert.equal(result.valid, false);
  assert.ok(result.error.includes('not found'));
});

test('validateVerdict accepts markdown ## VERDICT format', () => {
  const result = validateVerdict('## VERDICT\n\nAPPROVE');
  assert.equal(result.valid, true);
  assert.equal(result.value, 'APPROVE');
});

// ============================================================================
// CHECKS Validation Tests
// ============================================================================

test('validateChecks accepts key=value format', () => {
  const result = validateChecks('CHECKS: evidence=ok;tests=passed');
  assert.equal(result.valid, true);
  assert.deepEqual(result.value, { evidence: 'ok', tests: 'passed' });
});

test('validateChecks rejects missing CHECKS', () => {
  const result = validateChecks('No checks here');
  assert.equal(result.valid, false);
  assert.ok(result.error.includes('not found'));
});

test('validateChecks reports invalid format', () => {
  const result = validateChecks('CHECKS: invalid_format;evidence=ok');
  assert.equal(result.valid, false);
  assert.ok(result.error.includes('Invalid CHECKS format'));
});

// ============================================================================
// Producer Report Validation Tests
// ============================================================================

test('validateProducerReport passes valid report', () => {
  const text = [
    'SUMMARY:\nDone',
    'CHANGES:\nNone',
    'EVIDENCE:\nTest passed',
    'CODE_EVIDENCE:',
    '- files_checked: [a.ts]',
    '- sha: abc',
    '- evidence_source: local',
    'KEY_EVENTS:\n- Event 1',
    'HYPOTHESIS_MATRIX:\n- H1: SUPPORTED',
    'CHECKS: evidence=ok',
    'OPEN_RISKS:\n- None',
  ].join('\n');

  const result = validateProducerReport(text);
  assert.equal(result.valid, true);
  assert.deepEqual(result.missingSections, []);
  assert.deepEqual(result.invalidFields, []);
});

test('validateProducerReport fails missing required sections', () => {
  const text = 'SUMMARY:\nDone';
  const result = validateProducerReport(text);

  assert.equal(result.valid, false);
  assert.ok(result.missingSections.includes('CHANGES'));
  assert.ok(result.missingSections.includes('CHECKS'));
});

test('validateProducerReport requires CONTRACT when deliverables specified', () => {
  const text = [
    'SUMMARY:\nDone',
    'CHANGES:\nNone',
    'EVIDENCE:\nTest passed',
    'CODE_EVIDENCE:',
    '- files_checked: [a.ts]',
    '- sha: abc',
    '- evidence_source: local',
    'KEY_EVENTS:\n- Event 1',
    'HYPOTHESIS_MATRIX:\n- H1: SUPPORTED',
    'CHECKS: evidence=ok',
    'OPEN_RISKS:\n- None',
  ].join('\n');

  const result = validateProducerReport(text, { requiredDeliverables: ['root_cause'] });
  assert.equal(result.valid, false);
  assert.ok(result.missingSections.includes('CONTRACT'));
});

// ============================================================================
// Reviewer Report Validation Tests
// ============================================================================

test('validateReviewerReport passes valid report', () => {
  const text = [
    'VERDICT: APPROVE',
    'BLOCKERS:\n- None',
    'FINDINGS:\n- All good',
    'CODE_EVIDENCE:',
    '- files_verified: [a.ts]',
    '- sha: abc',
    'HYPOTHESIS_MATRIX:\n- H1: SUPPORTED',
    'NEXT_FOCUS: Continue',
    'CHECKS: criteria=met',
  ].join('\n');

  const result = validateReviewerReport(text);
  assert.equal(result.valid, true);
  assert.equal(result.extractedData.verdict, 'APPROVE');
});

test('validateReviewerReport fails invalid verdict', () => {
  const text = [
    'VERDICT: MAYBE',
    'BLOCKERS:\n- None',
    'FINDINGS:\n- All good',
    'CODE_EVIDENCE:',
    '- files_verified: [a.ts]',
    'HYPOTHESIS_MATRIX:\n- H1: SUPPORTED',
    'NEXT_FOCUS: Continue',
    'CHECKS: criteria=met',
  ].join('\n');

  const result = validateReviewerReport(text);
  assert.equal(result.valid, false);
  assert.ok(result.invalidFields.some(f => f.includes('Invalid VERDICT')));
});

test('validateReviewerReport requires DIMENSIONS when scoring dimensions specified', () => {
  const text = [
    'VERDICT: APPROVE',
    'BLOCKERS:\n- None',
    'FINDINGS:\n- All good',
    'CODE_EVIDENCE:',
    '- files_verified: [a.ts]',
    'HYPOTHESIS_MATRIX:\n- H1: SUPPORTED',
    'NEXT_FOCUS: Continue',
    'CHECKS: criteria=met',
  ].join('\n');

  const result = validateReviewerReport(text, { scoringDimensions: ['correctness'] });
  assert.equal(result.valid, false);
  assert.ok(result.missingSections.includes('DIMENSIONS'));
});

// ============================================================================
// Global Reviewer Report Validation Tests
// ============================================================================

test('validateGlobalReviewerReport passes valid report', () => {
  const text = [
    'VERDICT: APPROVE',
    'MACRO_ANSWERS:',
    'Q1: OpenClaw compatible — verified',
    'Q2: Business flow closed — verified',
    'BLOCKERS:\n- None',
    'FINDINGS:\n- All good',
    'CODE_EVIDENCE:',
    '- files_verified: [a.ts]',
    'NEXT_FOCUS: Continue',
    'CHECKS: macro=aligned',
  ].join('\n');

  const result = validateGlobalReviewerReport(text, { requiredMacroQuestions: ['Q1', 'Q2'] });
  assert.equal(result.valid, true);
  assert.equal(result.extractedData.verdict, 'APPROVE');
});

test('validateGlobalReviewerReport fails missing macro answers', () => {
  const text = [
    'VERDICT: APPROVE',
    'MACRO_ANSWERS:',
    'Q1: OpenClaw compatible — verified',
    'BLOCKERS:\n- None',
    'FINDINGS:\n- All good',
    'CODE_EVIDENCE:',
    '- files_verified: [a.ts]',
    'NEXT_FOCUS: Continue',
    'CHECKS: macro=aligned',
  ].join('\n');

  const result = validateGlobalReviewerReport(text, { requiredMacroQuestions: ['Q1', 'Q2'] });
  assert.equal(result.valid, false);
  assert.ok(result.invalidFields.some(f => f.includes('Q2')));
});

test('validateGlobalReviewerReport fails missing MACRO_ANSWERS section', () => {
  const text = [
    'VERDICT: APPROVE',
    'BLOCKERS:\n- None',
    'FINDINGS:\n- All good',
    'CODE_EVIDENCE:',
    '- files_verified: [a.ts]',
    'NEXT_FOCUS: Continue',
    'CHECKS: macro=aligned',
  ].join('\n');

  const result = validateGlobalReviewerReport(text, { requiredMacroQuestions: ['Q1'] });
  assert.equal(result.valid, false);
  assert.ok(result.missingSections.includes('MACRO_ANSWERS'));
});

// ============================================================================
// Stage Reports Validation Tests
// ============================================================================

test('validateStageReports validates all roles', () => {
  const producer = [
    'SUMMARY:\nDone',
    'CHANGES:\nNone',
    'EVIDENCE:\nTest passed',
    'CODE_EVIDENCE:',
    '- files_checked: [a.ts]',
    '- sha: abc',
    '- evidence_source: local',
    'KEY_EVENTS:\n- Event 1',
    'HYPOTHESIS_MATRIX:\n- H1: SUPPORTED',
    'CHECKS: evidence=ok',
    'OPEN_RISKS:\n- None',
  ].join('\n');

  const reviewer = [
    'VERDICT: APPROVE',
    'BLOCKERS:\n- None',
    'FINDINGS:\n- All good',
    'CODE_EVIDENCE:',
    '- files_verified: [a.ts]',
    '- sha: abc',
    'HYPOTHESIS_MATRIX:\n- H1: SUPPORTED',
    'NEXT_FOCUS: Continue',
    'CHECKS: criteria=met',
  ].join('\n');

  const result = validateStageReports({
    producer,
    reviewerA: reviewer,
    reviewerB: reviewer,
  });

  assert.equal(result.valid, true);
  assert.equal(result.producer.valid, true);
  assert.equal(result.reviewerA.valid, true);
  assert.equal(result.reviewerB.valid, true);
});

test('validateStageReports fails when reviewer report is invalid', () => {
  const producer = [
    'SUMMARY:\nDone',
    'CHANGES:\nNone',
    'EVIDENCE:\nTest passed',
    'CODE_EVIDENCE:',
    '- files_checked: [a.ts]',
    '- sha: abc',
    '- evidence_source: local',
    'KEY_EVENTS:\n- Event 1',
    'HYPOTHESIS_MATRIX:\n- H1: SUPPORTED',
    'CHECKS: evidence=ok',
    'OPEN_RISKS:\n- None',
  ].join('\n');

  const reviewerInvalid = 'VERDICT: MAYBE\nBLOCKERS:\n- None\nCHECKS: bad';

  const result = validateStageReports({
    producer,
    reviewerA: reviewerInvalid,
    reviewerB: reviewerInvalid,
  });

  assert.equal(result.valid, false);
  assert.ok(result.errorSummary.includes('Reviewer report contract violation'));
});

// ============================================================================
// Output Quality Determination Tests
// ============================================================================

test('determineOutputQuality returns NEEDS_WORK for invalid validation', () => {
  const validation = { valid: false };
  const metrics = {};

  const result = determineOutputQuality(validation, metrics);
  assert.equal(result.quality, OUTPUT_QUALITY.NEEDS_WORK);
});

test('determineOutputQuality returns NEEDS_WORK for insufficient approvals', () => {
  const validation = { valid: true };
  const metrics = { approvalCount: 1, requiredApprovals: 2 };

  const result = determineOutputQuality(validation, metrics);
  assert.equal(result.quality, OUTPUT_QUALITY.NEEDS_WORK);
});

test('determineOutputQuality returns NEEDS_WORK for blockers', () => {
  const validation = { valid: true };
  const metrics = { approvalCount: 2, blockerCount: 1 };

  const result = determineOutputQuality(validation, metrics);
  assert.equal(result.quality, OUTPUT_QUALITY.NEEDS_WORK);
});

test('determineOutputQuality returns SHADOW_COMPLETE for basic passing criteria', () => {
  const validation = { valid: true };
  const metrics = {
    approvalCount: 2,
    requiredApprovals: 2,
    blockerCount: 0,
    dimensionFailures: [],
    producerCodeEvidence: { evidenceScope: 'local' }, // Not 'both', so not production ready
  };

  const result = determineOutputQuality(validation, metrics);
  assert.equal(result.quality, OUTPUT_QUALITY.SHADOW_COMPLETE);
});

test('determineOutputQuality returns PRODUCTION_READY when all criteria met', () => {
  const validation = { valid: true };
  const metrics = {
    approvalCount: 2,
    requiredApprovals: 2,
    blockerCount: 0,
    dimensionFailures: [],
    producerCodeEvidence: { evidenceScope: 'both' },
    scoringDimensions: ['correctness', 'scope'],
    reviewerADimensions: { correctness: 4, scope: 5 },
    reviewerBDimensions: { correctness: 5, scope: 4 },
  };

    const result = determineOutputQuality(validation, metrics);

    assert.equal(result.quality, OUTPUT_QUALITY.PRODUCTION_READY);

  });

  

  test('determineOutputQuality returns SHADOW_COMPLETE when dimension below production threshold', () => {

    const validation = { valid: true };

    const metrics = {

      approvalCount: 2,

      requiredApprovals: 2,

      blockerCount: 0,

      dimensionFailures: [],

      producerCodeEvidence: { evidenceScope: 'both' },

      scoringDimensions: ['correctness'],

      reviewerADimensions: { correctness: 3 }, // Below production threshold 4

      reviewerBDimensions: { correctness: 5 },

    };

  

    const result = determineOutputQuality(validation, metrics);

    assert.equal(result.quality, OUTPUT_QUALITY.SHADOW_COMPLETE);

    assert.ok(result.reasons.some(r => r.includes('below production threshold')));

  });

  

  test('determineOutputQuality respects custom production threshold', () => {

    const validation = { valid: true };

    const metrics = {

      approvalCount: 2,

      requiredApprovals: 2,

      blockerCount: 0,

      dimensionFailures: [],

      producerCodeEvidence: { evidenceScope: 'both' },

      scoringDimensions: ['correctness'],

      reviewerADimensions: { correctness: 3 },

      reviewerBDimensions: { correctness: 3 },

    };

  

    const result = determineOutputQuality(validation, metrics, { productionThreshold: 3 });

    assert.equal(result.quality, OUTPUT_QUALITY.PRODUCTION_READY);

  });

  test('determineOutputQuality handles global reviewer requirements', () => {

    const validation = { valid: true };

    const metrics = {

      approvalCount: 3,

      requiredApprovals: 3,

      blockerCount: 0,

      dimensionFailures: [],

      globalReviewerRequired: true,

      macroAnswersAllSatisfied: false, // Not satisfied

      producerCodeEvidence: { evidenceScope: 'both' },

    };

    const result = determineOutputQuality(validation, metrics);

    assert.equal(result.quality, OUTPUT_QUALITY.NEEDS_WORK);

    assert.ok(result.reasons.some(r => r.includes('Macro answers')));

  });

  test('determineOutputQuality handles contract fulfillment', () => {

    const validation = { valid: true };

    const metrics = {

      approvalCount: 2,

      requiredApprovals: 2,

      blockerCount: 0,

      dimensionFailures: [],

      requiredDeliverables: ['root_cause'],

      contractCheck: { allDone: false },

    };

    const result = determineOutputQuality(validation, metrics);

    assert.equal(result.quality, OUTPUT_QUALITY.NEEDS_WORK);

    assert.ok(result.reasons.some(r => r.includes('Contract not fulfilled')));

  });

  // ==========================================================================
  // Phase 3: determineNextRunRecommendation Tests
  // ==========================================================================

  test('determineNextRunRecommendation returns NONE for PRODUCTION_READY', () => {
    const result = determineNextRunRecommendation(
      OUTPUT_QUALITY.PRODUCTION_READY,
      'advance',
      {},
      { qualityReasons: ['All criteria met'] }
    );
    assert.equal(result.type, NEXT_RUN_TYPE.NONE);
    assert.equal(result.spec, null);
  });

  test('determineNextRunRecommendation returns CONTINUATION for NEEDS_WORK with revise', () => {
    const result = determineNextRunRecommendation(
      OUTPUT_QUALITY.NEEDS_WORK,
      'revise',
      {},
      { qualityReasons: ['Validation failed'] }
    );
    assert.equal(result.type, NEXT_RUN_TYPE.CONTINUATION);
  });

  test('determineNextRunRecommendation returns CONTINUATION for NEEDS_WORK with halt (no recoverySpec)', () => {
    const result = determineNextRunRecommendation(
      OUTPUT_QUALITY.NEEDS_WORK,
      'halt',
      {},
      { qualityReasons: ['Stage halted'] }
    );
    assert.equal(result.type, NEXT_RUN_TYPE.CONTINUATION);
    assert.ok(result.reasons.some(r => r.includes('halted')));
  });

  test('determineNextRunRecommendation returns HANDOFF for NEEDS_WORK with halt and recoverySpec', () => {
    const result = determineNextRunRecommendation(
      OUTPUT_QUALITY.NEEDS_WORK,
      'halt',
      { recoverySpec: 'recovery-spec-name' },
      { qualityReasons: ['Stage halted'] }
    );
    assert.equal(result.type, NEXT_RUN_TYPE.HANDOFF);
    assert.equal(result.spec, 'recovery-spec-name');
  });

  test('determineNextRunRecommendation returns VERIFY for SHADOW_COMPLETE with verificationSpec', () => {
    const result = determineNextRunRecommendation(
      OUTPUT_QUALITY.SHADOW_COMPLETE,
      'advance',
      { verificationSpec: 'verify-spec-name' },
      { qualityReasons: ['Below production threshold'] }
    );
    assert.equal(result.type, NEXT_RUN_TYPE.VERIFY);
    assert.equal(result.spec, 'verify-spec-name');
  });

  test('determineNextRunRecommendation returns VERIFY for SHADOW_COMPLETE with requireVerify=true', () => {
    const result = determineNextRunRecommendation(
      OUTPUT_QUALITY.SHADOW_COMPLETE,
      'advance',
      { requireVerify: true },
      { qualityReasons: ['Below production threshold'] }
    );
    assert.equal(result.type, NEXT_RUN_TYPE.VERIFY);
    assert.equal(result.spec, null);
  });

  test('determineNextRunRecommendation returns CONTINUATION for SHADOW_COMPLETE without verify config', () => {
    const result = determineNextRunRecommendation(
      OUTPUT_QUALITY.SHADOW_COMPLETE,
      'advance',
      {},
      { qualityReasons: ['Below production threshold'] }
    );
    assert.equal(result.type, NEXT_RUN_TYPE.CONTINUATION);
  });

  test('determineNextRunRecommendation handles null spec safely', () => {
    const result = determineNextRunRecommendation(
      OUTPUT_QUALITY.SHADOW_COMPLETE,
      'advance',
      null,
      { qualityReasons: ['Test'] }
    );
    // Should not throw, should return CONTINUATION for shadow_complete without verify config
    assert.equal(result.type, NEXT_RUN_TYPE.CONTINUATION);
  });

  test('determineNextRunRecommendation includes qualityReasons in output', () => {
    const result = determineNextRunRecommendation(
      OUTPUT_QUALITY.NEEDS_WORK,
      'revise',
      {},
      { qualityReasons: ['Missing sections', 'Invalid verdict'] }
    );
    assert.ok(result.reasons.some(r => r.includes('Missing sections')));
    assert.ok(result.reasons.some(r => r.includes('Invalid verdict')));
  });

  test('determineNextRunRecommendation uses continuationSpec when provided', () => {
    const result = determineNextRunRecommendation(
      OUTPUT_QUALITY.NEEDS_WORK,
      'revise',
      { continuationSpec: 'continue-spec-name' },
      { qualityReasons: ['Need more work'] }
    );
    assert.equal(result.type, NEXT_RUN_TYPE.CONTINUATION);
    assert.equal(result.spec, 'continue-spec-name');
  });
