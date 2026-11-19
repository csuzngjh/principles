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
import { compileHardenedRuleEvaluator } from '@principles/core/runtime';
import { createSyntheticRuleHostInput } from '@principles/core/runtime';
import type { RuleHostHelpers, RuleHostInput, RuleHostResult } from '@principles/core/runtime';
import { loadRuleImplementationModule } from '../../src/core/rule-implementation-runtime.js';

// PRI-809 review: the parity rule reads every dimension the replay/live
// contract lists — canonicalKind echo, normalizedPath, evolution — so the
// parity assertion covers decision + reason + those derived fields, not just
// the decision enum. (2bae37491 removed RuleHostInput.session.currentGfi —
// SPEC §3.8 — so the session dimension is covered by evolution.epTier, which
// both boundaries also echo.)
const RULE = `
export const meta = { name: 'parity-guard', version: '1', ruleId: 'R_PARITY', coversCondition: 'all' };
export function evaluate(input, helpers) {
  var p = input.action.paramsSummary;
  var echo = 'kind:' + String(input.action.canonicalKind) + '|path:' + String(input.action.normalizedPath) + '|eptier:' + String(input.evolution.epTier);
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
    expect(reasonOf(live)).toContain('kind:undefined|path:null|eptier:0');
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

  it('live child boundary blocks the constructor-walk escape family (PRI-809 review probe)', () => {
    // The live executor hands the child's vm only a JSON string and rebuilds
    // input + helpers with the vm realm's intrinsics, so a constructor walk
    // lands on the realm's Function where `process` does not exist — neither
    // the child's nor the host's process is reachable.
    const escapeProbe = `
export function evaluate(input, helpers) {
  var attempts = [input, helpers];
  for (var i = 0; i < attempts.length; i++) {
    try {
      var proc = attempts[i].constructor.constructor('return process')();
      if (proc && proc.pid) {
        return { decision: 'allow', matched: false, reason: 'ESCAPED_PID_' + String(proc.pid) };
      }
    } catch (error) { /* blocked */ }
  }
  return { decision: 'allow', matched: false, reason: 'escape_blocked' };
}
`;
    const live = loadRuleImplementationModule(escapeProbe, 'escape-probe.js').callEvaluate?.({}, {}) as { reason?: string };
    expect(String(live.reason)).toBe('escape_blocked');
  });
});
