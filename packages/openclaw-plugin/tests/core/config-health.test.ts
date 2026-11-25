import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { linkSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import * as os from 'os';
import {
  checkConversationAccessConfig,
  getPluginEntry,
  ensureConversationAccessInConfig,
  isExplicitConversationAccessOptOut,
  shouldBlockOpenClawConversationReads,
} from '../../src/core/config-health.js';
import { readOpenClawEffectiveConfig } from '../../src/core/openclaw-config-loader.js';

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

    it('manual repair guidance prefers direct editing and warns that CLI rewrite can drop JSON5 comments', () => {
    const result = checkConversationAccessConfig({ hooks: {} });
    expect(result.authorized).toBe(false);
    expect(result.nextAction).toContain('directly edit the active OpenClaw config file');
    expect(result.nextAction).toContain('preserves JSON5 comments/formatting');
    expect(result.nextAction).toContain('may remove comments');
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

  it('nonexistent relative override paths fail closed instead of falling back to the default config', () => {
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

describe('OpenClaw 2026.11.5 JSON5 and $include effective config compatibility', () => {
  const root = join('/tmp', 'pd-test-openclaw-json5-include-' + Date.now());
  const configPath = join(root, 'openclaw.json');
  const envKeys = ['OPENCLAW_CONFIG_PATH', 'OPENCLAW_STATE_DIR', 'OPENCLAW_HOME', 'OPENCLAW_PROFILE', 'OPENCLAW_INCLUDE_ROOTS'] as const;
  let savedEnv: Record<string, string | undefined> = {};

  function resetFiles(): void {
    rmSync(root, { recursive: true, force: true });
    mkdirSync(root, { recursive: true });
  }
  function write(name: string, text: string): void {
    writeFileSync(join(root, name), text, 'utf8');
  }
  function main(text: string): void {
    writeFileSync(configPath, text, 'utf8');
  }
  function pluginConfig(value: boolean | undefined): string {
    const hook = value === undefined ? '{}' : `{ allowConversationAccess: ${value} }`;
    return `{ entries: { 'principles-disciple': { hooks: ${hook} } } }`;
  }
  function sha(): string {
    return readFileSync(configPath, 'utf8');
  }

  beforeEach(() => {
    savedEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
    for (const key of envKeys) delete process.env[key];
    resetFiles();
    process.env.OPENCLAW_CONFIG_PATH = configPath;
  });

  afterEach(() => {
    for (const key of envKeys) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
    rmSync(root, { recursive: true, force: true });
  });

  it('parses JSON5 comments, unquoted keys and trailing commas', () => {
    main(`{
      // Owner-managed host config
      plugins: {
        entries: {
          'principles-disciple': { hooks: { allowConversationAccess: true, }, },
        },
      },
    }`);
    expect(shouldBlockOpenClawConversationReads()).toBe(false);
  });

  it('recognizes explicit false through a single include and never auto-repairs over it', () => {
    write('plugins.json5', pluginConfig(false));
    main(`{ plugins: { $include: './plugins.json5' } }`);
    const before = sha();
    expect(shouldBlockOpenClawConversationReads()).toBe(true);
    expect(ensureConversationAccessInConfig()).toBe(false);
    expect(sha()).toBe(before);
  });

  it('recognizes explicit true through a single include without a redundant write', () => {
    write('plugins.json5', pluginConfig(true));
    main(`{ plugins: { $include: './plugins.json5' } }`);
    const before = sha();
    expect(shouldBlockOpenClawConversationReads()).toBe(false);
    expect(ensureConversationAccessInConfig()).toBe(false);
    expect(sha()).toBe(before);
  });

  it('resolves nested includes relative to the including file', () => {
    mkdirSync(join(root, 'nested'), { recursive: true });
    write('nested/deep.json5', pluginConfig(false));
    write('nested/mid.json5', `{ entries: { 'principles-disciple': { hooks: { $include: './deep.json5' } } } }`);
    main(`{ plugins: { $include: './nested/mid.json5' } }`);
    // The nested include shape above targets hooks as an object, so use the
    // canonical nested object form for the effective boolean assertion.
    write('nested/deep.json5', `{ allowConversationAccess: false }`);
    expect(shouldBlockOpenClawConversationReads()).toBe(true);
    write('nested/deep.json5', `{ allowConversationAccess: true }`);
    expect(shouldBlockOpenClawConversationReads()).toBe(false);
  });

  it('merges multiple includes in order with later includes winning scalar conflicts', () => {
    write('first.json5', pluginConfig(true));
    write('second.json5', pluginConfig(false));
    main(`{ plugins: { $include: ['./first.json5', './second.json5'] } }`);
    expect(shouldBlockOpenClawConversationReads()).toBe(true);
    main(`{ plugins: { $include: ['./second.json5', './first.json5'] } }`);
    expect(shouldBlockOpenClawConversationReads()).toBe(false);
  });

  it('main-config sibling keys override included values according to OpenClaw merge order', () => {
    write('plugins.json5', pluginConfig(false));
    main(`{ plugins: {
      $include: './plugins.json5',
      entries: { 'principles-disciple': { hooks: { allowConversationAccess: true } } },
    } }`);
    expect(shouldBlockOpenClawConversationReads()).toBe(false);
  });

  it('main explicit false wins over included true and remains untouched', () => {
    write('plugins.json5', pluginConfig(true));
    main(`{ plugins: {
      $include: './plugins.json5',
      entries: { 'principles-disciple': { hooks: { allowConversationAccess: false } } },
    } }`);
    const before = sha();
    expect(shouldBlockOpenClawConversationReads()).toBe(true);
    expect(ensureConversationAccessInConfig()).toBe(false);
    expect(sha()).toBe(before);
  });


  it('concatenates arrays and deep-merges objects in the same order as OpenClaw includes', () => {
    write('base.json5', `{ entries: { 'principles-disciple': { hooks: { allowConversationAccess: false } } }, list: ['base'], nested: { a: 1, shared: 'base' } }`);
    write('override.json5', `{ entries: { 'principles-disciple': { hooks: { allowConversationAccess: true } } }, list: ['override'], nested: { b: 2, shared: 'override' } }`);
    main(`{ plugins: { $include: ['./base.json5', './override.json5'] } }`);
    const loaded = readOpenClawEffectiveConfig(configPath);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    const plugins = loaded.config.plugins as Record<string, unknown>;
    expect(plugins.list).toEqual(['base', 'override']);
    expect(plugins.nested).toEqual({ a: 1, b: 2, shared: 'override' });
    expect(shouldBlockOpenClawConversationReads()).toBe(false);
  });

  it('missing include fails closed and blocks automatic repair', () => {
    main(`{ plugins: { $include: './missing.json5' } }`);
    const before = sha();
    expect(shouldBlockOpenClawConversationReads()).toBe(true);
    expect(ensureConversationAccessInConfig()).toBe(false);
    expect(sha()).toBe(before);
  });

  it('malformed include fails closed and blocks automatic repair', () => {
    write('bad.json5', '{ entries: ');
    main(`{ plugins: { $include: './bad.json5' } }`);
    const before = sha();
    expect(shouldBlockOpenClawConversationReads()).toBe(true);
    expect(ensureConversationAccessInConfig()).toBe(false);
    expect(sha()).toBe(before);
  });

  it('circular includes fail closed and block automatic repair', () => {
    write('a.json5', `{ $include: './b.json5' }`);
    write('b.json5', `{ $include: './a.json5' }`);
    main(`{ plugins: { $include: './a.json5' } }`);
    const before = sha();
    expect(shouldBlockOpenClawConversationReads()).toBe(true);
    expect(ensureConversationAccessInConfig()).toBe(false);
    expect(sha()).toBe(before);
  });

  it('include escaping the config directory fails closed', () => {
    mkdirSync(join(root, 'inside'), { recursive: true });
    writeFileSync(join('/tmp', 'pd-outside-include.json5'), pluginConfig(true), 'utf8');
    main(`{ plugins: { $include: '../pd-outside-include.json5' } }`);
    expect(shouldBlockOpenClawConversationReads()).toBe(true);
    rmSync(join('/tmp', 'pd-outside-include.json5'), { force: true });
  });

  it('invalid include values and excessive nesting fail closed', () => {
    main(`{ plugins: { $include: 42 } }`);
    expect(shouldBlockOpenClawConversationReads()).toBe(true);
    // Build real files: chain0 includes chain1 ... chain11 includes chain0.
    for (let i = 0; i < 12; i += 1) write(`chain${i}.json5`, `{ $include: './chain${(i + 1) % 12}.json5' }`);
    main(`{ plugins: { $include: './chain0.json5' } }`);
    expect(shouldBlockOpenClawConversationReads()).toBe(true);
  });


  it('unreadable effective config fails closed and performs no write', () => {
    if (process.platform === 'win32') return;
    writeFileSync(configPath, `{ plugins: ${pluginConfig(true)} }`, 'utf8');
    const before = sha();
    const { chmodSync } = require('node:fs') as typeof import('node:fs');
    chmodSync(configPath, 0o000);
    try {
      expect(shouldBlockOpenClawConversationReads()).toBe(true);
      expect(ensureConversationAccessInConfig()).toBe(false);
    } finally {
      chmodSync(configPath, 0o600);
    }
    expect(sha()).toBe(before);
  });

  it('an unrelated include branch does not block the normal absent-flag repair', () => {
    write('logging.json5', `{ level: 'debug' }`);
    main(JSON.stringify({
      logging: { $include: './logging.json5' },
      plugins: { entries: { 'principles-disciple': { enabled: true } } },
    }));
    expect(ensureConversationAccessInConfig()).toBe(true);
    expect(shouldBlockOpenClawConversationReads()).toBe(false);
  });

  it('accepts a symlinked include target inside an explicitly allowed root', () => {
    if (process.platform === 'win32') return;
    const shared = join(root, 'shared');
    mkdirSync(shared, { recursive: true });
    write('shared/plugins.json5', pluginConfig(true));
    const { symlinkSync } = require('node:fs') as typeof import('node:fs');
    symlinkSync(join(shared, 'plugins.json5'), join(root, 'linked-plugins.json5'));
    process.env.OPENCLAW_INCLUDE_ROOTS = shared;
    main(`{ plugins: { $include: './linked-plugins.json5' } }`);
    expect(shouldBlockOpenClawConversationReads()).toBe(false);
  });

  it('rejects a symlinked include target outside all allowed roots', () => {
    if (process.platform === 'win32') return;
    const outside = join('/tmp', 'pd-include-outside-' + process.pid + '.json5');
    writeFileSync(outside, pluginConfig(true), 'utf8');
    const { symlinkSync } = require('node:fs') as typeof import('node:fs');
    symlinkSync(outside, join(root, 'linked-outside.json5'));
    main(`{ plugins: { $include: './linked-outside.json5' } }`);
    expect(shouldBlockOpenClawConversationReads()).toBe(true);
    rmSync(outside, { force: true });
  });

  it('does not treat ordinary dotdot-prefixed filenames inside the root as traversal', () => {
    write('..plugins.json5', pluginConfig(true));
    main(`{ plugins: { $include: './..plugins.json5' } }`);
    expect(shouldBlockOpenClawConversationReads()).toBe(false);
  });

  it('repairs a direct plugin entry even when unrelated plugins.allow is include-backed', () => {
    write('allow.json5', `['other-plugin']`);
    main(JSON.stringify({
      plugins: {
        allow: { $include: './allow.json5' },
        entries: { 'principles-disciple': { enabled: true, hooks: {} } },
      },
    }));
    expect(ensureConversationAccessInConfig()).toBe(true);
    expect(shouldBlockOpenClawConversationReads()).toBe(false);
  });

  it('refuses startup repair through a config symlink and preserves the link', () => {
    if (process.platform === 'win32') return;
    const { symlinkSync, lstatSync } = require('node:fs') as typeof import('node:fs');
    write('allow.json5', `['other-plugin']`);
    write('managed.json', `{
      plugins: {
        allow: { $include: './allow.json5' },
        entries: { 'principles-disciple': { enabled: true, hooks: {} } },
      },
    }`);
    symlinkSync(join(root, 'managed.json'), configPath);
    const before = readFileSync(join(root, 'managed.json'), 'utf8');
    expect(ensureConversationAccessInConfig()).toBe(false);
    expect(lstatSync(configPath).isSymbolicLink()).toBe(true);
    expect(readFileSync(join(root, 'managed.json'), 'utf8')).toBe(before);
  });

  it('still refuses repair when the direct hooks parent is include-backed', () => {
    write('hooks.json5', `{ otherHook: true }`);
    main(`{
      plugins: { entries: { 'principles-disciple': {
        enabled: true,
        hooks: { $include: './hooks.json5' },
      } } },
    }`);
    const before = sha();
    expect(ensureConversationAccessInConfig()).toBe(false);
    expect(sha()).toBe(before);
  });

  it('does not auto-rewrite a JSON5-only main config because comments would be lost', () => {
    main(`{
      // Owner deployment notes must survive host configuration edits.
      plugins: {
        entries: {
          'principles-disciple': { enabled: true, hooks: {} },
        },
      },
    }`);
    const before = sha();
    expect(ensureConversationAccessInConfig()).toBe(false);
    expect(sha()).toBe(before);
    expect(sha()).toContain('Owner deployment notes');
  });

  it('rejects hardlinked include files and leaves config unchanged', () => {
    if (process.platform === 'win32') return;
    write('linked-source.json5', pluginConfig(true));
    linkSync(join(root, 'linked-source.json5'), join(root, 'linked-hardlink.json5'));
    main(`{ plugins: { $include: './linked-hardlink.json5' } }`);
    const before = sha();
    expect(shouldBlockOpenClawConversationReads()).toBe(true);
    expect(ensureConversationAccessInConfig()).toBe(false);
    expect(sha()).toBe(before);
  });

  it('rejects non-regular include targets before reading them', () => {
    mkdirSync(join(root, 'include-dir'), { recursive: true });
    main(`{ plugins: { $include: './include-dir' } }`);
    expect(shouldBlockOpenClawConversationReads()).toBe(true);
  });

  it('rejects oversized include files before reading them fully', () => {
    write('oversized.json5', `{ padding: '${'x'.repeat(2_097_153)}' }`);
    main(`{ plugins: { $include: './oversized.json5' } }`);
    expect(shouldBlockOpenClawConversationReads()).toBe(true);
  });

  it('missing flag without includes keeps the existing startup repair behavior', () => {
    main(JSON.stringify({ plugins: { entries: { 'principles-disciple': { enabled: true } } } }));
    expect(shouldBlockOpenClawConversationReads()).toBe(true);
    expect(ensureConversationAccessInConfig()).toBe(true);
    expect(shouldBlockOpenClawConversationReads()).toBe(false);
  });

  it('malformed main JSON5 fails closed and performs no write', () => {
    main('{ plugins: ');
    const before = sha();
    expect(shouldBlockOpenClawConversationReads()).toBe(true);
    expect(ensureConversationAccessInConfig()).toBe(false);
    expect(sha()).toBe(before);
  });
});


describe('config auto-fix file permissions', () => {
  it('preserves the original config mode across atomic replacement', () => {
    if (process.platform === 'win32') return;
    const root = join('/tmp', 'pd-config-mode-' + process.pid + '-' + Date.now());
    const dir = join(root, '.openclaw');
    const file = join(dir, 'openclaw.json');
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, JSON.stringify({ plugins: { entries: { 'principles-disciple': { enabled: true, hooks: {} } } } }), 'utf8');
    const { chmodSync, statSync } = require('node:fs') as typeof import('node:fs');
    chmodSync(file, 0o600);
    const saved = process.env.OPENCLAW_CONFIG_PATH;
    process.env.OPENCLAW_CONFIG_PATH = file;
    try {
      expect(ensureConversationAccessInConfig()).toBe(true);
      expect(statSync(file).mode & 0o777).toBe(0o600);
    } finally {
      if (saved === undefined) delete process.env.OPENCLAW_CONFIG_PATH;
      else process.env.OPENCLAW_CONFIG_PATH = saved;
      rmSync(root, { recursive: true, force: true });
    }
  });
});
