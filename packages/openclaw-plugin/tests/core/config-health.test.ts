import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import * as os from 'os';
import {
  checkConversationAccessConfig,
  getPluginEntry,
  ensureConversationAccessInConfig,
} from '../../src/core/config-health.js';

vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os');
  return {
    ...actual,
    homedir: vi.fn(),
  };
});

describe('config-health', () => {
  describe('checkConversationAccessConfig', () => {
    it('returns authorized when hooks.allowConversationAccess is true', () => {
      const result = checkConversationAccessConfig({
        hooks: { allowConversationAccess: true },
      });
      expect(result.authorized).toBe(true);
    });

    it('returns unauthorized when pluginConfig is null', () => {
      const result = checkConversationAccessConfig(null);
      expect(result.authorized).toBe(false);
      expect(result.reason).toContain('missing or invalid');
    });

    it('returns unauthorized when hooks is missing', () => {
      const result = checkConversationAccessConfig({});
      expect(result.authorized).toBe(false);
      expect(result.reason).toContain('allowConversationAccess');
    });

    it('returns unauthorized when allowConversationAccess is false', () => {
      const result = checkConversationAccessConfig({
        hooks: { allowConversationAccess: false },
      });
      expect(result.authorized).toBe(false);
    });

    it('returns unauthorized when hooks is an array', () => {
      const result = checkConversationAccessConfig({
        hooks: [],
      });
      expect(result.authorized).toBe(false);
    });
  });

  describe('getPluginEntry', () => {
    it('returns the plugin entry when it exists', () => {
      const config = {
        plugins: {
          entries: {
            'principles-disciple': { enabled: true, hooks: {} },
          },
        },
      };
      const entry = getPluginEntry(config, 'principles-disciple');
      expect(entry).toEqual({ enabled: true, hooks: {} });
    });

    it('returns undefined when config is invalid', () => {
      expect(getPluginEntry(null, 'test')).toBeUndefined();
      expect(getPluginEntry([], 'test')).toBeUndefined();
      expect(getPluginEntry('string', 'test')).toBeUndefined();
    });

    it('returns undefined when plugins.entries path is missing', () => {
      expect(getPluginEntry({}, 'test')).toBeUndefined();
      expect(getPluginEntry({ plugins: {} }, 'test')).toBeUndefined();
      expect(getPluginEntry({ plugins: { entries: {} } }, 'test')).toBeUndefined();
    });
  });
});

describe('ensureConversationAccessInConfig', () => {
  const testHome = join('/tmp', 'pd-test-config-health-' + Date.now());
  const configDir = join(testHome, '.openclaw');
  const configPath = join(configDir, 'openclaw.json');
  const lockPath = configPath + '.lock';

  beforeEach(() => {
    vi.mocked(os.homedir).mockReturnValue(testHome);
    mkdirSync(configDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(testHome, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  it('returns false when config file does not exist', () => {
    const result = ensureConversationAccessInConfig();
    expect(result).toBe(false);
  });

  it('returns false when config is valid JSON but not an object', () => {
    writeFileSync(configPath, '[]', 'utf8');
    const result = ensureConversationAccessInConfig();
    expect(result).toBe(false);
  });

  it('returns false when allowConversationAccess is already true', () => {
    const cfg = {
      plugins: {
        entries: {
          'principles-disciple': {
            hooks: { allowConversationAccess: true },
          },
        },
      },
    };
    writeFileSync(configPath, JSON.stringify(cfg), 'utf8');
    const result = ensureConversationAccessInConfig();
    expect(result).toBe(false);
  });

  it('sets allowConversationAccess to true when missing', () => {
    const cfg = {
      plugins: {
        entries: {
          'principles-disciple': { enabled: true },
        },
      },
    };
    writeFileSync(configPath, JSON.stringify(cfg), 'utf8');
    const result = ensureConversationAccessInConfig();
    expect(result).toBe(true);

    const updated = JSON.parse(readFileSync(configPath, 'utf8'));
    expect(updated.plugins.entries['principles-disciple'].hooks.allowConversationAccess).toBe(true);
  });

  it('creates plugins.entries path if missing', () => {
    writeFileSync(configPath, '{}', 'utf8');
    const result = ensureConversationAccessInConfig();
    expect(result).toBe(true);

    const updated = JSON.parse(readFileSync(configPath, 'utf8'));
    expect(updated.plugins.entries['principles-disciple'].hooks.allowConversationAccess).toBe(true);
  });

  it('creates plugin entry with enabled: true if missing', () => {
    const cfg = {
      plugins: {
        entries: {},
      },
    };
    writeFileSync(configPath, JSON.stringify(cfg), 'utf8');
    const result = ensureConversationAccessInConfig();
    expect(result).toBe(true);

    const updated = JSON.parse(readFileSync(configPath, 'utf8'));
    expect(updated.plugins.entries['principles-disciple'].enabled).toBe(true);
    expect(updated.plugins.entries['principles-disciple'].hooks.allowConversationAccess).toBe(true);
  });

  it('preserves other config fields when updating', () => {
    const cfg = {
      someTopLevelSetting: 'value',
      plugins: {
        entries: {
          'other-plugin': { enabled: true },
          'principles-disciple': { enabled: true, config: { language: 'zh' } },
        },
      },
    };
    writeFileSync(configPath, JSON.stringify(cfg), 'utf8');
    const result = ensureConversationAccessInConfig();
    expect(result).toBe(true);

    const updated = JSON.parse(readFileSync(configPath, 'utf8'));
    expect(updated.someTopLevelSetting).toBe('value');
    expect(updated.plugins.entries['other-plugin'].enabled).toBe(true);
    expect(updated.plugins.entries['principles-disciple'].config.language).toBe('zh');
    expect(updated.plugins.entries['principles-disciple'].hooks.allowConversationAccess).toBe(true);
  });

  it('cleans up lock file after successful write', () => {
    writeFileSync(configPath, '{}', 'utf8');
    ensureConversationAccessInConfig();
    expect(existsSync(lockPath)).toBe(false);
  });

  it('handles BOM in config file', () => {
    const cfg = { plugins: { entries: { 'principles-disciple': { enabled: true } } } };
    writeFileSync(configPath, '\uFEFF' + JSON.stringify(cfg), 'utf8');
    const result = ensureConversationAccessInConfig();
    expect(result).toBe(true);

    const updated = JSON.parse(readFileSync(configPath, 'utf8').replace(/^\uFEFF/, ''));
    expect(updated.plugins.entries['principles-disciple'].hooks.allowConversationAccess).toBe(true);
  });
});
