import test from 'node:test';
import assert from 'node:assert/strict';
import {
  decideStage,
  normalizeVerdict,
  extractBullets,
  buildStageMetrics,
  hasExplicitVerdict,
  parseDimensions,
  checkDimensionThresholds,
  extractContractItems,
  checkContractCompletion,
  buildHandoff,
  extractCodeEvidence,
  hasCodeEvidence,
  extractMacroAnswers,
} from '../lib/decision.mjs';

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
  assert.equal(result.blockers[0], 'Reviewer A did not emit a strict VERDICT: APPROVE|REVISE|BLOCK line.');
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

// --- Multi-dimensional scoring tests ---

test('parseDimensions extracts key=value pairs from DIMENSIONS line', () => {
  const text = 'VERDICT: APPROVE\nDIMENSIONS: evidence_quality=4;hypothesis_coverage=3;root_cause_confidence=5\nBLOCKERS:\n- None.';
  const dims = parseDimensions(text);
  assert.deepEqual(dims, {
    evidence_quality: 4,
    hypothesis_coverage: 3,
    root_cause_confidence: 5,
  });
});

test('parseDimensions returns empty object when no DIMENSIONS line', () => {
  assert.deepEqual(parseDimensions('VERDICT: APPROVE'), {});
  assert.deepEqual(parseDimensions(''), {});
});

test('parseDimensions ignores malformed entries', () => {
  const text = 'DIMENSIONS: valid=3;no_equals_sign;also_valid=4;bad=not_a_number';
  const dims = parseDimensions(text);
  assert.deepEqual(dims, { valid: 3, also_valid: 4 });
});

test('checkDimensionThresholds passes when all dimensions meet threshold', () => {
  const scores = { evidence_quality: 4, scope_control: 5 };
  const result = checkDimensionThresholds(scores, ['evidence_quality', 'scope_control'], 3);
  assert.equal(result.failures.length, 0);
  assert.equal(result.checks.evidence_quality, true);
  assert.equal(result.checks.scope_control, true);
});

test('checkDimensionThresholds reports failures for below-threshold scores', () => {
  const scores = { evidence_quality: 2, scope_control: 4 };
  const result = checkDimensionThresholds(scores, ['evidence_quality', 'scope_control'], 3);
  assert.equal(result.failures.length, 1);
  assert.equal(result.checks.evidence_quality, false);
  assert.equal(result.checks.scope_control, true);
});

test('checkDimensionThresholds reports failure when dimension not scored', () => {
  const scores = { evidence_quality: 4 };
  const result = checkDimensionThresholds(scores, ['evidence_quality', 'missing_dim'], 3);
  assert.equal(result.failures.length, 1);
  assert.equal(result.checks.evidence_quality, true);
  assert.equal(result.checks.missing_dim, null);
});

test('decideStage does not advance when dimension scores below threshold', () => {
  const result = decideStage({
    stageCriteria: {
      requiredApprovals: 2,
      requiredProducerSections: ['SUMMARY'],
      requiredReviewerSections: ['VERDICT', 'BLOCKERS'],
      scoringDimensions: ['evidence_quality', 'scope_control'],
      dimensionThreshold: 3,
    },
    producer: 'SUMMARY:\nDone',
    reviewerA: 'VERDICT: APPROVE\nDIMENSIONS: evidence_quality=2;scope_control=4\nBLOCKERS:\n- None.',
    reviewerB: 'VERDICT: APPROVE\nDIMENSIONS: evidence_quality=4;scope_control=5\nBLOCKERS:\n- None.',
    currentRound: 1,
    maxRoundsPerStage: 3,
  });

  assert.equal(result.outcome, 'revise');
  assert.ok(result.blockers.some((b) => b.includes('evidence_quality')));
});

test('decideStage advances when all dimension scores meet threshold', () => {
  const result = decideStage({
    stageCriteria: {
      requiredApprovals: 2,
      requiredProducerSections: ['SUMMARY'],
      requiredReviewerSections: ['VERDICT', 'BLOCKERS'],
      scoringDimensions: ['evidence_quality', 'scope_control'],
      dimensionThreshold: 3,
    },
    producer: 'SUMMARY:\nDone',
    reviewerA: 'VERDICT: APPROVE\nDIMENSIONS: evidence_quality=4;scope_control=5\nBLOCKERS:\n- None.',
    reviewerB: 'VERDICT: APPROVE\nDIMENSIONS: evidence_quality=5;scope_control=4\nBLOCKERS:\n- None.',
    currentRound: 1,
    maxRoundsPerStage: 3,
  });

  assert.equal(result.outcome, 'advance');
});

