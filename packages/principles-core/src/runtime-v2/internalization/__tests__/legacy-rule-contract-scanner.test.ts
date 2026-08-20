import { describe, it, expect } from 'vitest';
import {
  scanLegacyRuleContractDependencies,
  formatLegacyRuleContractRemediation,
} from '../legacy-rule-contract-scanner.js';

const base = {
  artifactId: 'art-rule-001',
  ruleId: 'rule-real-diagnosis-first',
  activationId: 'act_code_rule-real-diagnosis-first',
  principleId: 'principle-001',
};

describe('scanLegacyRuleContractDependencies', () => {
  it('detects the real historical recentThinking usage pattern', () => {
    const findings = scanLegacyRuleContractDependencies([{
      ...base,
      implementationCode: `function evaluate(input, helpers) {
  if (input.session.recentThinking === true) { return { decision: 'requireApproval', matched: true }; }
  return { decision: 'allow', matched: false };
}`,
    }]);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ symbol: 'recentThinking', channel: 'code_tool_hook', ruleId: base.ruleId, activationId: base.activationId });
  });

  it('detects workspace.planStatus and workspace.hasPlanFile field reads', () => {
    const findings = scanLegacyRuleContractDependencies([{
      ...base,
      implementationCode: `function evaluate(input) {
  if (input.workspace.planStatus !== 'READY' || input.workspace.hasPlanFile === false) {
    return { decision: 'block', matched: true };
  }
  return { decision: 'allow', matched: false };
}`,
    }]);
    expect(findings.map(f => f.symbol).sort()).toEqual(['hasPlanFile', 'planStatus']);
  });

  it('distinguishes helper calls from field reads for hasPlanFile', () => {
    const findings = scanLegacyRuleContractDependencies([{
      ...base,
      implementationCode: `function evaluate(input, helpers) {
  if (helpers.getPlanStatus() === 'READY' && helpers.hasPlanFile()) {
    return { decision: 'allow', matched: false };
  }
  return { decision: 'block', matched: true };
}`,
    }]);
    expect(findings.map(f => f.symbol).sort()).toEqual(['getPlanStatus', 'hasPlanFileHelper']);
  });

  it('passes a clean RuleContextV2-only rule (current contract)', () => {
    const findings = scanLegacyRuleContractDependencies([{
      ...base,
      implementationCode: `function evaluate(input, helpers) {
  var h = input.context && input.context.history;
  if (h && h.status === 'available' && h.recentCalls.length > 0) {
    return { decision: 'requireApproval', matched: true };
  }
  return { decision: 'allow', matched: false, reason: 'cannot verify: history unavailable' };
}`,
    }]);
    expect(findings).toEqual([]);
  });

  it('is conservative: a comment-only mention is still flagged', () => {
    const findings = scanLegacyRuleContractDependencies([{
      ...base,
      implementationCode: `function evaluate(input) {
  // legacy: used to check input.session.recentThinking before PRI retirement
  return { decision: 'allow', matched: false };
}`,
    }]);
    expect(findings.map(f => f.symbol)).toEqual(['recentThinking']);
  });

  it('does not match lookalike symbols (planStatusX, myRecentThinking)', () => {
    const findings = scanLegacyRuleContractDependencies([{
      ...base,
      implementationCode: `function evaluate(input) {
  var planStatusX = 1; var myRecentThinking = 2; var hasPlanFilePath = 3;
  return { decision: 'allow', matched: planStatusX + myRecentThinking + hasPlanFilePath > 0 ? false : true };
}`,
    }]);
    expect(findings).toEqual([]);
  });

  it('skips empty or non-string implementationCode entries', () => {
    expect(scanLegacyRuleContractDependencies([{ ...base, implementationCode: '' }])).toEqual([]);
  });

  it('reports one finding per distinct symbol per rule', () => {
    const findings = scanLegacyRuleContractDependencies([{
      ...base,
      implementationCode: 'if (input.session.recentThinking) {} if (input.session.recentThinking) {}',
    }]);
    expect(findings).toHaveLength(1);
  });
});

describe('formatLegacyRuleContractRemediation', () => {
  it('groups findings by rule and names the migration next action', () => {
    const text = formatLegacyRuleContractRemediation([
      { artifactId: 'art-1', ruleId: 'rule-a', symbol: 'recentThinking', channel: 'code_tool_hook' },
      { artifactId: 'art-2', ruleId: 'rule-b', activationId: 'act-2', symbol: 'planStatus', channel: 'code_tool_hook' },
    ]);
    expect(text).toContain('rule-a');
    expect(text).toContain('recentThinking');
    expect(text).toContain('rule-b (activation act-2)');
    expect(text).toContain('igrate or deactivate');
  });
});
