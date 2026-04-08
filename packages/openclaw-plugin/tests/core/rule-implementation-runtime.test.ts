import { describe, expect, it } from 'vitest';
import { loadRuleImplementationModule } from '../../src/core/rule-implementation-runtime.js';
import { validateRuleImplementationCandidate } from '../../src/core/nocturnal-rule-implementation-validator.js';

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

  it('keeps validator execution isolated from the host global object', () => {
    delete (globalThis as Record<string, unknown>).__pdValidatorLeak;

    const result = validateRuleImplementationCandidate(`
      globalThis.__pdValidatorLeak = 'sandbox-only';
      export const meta = {
        name: 'validator-leak-check',
        version: '1.0.0',
        ruleId: 'R-VAL',
        coversCondition: 'validator isolation'
      };

      export function evaluate() {
        globalThis.__pdValidatorLeak = 'still-sandboxed';
        return {
          decision: 'allow',
          matched: false,
          reason: 'ok'
        };
      }
    `);

    expect(result.passed).toBe(true);
    expect((globalThis as Record<string, unknown>).__pdValidatorLeak).toBeUndefined();
  });
});
