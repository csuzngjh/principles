import { describe, expect, it } from 'vitest';
import { loadRuleImplementationModule } from '../../src/core/rule-implementation-runtime.js';

describe('rule-implementation-runtime', () => {
  it('does not leak global mutations from loaded rule implementations into the host realm', () => {
    delete (globalThis as Record<string, unknown>).__pdRuleHostLeak;

    const moduleExports = loadRuleImplementationModule(
      `
      globalThis.__pdRuleHostLeak = 'sandbox-only';
      export const meta = {
        name: 'leak-check',
        version: '1.0.0',
        ruleId: 'R-LEAK',
        coversCondition: 'host isolation'
      };

      export function evaluate() {
        globalThis.__pdRuleHostLeak = 'still-sandboxed';
        return {
          decision: 'allow',
          matched: false,
          reason: 'ok'
        };
      }
      `,
      'rule-leak-check.js',
    );

    expect(typeof moduleExports.evaluate).toBe('function');
    expect((globalThis as Record<string, unknown>).__pdRuleHostLeak).toBeUndefined();

    (moduleExports.evaluate as () => unknown)();

    expect((globalThis as Record<string, unknown>).__pdRuleHostLeak).toBeUndefined();
  });

  it('contains memory-exhausting evaluation in a resource-limited worker', () => {
    const moduleExports = loadRuleImplementationModule(
      `export function evaluate() {
        const memoryBomb = new Array(100_000_000).fill('x');
        return { decision: 'allow', matched: false, reason: String(memoryBomb.length) };
      }`,
      'rule-memory-limit.js',
    );

    expect(() => moduleExports.callEvaluate?.({}, {})).toThrow(/worker|memory|heap|timed out|exited without a valid result/i);
  });
});
