import { describe, it, expect } from 'vitest';
import {
  BUILTIN_PATTERNS,
  BUILTIN_PATTERN_MAP,
  getFallbackName,
  getFallbackDescription,
  getBuiltinBaselineScenarios,
  deriveThinkingScenarios,
} from '../thinking-models-policy.js';
import { CORE_PRINCIPLES, CORE_PRINCIPLE_IDS } from '../../core-principles/index.js';

describe('thinking-models-policy', () => {
  describe('BUILTIN_PATTERNS', () => {
    it('has exactly 10 entries (T-01..T-10)', () => {
      expect(BUILTIN_PATTERNS).toHaveLength(10);
      const ids = BUILTIN_PATTERNS.map(p => p.id).sort();
      expect(ids).toEqual([
        'T-01', 'T-02', 'T-03', 'T-04', 'T-05',
        'T-06', 'T-07', 'T-08', 'T-09', 'T-10',
      ]);
    });

    it('every entry has at least one pattern and at least one baselineScenario', () => {
      for (const entry of BUILTIN_PATTERNS) {
        expect(entry.patterns.length).toBeGreaterThan(0);
        expect(entry.baselineScenarios.length).toBeGreaterThan(0);
      }
    });

    it('BUILTIN_PATTERN_MAP mirrors BUILTIN_PATTERNS', () => {
      expect(BUILTIN_PATTERN_MAP.size).toBe(BUILTIN_PATTERNS.length);
      for (const entry of BUILTIN_PATTERNS) {
        expect(BUILTIN_PATTERN_MAP.get(entry.id)).toBe(entry);
      }
    });
  });

  describe('getFallbackName / getFallbackDescription', () => {
    it('returns name from CORE_PRINCIPLES for known id', () => {
      for (const principle of CORE_PRINCIPLES) {
        expect(getFallbackName(principle.id)).toBe(principle.name);
        expect(getFallbackDescription(principle.id)).toBe(principle.statement);
      }
    });

    it('returns the id itself for unknown id (no crash)', () => {
      expect(getFallbackName('T-UNKNOWN')).toBe('T-UNKNOWN');
      expect(getFallbackDescription('T-UNKNOWN')).toBe('');
    });

    it('covers every CORE_PRINCIPLE_ID', () => {
      for (const id of CORE_PRINCIPLE_IDS) {
        const name = getFallbackName(id);
        const desc = getFallbackDescription(id);
        expect(name).toBeTruthy();
        expect(desc).not.toBe('');
      }
    });
  });

  describe('getBuiltinBaselineScenarios', () => {
    it('returns baselineScenarios for known id', () => {
      expect(getBuiltinBaselineScenarios('T-01')).toEqual(['exploration', 'discovery']);
      expect(getBuiltinBaselineScenarios('T-08')).toEqual(['reflection', 'pain-response']);
    });

    it('returns empty array for unknown id', () => {
      expect(getBuiltinBaselineScenarios('T-UNKNOWN')).toEqual([]);
    });
  });

  describe('deriveThinkingScenarios', () => {
    it('includes baselineScenarios for the model id', () => {
      const result = deriveThinkingScenarios('T-01', {});
      expect(result).toContain('exploration');
      expect(result).toContain('discovery');
    });

    it('adds after-tool-failure when a tool call failed', () => {
      const result = deriveThinkingScenarios('T-01', {
        recentToolCalls: [
          { toolName: 'edit_file', outcome: 'failure', errorType: 'ENOENT' },
        ],
      });
      expect(result).toContain('after-tool-failure');
      expect(result).toContain('incident-response');
    });

    it('adds after-recovery only when both failure and success present', () => {
      const onlyFailure = deriveThinkingScenarios('T-01', {
        recentToolCalls: [{ toolName: 'x', outcome: 'failure' }],
      });
      const onlySuccess = deriveThinkingScenarios('T-01', {
        recentToolCalls: [{ toolName: 'x', outcome: 'success' }],
      });
      const both = deriveThinkingScenarios('T-01', {
        recentToolCalls: [
          { toolName: 'x', outcome: 'failure' },
          { toolName: 'y', outcome: 'success' },
        ],
      });
      expect(onlyFailure).not.toContain('after-recovery');
      expect(onlySuccess).not.toContain('after-recovery');
      expect(both).toContain('after-recovery');
    });

    it('adds blocked-execution when a tool call was blocked', () => {
      const result = deriveThinkingScenarios('T-01', {
        recentToolCalls: [{ toolName: 'rm', outcome: 'blocked' }],
      });
      expect(result).toContain('blocked-execution');
    });

    it('adds user-friction when pain events present', () => {
      const result = deriveThinkingScenarios('T-01', {
        recentPainEvents: [{ source: 'gate', score: 5 }],
      });
      expect(result).toContain('user-friction');
    });

    it('adds gate-block when gate blocks present', () => {
      const result = deriveThinkingScenarios('T-01', {
        recentGateBlocks: [{ toolName: 'rm', reason: 'unsafe' }],
      });
      expect(result).toContain('gate-block');
    });

    it('adds user-correction when user corrections present', () => {
      const result = deriveThinkingScenarios('T-01', {
        recentUserCorrections: [{ correctionCue: 'no, do X instead' }],
      });
      expect(result).toContain('user-correction');
    });

    it('adds principle-feedback when principle events present', () => {
      const result = deriveThinkingScenarios('T-01', {
        recentPrincipleEvents: [{ eventType: 'admitted', principleId: 'P-001' }],
      });
      expect(result).toContain('principle-feedback');
    });

    it('adds model-specific scenarios for T-03, T-04, T-05, T-08, T-09', () => {
      expect(deriveThinkingScenarios('T-03', {})).toContain('root-cause-analysis');
      expect(deriveThinkingScenarios('T-04', {})).toContain('risk-review');
      expect(deriveThinkingScenarios('T-05', {})).toContain('risk-review');
      expect(deriveThinkingScenarios('T-08', {})).toContain('reflection-loop');
      expect(deriveThinkingScenarios('T-09', {})).toContain('task-planning');
    });

    it('does not add model-specific scenarios for other models', () => {
      const t01 = deriveThinkingScenarios('T-01', {});
      expect(t01).not.toContain('root-cause-analysis');
      expect(t01).not.toContain('risk-review');
      expect(t01).not.toContain('reflection-loop');
      expect(t01).not.toContain('task-planning');
    });

    it('returns empty array for unknown model id with empty context', () => {
      const result = deriveThinkingScenarios('T-UNKNOWN', {});
      expect(result).toEqual([]);
    });

    it('handles null/undefined context fields safely', () => {
      const result = deriveThinkingScenarios('T-01', {
        recentToolCalls: undefined,
        recentPainEvents: undefined,
        recentGateBlocks: undefined,
        recentUserCorrections: undefined,
        recentPrincipleEvents: undefined,
      });
      // Only baselineScenarios should be present
      expect(result).toEqual(['exploration', 'discovery']);
    });
  });
});
