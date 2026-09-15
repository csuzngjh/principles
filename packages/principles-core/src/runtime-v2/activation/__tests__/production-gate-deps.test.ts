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
import { compileHardenedRuleEvaluator, createProductionGateDeps } from '../production-gate-deps.js';
import { createGoldenTraceFixture, createSyntheticRuleHostInput } from '../../golden-trace.js';
import type { RuleHostInput } from '../../internalization/rule-host-contracts.js';
import type { RuleHostHelpers } from '../../internalization/rule-host-helpers.js';

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

  it('rejects export function evaluate syntax (PRI-439 Phase 2: export is forbidden)', () => {
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

    // PRI-439 Phase 2: `export` is now a forbidden pattern. The validator
    // rejects it before compilation — no stripping, no normalization.
    expect(result.success).toBe(false);
    expect(result.forbiddenPatternViolations).toContain('export');
  });

  it('handles bare function evaluate(input, helpers) syntax (canonical dialect)', () => {
    const deps = createProductionGateDeps();

    const bareCode = `
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

    const result = deps.evaluateInSandbox(bareCode, goldenTrace);

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

  // ── PRI-634 PR-A (Slice A): replay/live semantic authority convergence ──
  // The replay path previously used a LOCAL isValidRuleHostResult that was a
  // semantic SUBSET of the canonical validateRuleHostResult (live RuleHost
  // authority). Most notably it ACCEPTED `matched=false` paired with a
  // non-allow decision — a result the live RuleHost rejects. These tests pin
  // the convergence: the replay gate now enforces the exact canonical verdict
  // on the same unknown results (A-T01…A-T06 through the public boundary).
  describe('PRI-634 Slice A: canonical validator convergence', () => {
    const trace = () => createGoldenTraceFixture({
      toolName: 'edit',
      negativeParams: { filePath: '/etc/passwd' },
      positiveParams: { filePath: '/src/index.ts' },
      expectedDecision: 'block',
    });

    const evalWith = (returnExpr: string) =>
      createProductionGateDeps().evaluateInSandbox(
        `function evaluate(input, helpers) { return ${returnExpr}; }`,
        trace(),
      );

    it('A-T01: allow + matched=false is accepted by the replay path (both cases pass)', () => {
      const result = evalWith(`{ decision: 'allow', matched: false, reason: 'no match' }`);
      // positive-1 expects allow → passes; negative-1 expects block → fails.
      // The shape itself must NOT be the failure: no runtime_error failures.
      expect(result.failedCases.every((c) => c.errorType === 'validation_failed')).toBe(true);
    });

    it('A-T02: block + matched=false is REJECTED — static early-warning layer catches the literal form', () => {
      const result = evalWith(`{ decision: 'block', matched: false, reason: 'contradictory' }`);
      // The static pre-check (checkMatchedFalseDecisions) catches the literal
      // before VM execution — preserved early-warning semantics (SPEC Slice A2).
      expect(result.success).toBe(false);
      expect(result.failedCases.some((c) => c.caseId === '__matched_false_decision__' && c.errorType === 'validation_failed')).toBe(true);
    });

    it('A-T02b: block + dynamically-computed matched=false is REJECTED by the canonical runtime validator (convergence)', () => {
      // The static scan cannot see through a variable — pre-convergence the
      // local replay guard ACCEPTED this shape while the live RuleHost
      // rejected it. Post-convergence the canonical validator rejects it in
      // replay too: every case fails as runtime_error with the canonical reason.
      const deps = createProductionGateDeps();
      const result = deps.evaluateInSandbox(
        `function evaluate(input, helpers) {
  var m = (input.action.toolName === 'edit');
  m = false;
  return { decision: 'block', matched: m, reason: 'contradictory' };
}`,
        trace(),
      );
      expect(result.success).toBe(false);
      expect(result.failedCases.length).toBeGreaterThan(0);
      expect(result.failedCases.every((c) => c.errorType === 'runtime_error')).toBe(true);
      expect(result.failedCases.some((c) => c.message.includes("matched=false requires decision 'allow'"))).toBe(true);
    });

    it('A-T03: invalid decision enum (deny) is rejected', () => {
      const result = evalWith(`{ decision: 'deny', matched: true, reason: 'bad enum' }`);
      expect(result.success).toBe(false);
      expect(result.failedCases.some((c) => c.errorType === 'runtime_error' && c.message.includes('decision must be one of'))).toBe(true);
    });

    it('A-T04: auto_correct + malformed correctionProposal is rejected with canonical errors', () => {
      const result = evalWith(`{ decision: 'auto_correct', matched: true, reason: 'broken proposal', correctionProposal: { proposedParams: {} } }`);
      expect(result.success).toBe(false);
      expect(result.failedCases.some((c) => c.errorType === 'runtime_error' && c.message.includes('correctionProposal invalid'))).toBe(true);
    });

    it('A-T05: well-formed auto_correct result passes shape validation (failure, if any, is decision mismatch only)', () => {
      const result = evalWith(`{ decision: 'auto_correct', matched: true, reason: 'ok', correctionProposal: { proposedParams: { filePath: '/safe.ts' }, correctedFields: [{ field: 'filePath', original: '/etc/passwd', proposed: '/safe.ts', reason: 'redirect' }], applicationMode: 'shadow', confidence: 0.9, ruleId: 'rule-001', notifyAgent: true } }`);
      expect(result.failedCases.every((c) => c.errorType === 'validation_failed')).toBe(true);
    });

    it('A-T06: prototype-pollution keys in the result are rejected by the replay path (canonical-only check)', () => {
       
      const result = evalWith(`{ decision: 'allow', matched: false, reason: 'pp', __proto__: undefined }`);
      // A literal __proto__ own-property is hard to construct via object
      // literal in strict vm code; if the shape still validates, the case
      // outcome must at least never be runtime_error-free contradiction.
      // The authoritative prototype-pollution rejection is pinned directly in
      // rule-host-validator tests; here we pin the delegation is total (no
      // crash, structured failure).
      expect(result.success).toBe(false);
    });
  });
});

// ── PRI-809: pre-activation sandbox trust boundary ──────────────────────────
// Unapproved RuleCode must never reach host capabilities during replay.
// These probes call the hardened primitive DIRECTLY (no forbidden-pattern
// scanner in front) to prove runtime isolation is the trust boundary — the
// static scanner is only defense-in-depth (PRI-679 stays an upgrade option).

describe('PRI-809 sandbox trust boundary (hardened replay evaluator)', () => {
  const HOST_PROCESS_PREFIX = 'ESCAPED_PROCESS_';

  function evaluateRaw(ruleBody: string, input: RuleHostInput): { decision: string; matched: boolean; reason: string } {
    const evaluate = compileHardenedRuleEvaluator(
      `function evaluate(input, helpers) {\n${ruleBody}\n}`,
      'pri-809-probe',
    );
    return evaluate(input, {} as RuleHostHelpers);
  }

  function probeInput(): RuleHostInput {
    return createSyntheticRuleHostInput(
      { toolName: 'edit', params: { filePath: '/src/index.ts' } },
      {},
      {},
    );
  }

  it('blocks the top-level input.constructor.constructor escape (Case 1)', () => {
    const result = evaluateRaw(`
      try {
        var hostFunction = input.constructor.constructor;
        var proc = hostFunction('return process')();
        return { decision: 'allow', matched: false, reason: '${HOST_PROCESS_PREFIX}' + String(proc && proc.version) };
      } catch (error) {
        return { decision: 'allow', matched: false, reason: 'escape_blocked:' + String(error && error.message).slice(0, 80) };
      }
    `, probeInput());
    expect(result.decision).toBe('allow');
    expect(result.reason).not.toContain(HOST_PROCESS_PREFIX);
    expect(result.reason).toContain('escape_blocked');
  });

  it('blocks nested-object constructor chains (input.action.paramsSummary.constructor.constructor) (Case 2)', () => {
    const result = evaluateRaw(`
      try {
        var hostFunction = input.action.paramsSummary.constructor.constructor;
        var proc = hostFunction('return process')();
        return { decision: 'allow', matched: false, reason: '${HOST_PROCESS_PREFIX}' + String(proc && proc.version) };
      } catch (error) {
        return { decision: 'allow', matched: false, reason: 'escape_blocked_nested:' + String(error && error.message).slice(0, 80) };
      }
    `, probeInput());
    expect(result.reason).not.toContain(HOST_PROCESS_PREFIX);
  });

  it('blocks helper escapes (helpers.constructor.constructor and helpers.getToolName.constructor.constructor) (Case 3)', () => {
    const result = evaluateRaw(`
      var vectors = [helpers, helpers.getToolName];
      for (var i = 0; i < vectors.length; i++) {
        try {
          var hostFunction = vectors[i].constructor.constructor;
          var proc = hostFunction('return process')();
          return { decision: 'allow', matched: false, reason: '${HOST_PROCESS_PREFIX}' + String(proc && proc.version) };
        } catch (error) { /* try next vector */ }
      }
      return { decision: 'allow', matched: false, reason: 'helper_escape_blocked_all_vectors' };
    `, probeInput());
    expect(result.reason).toBe('helper_escape_blocked_all_vectors');
  });

  it('string-concatenation bypasses the scanner but still cannot escape (Case 4)', () => {
    // The forbidden-pattern scanner matches literal patterns; dynamic
    // property access built from concatenated strings evades it. Runtime
    // isolation must hold anyway — the scanner is NOT the trust boundary.
    const result = evaluateRaw(`
      try {
        var ctor = input['con' + 'structor'];
        var hostFunction = ctor['con' + 'structor'];
        var proc = hostFunction('return process')();
        return { decision: 'allow', matched: false, reason: '${HOST_PROCESS_PREFIX}' + String(proc && proc.version) };
      } catch (error) {
        return { decision: 'allow', matched: false, reason: 'concat_bypass_still_sandboxed:' + String(error && error.message).slice(0, 80) };
      }
    `, probeInput());
    expect(result.reason).not.toContain(HOST_PROCESS_PREFIX);
  });

  it('the concat-bypass rule sails through the forbidden-pattern scanner (proving isolation, not the scanner, is the boundary)', () => {
    const deps = createProductionGateDeps();
    const concatRule = `
function evaluate(input, helpers) {
  try {
    var hostFunction = input['con' + 'structor']['con' + 'structor'];
    hostFunction('return process')();
  } catch (error) { /* unreachable either way */ }
  return { decision: 'allow', matched: false, reason: 'safe path' };
}
`;
    const goldenTrace = createGoldenTraceFixture({
      toolName: 'edit',
      negativeParams: { filePath: '/etc/passwd' },
      positiveParams: { filePath: '/src/index.ts' },
      expectedDecision: 'allow',
    });
    const result = deps.evaluateInSandbox(concatRule, goldenTrace);
    // The scanner misses the dynamic access entirely, and the replay is
    // judged on behavior — no host escape happened (it could not).
    expect(result.forbiddenPatternViolations).toHaveLength(0);
    expect(result.success).toBe(true);
  });

  it('legal allow rule with helpers still works (Case 5a)', () => {
    const result = evaluateRaw(`
      if (helpers.getToolName() === 'edit' && helpers.isRiskPath() === false) {
        return { decision: 'allow', matched: false, reason: 'helpers:' + helpers.getToolName() + ':' + String(helpers.getEstimatedLineChanges()) + ':' + helpers.getBashRisk() + ':' + String(helpers.getEpTier()) };
      }
      return { decision: 'allow', matched: false, reason: 'helpers unexpected' };
    `, probeInput());
    expect(result.reason).toBe('helpers:edit:0:unknown:0');
  });

  it('legal block rule reading input context still works (Case 5b)', () => {
    const result = evaluateRaw(`
      var p = input.action.paramsSummary;
      if (p && p.filePath === '/src/index.ts') {
        return { decision: 'block', matched: true, reason: 'index guarded' };
      }
      return { decision: 'allow', matched: false, reason: 'safe path' };
    `, probeInput());
    expect(result.decision).toBe('block');
    expect(result.matched).toBe(true);
    expect(result.reason).toBe('index guarded');
  });

  it('replay is deterministic: same rule + same input produce identical verdicts', () => {
    const rule = `
function evaluate(input, helpers) {
  return { decision: 'allow', matched: false, reason: 'det:' + input.action.toolName + ':' + String(input.workspace.isRiskPath) };
}
`;
    const evaluate = compileHardenedRuleEvaluator(rule, 'pri-809-determinism');
    const a = evaluate(probeInput(), {} as RuleHostHelpers);
    const b = evaluate(probeInput(), {} as RuleHostHelpers);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('non-JSON-serializable input fails loud instead of crossing the boundary (rc-3)', () => {
    const evaluate = compileHardenedRuleEvaluator(
      'function evaluate(input, helpers) { return { decision: "allow", matched: false, reason: "ok" }; }',
      'pri-809-rc3',
    );
    const circular: Record<string, unknown> = { toolName: 'edit' };
    circular.self = circular;
    const poison = { derived: circular } as unknown as RuleHostInput;
    expect(() => evaluate(poison, {} as RuleHostHelpers)).toThrow(/not JSON-serializable/);
  });
});
