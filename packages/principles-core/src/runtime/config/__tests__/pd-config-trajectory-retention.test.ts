/**
 * PD Config trajectoryRetention-section tests — SPEC-PD-TR-001.
 *
 * The validator owns SHAPE only (types + closed key set). Range policy is
 * deliberately left to `resolveTrajectoryRetentionPolicy` so a well-typed but
 * dangerous value degrades the sweep instead of invalidating the whole config
 * (which would silently reset every other section to defaults).
 *
 * These cases exist because a typo here is the difference between "retention
 * degrades loudly" and "retention never runs again" (F3).
 */

import { describe, it, expect } from 'vitest';
import { validatePdConfig } from '../index.js';

function makeValidRawConfig(): Record<string, unknown> {
  return {
    version: 1,
    features: {
      prompt: { category: 'core', enabled: true },
      code_tool_hook: { category: 'core', enabled: true },
      defer_archive: { category: 'core', enabled: true },
    },
    runtimeProfiles: {
      'openclaw.default': { type: 'openclaw', source: 'default' },
    },
    internalAgents: {
      defaultRuntime: 'openclaw.default',
      agents: {
        diagnostician: { enabled: true },
        dreamer: { enabled: true },
        scribe: { enabled: true },
        artificer: { enabled: true },
        philosopher: { enabled: false },
        evaluator: { enabled: false },
        rolloutReviewer: { enabled: false },
        correctionObserver: { enabled: false },
      },
    },
  };
}

function withRetention(section: unknown): Record<string, unknown> {
  return { ...makeValidRawConfig(), trajectoryRetention: section };
}

describe('validatePdConfig: trajectoryRetention section (SPEC-PD-TR-001)', () => {
  it('preserves a fully specified valid section', () => {
    const result = validatePdConfig(withRetention({
      enabled: true,
      retentionDays: 90,
      intervalHours: 6,
      batchSize: 2000,
      runBudgetMs: 3000,
    }));

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.trajectoryRetention).toEqual({
        enabled: true,
        retentionDays: 90,
        intervalHours: 6,
        batchSize: 2000,
        runBudgetMs: 3000,
      });
    }
  });

  it('accepts a partial section and omits the keys that were not declared', () => {
    const result = validatePdConfig(withRetention({ retentionDays: 30 }));

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.trajectoryRetention).toEqual({ retentionDays: 30 });
    }
  });

  it('rejects a non-object section loudly', () => {
    const result = validatePdConfig(withRetention('ninety days'));

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((error) => error.path === 'trajectoryRetention')).toBe(true);
    }
  });

  it('rejects an unknown key instead of ignoring it', () => {
    const result = validatePdConfig(withRetention({ retentionDay: 90 }));

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((error) => error.path === 'trajectoryRetention.retentionDay')).toBe(true);
    }
  });

  it('rejects a non-boolean enabled', () => {
    const result = validatePdConfig(withRetention({ enabled: 'yes' }));

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((error) => error.path === 'trajectoryRetention.enabled')).toBe(true);
    }
  });

  it('rejects non-integer numeric fields', () => {
    const result = validatePdConfig(withRetention({
      retentionDays: '90',
      intervalHours: 6.5,
      batchSize: null,
      runBudgetMs: 3000,
    }));

    expect(result.ok).toBe(false);
    if (!result.ok) {
      const paths = result.errors.map((error) => error.path);
      expect(paths).toContain('trajectoryRetention.retentionDays');
      expect(paths).toContain('trajectoryRetention.intervalHours');
      expect(paths).toContain('trajectoryRetention.batchSize');
      // A valid sibling must not be reported.
      expect(paths).not.toContain('trajectoryRetention.runBudgetMs');
    }
  });

  it('drops the whole section when any key is invalid (no half-applied config)', () => {
    const result = validatePdConfig(withRetention({ retentionDays: 90, intervalHours: '6' }));

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((error) => error.path === 'trajectoryRetention.intervalHours')).toBe(true);
    }
  });

  it('leaves the section undefined when it is absent', () => {
    const result = validatePdConfig(makeValidRawConfig());

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.trajectoryRetention).toBeUndefined();
    }
  });
});
