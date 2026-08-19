/**
 * Rule Host Helpers Tests
 *
 * PURPOSE: Verify that the helper whitelist:
 *   - Returns correct values from the frozen input snapshot
 *   - Is a frozen object that cannot be mutated
 *   - All helpers are pure functions with no side effects
 *   - Does NOT expose retired plan-state helpers (PRI-286 anti-regression)
 */

import { describe, it, expect } from 'vitest';
import { createRuleHostHelpers } from '@principles/core/runtime-v2';
import type { RuleHostInput } from '@principles/core/runtime-v2';

function makeInput(overrides?: Partial<RuleHostInput>): RuleHostInput {
  return {
    action: {
      toolName: 'write',
      normalizedPath: 'src/test.ts',
      paramsSummary: {},
    },
    workspace: {
      isRiskPath: false,
    },
    session: {
      sessionId: 'session-123',
      currentGfi: 10,
      recentThinking: false,
    },
    evolution: {
      epTier: 2,
    },
    derived: {
      estimatedLineChanges: 50,
      bashRisk: 'normal',
    },
    ...overrides,
  };
}

describe('createRuleHostHelpers', () => {
  it('should return a frozen object', () => {
    const helpers = createRuleHostHelpers(makeInput());
    expect(Object.isFrozen(helpers)).toBe(true);
  });

  it('should throw TypeError when attempting to mutate helpers', () => {
    const helpers = createRuleHostHelpers(makeInput()) as Record<string, unknown>;
    expect(() => {
      (helpers as any).isRiskPath = () => true;
    }).toThrow(TypeError);
  });

  it('should return correct isRiskPath from input snapshot', () => {
    const helpers = createRuleHostHelpers(makeInput({
      workspace: { isRiskPath: true },
    }));
    expect(helpers.isRiskPath()).toBe(true);
  });

  it('should return false isRiskPath by default', () => {
    const helpers = createRuleHostHelpers(makeInput());
    expect(helpers.isRiskPath()).toBe(false);
  });

  it('should return correct toolName from input snapshot', () => {
    const helpers = createRuleHostHelpers(makeInput());
    expect(helpers.getToolName()).toBe('write');
  });

  it('should return correct estimatedLineChanges from input snapshot', () => {
    const helpers = createRuleHostHelpers(makeInput({
      derived: { estimatedLineChanges: 200, bashRisk: 'dangerous' },
    }));
    expect(helpers.getEstimatedLineChanges()).toBe(200);
  });

  it('should return correct bashRisk from input snapshot', () => {
    const helpers = createRuleHostHelpers(makeInput({
      derived: { estimatedLineChanges: 50, bashRisk: 'safe' },
    }));
    expect(helpers.getBashRisk()).toBe('safe');
  });

  it('should return correct epTier from input snapshot', () => {
    const helpers = createRuleHostHelpers(makeInput({
      evolution: { epTier: 4 },
    }));
    expect(helpers.getEpTier()).toBe(4);
  });

  it('all helpers should be pure functions with no side effects', () => {
    const input = makeInput();
    const helpers = createRuleHostHelpers(input);

    // Call each helper multiple times — should always return the same value
    expect(helpers.isRiskPath()).toBe(helpers.isRiskPath());
    expect(helpers.getToolName()).toBe(helpers.getToolName());
    expect(helpers.getEstimatedLineChanges()).toBe(helpers.getEstimatedLineChanges());
    expect(helpers.getBashRisk()).toBe(helpers.getBashRisk());
    expect(helpers.getEpTier()).toBe(helpers.getEpTier());
  });

  it('does not expose retired plan-state helpers (PRI-286 anti-regression)', () => {
    const helpers = createRuleHostHelpers(makeInput()) as unknown as Record<string, unknown>;
    expect(Object.hasOwn(helpers, 'hasPlanFile')).toBe(false);
    expect(Object.hasOwn(helpers, 'getPlanStatus')).toBe(false);
  });
});
