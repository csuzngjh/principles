import { describe, expect, it } from 'vitest';
import { classifyBashRisk, classifyCommandRisk } from '../bash-risk.js';
import { createSyntheticRuleHostInput } from '../../golden-trace.js';
import { validateApprovalGateCaseCoverage } from '../artificer-output.js';
import { buildToolSemanticRegistry } from '../tool-semantic-registry.js';

/**
 * PRI-1047 Owner review R6 #1: the read-only investigation exemption for
 * approval-gate rules must rest on ONE shared classifier — replay, the
 * host-runtime production gate and the OpenClaw enrichment all consume it,
 * and submit-time validation requires the golden cases to DECLARE the
 * not_approved × read-only / not_approved × mutating combinations the R04
 * production artifact never declared.
 */
describe('Owner review R6 #1 — shared bash-risk classification + approval-gate case coverage', () => {
  it('classifies read-only investigation as safe and mutations as normal/dangerous', () => {
    // Read-only investigation (the Owner's replay set).
    expect(classifyCommandRisk('git status --short')).toBe('safe');
    expect(classifyCommandRisk("rg --files services | Select-String 'generation'")).toBe('safe');
    expect(classifyCommandRisk('cat package.json')).toBe('safe');
    expect(classifyCommandRisk('ls -la src')).toBe('safe');
    // Mutations — including the git gap: `git commit` contains none of the old
    // mutation substrings and was previously classified 'safe'.
    expect(classifyCommandRisk('git commit -m "feat: x"')).toBe('normal');
    expect(classifyCommandRisk('git push origin main')).toBe('normal');
    expect(classifyCommandRisk('git add -A && git commit')).toBe('normal');
    expect(classifyCommandRisk('npm install left-pad')).toBe('normal');
    expect(classifyCommandRisk('echo hi > out.txt')).toBe('normal');
    expect(classifyCommandRisk('sed -i s/a/b/ file')).toBe('normal');
    expect(classifyCommandRisk('rm -rf node_modules')).toBe('dangerous');
    expect(classifyCommandRisk('chmod +x run.sh')).toBe('dangerous');
  });

  it('classifyBashRisk: non-execute kinds and unreadable commands stay unknown', () => {
    expect(classifyBashRisk(false, { command: 'git status' })).toBe('unknown'); // write/read tools
    expect(classifyBashRisk(true, {})).toBe('unknown');                          // no command text
    expect(classifyBashRisk(true, null)).toBe('unknown');
    expect(classifyBashRisk(true, { args: 'git status' })).toBe('safe');        // args carrier parity
  });

  it('golden-trace replay input derives bashRisk with the SAME classifier (no hard-coded unknown)', () => {
    const registry = buildToolSemanticRegistry();
    if (!registry.ok) throw new Error('fixture: baseline registry failed to build');
    const input = createSyntheticRuleHostInput(
      { toolName: 'bash', params: { command: 'git status --short' } },
      {},
      { toolSemantics: registry.registry },
    );
    expect(input.derived.bashRisk).toBe('safe');
    const mutating = createSyntheticRuleHostInput(
      { toolName: 'bash', params: { command: 'git commit -m "feat: x"' } },
      {},
      { toolSemantics: registry.registry },
    );
    expect(mutating.derived.bashRisk).toBe('normal');
    // Explicit override still wins; legacy (no registry) stays unknown.
    const overridden = createSyntheticRuleHostInput(
      { toolName: 'bash', params: { command: 'git status' } },
      { derived: { bashRisk: 'dangerous' } },
      { toolSemantics: registry.registry },
    );
    expect(overridden.derived.bashRisk).toBe('dangerous');
    const legacy = createSyntheticRuleHostInput({ toolName: 'bash', params: { command: 'git status' } }, {}, {});
    expect(legacy.derived.bashRisk).toBe('unknown');
  });

  it('approval-gate case coverage: rejects the R04 shape, accepts both declared combinations', () => {
    const resolve = (toolName: string) => (toolName === 'bash' ? 'execute' : toolName === 'apply_patch' ? 'write' : undefined);
    const notApproved = { version: 2 as const, history: { status: 'unavailable' as const, truncated: false, calls: [] }, facts: {} };
    const gate = (resolution: string) => ({
      ...notApproved,
      facts: { designGate: { resolution } },
    });

    // The R04 production shape: positives carried a missing/unknown fact only —
    // BOTH required combinations absent → two coverage errors.
    const r04Shape = {
      goldenTraceCases: [
        { caseId: 'n1', kind: 'negative', toolName: 'bash', params: { command: 'git commit -m "x"' }, expectedDecision: 'block', ruleContext: gate('unknown') },
        { caseId: 'p1', kind: 'positive', toolName: 'bash', params: { command: 'git status' }, expectedDecision: 'allow', ruleContext: gate('unknown') },
      ],
    };
    const rejected = validateApprovalGateCaseCoverage(r04Shape, resolve);
    expect(rejected).toHaveLength(2);
    expect(rejected.join(' ')).toContain('NEGATIVE case');
    expect(rejected.join(' ')).toContain('POSITIVE case');

    // Both combinations declared → accepted.
    const complete = {
      goldenTraceCases: [
        { caseId: 'n1', kind: 'negative', toolName: 'bash', params: { command: 'git commit -m "x"' }, expectedDecision: 'block', ruleContext: gate('not_approved') },
        { caseId: 'p1', kind: 'positive', toolName: 'bash', params: { command: 'rg --files src' }, expectedDecision: 'allow', ruleContext: gate('not_approved') },
      ],
    };
    expect(validateApprovalGateCaseCoverage(complete, resolve)).toEqual([]);

    // A "positive" that only passes because the gate fact is approved does NOT
    // satisfy the read-only requirement.
    const approvedOnlyPositive = {
      goldenTraceCases: [
        { caseId: 'n1', kind: 'negative', toolName: 'bash', params: { command: 'git commit -m "x"' }, expectedDecision: 'block', ruleContext: gate('not_approved') },
        { caseId: 'p1', kind: 'positive', toolName: 'bash', params: { command: 'git status' }, expectedDecision: 'allow', ruleContext: gate('approved') },
      ],
    };
    const missing = validateApprovalGateCaseCoverage(approvedOnlyPositive, resolve);
    expect(missing).toHaveLength(1);
    expect(missing[0]).toContain('POSITIVE case');
  });
});
