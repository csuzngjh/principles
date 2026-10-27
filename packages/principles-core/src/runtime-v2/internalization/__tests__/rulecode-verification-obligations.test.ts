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

  it('PRI-1047 R8: execute tools carry the hardcoded command-family probe counterfactuals', () => {
    const result = deriveRuleCodeVerification({ executionConditions }, [], tools);
    const probes = result.counterfactuals.filter((entry) => entry.caseId.includes(':probe:'));
    const ids = probes.map((entry) => entry.caseId.split(':probe:')[1]);
    // Every family required by the R8 owner review is present, with its
    // HARDCODED expectation (never computed from the classifier).
    expect(ids).toEqual([
      'readonly-status', 'readonly-log-format', 'readonly-show-path', 'readonly-grep-keyword',
      'readonly-cat', 'readonly-globalopt-query', 'mutate-remote-add', 'mutate-stash',
      'mutate-globalopt-commit', 'mutate-output-file', 'pipe-into-script', 'pipe-into-mutation',
      'inline-code-exec', 'sort-output-option', 'uniq-output-operand', 'rg-pre-exec', 'git-hash-object-write',
      'git-reflog-delete', 'git-branch-unset-upstream', 'newline-hidden-mutation', 'quoted-backtick-substitution',
      'variable-expansion', 'environment-assignment-wrapper', 'sudo-wrapper', 'substitution-output-into-find',
      'reflog-output-file', 'printf-n-write', 'read-write-redirection', 'fd-read-write-redirection',
      'brace-expansion-find-action', 'brace-expansion-rg-pre', 'git-config-pager', 'git-paginate',
      'git-diff-ext-diff', 'git-stash-ext-diff', 'git-reflog-ext-diff', 'git-reflog-output',
      'find-quoted-operator-action', 'rg-substitution-pre', 'readonly-quoted-operators', 'readonly-multiline-queries',
    ]);
    expect(probes.find((e) => e.caseId.endsWith('readonly-status'))?.expectedDecision).toBe('allow');
    expect(probes.find((e) => e.caseId.endsWith('readonly-log-format'))?.expectedDecision).toBe('allow');
    expect(probes.find((e) => e.caseId.endsWith('mutate-remote-add'))?.expectedDecision).toBe('block');
    expect(probes.find((e) => e.caseId.endsWith('mutate-output-file'))?.expectedDecision).toBe('block');
    expect(probes.find((e) => e.caseId.endsWith('pipe-into-script'))?.expectedDecision).toBe('block');
    expect(probes.find((e) => e.caseId.endsWith('inline-code-exec'))?.expectedDecision).toBe('block');
    for (const id of ['sort-output-option', 'uniq-output-operand', 'rg-pre-exec', 'git-hash-object-write',
      'git-reflog-delete', 'git-branch-unset-upstream', 'newline-hidden-mutation', 'quoted-backtick-substitution',
      'variable-expansion', 'environment-assignment-wrapper', 'sudo-wrapper', 'substitution-output-into-find',
      'reflog-output-file', 'printf-n-write', 'read-write-redirection', 'fd-read-write-redirection',
      'brace-expansion-find-action', 'brace-expansion-rg-pre', 'git-config-pager', 'git-paginate',
      'git-diff-ext-diff', 'git-stash-ext-diff', 'git-reflog-ext-diff', 'git-reflog-output',
      'find-quoted-operator-action', 'rg-substitution-pre']) {
      expect(probes.find((e) => e.caseId.endsWith(id))?.expectedDecision, id).toBe('block');
    }
    for (const id of ['readonly-quoted-operators', 'readonly-multiline-queries']) {
      expect(probes.find((e) => e.caseId.endsWith(id))?.expectedDecision, id).toBe('allow');
    }
    for (const probe of probes) {
      if (probe.ruleContext === undefined) throw new Error('fixture: probe ruleContext missing');
      expect(probe.ruleContext.facts.designGate).toMatchObject({ resolution: 'not_approved', requiresApproval: true });
    }
    // Representative probes are ALSO crossed with approved (gate face passes).
    const approved = result.counterfactuals.filter((entry) => entry.caseId.includes(':probe-approved:'));
    expect(approved.map((e) => e.caseId.split(':probe-approved:')[1]).sort()).toEqual(['mutate-remote-add', 'pipe-into-script', 'readonly-status']);
    expect(approved.every((e) => e.expectedDecision === 'allow')).toBe(true);
    // read/search tools do NOT get the execute-kind probes.
    const withRead = deriveRuleCodeVerification({ executionConditions }, [], [...tools, { rawToolName: 'host.read', canonicalKind: 'read' }]);
    expect(withRead.counterfactuals.some((entry) => entry.caseId.includes('host.read') && entry.caseId.includes(':probe:'))).toBe(false);
  });
});
