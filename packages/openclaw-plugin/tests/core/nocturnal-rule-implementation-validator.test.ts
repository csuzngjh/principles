import { describe, expect, it } from 'vitest';
import { validateRuleImplementationCandidate } from '../../src/core/nocturnal-rule-implementation-validator.js';

describe('nocturnal-rule-implementation-validator', () => {
  it('accepts a RuleHost-compatible candidate and reports helper usage', () => {
    const result = validateRuleImplementationCandidate(`
      export const meta = {
        name: 'risk-write-guard',
        version: '1.0.0',
        ruleId: 'R-001',
        coversCondition: 'risky write'
      };

      export function evaluate(input, helpers) {
        if (helpers.isRiskPath() && helpers.getToolName() === 'write') {
          return {
            decision: 'requireApproval',
            matched: true,
            reason: 'Risk path write requires approval'
          };
        }

        return {
          decision: 'allow',
          matched: false,
          reason: 'not applicable'
        };
      }
    `);

    expect(result.passed).toBe(true);
    expect(result.failures).toEqual([]);
    expect(result.helperUsage).toEqual(['isRiskPath', 'getToolName']);
    expect(result.meta).toMatchObject({
      ruleId: 'R-001',
      name: 'risk-write-guard',
    });
  });

  it('rejects forbidden APIs before compile/load checks', () => {
    const result = validateRuleImplementationCandidate(`
      export const meta = {
        name: 'bad-guard',
        version: '1.0.0',
        ruleId: 'R-001',
        coversCondition: 'bad'
      };

      export function evaluate() {
        const fn = eval('1 + 1');
        return {
          decision: 'allow',
          matched: false,
          reason: String(fn)
        };
      }
    `);

    expect(result.passed).toBe(false);
    expect(result.failures).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'forbidden-api',
          detail: 'eval',
        }),
      ])
    );
  });

  it('rejects malformed exports when meta is missing', () => {
    const result = validateRuleImplementationCandidate(`
      export function evaluate() {
        return {
          decision: 'allow',
          matched: false,
          reason: 'missing meta'
        };
      }
    `);

    expect(result.passed).toBe(false);
    expect(result.failures).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'missing-meta',
        }),
      ])
    );
  });

  it('rejects candidates whose evaluate result does not satisfy RuleHostResult', () => {
    const result = validateRuleImplementationCandidate(`
      export const meta = {
        name: 'wrong-result-shape',
        version: '1.0.0',
        ruleId: 'R-001',
        coversCondition: 'bad result'
      };

      export function evaluate() {
        return {
          decision: 'noop',
          matched: 'sometimes',
          reason: 42
        };
      }
    `);

    expect(result.passed).toBe(false);
    expect(result.failures).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'invalid-result',
          detail: 'decision',
        }),
        expect.objectContaining({
          code: 'invalid-result',
          detail: 'matched',
        }),
        expect.objectContaining({
          code: 'invalid-result',
          detail: 'reason',
        }),
      ])
    );
  });
});
