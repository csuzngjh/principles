import { describe, expect, it } from 'vitest';
import { createNodeRuleImplementationRuntime } from '../src/rule-implementation-runtime.js';

const sampleInput = {
  action: { toolName: 'write_file', normalizedPath: '/ws/file.txt' },
  workspace: { workspaceDir: '/ws', isRiskPath: false },
  derived: { estimatedLineChanges: 3, bashRisk: 'none' },
  evolution: { epTier: 2 },
};

describe('node rule implementation runtime sandbox boundary', () => {
  it('does not let rule source reach the host realm through injected call objects', () => {
    // The classic vm escape: walk `.constructor.constructor` from an injected
    // host-realm object back to the host's Function constructor. If the child
    // handed the context host objects (instead of a JSON string parsed inside
    // the context), `process` resolves and this rule returns ESCAPED_.
    const escapeProbe = `function evaluate(input, helpers) {
      var attempts = [input, helpers];
      for (var i = 0; i < attempts.length; i++) {
        try {
          var hostFunction = attempts[i].constructor.constructor;
          var proc = hostFunction('return process')();
          return { decision: 'block', matched: true, reason: 'ESCAPED_PROCESS_' + String(proc && proc.version) };
        } catch (error) { /* try next vector */ }
      }
      return { decision: 'allow', matched: false, reason: 'escape_blocked_all_vectors' };
    }
    var meta = { name: 'escape-probe', version: '1', ruleId: 'R_ESCAPE_PROBE', coversCondition: 'all' };`;
    const evaluation = createNodeRuleImplementationRuntime().evaluateBatch(
      [{ source: escapeProbe, filename: 'escape-probe.rule.ts' }],
      sampleInput,
      2500,
    );
    expect(evaluation.ok).toBe(true);
    const first = evaluation.results?.[0];
    expect(first?.ok).toBe(true);
    expect(first?.result).toMatchObject({ decision: 'allow', reason: 'escape_blocked_all_vectors' });
  });

  it('still exposes the documented helpers built inside the vm context', () => {
    const helperProbe = `function evaluate(input, helpers) {
      return {
        decision: 'allow', matched: false,
        reason: 'helpers:' + helpers.getToolName() + ':' + helpers.getBashRisk() + ':' + helpers.isRiskPath()
          + ':' + helpers.getEpTier() + ':' + helpers.getEstimatedLineChanges(),
      };
    }
    var meta = { name: 'helper-probe', version: '1', ruleId: 'R_HELPER_PROBE', coversCondition: 'all' };`;
    const evaluation = createNodeRuleImplementationRuntime().evaluateBatch(
      [{ source: helperProbe, filename: 'helper-probe.rule.ts' }],
      sampleInput,
      2500,
    );
    expect(evaluation.ok).toBe(true);
    const first = evaluation.results?.[0];
    expect(first?.ok).toBe(true);
    expect(first?.result).toMatchObject({
      decision: 'allow',
      reason: 'helpers:write_file:none:false:2:3',
    });
  });
});