test('buildStageMetrics includes dimension scores and checks', () => {
  const metrics = buildStageMetrics({
    stageCriteria: {
      requiredProducerSections: ['SUMMARY'],
      requiredReviewerSections: ['VERDICT'],
      scoringDimensions: ['correctness'],
      dimensionThreshold: 3,
    },
    producer: 'SUMMARY:\nDone',
    reviewerA: 'VERDICT: APPROVE\nDIMENSIONS: correctness=4',
    reviewerB: 'VERDICT: APPROVE\nDIMENSIONS: correctness=5',
  });

  assert.deepEqual(metrics.reviewerADimensions, { correctness: 4 });
  assert.deepEqual(metrics.reviewerBDimensions, { correctness: 5 });
  assert.equal(metrics.dimensionFailures.length, 0);
});

// --- Sprint contract tests ---

test('extractContractItems parses CONTRACT section', () => {
  const text = [
    'SUMMARY:\nDone',
    'CONTRACT:',
    '- Root cause identified with evidence status: DONE evidence: "see EVIDENCE"',
    '- Reproduction steps documented status: PARTIAL evidence: "partial"',
    '- Fix proposed status: TODO',
  ].join('\n');

  const items = extractContractItems(text);
  assert.equal(items.length, 3);
  assert.equal(items[0].status, 'DONE');
  assert.equal(items[1].status, 'PARTIAL');
  assert.equal(items[2].status, 'TODO');
});

test('extractContractItems returns empty array when no CONTRACT section', () => {
  assert.deepEqual(extractContractItems('SUMMARY:\nDone'), []);
});

test('checkContractCompletion reports all done', () => {
  const items = [
    { deliverable: 'Root cause', status: 'DONE' },
    { deliverable: 'Fix plan', status: 'DONE' },
  ];
  const result = checkContractCompletion(items);
  assert.equal(result.allDone, true);
  assert.equal(result.doneItems, 2);
  assert.equal(result.incompleteItems.length, 0);
});

test('checkContractCompletion reports incomplete items', () => {
  const items = [
    { deliverable: 'Root cause', status: 'DONE' },
    { deliverable: 'Fix plan', status: 'PARTIAL' },
  ];
  const result = checkContractCompletion(items);
  assert.equal(result.allDone, false);
  assert.equal(result.incompleteItems.length, 1);
});

test('decideStage does not advance when contract items are incomplete', () => {
  const result = decideStage({
    stageCriteria: {
      requiredApprovals: 2,
      requiredProducerSections: ['SUMMARY'],
      requiredReviewerSections: ['VERDICT', 'BLOCKERS'],
      requiredDeliverables: ['root_cause', 'fix_plan'],
    },
    producer: 'SUMMARY:\nDone\nCONTRACT:\n- Root cause identified status: DONE\n- Fix plan written status: PARTIAL',
    reviewerA: 'VERDICT: APPROVE\nBLOCKERS:\n- None.',
    reviewerB: 'VERDICT: APPROVE\nBLOCKERS:\n- None.',
    currentRound: 1,
    maxRoundsPerStage: 3,
  });

  assert.equal(result.outcome, 'revise');
  assert.ok(result.blockers.some((b) => b.includes('Contract not fulfilled')));
});

test('decideStage advances when all contract items are DONE', () => {
  const result = decideStage({
    stageCriteria: {
      requiredApprovals: 2,
      requiredProducerSections: ['SUMMARY'],
      requiredReviewerSections: ['VERDICT', 'BLOCKERS'],
      requiredDeliverables: ['root_cause'],
    },
    producer: 'SUMMARY:\nDone\nCONTRACT:\n- Root cause identified status: DONE',
    reviewerA: 'VERDICT: APPROVE\nBLOCKERS:\n- None.',
    reviewerB: 'VERDICT: APPROVE\nBLOCKERS:\n- None.',
    currentRound: 1,
    maxRoundsPerStage: 3,
  });

  assert.equal(result.outcome, 'advance');
});

// --- Structured handoff tests ---

test('buildHandoff extracts structured data from reviewer reports', () => {
  const handoff = buildHandoff({
    reviewerA: 'VERDICT: REVISE\nBLOCKERS:\n- Missing edge case\nNEXT_FOCUS: Add test for null input\nDIMENSIONS: correctness=2;scope=4',
    reviewerB: 'VERDICT: REVISE\nBLOCKERS:\n- No error handling\nNEXT_FOCUS: Handle errors gracefully\nDIMENSIONS: correctness=3;scope=5',
    producer: 'SUMMARY:\nDone\nCHECKS: evidence=ok\nCONTRACT:\n- Root cause status: DONE\n- Fix status: PARTIAL',
    metrics: {
      reviewerADimensions: { correctness: 2, scope: 4 },
      reviewerBDimensions: { correctness: 3, scope: 5 },
    },
    stageName: 'implement',
    round: 1,
  });

  assert.deepEqual(handoff.blockers, ['Missing edge case', 'No error handling']);
  assert.equal(handoff.focusForNextRound, 'Add test for null input; Handle errors gracefully');
  assert.equal(handoff.producerChecks, 'evidence=ok');
  assert.deepEqual(handoff.contractItems.length, 2);
  assert.equal(handoff.stageName, 'implement');
  assert.equal(handoff.round, 1);
  assert.ok(handoff.generatedAt);
});

