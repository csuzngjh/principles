/**
 * compileDemoRule unit tests (PRI-429).
 *
 * The demo rule compiler is the sandbox adapter for run-rulehost's
 * adversarial loop. It parses TypeScript rule implementations, extracts
 * evaluate(), and validates the returned rule host result shape.
 *
 * Missing coverage would allow silent regression in the
 * RefinerSandbox contract (evaluate output shape, invalid rule bodies,
 * meta export shapes, polluted globals, etc.).
 *
 * ERR refs:
 *   - ERR-021: vm.Script runInContext must not leak globals
 *   - ERR-025: Object.hasOwn for untrusted output shape validation
 *   - ERR-037: non-object evaluate() return must throw loudly
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { compileDemoRule } from '../../src/services/demo-rule-compiler.js';
import { createRuleHostHelpers } from '@principles/core/runtime-v2';
import type { ReplayEvaluateFn, RuleHostInput, RuleHostResult } from '@principles/core/runtime-v2';

const VALID_RULE = `
export const meta = {
  id: 'r1',
  version: '1.0.0',
  purpose: 'unit test',
};
export function evaluate(input, helpers) {
  return { decision: 'allow', matched: false, reason: 'ok' };
}
`;

const NO_EVALUATE = `
export const meta = { id: 'r1' };
`;

const THROWING_EVALUATE = `
export function evaluate(input, helpers) {
  throw new Error('boom');
}
`;

const INVALID_RETURN_WRONG_DECISION = `
export function evaluate() {
  return { decision: 'accepted', matched: false, reason: 'wrong decision enum' };
}
`;

const INVALID_RETURN_NO_MATCHED = `
export function evaluate() {
  return { decision: 'allow', reason: 'missing matched' };
}
`;

const INVALID_RETURN_NO_DECISION = `
export function evaluate(input, helpers) {
  return { reason: 'no-decision-field' };
}
`;

const INVALID_RETURN_PRIMITIVE = `
export function evaluate(input, helpers) {
  return 42;
}
`;

const INVALID_RETURN_NULL = `
export function evaluate(input, helpers) {
  return null;
}
`;

const INVALID_RETURN_UNDEF = `
export function evaluate(input, helpers) {
  return undefined;
}
`;

const INVALID_RETURN_STRING = `
export function evaluate(input, helpers) {
  return 'accepted';
}
`;

const RULE_WITH_EVIDENCE = `
export const meta = { id: 'r-evidence' };
export function evaluate(input, helpers) {
  const count = input.derived.estimatedLineChanges;
  const matched = count > 0;
  return { decision: matched ? 'block' : 'allow', matched, reason: 'based on changes', diagnostics: { count } };
}
`;

const RULE_WITH_HASOWN_POISON_PAYLOAD = `
export function evaluate(input, helpers) {
  const poisoned = Object.create(null);
  poisoned.decision = 'allow';
  poisoned.matched = false;
  poisoned.reason = 'ok';
  return poisoned;
}
`;

function makeRuleHostInput(estimatedLineChanges = 0): RuleHostInput {
  return {
    action: {
      toolName: 'write_file',
      normalizedPath: '/workspace/a.ts',
      paramsSummary: {},
    },
    workspace: { isRiskPath: false },
    session: { currentGfi: 0, recentThinking: true },
    evolution: { epTier: 0 },
    derived: { estimatedLineChanges, bashRisk: 'safe' },
  };
}

function evaluateRule(evaluate: ReplayEvaluateFn, input: RuleHostInput = makeRuleHostInput()): RuleHostResult {
  return evaluate(input, createRuleHostHelpers(input));
}

describe('compileDemoRule', () => {
  describe('source normalization', () => {
    it('compiles a syntactically valid rule module', () => {
      const fn = compileDemoRule(VALID_RULE, 'valid-rule.ts');
      expect(typeof fn).toBe('function');
    });

    it('throws on code missing evaluate function', () => {
      expect(() => compileDemoRule(NO_EVALUATE, 'no-evaluate.ts')).toThrow(/evaluate/);
    });

    it('propagates syntax errors from vm.Script', () => {
      expect(() => compileDemoRule('this is not valid {{{', 'bad.ts')).toThrow();
    });
  });

  describe('evaluate output shape validation', () => {
    it('returns a fully validated RuleHostResult', () => {
      const fn = compileDemoRule(VALID_RULE, 'valid-rule.ts');
      const result = evaluateRule(fn);
      expect(result).toEqual({
        decision: 'allow',
        matched: false,
        reason: 'ok',
      });
    });

    it('throws when evaluate returns an object without a decision field (ERR-037)', () => {
      const fn = compileDemoRule(INVALID_RETURN_NO_DECISION, 'no-decision.ts');
      expect(() => evaluateRule(fn)).toThrow(/invalid RuleHostResult/);
    });

    it('rejects objects using a non-RuleHost decision enum', () => {
      const fn = compileDemoRule(INVALID_RETURN_WRONG_DECISION, 'wrong-decision.ts');
      expect(() => evaluateRule(fn)).toThrow(/invalid RuleHostResult/);
    });

    it('rejects objects missing the required matched flag', () => {
      const fn = compileDemoRule(INVALID_RETURN_NO_MATCHED, 'missing-matched.ts');
      expect(() => evaluateRule(fn)).toThrow(/invalid RuleHostResult/);
    });

    it('throws when evaluate returns a number (non-object)', () => {
      const fn = compileDemoRule(INVALID_RETURN_PRIMITIVE, 'primitive.ts');
      expect(() => evaluateRule(fn)).toThrow(/invalid RuleHostResult/);
    });

    it('throws when evaluate returns null', () => {
      const fn = compileDemoRule(INVALID_RETURN_NULL, 'null-return.ts');
      expect(() => evaluateRule(fn)).toThrow(/invalid RuleHostResult/);
    });

    it('throws when evaluate returns undefined', () => {
      const fn = compileDemoRule(INVALID_RETURN_UNDEF, 'undef-return.ts');
      expect(() => evaluateRule(fn)).toThrow(/invalid RuleHostResult/);
    });

    it('throws when evaluate returns a string', () => {
      const fn = compileDemoRule(INVALID_RETURN_STRING, 'string-return.ts');
      expect(() => evaluateRule(fn)).toThrow(/invalid RuleHostResult/);
    });

    it('handles Object.create(null) output (no prototype) via Object.hasOwn (ERR-025)', () => {
      const fn = compileDemoRule(RULE_WITH_HASOWN_POISON_PAYLOAD, 'hasown-poison.ts');
      const result = evaluateRule(fn);
      expect(result.decision).toBe('allow');
    });
  });

  describe('evaluate behaviour', () => {
    it('propagates evaluate() exceptions to the caller (fail loud)', () => {
      const fn = compileDemoRule(THROWING_EVALUATE, 'throwing.ts');
      expect(() => evaluateRule(fn)).toThrow(/boom/);
    });

    it('reads real RuleHostInput fields and returns different decisions', () => {
      const fn = compileDemoRule(RULE_WITH_EVIDENCE, 'evidence-rule.ts');
      const withChanges = evaluateRule(fn, makeRuleHostInput(3));
      const withoutChanges = evaluateRule(fn);
      expect(withChanges.decision).toBe('block');
      expect(withoutChanges.decision).toBe('allow');
    });
  });

  describe('vm sandbox isolation', () => {
    it('does not pollute Node.js globalThis between invocations (ERR-021)', () => {
      const polluter = `
      export function evaluate() {
        globalThis.__pd_leaked_test = 1;
        return { decision: 'block', matched: true, reason: 'polluting' };
      }
      `;
      expect(Reflect.get(globalThis, '__pd_leaked_test')).toBeUndefined();
      const fn = compileDemoRule(polluter, 'polluter.ts');
      evaluateRule(fn);
      const leakedValue = Reflect.get(globalThis, '__pd_leaked_test');
      // The sandboxed __pdRuleModule temporary assignment must not leak
      // arbitrary user-defined globals.
      expect(leakedValue).toBeUndefined();
    });

    it('removes the __pdRuleModule helper from the sandbox after compilation', () => {
      // This indirectly asserts the cleanup path — a second compilation
      // that does not export evaluate still throws rather than returning
      // a stale value from the first run.
      compileDemoRule(VALID_RULE, 'first.ts');
      expect(() => compileDemoRule(NO_EVALUATE, 'second.ts')).toThrow(/evaluate/);
    });
  });

  describe('sourceLabel is threaded into error messages', () => {
    it('includes sourceLabel when evaluate() returns invalid output', () => {
      const fn = compileDemoRule(INVALID_RETURN_PRIMITIVE, 'labeled-42.ts');
      expect(() => evaluateRule(fn)).toThrow(/labeled-42\.ts/);
    });

    it('includes sourceLabel when evaluate export is missing', () => {
      expect(() => compileDemoRule(NO_EVALUATE, 'no-eval-source-label.ts')).toThrow(/no-eval-source-label\.ts/);
    });
  });
});
