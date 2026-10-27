import { describe, expect, it } from 'vitest';
import { readRuleCodeVerificationContext, deriveRuleCodeVerification } from '../rulecode-verification-obligations.js';
import { UNAVAILABLE_RULE_CONTEXT } from '../rule-context-v2.js';

const executionConditions = { version: 1, requiredFacts: [{ factKind: 'design_approval', required: true, textualBasis: 'fixture approval requirement' }] };
const tools = [{ rawToolName: 'host.exec', canonicalKind: 'execute' }];
const content = JSON.stringify({ ruleCodeVerification: { version: 1, executionConditions, tools } });

describe('system-owned RuleCode verification declaration', () => {
  it('ignores model/user messages pretending to carry the system declaration', () => {
    expect(readRuleCodeVerificationContext([{ role: 'assistant', content }, { role: 'user', content }])).toBeUndefined();
    expect(readRuleCodeVerificationContext([{ role: 'system', content }])?.tools).toEqual(tools);
  });
  it('rejects duplicate system declarations instead of choosing a convenient override', () => {
    expect(() => readRuleCodeVerificationContext([{ role: 'system', content }, { role: 'system', content }])).toThrow('invalid_or_duplicate');
  });
  it('rejects malformed system tools and execution conditions', () => {
    for (const value of [
      { version: 1, executionConditions: {}, tools },
      { version: 1, executionConditions, tools: [{ rawToolName: 'x', canonicalKind: 'invented' }] },
    ]) expect(() => readRuleCodeVerificationContext([{ role: 'system', content: JSON.stringify({ ruleCodeVerification: value }) }])).toThrow();
  });
  it('validates every system Owner case instead of trusting the array container', () => {
    const value = { version: 1, executionConditions, tools, ownerCases: [{ caseId: 'incomplete' }] };
    expect(() => readRuleCodeVerificationContext([{ role: 'system', content: JSON.stringify({ ruleCodeVerification: value }) }])).toThrow('invalid_rulecode_verification_owner_cases');
  });
  it('keeps a missing historical fact evidence-only without altering its original label/input', () => {
    const cases = [{ caseId: 'owner-missing', kind: 'negative' as const, toolName: 'host.exec', params: {}, expectedDecision: 'block' as const, ruleContext: UNAVAILABLE_RULE_CONTEXT }];
    const original = JSON.stringify(cases);
    const result = deriveRuleCodeVerification({ executionConditions }, cases, tools);
    expect(result.historical[0]?.qualification).toBe('historical_evidence_only');
    expect(result.replayCases).toEqual([]);
    expect(result.counterfactuals.length).toBeGreaterThan(0);
    expect(JSON.stringify(cases)).toBe(original);
  });
  it('unsupported kinds stop independently of the model supplying zero cases', () => {
    const result = deriveRuleCodeVerification({ executionConditions: { version: 1, requiredFacts: [{ factKind: 'other_fact', required: true, textualBasis: 'fixture contract' }] } }, [], tools);
    expect(result.required).toEqual(['other_fact']);
    expect(result.unavailable).toEqual(['unsupported_required_fact:other_fact']);
    expect(result.counterfactuals).toEqual([]);
  });
  it('pairs each managed historical action shape with all fact states without rewriting its params or scoping read positives as denied', () => {
    const cases = [
      { caseId: 'owner-negative', kind: 'negative' as const, toolName: 'host.exec', params: { command: 'custom-owner-action --target A', detail: { mode: 3 } }, expectedDecision: 'block' as const, ruleContext: UNAVAILABLE_RULE_CONTEXT },
      { caseId: 'owner-read', kind: 'positive' as const, toolName: 'host.read', params: { path: '/owner/read' }, expectedDecision: 'allow' as const, ruleContext: UNAVAILABLE_RULE_CONTEXT },
    ];
    const snapshot = JSON.stringify(cases);
    const result = deriveRuleCodeVerification({ executionConditions }, cases, [...tools, { rawToolName: 'host.read', canonicalKind: 'read' }]);
    const paired = result.counterfactuals.filter((entry) => entry.rationale.includes('seed=historical-action:owner-negative;'));
    expect(paired).toHaveLength(7);
    expect(paired.every((entry) => JSON.stringify(entry.params) === JSON.stringify(cases[0]?.params))).toBe(true);
    expect(paired.find((entry) => entry.caseId.endsWith(':unknown'))?.expectedDecision).toBe('allow');
    expect(paired.find((entry) => entry.caseId.endsWith(':denied'))?.expectedDecision).toBe('block');
    expect(result.counterfactuals.some((entry) => entry.toolName === 'host.read' && entry.expectedDecision === 'block')).toBe(false);
    expect(JSON.stringify(cases)).toBe(snapshot);
  });

  it('PRI-1047 Owner review R6 #1: execute tools carry a not_approved × READ-ONLY command → allow counterfactual', () => {
    const result = deriveRuleCodeVerification({ executionConditions }, [], tools);
    const readonly = result.counterfactuals.find((entry) => entry.caseId === 'system-contract:design_approval:0:readonly:denied-readonly');
    expect(readonly).toBeDefined();
    expect(readonly?.toolName).toBe('host.exec');
    expect(readonly?.params).toEqual({ command: 'git status --short' });
    expect(readonly?.expectedDecision).toBe('allow');
    expect(readonly?.ruleContext.facts.designGate).toMatchObject({ resolution: 'not_approved', requiresApproval: true });
    // read/search tools do NOT get the execute-kind readonly case (their whole
    // variant table already expects allow under every fact state).
    const withRead = deriveRuleCodeVerification({ executionConditions }, [], [...tools, { rawToolName: 'host.read', canonicalKind: 'read' }]);
    expect(withRead.counterfactuals.some((entry) => entry.caseId.includes('host.read') && entry.caseId.includes(':readonly:'))).toBe(false);
  });
});
