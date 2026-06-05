import { describe, it, expect } from 'vitest';
import {
  getReadinessBadgeVariant,
  getReadinessLabel,
  redactDiagnosticsForCopy,
  computeOverallReadiness,
  groupAgentsByReadiness,
  type ControlCenterDiagnostics,
} from '../../src/ui/utils/control-center-helpers.js';

// ── Fixtures ─────────────────────────────────────────────────────────────────

const sampleDiagnostics: ControlCenterDiagnostics = {
  version: 1,
  source: 'defaults',
  features: [
    { id: 'prompt', category: 'core', enabled: true },
    { id: 'defer_archive', category: 'core', enabled: true },
    { id: 'code_tool_hook', category: 'core', enabled: false },
  ],
  runtimeProfiles: [
    { id: 'default', type: 'openclaw', label: 'openclaw: default', readiness: 'ready' },
    { id: 'lmstudio', type: 'openclaw', label: 'openclaw: lmstudio/qwen3', readiness: 'needs_setup' },
    { id: 'pi-ai-gpt4', type: 'pi-ai', label: 'pi-ai: openai/gpt-4', apiKeyEnv: 'OPENAI_API_KEY', readiness: 'ready' },
  ],
  defaultRuntime: 'default',
  agents: [
    { name: 'diagnostician', enabled: true, runtimeProfileId: 'default', runtimeProfileLabel: 'openclaw: default', readiness: 'ready' },
    { name: 'dreamer', enabled: true, runtimeProfileId: 'lmstudio', runtimeProfileLabel: 'openclaw: lmstudio/qwen3', readiness: 'needs_setup' },
    { name: 'philosopher', enabled: false, runtimeProfileId: 'default', runtimeProfileLabel: 'openclaw: default', readiness: 'disabled' },
    { name: 'scribe', enabled: true, runtimeProfileId: 'missing-profile', runtimeProfileLabel: 'unknown:missing-profile', readiness: 'not_ready' },
  ],
  ui: { diagnostics: { mode: 'simple' } },
  warnings: [],
};

// ── getReadinessBadgeVariant ─────────────────────────────────────────────────

describe('getReadinessBadgeVariant', () => {
  it('returns "default" for ready', () => {
    expect(getReadinessBadgeVariant('ready')).toBe('default');
  });

  it('returns "secondary" for needs_setup', () => {
    expect(getReadinessBadgeVariant('needs_setup')).toBe('secondary');
  });

  it('returns "outline" for disabled', () => {
    expect(getReadinessBadgeVariant('disabled')).toBe('outline');
  });

  it('returns "destructive" for not_ready', () => {
    expect(getReadinessBadgeVariant('not_ready')).toBe('destructive');
  });

  it('returns "secondary" for unknown', () => {
    expect(getReadinessBadgeVariant('unknown')).toBe('secondary');
  });
});

// ── getReadinessLabel ────────────────────────────────────────────────────────

describe('getReadinessLabel', () => {
  it('returns human-readable labels for each status', () => {
    expect(getReadinessLabel('ready')).toBe('Ready');
    expect(getReadinessLabel('needs_setup')).toBe('Needs Setup');
    expect(getReadinessLabel('disabled')).toBe('Disabled');
    expect(getReadinessLabel('not_ready')).toBe('Not Ready');
    expect(getReadinessLabel('unknown')).toBe('Unknown');
  });
});

// ── computeOverallReadiness ──────────────────────────────────────────────────

