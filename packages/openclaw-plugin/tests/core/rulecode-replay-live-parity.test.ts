/**
 * PRI-809 — replay/live semantic parity for the same RuleCode artifact.
 *
 * Mission §8: the SAME rule + the SAME input must yield the SAME business
 * verdict whether it runs through the pre-activation replay path (core
 * hardened replay evaluator) or the live RuleHost boundary (the plugin's
 * child-process callEvaluate). Isolation mechanics differ; the decision
 * contract must not drift.
 */

import { describe, expect, it } from 'vitest';
import { compileHardenedRuleEvaluator } from '@principles/core/runtime-v2';
import { createSyntheticRuleHostInput } from '@principles/core/runtime-v2';
import type { RuleHostHelpers, RuleHostInput, RuleHostResult } from '@principles/core/runtime-v2';
import { loadRuleImplementationModule } from '../../src/core/rule-implementation-runtime.js';

const RULE = `
export const meta = { name: 'parity-guard', version: '1', ruleId: 'R_PARITY', coversCondition: 'all' };
export function evaluate(input, helpers) {
  var p = input.action.paramsSummary;
  if (helpers.getToolName() === 'edit' && p && p.filePath === '/etc/passwd') {
    return { decision: 'block', matched: true, reason: 'system path blocked' };
  }
  return { decision: 'allow', matched: false, reason: 'safe path' };
}
`;

function parityInput(filePath: string): RuleHostInput {
  return createSyntheticRuleHostInput(
    { toolName: 'edit', params: { filePath } },
    {},
    {},
  );
}

function reasonOf(result: unknown): string {
  return (result as { reason?: unknown }).reason as string;
}

describe('PRI-809 replay/live semantic parity', () => {
  it('same rule + same input → same decision on replay path and live child-process boundary (allow side)', () => {
    const input = parityInput('/src/index.ts');

    const replay = compileHardenedRuleEvaluator(RULE, 'parity-replay')(input, {} as RuleHostHelpers) as RuleHostResult;
    const live = loadRuleImplementationModule(RULE, 'parity-live.js').callEvaluate?.(input, {}) as unknown;

    expect(replay.decision).toBe('allow');
    expect((live as RuleHostResult).decision).toBe('allow');
    expect(reasonOf(live)).toBe(reasonOf(replay));
    expect(reasonOf(live)).toBe('safe path');
  });

  it('same rule + same input → same decision on replay path and live child-process boundary (block side)', () => {
    const input = parityInput('/etc/passwd');

    const replay = compileHardenedRuleEvaluator(RULE, 'parity-replay')(input, {} as RuleHostHelpers) as RuleHostResult;
    const live = loadRuleImplementationModule(RULE, 'parity-live.js').callEvaluate?.(input, {}) as unknown;

    expect(replay.decision).toBe('block');
    expect((live as RuleHostResult).decision).toBe('block');
    expect(reasonOf(live)).toBe(reasonOf(replay));
    expect(reasonOf(live)).toBe('system path blocked');
  });
});
