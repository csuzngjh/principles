/**
 * PRI-42: Core internalization contract export tests
 *
 * Verifies that @principles/core/runtime-v2 exports all RuleHost contracts
 * and that createRuleHostHelpers produces a frozen helper surface.
 */
import { describe, it, expect } from 'vitest';

describe('internalization contracts (PRI-42)', () => {
  describe('barrel exports', () => {
    const barrel = import('../index.js');

    const REQUIRED_EXPORTS = [
      'createRuleHostHelpers',
    ];

    for (const name of REQUIRED_EXPORTS) {
      it(`exports ${name}`, async () => {
        const mod = (await barrel) as Record<string, unknown>;
        expect(mod).toHaveProperty(name);
        expect(typeof mod[name]).toBe('function');
      }, 30_000);
    }

    const REQUIRED_TYPES = [
      'RuleHostInput',
      'RuleHostDecision',
      'RuleHostMeta',
      'RuleHostResult',
      'LoadedImplementation',
      'RuleHostHelpers',
    ];

    // Types are erased at runtime, so we verify the module compiles
    // and the barrel re-exports them (verified by typecheck).
    it(`barrel declares type exports: ${REQUIRED_TYPES.join(', ')}`, async () => {
      const { existsSync, readFileSync } = await import('node:fs');
      const { resolve } = await import('node:path');
      const indexPath = resolve(__dirname, '..', 'index.ts');
      expect(existsSync(indexPath)).toBe(true);
      const src = readFileSync(indexPath, 'utf-8');
      for (const typeName of REQUIRED_TYPES) {
        expect(src).toContain(typeName);
      }
    });
  });

  describe('createRuleHostHelpers', () => {
    it('returns a frozen object with all helper methods', async () => {
      const { createRuleHostHelpers } = await import('../internalization/rule-host-helpers.js');
      const input = {
        action: { toolName: 'write', normalizedPath: 'src/test.ts', paramsSummary: {} },
        workspace: { isRiskPath: true, planStatus: 'DRAFT' as const, hasPlanFile: true },
        session: { sessionId: 'test', currentGfi: 3, recentThinking: false },
        evolution: { epTier: 2 },
        derived: { estimatedLineChanges: 10, bashRisk: 'normal' as const },
      };

      const helpers = createRuleHostHelpers(input);

      expect(Object.isFrozen(helpers)).toBe(true);
      expect(helpers.isRiskPath()).toBe(true);
      expect(helpers.getToolName()).toBe('write');
      expect(helpers.getEstimatedLineChanges()).toBe(10);
      expect(helpers.getBashRisk()).toBe('normal');
      expect(helpers.hasPlanFile()).toBe(true);
      expect(helpers.getPlanStatus()).toBe('DRAFT');
      expect(helpers.getEpTier()).toBe(2);
    });

    it('helpers cannot be modified (frozen)', async () => {
      const { createRuleHostHelpers } = await import('../internalization/rule-host-helpers.js');
      const input = {
        action: { toolName: 'bash', normalizedPath: null, paramsSummary: {} },
        workspace: { isRiskPath: false, planStatus: 'NONE' as const, hasPlanFile: false },
        session: { currentGfi: 0, recentThinking: false },
        evolution: { epTier: 0 },
        derived: { estimatedLineChanges: 0, bashRisk: 'unknown' as const },
      };

      const helpers = createRuleHostHelpers(input);

      expect(() => {
        (helpers as unknown as Record<string, unknown>).isRiskPath = () => true;
      }).toThrow();
    });
  });
});
