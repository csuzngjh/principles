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

// PRI-809 review: the parity rule reads every dimension the replay/live
// contract lists — canonicalKind echo, normalizedPath, context — so the
// parity assertion covers decision + reason + those derived fields, not just
// the decision enum.
const RULE = `
export const meta = { name: 'parity-guard', version: '1', ruleId: 'R_PARITY', coversCondition: 'all' };
export function evaluate(input, helpers) {
  var p = input.action.paramsSummary;
  var echo = 'kind:' + String(input.action.canonicalKind) + '|path:' + String(input.action.normalizedPath) + '|gfi:' + String(input.session.currentGfi);
  if (helpers.getToolName() === 'edit' && p && p.filePath === '/etc/passwd') {
    return { decision: 'block', matched: true, reason: 'system path blocked ' + echo };
  }
  return { decision: 'allow', matched: false, reason: 'safe path ' + echo };
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
    expect(reasonOf(live)).toContain('safe path ');
    // Baseline synthetic input: canonicalKind absent, normalizedPath null —
    // both boundaries must observe the SAME echo (absent/null preserved).
    expect(reasonOf(live)).toContain('kind:undefined|path:null|gfi:0');
    expect(reasonOf(live)).toBe(reasonOf(replay));
  });

  it('same rule + same input → same decision on replay path and live child-process boundary (block side)', () => {
    const input = parityInput('/etc/passwd');

    const replay = compileHardenedRuleEvaluator(RULE, 'parity-replay')(input, {} as RuleHostHelpers) as RuleHostResult;
    const live = loadRuleImplementationModule(RULE, 'parity-live.js').callEvaluate?.(input, {}) as unknown;

    expect(replay.decision).toBe('block');
    expect((live as RuleHostResult).decision).toBe('block');
    expect(reasonOf(live)).toBe(reasonOf(replay));
    expect(reasonOf(live)).toContain('system path blocked kind:undefined');
  });

  it('live child boundary contains the escape family in the sacrificial child process, never the host (PRI-809 review probe)', () => {
    // The legacy live executor passes a child-realm object into the child's
    // vm, so a constructor walk CAN reach the CHILD's process — that is the
    // accepted live design: the child (32MB heap, 3s timeout, 1MB stdout) is
    // the sacrificial boundary. What must NEVER happen is reaching the HOST
    // (test) process. Evidence: the escaped pid differs from this process's.
    const escapeProbe = `
export function evaluate(input, helpers) {
  try {
    var proc = input.constructor.constructor('return process')();
    if (proc && proc.pid) {
      return { decision: 'allow', matched: false, reason: 'ESCAPED_PID_' + String(proc.pid) };
    }
  } catch (error) { /* blocked */ }
  return { decision: 'allow', matched: false, reason: 'escape_blocked' };
}
`;
    const live = loadRuleImplementationModule(escapeProbe, 'escape-probe.js').callEvaluate?.({}, {}) as { reason?: string };
    expect(String(live.reason)).toContain('ESCAPED_PID_');
    expect(String(live.reason)).not.toContain(`ESCAPED_PID_${process.pid}`);
  });
});