test('buildHandoff handles missing NEXT_FOCUS gracefully', () => {
  const handoff = buildHandoff({
    reviewerA: 'VERDICT: APPROVE\nBLOCKERS:\n- None.',
    reviewerB: 'VERDICT: APPROVE\nBLOCKERS:\n- None.',
    producer: 'SUMMARY:\nDone',
    metrics: {},
    stageName: 'verify',
    round: 2,
  });

  assert.equal(handoff.focusForNextRound, null);
  assert.deepEqual(handoff.blockers, []);
});

// --- Combined: dimensions + contract + blockers ---

test('decideStage with dimensions, contract, and blockers all passing advances', () => {
  const result = decideStage({
    stageCriteria: {
      requiredApprovals: 2,
      requiredProducerSections: ['SUMMARY'],
      requiredReviewerSections: ['VERDICT', 'BLOCKERS'],
      scoringDimensions: ['correctness', 'scope_control'],
      dimensionThreshold: 3,
      requiredDeliverables: ['root_cause'],
    },
    producer: 'SUMMARY:\nDone\nCONTRACT:\n- Root cause found status: DONE',
    reviewerA: 'VERDICT: APPROVE\nDIMENSIONS: correctness=4;scope_control=5\nBLOCKERS:\n- None.',
    reviewerB: 'VERDICT: APPROVE\nDIMENSIONS: correctness=5;scope_control=4\nBLOCKERS:\n- None.',
    currentRound: 1,
    maxRoundsPerStage: 3,
  });

  assert.equal(result.outcome, 'advance');
  assert.equal(result.metrics.dimensionFailures.length, 0);
  assert.equal(result.metrics.contractCheck.allDone, true);
});

test('decideStage with dimension failure AND contract failure reports both as blockers', () => {
  const result = decideStage({
    stageCriteria: {
      requiredApprovals: 2,
      requiredProducerSections: ['SUMMARY'],
      requiredReviewerSections: ['VERDICT', 'BLOCKERS'],
      scoringDimensions: ['correctness'],
      dimensionThreshold: 3,
      requiredDeliverables: ['fix'],
    },
    producer: 'SUMMARY:\nDone\nCONTRACT:\n- Fix implemented status: TODO',
    reviewerA: 'VERDICT: APPROVE\nDIMENSIONS: correctness=2\nBLOCKERS:\n- None.',
    reviewerB: 'VERDICT: APPROVE\nDIMENSIONS: correctness=5\nBLOCKERS:\n- None.',
    currentRound: 1,
    maxRoundsPerStage: 3,
  });

  assert.equal(result.outcome, 'revise');
  const hasDimensionBlocker = result.blockers.some((b) => b.includes('correctness'));
  const hasContractBlocker = result.blockers.some((b) => b.includes('Contract not fulfilled'));
  assert.ok(hasDimensionBlocker, 'should have dimension blocker');
  assert.ok(hasContractBlocker, 'should have contract blocker');
});

// --- CODE_EVIDENCE tests ---

test('extractCodeEvidence parses producer CODE_EVIDENCE section', () => {
  const text = [
    'SUMMARY:\nDone',
    'CODE_EVIDENCE:',
    '- files_checked: [src/observer.js, src/persistence.ts]',
    '- evidence_source: local',
    '- sha: abc123def',
    '- branch/worktree: sprint/abc123/investigate',
    'FINDINGS:\nNone.',
  ].join('\n');
  const evidence = extractCodeEvidence(text);
  assert.deepEqual(evidence.filesChecked, ['src/observer.js', 'src/persistence.ts']);
  assert.equal(evidence.evidenceSource, 'local');
  assert.equal(evidence.sha, 'abc123def');
  assert.equal(evidence.branchWorktree, 'sprint/abc123/investigate');
});

test('extractCodeEvidence parses reviewer CODE_EVIDENCE section', () => {
  const text = [
    'VERDICT: APPROVE',
    'CODE_EVIDENCE:',
    '- files_verified: [src/fix.ts, src/test.ts]',
    '- evidence_source: both',
    '- sha: fed123',
  ].join('\n');
  const evidence = extractCodeEvidence(text);
  assert.deepEqual(evidence.filesChecked, ['src/fix.ts', 'src/test.ts']);
  assert.equal(evidence.evidenceSource, 'both');
  assert.equal(evidence.sha, 'fed123');
});

