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
import type { RuleHostInput, RuleHostHelpers, RuleHostResult } from '@principles/core/runtime-v2';

const VALID_RULE = `
export const meta = {
  id: 'r1',
  version: '1.0.0',
  purpose: 'unit test',
};
export function evaluate(input, helpers) {
  return { decision: 'accepted', reason: 'ok', evidence: [] };
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
  const count = Array.isArray(input.context) ? input.context.length : 0;
  return { decision: count > 0 ? 'accepted' : 'rejected', reason: 'based on count', evidence: [{ count }] };
}
`;

const RULE_WITH_HASOWN_POISON_PAYLOAD = `
export function evaluate(input, helpers) {
  const poisoned = Object.create(null);
  poisoned.decision = 'accepted';
  poisoned.reason = 'ok';
  poisoned.evidence = [];
  return poisoned;
}
`;

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
    it('returns a RuleHostResult with decision="accepted"', () => {
      const fn = compileDemoRule(VALID_RULE, 'valid-rule.ts');
      const input = { task: 'x', context: [] } as unknown as RuleHostInput;
      const helpers = {} as RuleHostHelpers;
      const result = fn(input, helpers);
      expect(result).toEqual({ decision: 'accepted', reason: 'ok', evidence: [] });
    });

    it('throws when evaluate returns an object without a decision field (ERR-037)', () => {
      const fn = compileDemoRule(INVALID_RETURN_NO_DECISION, 'no-decision.ts');
      expect(() => fn({} as RuleHostInput, {} as RuleHostHelpers)).toThrow(/invalid RuleHostResult/);
    });

    it('throws when evaluate returns a number (non-object)', () => {
      const fn = compileDemoRule(INVALID_RETURN_PRIMITIVE, 'primitive.ts');
      expect(() => fn({} as RuleHostInput, {} as RuleHostHelpers)).toThrow(/invalid RuleHostResult/);
    });

    it('throws when evaluate returns null', () => {
      const fn = compileDemoRule(INVALID_RETURN_NULL, 'null-return.ts');
      expect(() => fn({} as RuleHostInput, {} as RuleHostHelpers)).toThrow(/invalid RuleHostResult/);
    });

    it('throws when evaluate returns undefined', () => {
      const fn = compileDemoRule(INVALID_RETURN_UNDEF, 'undef-return.ts');
      expect(() => fn({} as RuleHostInput, {} as RuleHostHelpers)).toThrow(/invalid RuleHostResult/);
    });

    it('throws when evaluate returns a string', () => {
      const fn = compileDemoRule(INVALID_RETURN_STRING, 'string-return.ts');
      expect(() => fn({} as RuleHostInput, {} as RuleHostHelpers)).toThrow(/invalid RuleHostResult/);
    });

    it('handles Object.create(null) output (no prototype) via Object.hasOwn (ERR-025)', () => {
      const fn = compileDemoRule(RULE_WITH_HASOWN_POISON_PAYLOAD, 'hasown-poison.ts');
      const result = fn({} as RuleHostInput, {} as RuleHostHelpers);
      expect(result.decision).toBe('accepted');
    });
  });

  describe('evaluate behaviour', () => {
    it('propagates evaluate() exceptions to the caller (fail loud)', () => {
      const fn = compileDemoRule(THROWING_EVALUATE, 'throwing.ts');
      expect(() => fn({} as RuleHostInput, {} as RuleHostHelpers)).toThrow(/boom/);
    });

    it('reads inputs and returns different results based on context', () => {
      const fn = compileDemoRule(RULE_WITH_EVIDENCE, 'evidence-rule.ts');
      const withContext = fn(
        { task: 'x', context: [1, 2, 3] } as unknown as RuleHostInput,
        {} as RuleHostHelpers,
      );
      const without = fn(
        { task: 'x', context: [] } as unknown as RuleHostInput,
        {} as RuleHostHelpers,
      );
      expect(withContext.decision).toBe('accepted');
      expect(without.decision).toBe('rejected');
    });
  });

  describe('vm sandbox isolation', () => {
    it('does not pollute Node.js globalThis between invocations (ERR-021)', () => {
      const polluter = `
      export function evaluate() {
        globalThis.__pd_leaked_test = 1;
        return { decision: 'rejected', reason: 'polluting', evidence: [] };
      }
      `;
      const before = (globalThis as { __pd_leaked_test?: unknown }).__pd_leaked_test;
      const fn = compileDemoRule(polluter, 'polluter.ts');
      fn({} as RuleHostInput, {} as RuleHostHelpers);
      const after = (globalThis as { __pd_leaked_test?: unknown }).__pd_leaked_test;
      // The sandboxed __pdRuleModule temporary assignment must not leak
      // arbitrary user-defined globals.
      expect(before).toBeUndefined();
      expect(after).toBeUndefined();
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
      let caught: Error | null = null;
      try {
        fn({} as RuleHostInput, {} as RuleHostHelpers);
      } catch (err) {
        caught = err as Error;
      }
      expect(caught).not.toBeNull();
      expect(caught!.message).toMatch(/labeled-42\.ts/);
    });

    it('includes sourceLabel when evaluate export is missing', () => {
      let caught: Error | null = null;
      try {
        compileDemoRule(NO_EVALUATE, 'no-eval-source-label.ts');
      } catch (err) {
        caught = err as Error;
      }
      expect(caught).not.toBeNull();
      expect(caught!.message).toMatch(/no-eval-source-label\.ts/);
    });
  });
});
