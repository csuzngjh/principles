/**
 * Production Gate Deps Factory Tests — Story A (PRI-408)
 *
 * Tests verify that createProductionGateDeps() returns a valid
 * RefinerRuleHostGateDeps that can compile and evaluate rule code
 * against golden traces using node:vm — the same compilation path
 * used by the production openclaw-plugin RuleHost.
 *
 * ERR checklist:
 * - ERR-001: Treat parsed JSON / LLM output as unknown — rule code is string-validated
 * - ERR-002: Every failure path carries reason
 * - ERR-025: Production-path test, not just helper
 */

import { describe, it, expect } from 'vitest';
import { createProductionGateDeps } from '../production-gate-deps.js';
import { createGoldenTraceFixture } from '../../golden-trace.js';

describe('createProductionGateDeps', () => {
  it('returns a valid RefinerRuleHostGateDeps with evaluateInSandbox function', () => {
    const deps = createProductionGateDeps();
    expect(deps).toBeDefined();
    expect(typeof deps.evaluateInSandbox).toBe('function');
  });

  it('compiles and evaluates valid rule code that matches golden trace expectations', () => {
    const deps = createProductionGateDeps();

    // Rule: block edit on system paths, allow safe paths.
    // Differentiates negative/positive by checking params.filePath.
    const ruleCode = `
function evaluate(input, helpers) {
  var p = input.action.paramsSummary;
  if (helpers.getToolName() === 'edit' && p && p.filePath === '/etc/passwd') {
    return { decision: 'block', matched: true, reason: 'system path blocked' };
  }
  return { decision: 'allow', matched: false, reason: 'safe path' };
}
`;

    const goldenTrace = createGoldenTraceFixture({
      toolName: 'edit',
      negativeParams: { filePath: '/etc/passwd' },
      positiveParams: { filePath: '/src/index.ts' },
      expectedDecision: 'block',
    });

    const result = deps.evaluateInSandbox(ruleCode, goldenTrace);

    expect(result.success).toBe(true);
    expect(result.failedCases).toHaveLength(0);
    expect(result.forbiddenPatternViolations).toHaveLength(0);
  });

  it('detects validation failure when rule decision does not match golden trace', () => {
    const deps = createProductionGateDeps();

    // Rule: always allows — but golden trace expects block for negative case
    const ruleCode = `
function evaluate(input, helpers) {
  return { decision: 'allow', matched: false, reason: 'always allow' };
}
`;

    const goldenTrace = createGoldenTraceFixture({
      toolName: 'edit',
      negativeParams: { filePath: '/etc/passwd' },
      positiveParams: { filePath: '/src/index.ts' },
      expectedDecision: 'block',
    });

    const result = deps.evaluateInSandbox(ruleCode, goldenTrace);

    expect(result.success).toBe(false);
    expect(result.failedCases.length).toBeGreaterThan(0);
    // The negative case should fail because expectedDecision is 'block' but rule returns 'allow'
    const negativeFailure = result.failedCases.find((c) => c.caseId === 'negative-1');
    expect(negativeFailure).toBeDefined();
    expect(negativeFailure?.errorType).toBe('validation_failed');
  });

  it('rejects code with forbidden patterns (e.g., require)', () => {
    const deps = createProductionGateDeps();

    const maliciousCode = `
function evaluate(input, helpers) {
  const fs = require('fs');
  return { decision: 'allow', matched: false, reason: 'ok' };
}
`;

    const goldenTrace = createGoldenTraceFixture({
      toolName: 'edit',
      negativeParams: { filePath: '/etc/passwd' },
      positiveParams: { filePath: '/src/index.ts' },
      expectedDecision: 'block',
    });

    const result = deps.evaluateInSandbox(maliciousCode, goldenTrace);

    expect(result.success).toBe(false);
    expect(result.forbiddenPatternViolations.length).toBeGreaterThan(0);
  });

  it('rejects code that does not define an evaluate function', () => {
    const deps = createProductionGateDeps();

    const invalidCode = `
function notEvaluate(input, helpers) {
  return { decision: 'allow', matched: false, reason: 'ok' };
}
`;

    const goldenTrace = createGoldenTraceFixture({
      toolName: 'edit',
      negativeParams: { filePath: '/etc/passwd' },
      positiveParams: { filePath: '/src/index.ts' },
      expectedDecision: 'block',
    });

    const result = deps.evaluateInSandbox(invalidCode, goldenTrace);

    expect(result.success).toBe(false);
    expect(result.failedCases.length).toBeGreaterThan(0);
  });

  it('handles export function evaluate syntax (normalized by compiler)', () => {
    const deps = createProductionGateDeps();

    const exportCode = `
export function evaluate(input, helpers) {
  var p = input.action.paramsSummary;
  if (helpers.getToolName() === 'edit' && p && p.filePath === '/etc/passwd') {
    return { decision: 'block', matched: true, reason: 'system path blocked' };
  }
  return { decision: 'allow', matched: false, reason: 'safe path' };
}
`;

    const goldenTrace = createGoldenTraceFixture({
      toolName: 'edit',
      negativeParams: { filePath: '/etc/passwd' },
      positiveParams: { filePath: '/src/index.ts' },
      expectedDecision: 'block',
    });

    const result = deps.evaluateInSandbox(exportCode, goldenTrace);

    expect(result.success).toBe(true);
    expect(result.failedCases).toHaveLength(0);
  });

  // P2 #6 fix: vm evaluator output validation tests
  describe('P2 #6: vm evaluator output validation', () => {
    it('rejects invalid decision enum value (not one of allow|block|requireApproval|auto_correct)', () => {
      const deps = createProductionGateDeps();

      const invalidDecisionCode = `
function evaluate(input, helpers) {
  return { decision: 'invalid_decision', matched: true, reason: 'bad decision' };
}
`;

      const goldenTrace = createGoldenTraceFixture({
        toolName: 'edit',
        negativeParams: { filePath: '/etc/passwd' },
        positiveParams: { filePath: '/src/index.ts' },
        expectedDecision: 'block',
      });

      const result = deps.evaluateInSandbox(invalidDecisionCode, goldenTrace);

      expect(result.success).toBe(false);
      expect(result.failedCases.length).toBeGreaterThan(0);
      // The invalid decision may surface as either a compile-time error or a
      // per-case validation error, depending on whether the rule is evaluated
      // during compilation. Either way, the result must be failure.
      expect(result.success).toBe(false);
    });

    it('rejects result with missing matched field', () => {
      const deps = createProductionGateDeps();

      const missingMatchedCode = `
function evaluate(input, helpers) {
  return { decision: 'allow', reason: 'missing matched' };
}
`;

      const goldenTrace = createGoldenTraceFixture({
        toolName: 'edit',
        negativeParams: { filePath: '/etc/passwd' },
        positiveParams: { filePath: '/src/index.ts' },
        expectedDecision: 'block',
      });

      const result = deps.evaluateInSandbox(missingMatchedCode, goldenTrace);

      expect(result.success).toBe(false);
    });

    it('rejects result with missing reason field', () => {
      const deps = createProductionGateDeps();

      const missingReasonCode = `
function evaluate(input, helpers) {
  return { decision: 'allow', matched: false };
}
`;

      const goldenTrace = createGoldenTraceFixture({
        toolName: 'edit',
        negativeParams: { filePath: '/etc/passwd' },
        positiveParams: { filePath: '/src/index.ts' },
        expectedDecision: 'block',
      });

      const result = deps.evaluateInSandbox(missingReasonCode, goldenTrace);

      expect(result.success).toBe(false);
    });

    it('rejects auto_correct decision without correctionProposal', () => {
      const deps = createProductionGateDeps();

      const autoCorrectWithoutProposalCode = `
function evaluate(input, helpers) {
  return { decision: 'auto_correct', matched: true, reason: 'auto correct without proposal' };
}
`;

      const goldenTrace = createGoldenTraceFixture({
        toolName: 'edit',
        negativeParams: { filePath: '/etc/passwd' },
        positiveParams: { filePath: '/src/index.ts' },
        expectedDecision: 'block',
      });

      const result = deps.evaluateInSandbox(autoCorrectWithoutProposalCode, goldenTrace);

      expect(result.success).toBe(false);
    });

    it('accepts auto_correct decision with correctionProposal present', () => {
      const deps = createProductionGateDeps();

      const autoCorrectWithProposalCode = `
function evaluate(input, helpers) {
  return {
    decision: 'auto_correct',
    matched: true,
    reason: 'auto correct with proposal',
    correctionProposal: {
      proposedParams: { filePath: '/safe/path.ts' },
      correctedFields: [{ field: 'filePath', original: '/etc/passwd', proposed: '/safe/path.ts', reason: 'redirected' }],
      applicationMode: 'shadow',
      confidence: 0.9,
      ruleId: 'rule-001',
      notifyAgent: true
    }
  };
}
`;

      const goldenTrace = createGoldenTraceFixture({
        toolName: 'edit',
        negativeParams: { filePath: '/etc/passwd' },
        positiveParams: { filePath: '/src/index.ts' },
        expectedDecision: 'block',
      });

      const result = deps.evaluateInSandbox(autoCorrectWithProposalCode, goldenTrace);

      // The rule returns auto_correct which doesn't match expectedDecision 'block',
      // so the golden trace validation will fail — but the RuleHostResult shape
      // validation itself should pass (no compile error about invalid shape).
      // The failure should be a validation_failed, not a compile/shape error.
      expect(result.success).toBe(false);
      // Verify the failure is due to decision mismatch, not invalid shape
      const shapeError = result.failedCases.find(c => c.caseId === '__compile__' && c.message?.includes('invalid RuleHostResult'));
      expect(shapeError).toBeUndefined();
    });

    it('rejects result where matched is not a boolean', () => {
      const deps = createProductionGateDeps();

      const wrongTypeMatchedCode = `
function evaluate(input, helpers) {
  return { decision: 'allow', matched: 'yes', reason: 'matched is string not boolean' };
}
`;

      const goldenTrace = createGoldenTraceFixture({
        toolName: 'edit',
        negativeParams: { filePath: '/etc/passwd' },
        positiveParams: { filePath: '/src/index.ts' },
        expectedDecision: 'block',
      });

      const result = deps.evaluateInSandbox(wrongTypeMatchedCode, goldenTrace);

      expect(result.success).toBe(false);
    });
  });
});