test('extractCodeEvidence returns null when no CODE_EVIDENCE section', () => {
  assert.equal(extractCodeEvidence('SUMMARY:\nDone'), null);
  assert.equal(extractCodeEvidence(''), null);
});

test('extractCodeEvidence parses evidence_scope annotation', () => {
  const text = [
    'CODE_EVIDENCE:',
    '- files_checked: [src/runtime.ts]',
    '- evidence_source: both',
    '- sha: fed123',
    '- evidence_scope: openclaw',
  ].join('\n');
  const evidence = extractCodeEvidence(text);
  assert.equal(evidence.evidenceScope, 'openclaw');
});

test('extractCodeEvidence handles missing fields gracefully', () => {
  const text = 'CODE_EVIDENCE:\n- files_checked: [src/a.ts]\n- sha: abc';
  const evidence = extractCodeEvidence(text);
  assert.deepEqual(evidence.filesChecked, ['src/a.ts']);
  assert.equal(evidence.evidenceSource, null);
  assert.equal(evidence.evidenceScope, null);
});

test('hasCodeEvidence returns true when CODE_EVIDENCE present', () => {
  assert.equal(hasCodeEvidence('CODE_EVIDENCE:\n- files_checked: [a.ts]'), true);
  assert.equal(hasCodeEvidence('SUMMARY:\nDone'), false);
});

test('buildStageMetrics includes CODE_EVIDENCE fields', () => {
  const metrics = buildStageMetrics({
    stageCriteria: {
      requiredProducerSections: ['SUMMARY'],
      requiredReviewerSections: ['VERDICT'],
    },
    producer: 'SUMMARY:\nDone\nCODE_EVIDENCE:\n- files_checked: [a.ts]\n- sha: abc',
    reviewerA: 'VERDICT: APPROVE\nCODE_EVIDENCE:\n- files_verified: [b.ts]\n- sha: def',
    reviewerB: 'VERDICT: APPROVE\nCODE_EVIDENCE:\n- files_verified: [c.ts]\n- sha: def',
  });

  assert.equal(metrics.producerHasCodeEvidence, true);
  assert.equal(metrics.reviewerAHasCodeEvidence, true);
  assert.equal(metrics.reviewerBHasCodeEvidence, true);
  assert.equal(metrics.producerCodeEvidence.sha, 'abc');
  assert.equal(metrics.reviewerACodeEvidence.sha, 'def');
  assert.equal(metrics.reviewerBCodeEvidence.sha, 'def');
});

test('buildStageMetrics handles missing CODE_EVIDENCE gracefully', () => {
  const metrics = buildStageMetrics({
    stageCriteria: {
      requiredProducerSections: ['SUMMARY'],
      requiredReviewerSections: ['VERDICT'],
    },
    producer: 'SUMMARY:\nDone',
    reviewerA: 'VERDICT: APPROVE',
    reviewerB: 'VERDICT: APPROVE',
  });

  assert.equal(metrics.producerHasCodeEvidence, false);
  assert.equal(metrics.reviewerAHasCodeEvidence, false);
  assert.equal(metrics.reviewerBHasCodeEvidence, false);
  assert.equal(metrics.producerCodeEvidence, null);
  assert.equal(metrics.reviewerACodeEvidence, null);
  assert.equal(metrics.reviewerBCodeEvidence, null);
});

test('buildHandoff includes CODE_EVIDENCE from all roles', () => {
  const handoff = buildHandoff({
    reviewerA: 'VERDICT: APPROVE\nBLOCKERS:\n- None.\nCODE_EVIDENCE:\n- files_verified: [a.ts]\n- sha: abc',
    reviewerB: 'VERDICT: APPROVE\nBLOCKERS:\n- None.\nCODE_EVIDENCE:\n- files_verified: [b.ts]\n- sha: def',
    producer: 'SUMMARY:\nDone\nCODE_EVIDENCE:\n- files_checked: [main.ts]\n- sha: ghi',
    metrics: {},
    stageName: 'implement-pass-1',
    round: 1,
  });
  assert.deepEqual(handoff.producerCodeEvidence.filesChecked, ['main.ts']);
  assert.deepEqual(handoff.reviewerACodeEvidence.filesChecked, ['a.ts']);
  assert.deepEqual(handoff.reviewerBCodeEvidence.filesChecked, ['b.ts']);
});

// --- Global reviewer tests ---

