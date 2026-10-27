import { describe, expect, it } from 'vitest';
import { classifyBashRisk, classifyCommandRisk } from '../bash-risk.js';
import { createSyntheticRuleHostInput } from '../../golden-trace.js';
import { buildToolSemanticRegistry } from '../tool-semantic-registry.js';

/**
 * PRI-1047 Owner review R6 #1: the read-only investigation exemption for
 * approval-gate rules must rest on ONE shared classifier — replay, the
 * host-runtime production gate and the OpenClaw enrichment all consume it.
 * (The not_approved × read-only / not_approved × mutating verification lives in
 * the SYSTEM-generated approval-gate counterfactuals — see
 * rulecode-verification-obligations.test.ts; model-declared cases stay
 * historical and never invent designGate facts.)
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
    // Arbitrary code execution is NOT read-only (the system counterfactual
    // verifies denied × node -e / python -c → block; exposed by the R6 round).
    expect(classifyCommandRisk('node -e "process.stdout.write(123)"')).toBe('normal');
    expect(classifyCommandRisk('python -c "print(456)"')).toBe('normal');
    expect(classifyCommandRisk('node --version')).toBe('safe');
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
});
