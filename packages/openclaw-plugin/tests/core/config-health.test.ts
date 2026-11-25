import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import * as os from 'os';
import {
  checkConversationAccessConfig,
  getPluginEntry,
  ensureConversationAccessInConfig,
  isExplicitConversationAccessOptOut,
  shouldBlockOpenClawConversationReads,
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

  describe('isExplicitConversationAccessOptOut', () => {
    it('returns true only for an explicit hooks.allowConversationAccess === false', () => {
      expect(isExplicitConversationAccessOptOut({ hooks: { allowConversationAccess: false } })).toBe(true);
      expect(isExplicitConversationAccessOptOut({ hooks: { allowConversationAccess: true } })).toBe(false);
      expect(isExplicitConversationAccessOptOut({ hooks: {} })).toBe(false);
      expect(isExplicitConversationAccessOptOut({ enabled: true })).toBe(false);
      expect(isExplicitConversationAccessOptOut({ hooks: 'garbage' })).toBe(false);
      expect(isExplicitConversationAccessOptOut(null)).toBe(false);
      expect(isExplicitConversationAccessOptOut('string')).toBe(false);
      expect(isExplicitConversationAccessOptOut([])).toBe(false);
    });
  });
});

describe('shouldBlockOpenClawConversationReads', () => {
  const testRoot = join('/tmp', 'pd-test-openclaw-config-' + Date.now());
  const defaultDir = join(testRoot, 'default-home', '.openclaw');
  const customDir = join(testRoot, 'custom-state');
  const defaultPath = join(defaultDir, 'openclaw.json');
  const customPath = join(customDir, 'openclaw.json');
  const customFilePath = join(testRoot, 'explicit-config.json');
  const envKeys = ['OPENCLAW_CONFIG_PATH', 'OPENCLAW_STATE_DIR', 'HOME', 'USERPROFILE'] as const;
  let savedEnv: Record<string, string | undefined> = {};

  function writeConfig(filePath: string, allow: boolean): void {
    writeFileSync(filePath, JSON.stringify({ plugins: { entries: { 'principles-disciple': { hooks: { allowConversationAccess: allow } } } } }), 'utf8');
  }

  beforeEach(() => {
    savedEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
    for (const key of envKeys) delete process.env[key];
    process.env.HOME = join(testRoot, 'default-home');
    mkdirSync(defaultDir, { recursive: true });
    mkdirSync(customDir, { recursive: true });
  });

  afterEach(() => {
    for (const key of envKeys) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
    rmSync(testRoot, { recursive: true, force: true });
  });

  it('allows only explicit allowConversationAccess=true in the default effective config', () => {
    writeConfig(defaultPath, true);
    expect(shouldBlockOpenClawConversationReads()).toBe(false);
    writeConfig(defaultPath, false);
    expect(shouldBlockOpenClawConversationReads()).toBe(true);
  });

  it('custom config wins over the default config in BOTH directions', () => {
    process.env.OPENCLAW_STATE_DIR = customDir;
    writeConfig(defaultPath, true);
    writeConfig(customPath, false);
    expect(shouldBlockOpenClawConversationReads()).toBe(true);
    writeConfig(defaultPath, false);
    writeConfig(customPath, true);
    expect(shouldBlockOpenClawConversationReads()).toBe(false);
  });

  it('OPENCLAW_CONFIG_PATH wins over OPENCLAW_STATE_DIR', () => {
    process.env.OPENCLAW_STATE_DIR = customDir;
    process.env.OPENCLAW_CONFIG_PATH = customFilePath;
    writeConfig(customPath, false);
    writeConfig(customFilePath, true);
    expect(shouldBlockOpenClawConversationReads()).toBe(false);
  });

  it('missing, damaged, or indeterminate effective config fails closed', () => {
    rmSync(defaultPath, { force: true });
    expect(shouldBlockOpenClawConversationReads()).toBe(true);
    writeFileSync(defaultPath, '{broken', 'utf8');
    expect(shouldBlockOpenClawConversationReads()).toBe(true);
    writeFileSync(defaultPath, JSON.stringify({ plugins: { entries: { 'principles-disciple': { hooks: {} } } } }), 'utf8');
    expect(shouldBlockOpenClawConversationReads()).toBe(true);
  });

  it('relative override paths fail closed instead of falling back to the default config', () => {
    writeConfig(defaultPath, true);
    process.env.OPENCLAW_STATE_DIR = 'relative-state';
    expect(shouldBlockOpenClawConversationReads()).toBe(true);
    delete process.env.OPENCLAW_STATE_DIR;
    process.env.OPENCLAW_CONFIG_PATH = 'relative-openclaw.json';
    expect(shouldBlockOpenClawConversationReads()).toBe(true);
  });

  it('revocation is visible on the immediately following check', () => {
    writeConfig(defaultPath, true);
    expect(shouldBlockOpenClawConversationReads()).toBe(false);
    writeConfig(defaultPath, false);
    expect(shouldBlockOpenClawConversationReads()).toBe(true);
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

  // Audit finding openclaw-plugin:conversation-access-autofix-overrides-explicit-owner-opt-out:
  // an explicit `false` is the Owner's documented turn-off
  // (`openclaw config set ... hooks.allowConversationAccess false`). The
  // auto-fix repairs only an ABSENT flag — it must never rewrite an explicit
  // deny, and the deny must survive gateway restarts.
  it('preserves an explicit allowConversationAccess=false opt-out untouched', () => {
    const cfg = {
      someTopLevelSetting: 'value',
      plugins: {
        entries: {
          'principles-disciple': {
            enabled: true,
            hooks: { allowConversationAccess: false },
          },
        },
      },
    };
    writeFileSync(configPath, JSON.stringify(cfg, null, 2), 'utf8');
    const before = readFileSync(configPath, 'utf8');

    const result = ensureConversationAccessInConfig();

    expect(result).toBe(false);
    expect(readFileSync(configPath, 'utf8')).toBe(before);
    const updated = JSON.parse(readFileSync(configPath, 'utf8'));
    expect(updated.plugins.entries['principles-disciple'].hooks.allowConversationAccess).toBe(false);
    expect(updated.someTopLevelSetting).toBe('value');
  });

  it('sets the flag to true when the hooks object exists but the key is absent', () => {
    const cfg = {
      plugins: {
        entries: {
          'principles-disciple': {
            enabled: true,
            hooks: { somethingElse: true },
          },
        },
      },
    };
    writeFileSync(configPath, JSON.stringify(cfg), 'utf8');
    const result = ensureConversationAccessInConfig();
    expect(result).toBe(true);
    const updated = JSON.parse(readFileSync(configPath, 'utf8'));
    expect(updated.plugins.entries['principles-disciple'].hooks.allowConversationAccess).toBe(true);
    expect(updated.plugins.entries['principles-disciple'].hooks.somethingElse).toBe(true);
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