test('extractMacroAnswers parses MACRO_ANSWERS section', () => {
  const text = [
    'VERDICT: APPROVE',
    'MACRO_ANSWERS:',
    'Q1: OpenClaw hook timing verified via source reading — hooks/subagent.ts line 42',
    'Q2: Business flow closed — empathy results persisted to subagent_workflows table',
    'Q3: Architecture converging — unified RuntimeDirectDriver used by both empathy and deep-reflect',
    'Q4: Data flow closed — sessionKey = child session identity, runId = agent run identity',
    'Q5: Sprint moves closer to unified PD subagent workflow — next step is Nocturnal migration',
    'NEXT_FOCUS: Monitor shadow-run parity',
  ].join('\n');
  const result = extractMacroAnswers(text, ['Q1', 'Q2', 'Q3', 'Q4', 'Q5']);
  assert.deepEqual(result.found, ['Q1', 'Q2', 'Q3', 'Q4', 'Q5']);
  assert.deepEqual(result.satisfied, ['Q1', 'Q2', 'Q3', 'Q4', 'Q5']);
  assert.equal(result.allSatisfied, true);
});

test('extractMacroAnswers marks incomplete answers as not satisfied', () => {
  const text = [
    'VERDICT: REVISE',
    'MACRO_ANSWERS:',
    'Q1: OpenClaw hook timing verified — hooks/subagent.ts line 42',
    'Q2: n/a — pending cross-repo verification',
    'Q3: Architecture converging — unified RuntimeDirectDriver',
    'BLOCKERS:\n- Need more evidence for Q2',
  ].join('\n');
  const result = extractMacroAnswers(text, ['Q1', 'Q2', 'Q3', 'Q4']);
  assert.deepEqual(result.found, ['Q1', 'Q2', 'Q3']);
  assert.deepEqual(result.satisfied, ['Q1', 'Q3']);
  assert.equal(result.allSatisfied, false);
});

test('extractMacroAnswers returns empty when no MACRO_ANSWERS section', () => {
  const result = extractMacroAnswers('VERDICT: APPROVE\nBLOCKERS:\n- None.', ['Q1', 'Q2']);
  assert.deepEqual(result.found, []);
  assert.deepEqual(result.satisfied, []);
  assert.equal(result.allSatisfied, false);
});

test('buildStageMetrics includes global_reviewer fields', () => {
  const metrics = buildStageMetrics({
    stageCriteria: {
      requiredProducerSections: ['SUMMARY'],
      requiredReviewerSections: ['VERDICT'],
      requiredGlobalReviewerSections: ['VERDICT', 'MACRO_ANSWERS'],
      globalReviewerRequired: true,
      globalReviewerMustAnswer: ['Q1', 'Q2'],
    },
    producer: 'SUMMARY:\nDone',
    reviewerA: 'VERDICT: APPROVE',
    reviewerB: 'VERDICT: APPROVE',
    globalReviewer: [
      'VERDICT: APPROVE',
      'MACRO_ANSWERS:',
      'Q1: OpenClaw compatible — hooks/subagent.ts verified',
      'Q2: Business flow closed — results persisted',
    ].join('\n'),
  });

  assert.equal(metrics.globalReviewerVerdict, 'APPROVE');
  assert.equal(metrics.globalReviewerHasExplicitVerdict, true);
  assert.equal(metrics.globalReviewerRequired, true);
  assert.deepEqual(metrics.globalReviewerChecks.VERDICT, true);
  assert.deepEqual(metrics.globalReviewerChecks.MACRO_ANSWERS, true);
  assert.deepEqual(metrics.macroAnswersFound, ['Q1', 'Q2']);
  assert.deepEqual(metrics.macroAnswersSatisfied, ['Q1', 'Q2']);
  assert.equal(metrics.macroAnswersAllSatisfied, true);
  assert.deepEqual(metrics.requiredMacroAnswers, ['Q1', 'Q2']);
});

test('decideStage with globalReviewerRequired — advances when all three APPROVE', () => {
  const result = decideStage({
    stageCriteria: {
      requiredApprovals: 3,
      requiredProducerSections: ['SUMMARY'],
      requiredReviewerSections: ['VERDICT', 'BLOCKERS'],
      requiredGlobalReviewerSections: ['VERDICT', 'MACRO_ANSWERS'],
      globalReviewerRequired: true,
      globalReviewerMustAnswer: ['Q1', 'Q2'],
    },
    producer: 'SUMMARY:\nDone',
    reviewerA: 'VERDICT: APPROVE\nBLOCKERS:\n- None.',
    reviewerB: 'VERDICT: APPROVE\nBLOCKERS:\n- None.',
    globalReviewer: [
      'VERDICT: APPROVE',
      'MACRO_ANSWERS:',
      'Q1: OpenClaw compatible',
      'Q2: Business flow closed',
    ].join('\n'),
    currentRound: 1,
    maxRoundsPerStage: 3,
  });

  assert.equal(result.outcome, 'advance');
  assert.equal(result.metrics.approvalCount, 3);
});

