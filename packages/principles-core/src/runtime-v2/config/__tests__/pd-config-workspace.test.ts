/**
 * Workspace config validation tests.
 *
 * Tests the WorkspaceConfig type validation in validatePdConfig:
 * - Accepts valid workspace.default with absolute paths (Windows + POSIX)
 * - Rejects relative paths, empty strings, non-string values
 * - Optional — configs without workspace section still validate
 */
import { describe, it, expect } from 'vitest';
import {
  validatePdConfig,
  computeEffectivePdConfig,
  getDefaultPdConfig,
  PD_CONFIG_VERSION,
  INTERNAL_AGENT_NAMES,
} from '../index.js';

// ── Minimal valid config builder ─────────────────────────────────────────────

function makeValidConfig(workspace?: unknown): unknown {
  return {
    version: PD_CONFIG_VERSION,
    ...(workspace !== undefined ? { workspace } : {}),
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
      agents: Object.fromEntries(
        INTERNAL_AGENT_NAMES.map(name => [name, { enabled: name === 'diagnostician' || name === 'dreamer' || name === 'scribe' || name === 'artificer', runtimeProfile: 'openclaw.default' }]),
      ),
    },
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('validatePdConfig workspace field', () => {
  // 1. Config without workspace section is valid (optional)
  it('accepts config without workspace section', () => {
    const result = validatePdConfig(makeValidConfig());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.workspace).toBeUndefined();
    }
  });

  // 2. Valid workspace.default with POSIX absolute path
  it('accepts valid workspace.default with POSIX path', () => {
    const result = validatePdConfig(makeValidConfig({ default: '/home/user/.openclaw/workspace' }));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.workspace).toEqual({ default: '/home/user/.openclaw/workspace' });
    }
  });

  // 3. Valid workspace.default with Windows absolute path
  it('accepts valid workspace.default with Windows path', () => {
    const result = validatePdConfig(makeValidConfig({ default: 'D:\\.openclaw\\workspace' }));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.workspace).toEqual({ default: 'D:\\.openclaw\\workspace' });
    }
  });

  // 4. Valid workspace.default with Windows forward-slash path
  it('accepts valid workspace.default with Windows forward-slash path', () => {
    const result = validatePdConfig(makeValidConfig({ default: 'C:/.openclaw/workspace' }));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.workspace).toEqual({ default: 'C:/.openclaw/workspace' });
    }
  });

  // 5. Rejects relative path
  it('rejects relative path', () => {
    const result = validatePdConfig(makeValidConfig({ default: 'relative/path' }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const wsError = result.errors.find(e => e.path === 'workspace.default');
      expect(wsError).toBeDefined();
      expect(wsError?.reason).toContain('absolute path');
    }
  });

  // 6. Rejects empty string
  it('rejects empty string', () => {
    const result = validatePdConfig(makeValidConfig({ default: '' }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const wsError = result.errors.find(e => e.path === 'workspace.default');
      expect(wsError).toBeDefined();
    }
  });

  // 7. Rejects non-string value
  it('rejects non-string value', () => {
    const result = validatePdConfig(makeValidConfig({ default: 123 }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const wsError = result.errors.find(e => e.path === 'workspace.default');
      expect(wsError).toBeDefined();
    }
  });

  // 8. Rejects workspace object without default field
  it('rejects workspace object without default field', () => {
    const result = validatePdConfig(makeValidConfig({}));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const wsError = result.errors.find(e => e.path === 'workspace.default');
      expect(wsError).toBeDefined();
      expect(wsError?.reason).toContain('missing required field default');
    }
  });

  // 9. Rejects non-object workspace
  it('rejects non-object workspace value', () => {
    const result = validatePdConfig(makeValidConfig('not-an-object'));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const wsError = result.errors.find(e => e.path === 'workspace');
      expect(wsError).toBeDefined();
      expect(wsError?.reason).toContain('must be an object');
    }
  });

  // 10. Rejects unknown keys in workspace section
  it('rejects unknown keys in workspace section', () => {
    const result = validatePdConfig(makeValidConfig({ default: '/valid/path', extra: 'bad' }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const wsError = result.errors.find(e => e.path === 'workspace.extra');
      expect(wsError).toBeDefined();
      expect(wsError?.reason).toContain('unknown key');
    }
  });

  // 11. Rejects dangerous keys in workspace section
  // Note: __proto__ in object literals is not enumerable, so the dangerous key
  // check is for runtime configs where these keys might be present.
  // We test this by constructing the object via Object.create to bypass the
  // literal __proto__ special case.
  it('rejects dangerous keys in workspace section', () => {
    const wsObj = Object.create(null);
    wsObj.default = '/valid/path';
    wsObj.__proto__ = 'bad';
    const result = validatePdConfig(makeValidConfig(wsObj));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const wsError = result.errors.find(e => e.path === 'workspace.__proto__');
      expect(wsError).toBeDefined();
      expect(wsError?.reason).toContain('dangerous key');
    }
  });

  // 12. Workspace passes through effective config
  it('workspace passes through computeEffectivePdConfig', () => {
    const result = validatePdConfig(makeValidConfig({ default: '/home/user/workspace' }));
    expect(result.ok).toBe(true);
    if (result.ok) {
      const effective = computeEffectivePdConfig(result.value);
      expect(effective.config.workspace).toEqual({ default: '/home/user/workspace' });
    }
  });

  // 13. Workspace not in defaults
  it('workspace is not in default config', () => {
    const defaults = getDefaultPdConfig();
    expect(defaults.workspace).toBeUndefined();
  });
});