describe('computeOverallReadiness', () => {
  it('returns "ready" when all enabled agents are ready', () => {
    const diag: ControlCenterDiagnostics = {
      ...sampleDiagnostics,
      agents: [
        { name: 'diagnostician', enabled: true, runtimeProfileId: 'default', runtimeProfileLabel: 'openclaw: default', readiness: 'ready' },
        { name: 'dreamer', enabled: true, runtimeProfileId: 'default', runtimeProfileLabel: 'openclaw: default', readiness: 'ready' },
        { name: 'philosopher', enabled: false, runtimeProfileId: 'default', runtimeProfileLabel: 'openclaw: default', readiness: 'disabled' },
      ],
    };
    expect(computeOverallReadiness(diag)).toBe('ready');
  });

  it('returns "needs_setup" when any enabled agent needs setup', () => {
    const diag: ControlCenterDiagnostics = {
      ...sampleDiagnostics,
      agents: [
        { name: 'diagnostician', enabled: true, runtimeProfileId: 'default', runtimeProfileLabel: 'openclaw: default', readiness: 'ready' },
        { name: 'dreamer', enabled: true, runtimeProfileId: 'lmstudio', runtimeProfileLabel: 'openclaw: lmstudio/qwen3', readiness: 'needs_setup' },
        { name: 'philosopher', enabled: false, runtimeProfileId: 'default', runtimeProfileLabel: 'openclaw: default', readiness: 'disabled' },
      ],
    };
    expect(computeOverallReadiness(diag)).toBe('needs_setup');
  });

  it('returns "not_ready" when any enabled agent is not_ready and none need setup', () => {
    const diag: ControlCenterDiagnostics = {
      ...sampleDiagnostics,
      agents: [
        { name: 'diagnostician', enabled: true, runtimeProfileId: 'default', runtimeProfileLabel: 'openclaw: default', readiness: 'ready' },
        { name: 'scribe', enabled: true, runtimeProfileId: 'missing', runtimeProfileLabel: 'unknown:missing', readiness: 'not_ready' },
        { name: 'philosopher', enabled: false, runtimeProfileId: 'default', runtimeProfileLabel: 'openclaw: default', readiness: 'disabled' },
      ],
    };
    expect(computeOverallReadiness(diag)).toBe('not_ready');
  });

  it('returns "disabled" when all agents are disabled', () => {
    const diag: ControlCenterDiagnostics = {
      ...sampleDiagnostics,
      agents: [
        { name: 'diagnostician', enabled: false, runtimeProfileId: 'default', runtimeProfileLabel: 'openclaw: default', readiness: 'disabled' },
        { name: 'dreamer', enabled: false, runtimeProfileId: 'default', runtimeProfileLabel: 'openclaw: default', readiness: 'disabled' },
      ],
    };
    expect(computeOverallReadiness(diag)).toBe('disabled');
  });

  it('returns "unknown" when agents list is empty', () => {
    const diag: ControlCenterDiagnostics = {
      ...sampleDiagnostics,
      agents: [],
    };
    expect(computeOverallReadiness(diag)).toBe('unknown');
  });
});

// ── groupAgentsByReadiness ───────────────────────────────────────────────────

describe('groupAgentsByReadiness', () => {
  it('groups agents by readiness status', () => {
    const groups = groupAgentsByReadiness(sampleDiagnostics);
    expect(groups.ready).toHaveLength(1);
    expect(groups.ready[0].name).toBe('diagnostician');
    expect(groups.needs_setup).toHaveLength(1);
    expect(groups.needs_setup[0].name).toBe('dreamer');
    expect(groups.disabled).toHaveLength(1);
    expect(groups.disabled[0].name).toBe('philosopher');
    expect(groups.not_ready).toHaveLength(1);
    expect(groups.not_ready[0].name).toBe('scribe');
    expect(groups.unknown).toHaveLength(0);
  });
});

// ── redactDiagnosticsForCopy ─────────────────────────────────────────────────