test('decideStage with globalReviewerRequired — cannot advance when global reviewer missing', () => {
  const result = decideStage({
    stageCriteria: {
      requiredApprovals: 3,
      requiredProducerSections: ['SUMMARY'],
      requiredReviewerSections: ['VERDICT', 'BLOCKERS'],
      requiredGlobalReviewerSections: ['VERDICT', 'MACRO_ANSWERS'],
      globalReviewerRequired: true,
      globalReviewerMustAnswer: ['Q1', 'Q2'],
    },
    producer: 'SUMMARY:\nDone',
    reviewerA: 'VERDICT: APPROVE\nBLOCKERS:\n- None.',
    reviewerB: 'VERDICT: APPROVE\nBLOCKERS:\n- None.',
    globalReviewer: null,
    currentRound: 1,
    maxRoundsPerStage: 3,
  });

  assert.equal(result.outcome, 'revise');
  assert.ok(result.blockers.some((b) => b.includes('Global reviewer')));
});

test('decideStage with globalReviewerRequired — cannot advance when Q-answers missing', () => {
  const result = decideStage({
    stageCriteria: {
      requiredApprovals: 3,
      requiredProducerSections: ['SUMMARY'],
      requiredReviewerSections: ['VERDICT', 'BLOCKERS'],
      requiredGlobalReviewerSections: ['VERDICT', 'MACRO_ANSWERS'],
      globalReviewerRequired: true,
      globalReviewerMustAnswer: ['Q1', 'Q2', 'Q3'],
    },
    producer: 'SUMMARY:\nDone',
    reviewerA: 'VERDICT: APPROVE\nBLOCKERS:\n- None.',
    reviewerB: 'VERDICT: APPROVE\nBLOCKERS:\n- None.',
    globalReviewer: [
      'VERDICT: APPROVE',
      'MACRO_ANSWERS:',
      'Q1: OpenClaw compatible',
      'Q2: Business flow closed',
      // Q3 missing
    ].join('\n'),
    currentRound: 1,
    maxRoundsPerStage: 3,
  });

  assert.equal(result.outcome, 'revise');
  assert.ok(result.blockers.some((b) => b.includes('Q3')));
});

test('decideStage with globalReviewerRequired — BLOCK from global reviewer halts even if A and B approve', () => {
  const result = decideStage({
    stageCriteria: {
      requiredApprovals: 3,
      requiredProducerSections: ['SUMMARY'],
      requiredReviewerSections: ['VERDICT', 'BLOCKERS'],
      requiredGlobalReviewerSections: ['VERDICT', 'MACRO_ANSWERS'],
      globalReviewerRequired: true,
      globalReviewerMustAnswer: ['Q1'],
    },
    producer: 'SUMMARY:\nDone',
    reviewerA: 'VERDICT: APPROVE\nBLOCKERS:\n- None.',
    reviewerB: 'VERDICT: APPROVE\nBLOCKERS:\n- None.',
    globalReviewer: [
      'VERDICT: BLOCK',
      'BLOCKERS:\n- Architecture diverges — new implicit protocol introduced',
      'MACRO_ANSWERS:',
      'Q1: OpenClaw compatible — hooks verified',
    ].join('\n'),
    currentRound: 1,
    maxRoundsPerStage: 3,
  });

  assert.equal(result.outcome, 'revise');
  assert.ok(result.blockers.some((b) => b.includes('[GLOBAL]') && b.includes('Architecture diverges')));
});

test('decideStage with globalReviewerRequired — BLOCK without specific blockers still blocks', () => {
  const result = decideStage({
    stageCriteria: {
      requiredApprovals: 3,
      requiredProducerSections: ['SUMMARY'],
      requiredReviewerSections: ['VERDICT', 'BLOCKERS'],
      requiredGlobalReviewerSections: ['VERDICT'],
      globalReviewerRequired: true,
    },
    producer: 'SUMMARY:\nDone',
    reviewerA: 'VERDICT: APPROVE\nBLOCKERS:\n- None.',
    reviewerB: 'VERDICT: APPROVE\nBLOCKERS:\n- None.',
    globalReviewer: 'VERDICT: BLOCK',
    currentRound: 1,
    maxRoundsPerStage: 3,
  });

  assert.equal(result.outcome, 'revise');
  assert.ok(result.blockers.some((b) => b.includes('Global reviewer BLOCKED with no specific blockers')));
});

