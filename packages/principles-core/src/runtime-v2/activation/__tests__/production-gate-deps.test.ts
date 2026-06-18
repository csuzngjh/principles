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
});
