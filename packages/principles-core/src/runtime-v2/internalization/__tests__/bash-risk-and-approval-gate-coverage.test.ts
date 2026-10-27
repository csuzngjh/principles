import { describe, expect, it } from 'vitest';
import { classifyBashRisk } from '../bash-risk.js';
import { createSyntheticRuleHostInput } from '../../golden-trace.js';
import { buildToolSemanticRegistry } from '../tool-semantic-registry.js';

/**
 * PRI-1047 R8: the deep positive-evidence matrix lives in
 * bash-risk-positive-evidence.test.ts (hardcoded expectations, command-family
 * probes). This file keeps the surface-boundary checks: carrier shapes,
 * replay-derivation parity (R6) and the explicit-override/legacy behavior.
 */
describe('bash-risk surface boundaries (R6/R8)', () => {
  it('classifyBashRisk: non-execute kinds and unreadable params stay unknown', () => {
    expect(classifyBashRisk(false, { command: 'git status' })).toBe('unknown'); // write/read tools
    expect(classifyBashRisk(true, {})).toBe('unknown');                          // no command text
    expect(classifyBashRisk(true, null)).toBe('unknown');
    expect(classifyBashRisk(true, { args: 'git status' })).toBe('safe');        // args carrier parity
    expect(classifyBashRisk(true, { command: 'totally-unknown-cmd --x' })).toBe('unknown');
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