test('decideStage without globalReviewerRequired — ignores global_reviewer even if provided', () => {
  const result = decideStage({
    stageCriteria: {
      requiredApprovals: 2,
      requiredProducerSections: ['SUMMARY'],
      requiredReviewerSections: ['VERDICT', 'BLOCKERS'],
      globalReviewerRequired: false,
    },
    producer: 'SUMMARY:\nDone',
    reviewerA: 'VERDICT: APPROVE\nBLOCKERS:\n- None.',
    reviewerB: 'VERDICT: APPROVE\nBLOCKERS:\n- None.',
    globalReviewer: 'VERDICT: BLOCK\nBLOCKERS:\n- Should be ignored',
    currentRound: 1,
    maxRoundsPerStage: 3,
  });

  assert.equal(result.outcome, 'advance');
  assert.equal(result.metrics.approvalCount, 2);
});

test('buildHandoff includes global_reviewer blockers and focus', () => {
  const handoff = buildHandoff({
    reviewerA: 'VERDICT: REVISE\nBLOCKERS:\n- ReviewerA blocker\nNEXT_FOCUS: Fix X',
    reviewerB: 'VERDICT: REVISE\nBLOCKERS:\n- ReviewerB blocker\nNEXT_FOCUS: Fix Y',
    globalReviewer: 'VERDICT: REVISE\nBLOCKERS:\n- Global blocker\nNEXT_FOCUS: Fix Z',
    producer: 'SUMMARY:\nDone',
    metrics: { globalReviewerVerdict: 'REVISE' },
    stageName: 'architecture-cut',
    round: 2,
  });

  assert.deepEqual(handoff.blockers, ['ReviewerA blocker', 'ReviewerB blocker', 'Global blocker']);
  assert.ok(handoff.focusForNextRound.includes('Fix X'));
  assert.ok(handoff.focusForNextRound.includes('Fix Y'));
  assert.ok(handoff.focusForNextRound.includes('Fix Z'));
  assert.equal(handoff.dimensionScores.globalReviewer, 'REVISE');
});

test('buildHandoff handles missing global_reviewer gracefully', () => {
  const handoff = buildHandoff({
    reviewerA: 'VERDICT: APPROVE\nBLOCKERS:\n- None.',
    reviewerB: 'VERDICT: APPROVE\nBLOCKERS:\n- None.',
    globalReviewer: null,
    producer: 'SUMMARY:\nDone',
    metrics: {},
    stageName: 'investigate',
    round: 1,
  });

  assert.deepEqual(handoff.blockers, []);
  assert.equal(handoff.focusForNextRound, null);
  assert.equal(handoff.globalReviewerCodeEvidence, null);
  assert.equal(handoff.dimensionScores.globalReviewer, null);
});

// --- Markdown heading compatibility tests ---

test('extractContractItems parses ## CONTRACT (markdown heading)', () => {
  const text = [
    'SUMMARY:\nDone',
    '## CONTRACT',
    '- Root cause identified with evidence status: DONE evidence: "see EVIDENCE"',
    '- Fix proposed status: TODO',
  ].join('\n');

  const items = extractContractItems(text);
  assert.equal(items.length, 2);
  assert.equal(items[0].status, 'DONE');
  assert.equal(items[1].status, 'TODO');
});

test('extractContractItems parses CONTRACT: (colon format)', () => {
  const text = [
    'SUMMARY:\nDone',
    'CONTRACT:',
    '- Root cause identified status: DONE',
    '- Fix proposed status: PARTIAL',
  ].join('\n');

  const items = extractContractItems(text);
  assert.equal(items.length, 2);
  assert.equal(items[0].status, 'DONE');
  assert.equal(items[1].status, 'PARTIAL');
});

test('extractCodeEvidence parses ## CODE_EVIDENCE (markdown heading)', () => {
  const text = [
    '## CODE_EVIDENCE',
    '- files_checked: src/observer.js, src/persistence.ts',
    '- evidence_source: local',
    '- sha: abc123def',
    '- branch/worktree: main',
  ].join('\n');
  const evidence = extractCodeEvidence(text);
  assert.ok(evidence, 'should parse ## CODE_EVIDENCE');
  assert.deepEqual(evidence.filesChecked, ['src/observer.js', 'src/persistence.ts']);
  assert.equal(evidence.evidenceSource, 'local');
  assert.equal(evidence.sha, 'abc123def');
});

test('extractCodeEvidence parses comma-separated files_checked (no brackets)', () => {
  const text = [
    'CODE_EVIDENCE:',
    '- files_checked: empathy-observer-manager.ts, hooks/subagent.ts, index.ts',
    '- evidence_source: both',
    '- sha: b1964a55',
  ].join('\n');
  const evidence = extractCodeEvidence(text);
  assert.ok(evidence, 'should parse flat comma list');
  assert.deepEqual(evidence.filesChecked, ['empathy-observer-manager.ts', 'hooks/subagent.ts', 'index.ts']);
});

