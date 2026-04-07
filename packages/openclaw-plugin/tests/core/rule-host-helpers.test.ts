/**
 * Rule Host Helpers Tests
 *
 * PURPOSE: Verify that the helper whitelist:
 *   - Returns correct values from the frozen input snapshot
 *   - Is a frozen object that cannot be mutated
 *   - All helpers are pure functions with no side effects
 */

import { describe, it, expect } from 'vitest';
import { createRuleHostHelpers } from '../../src/core/rule-host-helpers.js';
import type { RuleHostInput } from '../../src/core/rule-host-types.js';

function makeInput(overrides?: Partial<RuleHostInput>): RuleHostInput {
  return {
    action: {
      toolName: 'write',
      normalizedPath: 'src/test.ts',
      paramsSummary: {},
    },
    workspace: {
      isRiskPath: false,
      planStatus: 'NONE',
      hasPlanFile: false,
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
      workspace: { isRiskPath: true, planStatus: 'READY', hasPlanFile: true },
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

  it('should return correct hasPlanFile from input snapshot', () => {
    const helpers = createRuleHostHelpers(makeInput({
      workspace: { isRiskPath: false, planStatus: 'READY', hasPlanFile: true },
    }));
    expect(helpers.hasPlanFile()).toBe(true);
  });

  it('should return correct planStatus from input snapshot', () => {
    const helpers = createRuleHostHelpers(makeInput({
      workspace: { isRiskPath: false, planStatus: 'DRAFT', hasPlanFile: true },
    }));
    expect(helpers.getPlanStatus()).toBe('DRAFT');
  });

  it('should return correct epTier from input snapshot', () => {
    const helpers = createRuleHostHelpers(makeInput({
      evolution: { epTier: 4 },
    }));
    expect(helpers.getCurrentEpiTier()).toBe(4);
  });

  it('all helpers should be pure functions with no side effects', () => {
    const input = makeInput();
    const helpers = createRuleHostHelpers(input);

    // Call each helper multiple times — should always return the same value
    expect(helpers.isRiskPath()).toBe(helpers.isRiskPath());
    expect(helpers.getToolName()).toBe(helpers.getToolName());
    expect(helpers.getEstimatedLineChanges()).toBe(helpers.getEstimatedLineChanges());
    expect(helpers.getBashRisk()).toBe(helpers.getBashRisk());
    expect(helpers.hasPlanFile()).toBe(helpers.hasPlanFile());
    expect(helpers.getPlanStatus()).toBe(helpers.getPlanStatus());
    expect(helpers.getCurrentEpiTier()).toBe(helpers.getCurrentEpiTier());
  });
});
