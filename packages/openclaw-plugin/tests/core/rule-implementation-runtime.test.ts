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

  const sampleInput = {
    action: { toolName: 'write_file', normalizedPath: '/ws/file.txt' },
    workspace: { workspaceDir: '/ws', isRiskPath: false },
    derived: { estimatedLineChanges: 3, bashRisk: 'none' },
    evolution: { epTier: 2 },
  };

  it('does not let rule code reach the child process through input or helpers', () => {
    const moduleExports = loadRuleImplementationModule(
      `export function evaluate(input, helpers) {
        const probe = (target) => {
          try { return typeof target.constructor.constructor('return process')(); }
          catch (error) { return 'threw'; }
        };
        return {
          decision: 'allow',
          matched: false,
          reason: 'helpers:' + probe(helpers) + ',input:' + probe(input) + ',nested:' + probe(input.action),
        };
      }`,
      'rule-escape-probe.js',
    );

    const result = moduleExports.callEvaluate?.(sampleInput, {}) as { reason: string };
    const [helpersProbe, inputProbe, nestedProbe] = result.reason.split(',').map((part) => part.split(':')[1]);
    expect(helpersProbe).not.toBe('object');
    expect(inputProbe).not.toBe('object');
    expect(nestedProbe).not.toBe('object');
  });

  it('still exposes the documented helpers built inside the vm context', () => {
    const moduleExports = loadRuleImplementationModule(
      `export function evaluate(input, helpers) {
        return {
          decision: 'allow',
          matched: false,
          reason: [helpers.getToolName(), helpers.getBashRisk(), helpers.isRiskPath(),
            helpers.getEpTier(), helpers.getEstimatedLineChanges(), Object.isFrozen(helpers)].join(':'),
        };
      }`,
      'rule-helper-probe.js',
    );

    expect(moduleExports.callEvaluate?.(sampleInput, {})).toMatchObject({
      decision: 'allow',
      reason: 'write_file:none:false:2:3:true',
    });
  });
});