describe('redactDiagnosticsForCopy', () => {
  it('produces a string suitable for clipboard', () => {
    const result = redactDiagnosticsForCopy(sampleDiagnostics);
    expect(typeof result).toBe('string');
    expect(result).toContain('PD Control Center Diagnostics');
    expect(result).toContain('Overall Status: Not Ready');
  });

  it('redacts apiKeyEnv values — never shows the env var name in copy output', () => {
    const result = redactDiagnosticsForCopy(sampleDiagnostics);
    // apiKeyEnv field should be redacted — the key name itself is sensitive
    expect(result).not.toContain('OPENAI_API_KEY');
    // But the profile label (safe) should be present
    expect(result).toContain('pi-ai: openai/gpt-4');
  });

  it('never includes raw token or secret values', () => {
    const result = redactDiagnosticsForCopy(sampleDiagnostics);
    // Should not contain common secret patterns
    expect(result).not.toMatch(/sk-[a-zA-Z0-9]+/);
    expect(result).not.toMatch(/api[_-]?key\s*[:=]/i);
    expect(result).not.toMatch(/token\s*[:=]/i);
  });

  it('includes agent readiness details', () => {
    const result = redactDiagnosticsForCopy(sampleDiagnostics);
    expect(result).toContain('diagnostician');
    expect(result).toContain('dreamer');
    expect(result).toContain('Ready');
    expect(result).toContain('Needs Setup');
  });

  it('includes feature flags summary', () => {
    const result = redactDiagnosticsForCopy(sampleDiagnostics);
    expect(result).toContain('Features');
    expect(result).toContain('prompt');
    expect(result).toContain('core');
  });

  it('includes warnings when present', () => {
    const diag: ControlCenterDiagnostics = {
      ...sampleDiagnostics,
      warnings: ['Config file uses deprecated format'],
    };
    const result = redactDiagnosticsForCopy(diag);
    expect(result).toContain('Warnings');
    expect(result).toContain('deprecated format');
  });

  it('includes errors when present', () => {
    const diag: ControlCenterDiagnostics = {
      ...sampleDiagnostics,
      errors: [{ path: 'runtimeProfiles.lmstudio', reason: 'Missing provider', nextAction: 'Add provider field' }],
    };
    const result = redactDiagnosticsForCopy(diag);
    expect(result).toContain('Errors');
    expect(result).toContain('Missing provider');
  });

  it('truncates sections exceeding MAX_ITEMS_PER_SECTION', () => {
    // Create diagnostics with 60 features (exceeds limit of 50)
    const manyFeatures = Array.from({ length: 60 }, (_, i) => ({
      id: `feature-${i}`,
      category: 'core',
      enabled: true,
    }));
    const diag: ControlCenterDiagnostics = {
      ...sampleDiagnostics,
      features: manyFeatures,
    };
    const result = redactDiagnosticsForCopy(diag);
    // Should show first 50 items and a truncation notice
    expect(result).toContain('feature-0');
    expect(result).toContain('feature-49');
    expect(result).not.toContain('feature-50');
    expect(result).toContain('+10 more');
  });

  // ── Additional edge cases for diagnostics truncation ──────────────────────────

  it('truncates runtime profiles exceeding MAX_ITEMS_PER_SECTION', () => {
    // Create diagnostics with 60 runtime profiles (exceeds limit of 50)
    const manyProfiles = Array.from({ length: 60 }, (_, i) => ({
      id: `profile-${i}`,
      type: 'openclaw',
      label: `openclaw: profile-${i}`,
      readiness: 'ready' as const,
    }));
    const diag: ControlCenterDiagnostics = {
      ...sampleDiagnostics,
      runtimeProfiles: manyProfiles,
    };
    const result = redactDiagnosticsForCopy(diag);
    expect(result).toContain('profile-0');
    expect(result).toContain('profile-49');
    expect(result).not.toContain('profile-50');
    expect(result).toContain('+10 more');
  });

  it('truncates agents exceeding MAX_ITEMS_PER_SECTION', () => {
    // Create diagnostics with 60 agents (exceeds limit of 50)
    const manyAgents = Array.from({ length: 60 }, (_, i) => ({
      name: `agent-${i}`,
      enabled: true,
      runtimeProfileId: 'default',
      runtimeProfileLabel: 'openclaw: default',
      readiness: 'ready' as const,
    }));
    const diag: ControlCenterDiagnostics = {
      ...sampleDiagnostics,
      agents: manyAgents,
    };
    const result = redactDiagnosticsForCopy(diag);
    expect(result).toContain('agent-0');
    expect(result).toContain('agent-49');
    expect(result).not.toContain('agent-50');
    expect(result).toContain('+10 more');
  });

  it('truncates warnings exceeding MAX_ITEMS_PER_SECTION', () => {
    // Create diagnostics with 60 warnings (exceeds limit of 50)
    const manyWarnings = Array.from({ length: 60 }, (_, i) => `Warning ${i}`);
    const diag: ControlCenterDiagnostics = {
      ...sampleDiagnostics,
      warnings: manyWarnings,
    };
    const result = redactDiagnosticsForCopy(diag);
    expect(result).toContain('Warning 0');
    expect(result).toContain('Warning 49');
    expect(result).not.toContain('Warning 50');
    expect(result).toContain('+10 more');
  });

  it('truncates errors exceeding MAX_ITEMS_PER_SECTION', () => {
    // Create diagnostics with 60 errors (exceeds limit of 50)
    const manyErrors = Array.from({ length: 60 }, (_, i) => ({
      path: `path-${i}`,
      reason: `Error ${i}`,
      nextAction: `Fix error ${i}`,
    }));
    const diag: ControlCenterDiagnostics = {
      ...sampleDiagnostics,
      errors: manyErrors,
    };
    const result = redactDiagnosticsForCopy(diag);
    expect(result).toContain('path-0');
    expect(result).toContain('path-49');
    expect(result).not.toContain('path-50');
    expect(result).toContain('+10 more');
  });

  it('handles exactly MAX_ITEMS_PER_SECTION items without truncation', () => {
    // Create diagnostics with exactly 50 features (at limit)
    const exactFeatures = Array.from({ length: 50 }, (_, i) => ({
      id: `feature-${i}`,
      category: 'core',
      enabled: true,
    }));
    const diag: ControlCenterDiagnostics = {
      ...sampleDiagnostics,
      features: exactFeatures,
    };
    const result = redactDiagnosticsForCopy(diag);
    expect(result).toContain('feature-0');
    expect(result).toContain('feature-49');
    expect(result).not.toContain('+');
    expect(result).not.toContain('more');
  });
});