test('extractCodeEvidence parses comma-separated files_verified (no brackets)', () => {
  const text = [
    '## CODE_EVIDENCE',
    '- files_verified: src/fix.ts, src/test.ts, src/helper.ts',
    '- evidence_source: both',
    '- sha: fed123',
  ].join('\n');
  const evidence = extractCodeEvidence(text);
  assert.ok(evidence, 'should parse flat comma list for files_verified');
  assert.deepEqual(evidence.filesChecked, ['src/fix.ts', 'src/test.ts', 'src/helper.ts']);
});

test('hasCodeEvidence returns true for ## CODE_EVIDENCE', () => {
  assert.equal(hasCodeEvidence('## CODE_EVIDENCE\n- files_checked: a.ts'), true);
});

test('decideStage advances with ## CONTRACT and ## CODE_EVIDENCE', () => {
  const result = decideStage({
    stageCriteria: {
      requiredApprovals: 2,
      requiredProducerSections: ['SUMMARY'],
      requiredReviewerSections: ['VERDICT', 'BLOCKERS'],
      requiredDeliverables: ['root_cause'],
    },
    producer: [
      'SUMMARY:\nDone',
      '## CONTRACT',
      '- Root cause identified status: DONE',
      '## CODE_EVIDENCE',
      '- files_checked: a.ts, b.ts',
      '- sha: abc123',
    ].join('\n'),
    reviewerA: 'VERDICT: APPROVE\nBLOCKERS:\n- None.',
    reviewerB: 'VERDICT: APPROVE\nBLOCKERS:\n- None.',
    currentRound: 1,
    maxRoundsPerStage: 3,
  });

  assert.equal(result.outcome, 'advance');
  assert.equal(result.metrics.contractCheck.allDone, true);
  assert.ok(result.metrics.producerCodeEvidence, 'should have CODE_EVIDENCE');
  assert.deepEqual(result.metrics.producerCodeEvidence.filesChecked, ['a.ts', 'b.ts']);
});

test('extractContractItems parses ## CONTRACT correctly when followed by ## CODE_EVIDENCE', () => {
  // Verify ## CONTRACT section stops at ## CODE_EVIDENCE boundary
  const text = [
    'SUMMARY:\nDone',
    '## CONTRACT',
    '- Root cause identified status: DONE',
    '## CODE_EVIDENCE',
    '- files_checked: a.ts, b.ts',
    '- sha: abc123',
  ].join('\n');
  const items = extractContractItems(text);
  // Should only have the contract item, NOT the CODE_EVIDENCE lines
  assert.equal(items.length, 1);
  assert.equal(items[0].status, 'DONE');
  assert.ok(items[0].deliverable.includes('Root cause identified'));
});

test('extractContractItems ignores markdown horizontal rules (---, ***, ___)', () => {
  const text = [
    '## CONTRACT',
    '- transport_audit status: DONE',
    '- lifecycle_hook_map status: DONE',
    '---',
    '**Round 3 Producer Report**',
  ].join('\n');
  const items = extractContractItems(text);
  assert.equal(items.length, 2);
  assert.equal(items[0].status, 'DONE');
  assert.equal(items[1].status, 'DONE');
  assert.ok(!items.some((i) => i.deliverable.includes('--')), 'no horizontal rule artifacts');
});

test('extractContractItems ignores *** and ___ separators', () => {
  const text = [
    'CONTRACT:',
    '- item_a status: DONE',
    '***',
    '- item_b status: PARTIAL',
    '___',
  ].join('\n');
  const items = extractContractItems(text);
  assert.equal(items.length, 2);
  assert.equal(items[0].deliverable, 'item_a');
  assert.equal(items[1].deliverable, 'item_b');
});

test('extractContractItems strips markdown code fences before parsing', () => {
  const text = [
    '## CONTRACT',
    '',
    '```',
    'CONTRACT:',
    '- transport_audit status: DONE',
    '- lifecycle_hook_map status: DONE',
    '- openclaw_assumptions_documented status: DONE',
    '- failure_mode_inventory status: DONE',
    '```',
    '',
    '---',
    '',
    '## APPENDIX: Round 2 Blocker Resolution',
  ].join('\n');
  const items = extractContractItems(text);
  assert.equal(items.length, 4);
  assert.equal(items[0].deliverable, 'transport_audit');
  assert.equal(items[0].status, 'DONE');
  assert.equal(items[3].deliverable, 'failure_mode_inventory');
  assert.equal(items[3].status, 'DONE');
});
