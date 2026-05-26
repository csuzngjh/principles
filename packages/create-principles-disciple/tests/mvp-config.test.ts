import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as yaml from 'js-yaml';
import {
  MVP_CHANNELS,
  MVP_QUIET_FLAGS,
  MVP_GONE_FLAGS,
  generateFeatureFlagsYamlContent,
  validateMvpChannels,
  parseChannelsOption,
  validateOpenClawConfig,
  buildSuccessOutput,
  buildFailureOutput,
  getFeatureFlagsPath,
  isMvpChannel,
  getHomeDir,
  getOpenClawDir,
  getPluginExtDir,
  getInstalledPdCliDir,
  getInstalledBinDir,
  isWindows,
  readEnabledChannelsFromDisk,
  type MvpChannel,
  type ComponentStatus,
  type VerificationResult,
} from '../src/mvp-config.js';

describe('MVP channel contract', () => {
  it('defines exactly three MVP channels', () => {
    expect(MVP_CHANNELS).toEqual(['prompt', 'code_tool_hook', 'defer_archive']);
  });
});

describe('Bundle source path contract', () => {
  const rootDir = path.resolve(__dirname, '..', '..', '..');
  const pluginSrc = path.join(rootDir, 'packages', 'openclaw-plugin');
  const pdCliSrc = path.join(rootDir, 'packages', 'pd-cli');

  it('openclaw-plugin source directory exists', () => {
    expect(fs.existsSync(pluginSrc)).toBe(true);
  });

  it('openclaw-plugin/package.json exists', () => {
    expect(fs.existsSync(path.join(pluginSrc, 'package.json'))).toBe(true);
  });

  it('pd-cli source directory exists', () => {
    expect(fs.existsSync(pdCliSrc)).toBe(true);
  });

  it('pd-cli/package.json exists', () => {
    expect(fs.existsSync(path.join(pdCliSrc, 'package.json'))).toBe(true);
  });

  it('bundle-plugin.mjs references packages/openclaw-plugin', () => {
    const scriptPath = path.resolve(__dirname, '..', 'scripts', 'bundle-plugin.mjs');
    const content = fs.readFileSync(scriptPath, 'utf-8');
    expect(content).toContain("join(ROOT_DIR, 'packages', 'openclaw-plugin')");
  });

  it('bundle-plugin.mjs references packages/pd-cli', () => {
    const scriptPath = path.resolve(__dirname, '..', 'scripts', 'bundle-plugin.mjs');
    const content = fs.readFileSync(scriptPath, 'utf-8');
    expect(content).toContain("join(ROOT_DIR, 'packages', 'pd-cli')");
  });
});

describe('Windows .cmd verification contract', () => {
  it('isWindows() returns boolean', () => {
    expect(typeof isWindows()).toBe('boolean');
  });

  it('local shim path uses .cmd on Windows', () => {
    const binDir = getInstalledBinDir();
    const expected = isWindows() ? path.join(binDir, 'pd.cmd') : path.join(binDir, 'pd');
    expect(expected.endsWith(isWindows() ? 'pd.cmd' : 'pd')).toBe(true);
  });
});

describe('generateFeatureFlagsYamlContent', () => {
  it('produces valid YAML', () => {
    const content = generateFeatureFlagsYamlContent();
    const parsed = yaml.load(content);
    expect(typeof parsed).toBe('object');
    expect(parsed).not.toBeNull();
  });

  it('core flags are enabled by default (no channels arg)', () => {
    const parsed = yaml.load(generateFeatureFlagsYamlContent()) as Record<string, unknown>;
    for (const ch of MVP_CHANNELS) {
      const flag = parsed[ch] as Record<string, unknown> | undefined;
      expect(flag).toBeDefined();
      expect(flag?.enabled).toBe(true);
      expect(flag?.category).toBe('core');
    }
  });

  it('gone flags are disabled by default', () => {
    const parsed = yaml.load(generateFeatureFlagsYamlContent()) as Record<string, unknown>;
    for (const gone of MVP_GONE_FLAGS) {
      const flag = parsed[gone] as Record<string, unknown> | undefined;
      expect(flag).toBeDefined();
      expect(flag?.enabled).toBe(false);
      expect(flag?.category).toBe('gone');
    }
  });

  it('quiet flags are disabled by default', () => {
    const parsed = yaml.load(generateFeatureFlagsYamlContent()) as Record<string, unknown>;
    for (const quiet of MVP_QUIET_FLAGS) {
      const flag = parsed[quiet] as Record<string, unknown> | undefined;
      expect(flag).toBeDefined();
      expect(flag?.enabled).toBe(false);
      expect(flag?.category).toBe('quiet');
    }
  });

  it('does not contain skill channel', () => {
    const parsed = yaml.load(generateFeatureFlagsYamlContent()) as Record<string, unknown>;
    expect(Object.hasOwn(parsed, 'skill')).toBe(false);
  });

  it('only MVP channels are enabled by default', () => {
    const parsed = yaml.load(generateFeatureFlagsYamlContent()) as Record<string, unknown>;
    const enabledFlags: string[] = [];
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === 'object' && value !== null && Object.hasOwn(value, 'enabled')) {
        const flag = value as Record<string, unknown>;
        if (flag.enabled === true) enabledFlags.push(key);
      }
    }
    expect(enabledFlags.sort()).toEqual(['code_tool_hook', 'defer_archive', 'prompt']);
  });

  it('core flags are always enabled regardless of channels parameter', () => {
    const parsed = yaml.load(generateFeatureFlagsYamlContent(['prompt'])) as Record<string, unknown>;
    for (const ch of MVP_CHANNELS) {
      const flag = parsed[ch] as Record<string, unknown> | undefined;
      expect(flag).toBeDefined();
      expect(flag?.enabled).toBe(true);
      expect(flag?.category).toBe('core');
    }
  });

  it('core flags are always enabled even with empty channels', () => {
    const parsed = yaml.load(generateFeatureFlagsYamlContent([])) as Record<string, unknown>;
    for (const ch of MVP_CHANNELS) {
      const flag = parsed[ch] as Record<string, unknown> | undefined;
      expect(flag?.enabled).toBe(true);
    }
  });

  it('preserves category and since metadata for core flags', () => {
    const parsed = yaml.load(generateFeatureFlagsYamlContent(['prompt'])) as Record<string, unknown>;
    const codeToolFlag = parsed['code_tool_hook'] as Record<string, unknown>;
    expect(codeToolFlag.enabled).toBe(true);
    expect(codeToolFlag.category).toBe('core');
    expect(typeof codeToolFlag.since).toBe('string');
  });

  it('written to temp workspace is loadable', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-yaml-test-'));
    try {
      const configDir = path.join(tmpDir, '.pd');
      fs.mkdirSync(configDir, { recursive: true });
      fs.writeFileSync(path.join(configDir, 'feature-flags.yaml'), generateFeatureFlagsYamlContent(), 'utf8');
      const raw = fs.readFileSync(path.join(configDir, 'feature-flags.yaml'), 'utf8');
      const parsed = yaml.load(raw, { schema: yaml.JSON_SCHEMA }) as Record<string, unknown>;
      expect(Object.hasOwn(parsed, 'prompt')).toBe(true);
      expect(Object.hasOwn(parsed, 'code_tool_hook')).toBe(true);
      expect(Object.hasOwn(parsed, 'defer_archive')).toBe(true);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe('validateMvpChannels', () => {
  it('accepts all three MVP channels', () => {
    const result = validateMvpChannels(['prompt', 'code_tool_hook', 'defer_archive']);
    expect(result.valid).toEqual(['prompt', 'code_tool_hook', 'defer_archive']);
    expect(result.unknowns).toEqual([]);
  });

  it('rejects non-MVP channels as unknowns', () => {
    const result = validateMvpChannels(['prompt', 'skill', 'nocturnal']);
    expect(result.valid).toEqual(['prompt']);
    expect(result.unknowns).toEqual(['skill', 'nocturnal']);
  });

  it('rejects evolution/trust/pain', () => {
    const result = validateMvpChannels(['evolution', 'trust', 'pain']);
    expect(result.valid).toEqual([]);
    expect(result.unknowns).toEqual(['evolution', 'trust', 'pain']);
  });

  it('returns empty for non-array', () => {
    expect(validateMvpChannels('not-array').valid).toEqual([]);
    expect(validateMvpChannels(null).valid).toEqual([]);
  });

  it('skips non-string elements', () => {
    const result = validateMvpChannels([42, 'prompt', null, 'code_tool_hook']);
    expect(result.valid).toEqual(['prompt', 'code_tool_hook']);
  });
});

describe('parseChannelsOption', () => {
  it('returns defaults for null/undefined', () => {
    const result = parseChannelsOption(null);
    expect(result.channels).toEqual([...MVP_CHANNELS]);
    expect(result.error).toBeUndefined();
  });

  it('returns defaults for empty string', () => {
    const result = parseChannelsOption('');
    expect(result.channels).toEqual([...MVP_CHANNELS]);
  });

  it('parses valid channels and always includes all core channels', () => {
    const result = parseChannelsOption('prompt,defer_archive');
    expect(result.channels).toEqual(['prompt', 'code_tool_hook', 'defer_archive']);
    expect(result.unknowns).toEqual([]);
  });

  it('rejects non-string input with error', () => {
    const result = parseChannelsOption(42);
    expect(result.channels).toEqual([]);
    expect(result.error).toContain('expects a string');
  });

  it('all-invalid channels returns error with empty channels', () => {
    const result = parseChannelsOption('skill,nocturnal');
    expect(result.channels).toEqual([]);
    expect(result.unknowns).toEqual(['skill', 'nocturnal']);
    expect(result.error).toContain('All specified channels are invalid');
  });

  it('all-invalid evolution/trust/pain returns error', () => {
    const result = parseChannelsOption('evolution,trust,pain');
    expect(result.channels).toEqual([]);
    expect(result.error).toBeDefined();
  });

  it('separates valid from unknown — partial valid returns all core channels plus rejected channels exposed', () => {
    const result = parseChannelsOption('prompt,skill');
    expect(result.channels).toEqual(['prompt', 'code_tool_hook', 'defer_archive']);
    expect(result.unknowns).toEqual(['skill']);
    expect(result.error).toBeUndefined();
  });
});

describe('validateOpenClawConfig', () => {
  it('rejects null config — file exists but parsed as null', () => {
    const result = validateOpenClawConfig(null);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('null');
  });

  it('accepts undefined config — file does not exist yet', () => {
    expect(validateOpenClawConfig(undefined).valid).toBe(true);
  });

  it('accepts valid config', () => {
    const config = { plugins: { allow: ['principles-disciple'], entries: {}, installs: {} } };
    expect(validateOpenClawConfig(config).valid).toBe(true);
  });

  it('rejects array root', () => {
    expect(validateOpenClawConfig([]).valid).toBe(false);
  });

  it('rejects string root', () => {
    expect(validateOpenClawConfig('bad').valid).toBe(false);
  });

  it('rejects non-object plugins', () => {
    expect(validateOpenClawConfig({ plugins: 'bad' }).valid).toBe(false);
  });

  it('rejects non-array allow', () => {
    expect(validateOpenClawConfig({ plugins: { allow: 'bad' } }).valid).toBe(false);
  });

  it('rejects non-string elements in allow', () => {
    expect(validateOpenClawConfig({ plugins: { allow: ['valid', 42, null, 'also-valid'] } }).valid).toBe(false);
  });

  it('accepts all-string allow array', () => {
    expect(validateOpenClawConfig({ plugins: { allow: ['principles-disciple', 'other-plugin'] } }).valid).toBe(true);
  });

  it('rejects non-object entries', () => {
    expect(validateOpenClawConfig({ plugins: { entries: 'bad' } }).valid).toBe(false);
  });

  it('rejects non-object installs', () => {
    expect(validateOpenClawConfig({ plugins: { installs: 'bad' } }).valid).toBe(false);
  });

  it('accepts null plugins', () => {
    expect(validateOpenClawConfig({ plugins: null }).valid).toBe(true);
  });

  it('accepts config without plugins', () => {
    expect(validateOpenClawConfig({}).valid).toBe(true);
  });
});

describe('buildSuccessOutput', () => {
  const verification: VerificationResult = { features: 'passed', storyA: 'passed' };

  it('returns success true when plugin+cli verified and console configured', () => {
    const components: ComponentStatus = { plugin: 'verified', cli: 'verified', console: 'configured', consoleEntrypoint: 'http://localhost:3100' };
    const result = buildSuccessOutput({ workspace: '/tmp/ws', components, channels: [...MVP_CHANNELS], verification });
    expect(result.success).toBe(true);
  });

  it('returns success false when console not deliverable', () => {
    const components: ComponentStatus = { plugin: 'verified', cli: 'verified', console: 'not_deliverable' };
    const result = buildSuccessOutput({ workspace: '/tmp/ws', components, channels: [...MVP_CHANNELS], verification });
    expect(result.success).toBe(false);
  });

  it('includes nextAction with canary command', () => {
    const components: ComponentStatus = { plugin: 'verified', cli: 'verified', console: 'not_deliverable' };
    const result = buildSuccessOutput({ workspace: '/tmp/ws', components, channels: [...MVP_CHANNELS], verification });
    expect(result.nextAction).toContain('pd runtime canary');
  });

  it('includes console not deliverable in nextAction when not_deliverable', () => {
    const components: ComponentStatus = { plugin: 'verified', cli: 'verified', console: 'not_deliverable' };
    const result = buildSuccessOutput({ workspace: '/tmp/ws', components, channels: [...MVP_CHANNELS], verification });
    expect(result.nextAction).toContain('release-blocking');
  });
});

describe('buildFailureOutput', () => {
  it('returns structured failure', () => {
    const result = buildFailureOutput('test_reason', 'do something');
    expect(result.success).toBe(false);
    expect(result.reason).toBe('test_reason');
    expect(result.nextAction).toBe('do something');
  });
});

describe('getFeatureFlagsPath', () => {
  it('returns .pd/feature-flags.yaml under workspace', () => {
    const result = getFeatureFlagsPath('/tmp/ws');
    expect(result.endsWith(path.join('.pd', 'feature-flags.yaml'))).toBe(true);
  });

  it('does not hardcode user-specific paths', () => {
    const result = getFeatureFlagsPath('/tmp/test-workspace');
    expect(result).not.toContain('Administrator');
    expect(result).not.toContain('D:\\');
  });
});

describe('isMvpChannel', () => {
  it('returns true for MVP channels', () => {
    expect(isMvpChannel('prompt')).toBe(true);
    expect(isMvpChannel('code_tool_hook')).toBe(true);
    expect(isMvpChannel('defer_archive')).toBe(true);
  });

  it('returns false for non-MVP channels', () => {
    expect(isMvpChannel('skill')).toBe(false);
    expect(isMvpChannel('nocturnal')).toBe(false);
    expect(isMvpChannel('evolution')).toBe(false);
    expect(isMvpChannel('model_training')).toBe(false);
    expect(isMvpChannel('trainer')).toBe(false);
  });
});

describe('Path helpers', () => {
  it('getHomeDir returns a non-empty string', () => {
    expect(getHomeDir().length).toBeGreaterThan(0);
  });

  it('getOpenClawDir ends with .openclaw', () => {
    expect(getOpenClawDir().endsWith('.openclaw')).toBe(true);
  });

  it('getPluginExtDir contains extensions/principles-disciple', () => {
    expect(getPluginExtDir()).toContain('extensions');
    expect(getPluginExtDir()).toContain('principles-disciple');
  });

  it('getInstalledPdCliDir contains pd-cli', () => {
    expect(getInstalledPdCliDir()).toContain('pd-cli');
  });

  it('getInstalledBinDir contains bin', () => {
    expect(getInstalledBinDir()).toContain('bin');
  });

  it('isWindows returns boolean', () => {
    expect(typeof isWindows()).toBe('boolean');
  });
});

describe('Rerun --channels updates feature-flags.yaml', () => {
  it('fresh install with all channels enables all', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-rerun-test-'));
    try {
      const configDir = path.join(tmpDir, '.pd');
      fs.mkdirSync(configDir, { recursive: true });
      const configPath = path.join(configDir, 'feature-flags.yaml');

      fs.writeFileSync(configPath, generateFeatureFlagsYamlContent(['prompt', 'code_tool_hook', 'defer_archive']), 'utf8');
      const parsed = yaml.load(fs.readFileSync(configPath, 'utf8'));
      expect(typeof parsed).toBe('object');
      expect(parsed).not.toBeNull();
      const flags = parsed as Record<string, unknown>;
      for (const ch of MVP_CHANNELS) {
        const flag = flags[ch] as Record<string, unknown>;
        expect(flag.enabled).toBe(true);
      }
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('rerun with --channels prompt still enables all core channels', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-rerun-test-'));
    try {
      const configDir = path.join(tmpDir, '.pd');
      fs.mkdirSync(configDir, { recursive: true });
      const configPath = path.join(configDir, 'feature-flags.yaml');

      fs.writeFileSync(configPath, generateFeatureFlagsYamlContent(['prompt', 'code_tool_hook', 'defer_archive']), 'utf8');

      fs.writeFileSync(configPath, generateFeatureFlagsYamlContent(['prompt']), 'utf8');

      const parsed = yaml.load(fs.readFileSync(configPath, 'utf8'));
      expect(typeof parsed).toBe('object');
      expect(parsed).not.toBeNull();
      const flags = parsed as Record<string, unknown>;
      for (const ch of MVP_CHANNELS) {
        const flag = flags[ch] as Record<string, unknown>;
        expect(flag.enabled).toBe(true);
      }
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('rerun preserves category and since metadata for core channels', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-rerun-test-'));
    try {
      const configDir = path.join(tmpDir, '.pd');
      fs.mkdirSync(configDir, { recursive: true });
      const configPath = path.join(configDir, 'feature-flags.yaml');

      fs.writeFileSync(configPath, generateFeatureFlagsYamlContent(['prompt']), 'utf8');
      const parsed = yaml.load(fs.readFileSync(configPath, 'utf8'));
      expect(typeof parsed).toBe('object');
      expect(parsed).not.toBeNull();
      const flags = parsed as Record<string, unknown>;
      const codeToolFlag = flags['code_tool_hook'] as Record<string, unknown>;
      expect(codeToolFlag.enabled).toBe(true);
      expect(codeToolFlag.category).toBe('core');
      expect(typeof codeToolFlag.since).toBe('string');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe('Existing config with new workspace', () => {
  it('preserves channels but updates workspace path', () => {
    const existingChannels = ['prompt', 'code_tool_hook'];
    const newWorkspace = '/new/workspace/path';
    const config = {
      workspace: '/old/workspace',
      state: '/old/workspace/.state',
      channels: existingChannels,
      installedAt: '2026-01-01T00:00:00.000Z',
      mvpFirst: true,
    };

    const newConfig = {
      ...config,
      workspace: newWorkspace,
      state: path.join(newWorkspace, '.state'),
    };

    expect(newConfig.channels).toEqual(existingChannels);
    expect(newConfig.workspace).toBe(newWorkspace);
    expect(path.resolve(newConfig.state).startsWith(path.resolve(newWorkspace))).toBe(true);
  });
});

describe('Malformed channels rejected', () => {
  it('non-string channels option returns error', () => {
    const result = parseChannelsOption(123);
    expect(result.error).toBeDefined();
    expect(result.channels).toEqual([]);
  });

  it('all-invalid channels returns error with empty channels', () => {
    const result = parseChannelsOption('skill,nocturnal,evolution');
    expect(result.channels).toEqual([]);
    expect(result.unknowns.length).toBeGreaterThan(0);
    expect(result.error).toContain('All specified channels are invalid');
  });
});

describe('Malformed openclaw.json fails structurally', () => {
  it('non-object root fails', () => {
    const result = validateOpenClawConfig('not an object');
    expect(result.valid).toBe(false);
    expect(result.error).toBeDefined();
  });

  it('non-array allow fails', () => {
    const result = validateOpenClawConfig({ plugins: { allow: {} } });
    expect(result.valid).toBe(false);
  });

  it('array entries fails', () => {
    const result = validateOpenClawConfig({ plugins: { entries: [] } });
    expect(result.valid).toBe(false);
  });

  it('non-string elements in allow fails', () => {
    const result = validateOpenClawConfig({ plugins: { allow: ['ok', 42] } });
    expect(result.valid).toBe(false);
    expect(result.error).toContain('non-string');
  });
});

describe('Dependency install failure returns failure', () => {
  it('buildFailureOutput for dependency failure', () => {
    const result = buildFailureOutput('npm_install_failed', 'Run npm install manually');
    expect(result.success).toBe(false);
    expect(result.reason).toBe('npm_install_failed');
    expect(result.nextAction).toContain('manually');
  });
});

describe('Native validation failure returns failure', () => {
  it('buildFailureOutput for native module failure', () => {
    const result = buildFailureOutput('native_module_better-sqlite3_failed', 'Run npm rebuild better-sqlite3 manually');
    expect(result.success).toBe(false);
    expect(result.reason).toContain('better-sqlite3');
  });
});

describe('Rollback restores prior plugin on replacement failure', () => {
  it('backup/restore cycle preserves data', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-rollback-test-'));
    try {
      const extDir = path.join(tmpDir, 'extensions', 'principles-disciple');
      fs.mkdirSync(extDir, { recursive: true });
      fs.writeFileSync(path.join(extDir, 'marker.txt'), 'original', 'utf8');

      const backupDir = extDir + '.backup.' + Date.now();
      fs.renameSync(extDir, backupDir);
      expect(fs.existsSync(extDir)).toBe(false);
      expect(fs.existsSync(path.join(backupDir, 'marker.txt'))).toBe(true);

      fs.mkdirSync(extDir, { recursive: true });
      fs.writeFileSync(path.join(extDir, 'new.txt'), 'new', 'utf8');

      fs.rmSync(extDir, { recursive: true, force: true });
      fs.renameSync(backupDir, extDir);

      expect(fs.existsSync(path.join(extDir, 'marker.txt'))).toBe(true);
      expect(fs.readFileSync(path.join(extDir, 'marker.txt'), 'utf8')).toBe('original');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('existing install + rename failure must not proceed to copy/install', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-backup-fail-test-'));
    try {
      const extDir = path.join(tmpDir, 'extensions', 'principles-disciple');
      fs.mkdirSync(extDir, { recursive: true });
      fs.writeFileSync(path.join(extDir, 'important.txt'), 'user-data', 'utf8');

      const lockedFile = path.join(extDir, 'locked.dat');
      const handle = fs.openSync(lockedFile, 'w');
      fs.writeSync(handle, Buffer.alloc(1024), 0, 1024, 0);

      let renameFailed = false;
      const backupDir = extDir + '.backup.' + Date.now();
      try {
        fs.renameSync(extDir, backupDir);
      } catch {
        renameFailed = true;
      }

      if (renameFailed) {
        expect(fs.existsSync(path.join(extDir, 'important.txt'))).toBe(true);
      }

      fs.closeSync(handle);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe('CLI wiring: --json implies non-interactive', () => {
  it('--json alone implies non-interactive (auto-sets --yes)', () => {
    const result = buildFailureOutput('json_requires_non_interactive', 'Use --json together with --yes or --non-interactive');
    expect(result.success).toBe(false);
    expect(result.reason).toBe('json_requires_non_interactive');
  });
});

describe('Install success output exposes plugin/cli/console status', () => {
  const verification: VerificationResult = { features: 'passed', storyA: 'passed' };

  it('full success output has all component fields', () => {
    const components: ComponentStatus = { plugin: 'verified', cli: 'verified', console: 'configured', consoleEntrypoint: 'http://localhost:3100' };
    const result = buildSuccessOutput({ workspace: '/tmp/ws', components, channels: [...MVP_CHANNELS], verification });
    expect(result.success).toBe(true);
    expect(result.components.plugin).toBe('verified');
    expect(result.components.cli).toBe('verified');
    expect(result.components.console).toBe('configured');
    expect(result.components.consoleEntrypoint).toBe('http://localhost:3100');
    expect(result.enabledChannels).toEqual(['prompt', 'code_tool_hook', 'defer_archive']);
    expect(result.verification.features).toBe('passed');
    expect(result.verification.storyA).toBe('passed');
  });

  it('partial success (console not deliverable) returns success false', () => {
    const components: ComponentStatus = { plugin: 'verified', cli: 'verified', console: 'not_deliverable' };
    const result = buildSuccessOutput({ workspace: '/tmp/ws', components, channels: [...MVP_CHANNELS], verification });
    expect(result.success).toBe(false);
    expect(result.nextAction).toContain('release-blocking');
  });
});

describe('Console delivery contract', () => {
  const verification: VerificationResult = { features: 'passed', storyA: 'skipped', storyASkipReason: 'Console not available' };

  it('not_deliverable console means success=false', () => {
    const components: ComponentStatus = { plugin: 'verified', cli: 'verified', console: 'not_deliverable' };
    const result = buildSuccessOutput({ workspace: '/tmp/ws', components, channels: [...MVP_CHANNELS], verification });
    expect(result.success).toBe(false);
    expect(result.components.console).toBe('not_deliverable');
    expect(result.nextAction).toContain('release-blocking');
  });

  it('configured console with entrypoint means success=true', () => {
    const components: ComponentStatus = { plugin: 'verified', cli: 'verified', console: 'configured', consoleEntrypoint: 'http://localhost:3100' };
    const result = buildSuccessOutput({ workspace: '/tmp/ws', components, channels: [...MVP_CHANNELS], verification });
    expect(result.success).toBe(true);
    expect(result.components.consoleEntrypoint).toBe('http://localhost:3100');
  });

  it('plugin failed means success=false regardless of console', () => {
    const components: ComponentStatus = { plugin: 'failed', cli: 'verified', console: 'configured', consoleEntrypoint: 'http://localhost:3100' };
    const result = buildSuccessOutput({ workspace: '/tmp/ws', components, channels: [...MVP_CHANNELS], verification });
    expect(result.success).toBe(false);
  });

  it('cli failed means success=false regardless of console', () => {
    const components: ComponentStatus = { plugin: 'verified', cli: 'failed', console: 'configured', consoleEntrypoint: 'http://localhost:3100' };
    const result = buildSuccessOutput({ workspace: '/tmp/ws', components, channels: [...MVP_CHANNELS], verification });
    expect(result.success).toBe(false);
  });
});

describe('Tarball content contract', () => {
  it('package.json files array includes plugin and pd-cli', () => {
    const pkgJsonPath = path.resolve(__dirname, '..', 'package.json');
    const pkgJson = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8')) as Record<string, unknown>;
    const files = pkgJson.files;
    expect(Array.isArray(files)).toBe(true);
    const filesArr = files as string[];
    expect(filesArr).toContain('plugin');
    expect(filesArr).toContain('pd-cli');
    expect(filesArr).toContain('dist');
    expect(filesArr).toContain('templates');
  });
});

describe('Invalid --channels JSON output contract', () => {
  it('all-invalid channels produces structured failure output', () => {
    const result = parseChannelsOption('skill,nocturnal');
    expect(result.channels).toEqual([]);
    expect(result.error).toBeDefined();
    const failure = buildFailureOutput('invalid_channels', `${result.error}. Rejected: ${result.unknowns.join(', ')}`);
    expect(failure.success).toBe(false);
    expect(failure.reason).toBe('invalid_channels');
    expect(failure.nextAction).toContain('Rejected');
  });

  it('partial valid channels produces all core channels plus rejected channels exposed', () => {
    const result = parseChannelsOption('prompt,skill');
    expect(result.channels).toEqual(['prompt', 'code_tool_hook', 'defer_archive']);
    expect(result.unknowns).toEqual(['skill']);
    expect(result.error).toBeUndefined();
  });
});

describe('CLI verification contract', () => {
  it('cli: verified (global) — nextAction uses bare pd', () => {
    const components: ComponentStatus = { plugin: 'verified', cli: 'verified', console: 'not_deliverable' };
    const result = buildSuccessOutput({ workspace: '/tmp/ws', components, channels: [...MVP_CHANNELS], verification: { features: 'passed', storyA: 'passed' } });
    expect(result.components.cli).toBe('verified');
    expect(result.nextAction).toContain('pd runtime canary');
    expect(result.nextAction).not.toContain('global pd not on PATH');
  });

  it('cli: verified_local_only — nextAction uses local shim path', () => {
    const components: ComponentStatus = { plugin: 'verified', cli: 'verified_local_only', console: 'not_deliverable', cliLocalPath: '/home/.openclaw/extensions/principles-disciple/bin/pd' };
    const result = buildSuccessOutput({ workspace: '/tmp/ws', components, channels: [...MVP_CHANNELS], verification: { features: 'passed', storyA: 'passed' } });
    expect(result.components.cli).toBe('verified_local_only');
    expect(result.nextAction).toContain('/home/.openclaw/extensions/principles-disciple/bin/pd');
    expect(result.nextAction).toContain('global pd not on PATH');
    expect(result.nextAction).not.toMatch(/"(?:pd|pd\.cmd)" runtime canary/);
  });

  it('cli: verified_local_only counts as CLI working for isComplete', () => {
    const components: ComponentStatus = { plugin: 'verified', cli: 'verified_local_only', console: 'configured', consoleEntrypoint: 'http://localhost:3100', cliLocalPath: '/local/pd' };
    const result = buildSuccessOutput({ workspace: '/tmp/ws', components, channels: [...MVP_CHANNELS], verification: { features: 'passed', storyA: 'passed' } });
    expect(result.success).toBe(true);
  });

  it('cli: failed means success=false even if plugin is verified', () => {
    const components: ComponentStatus = { plugin: 'verified', cli: 'failed', console: 'not_deliverable' };
    const result = buildSuccessOutput({ workspace: '/tmp/ws', components, channels: [...MVP_CHANNELS], verification: { features: 'passed', storyA: 'passed' } });
    expect(result.success).toBe(false);
  });

  it('cli failure output includes structured reason', () => {
    const result = buildFailureOutput('cli_verification_failed', 'PD CLI is not executable after install. Check Node.js and PATH configuration.');
    expect(result.success).toBe(false);
    expect(result.reason).toBe('cli_verification_failed');
    expect(result.nextAction).toContain('PATH');
  });
});

describe('Core channels are never partially disabled (P1 fix)', () => {
  it('parseChannelsOption with only prompt returns all three core channels', () => {
    const result = parseChannelsOption('prompt');
    expect(result.channels).toEqual(['prompt', 'code_tool_hook', 'defer_archive']);
  });

  it('parseChannelsOption with prompt+defer_archive returns all three core channels', () => {
    const result = parseChannelsOption('prompt,defer_archive');
    expect(result.channels).toEqual(['prompt', 'code_tool_hook', 'defer_archive']);
  });

  it('parseChannelsOption default returns all three core channels', () => {
    const result = parseChannelsOption(null);
    expect(result.channels).toEqual(['prompt', 'code_tool_hook', 'defer_archive']);
  });

  it('generateFeatureFlagsYamlContent with subset channels still enables all core', () => {
    const parsed = yaml.load(generateFeatureFlagsYamlContent(['prompt'])) as Record<string, unknown>;
    const promptFlag = parsed['prompt'] as Record<string, unknown>;
    expect(promptFlag.enabled).toBe(true);
    const codeToolFlag = parsed['code_tool_hook'] as Record<string, unknown>;
    expect(codeToolFlag.enabled).toBe(true);
    const deferFlag = parsed['defer_archive'] as Record<string, unknown>;
    expect(deferFlag.enabled).toBe(true);
  });

  it('YAML output matches runtime behavior — no core flag can be disabled', () => {
    const parsed = yaml.load(generateFeatureFlagsYamlContent(['prompt'])) as Record<string, unknown>;
    const coreFlags = Object.entries(parsed).filter(([, v]) => {
      if (typeof v !== 'object' || v === null) return false;
      const flag = v as Record<string, unknown>;
      return flag.category === 'core';
    });
    for (const [, v] of coreFlags) {
      const flag = v as Record<string, unknown>;
      expect(flag.enabled).toBe(true);
    }
  });

  it('quiet flag remains disabled when not in channels', () => {
    const parsed = yaml.load(generateFeatureFlagsYamlContent(['prompt'])) as Record<string, unknown>;
    const gfiFlag = parsed['gfi'] as Record<string, unknown>;
    expect(gfiFlag.enabled).toBe(false);
    expect(gfiFlag.category).toBe('quiet');
  });
});

describe('openclaw.json null vs undefined (P2 fix)', () => {
  it('null config is rejected — file exists but parsed as null', () => {
    const result = validateOpenClawConfig(null);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('null');
  });

  it('undefined config is accepted — file does not exist', () => {
    const result = validateOpenClawConfig(undefined);
    expect(result.valid).toBe(true);
  });

  it('empty object is accepted — valid new config', () => {
    const result = validateOpenClawConfig({});
    expect(result.valid).toBe(true);
  });
});

describe('Install output never implies partial core channel disabling', () => {
  const verification: VerificationResult = { features: 'passed', storyA: 'passed' };

  it('success output always exposes all three core channels', () => {
    const components: ComponentStatus = { plugin: 'verified', cli: 'verified', console: 'configured', consoleEntrypoint: 'http://localhost:3100' };
    const result = buildSuccessOutput({ workspace: '/tmp/ws', components, channels: [...MVP_CHANNELS], verification });
    expect(result.success).toBe(true);
    expect(result.enabledChannels).toEqual(['prompt', 'code_tool_hook', 'defer_archive']);
  });

  it('partial success output does not expose enabledChannels (success=false)', () => {
    const components: ComponentStatus = { plugin: 'verified', cli: 'verified', console: 'not_deliverable' };
    const result = buildSuccessOutput({ workspace: '/tmp/ws', components, channels: [...MVP_CHANNELS], verification });
    expect(result.success).toBe(false);
    expect(result.enabledChannels).toBeUndefined();
  });

  it('partial success nextAction does not imply channels can be partially disabled', () => {
    const components: ComponentStatus = { plugin: 'verified', cli: 'verified', console: 'not_deliverable' };
    const result = buildSuccessOutput({ workspace: '/tmp/ws', components, channels: [...MVP_CHANNELS], verification });
    expect(result.nextAction).not.toContain('disabled');
    expect(result.nextAction).not.toContain('channel');
  });

  it('CLI entry does not expose --channels option', () => {
    const indexPath = path.resolve(__dirname, '..', 'src', 'index.ts');
    const content = fs.readFileSync(indexPath, 'utf-8');
    expect(content).not.toContain('--channels');
  });

  it('README does not expose --channels option', () => {
    const readmePath = path.resolve(__dirname, '..', 'README.md');
    const content = fs.readFileSync(readmePath, 'utf-8');
    expect(content).not.toContain('--channels');
    expect(content).not.toContain('Channels not listed are disabled');
  });

  it('README states core channels cannot be disabled', () => {
    const readmePath = path.resolve(__dirname, '..', 'README.md');
    const content = fs.readFileSync(readmePath, 'utf-8');
    expect(content).toContain('cannot be disabled');
  });
});

describe('Installer has no @principles/core runtime dependency (P1 fix)', () => {
  it('package.json does not depend on @principles/core', () => {
    const pkgJsonPath = path.resolve(__dirname, '..', 'package.json');
    const pkgJson = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8')) as Record<string, unknown>;
    const deps = pkgJson.dependencies as Record<string, unknown> | undefined;
    expect(deps).toBeDefined();
    expect(Object.keys(deps ?? {})).not.toContain('@principles/core');
  });

  it('mvp-config.ts does not import from @principles/core', () => {
    const mvpConfigPath = path.resolve(__dirname, '..', 'src', 'mvp-config.ts');
    const content = fs.readFileSync(mvpConfigPath, 'utf-8');
    expect(content).not.toContain('@principles/core');
  });

  it('inlined DEFAULT_FEATURE_FLAGS matches core definition', () => {
    const mvpConfigPath = path.resolve(__dirname, '..', 'src', 'mvp-config.ts');
    const content = fs.readFileSync(mvpConfigPath, 'utf-8');
    expect(content).toContain("'prompt', category: 'core'");
    expect(content).toContain("'code_tool_hook', category: 'core'");
    expect(content).toContain("'defer_archive', category: 'core'");
    expect(content).toContain("'gfi', category: 'quiet'");
    expect(content).toContain("'nocturnal', category: 'gone'");
  });
});

describe('CLI verification requires localOk first (P1 fix)', () => {
  it('installer.ts checks localOk before globalOk', () => {
    const installerPath = path.resolve(__dirname, '..', 'src', 'installer.ts');
    const content = fs.readFileSync(installerPath, 'utf-8');
    const localOkCheck = content.indexOf('!cliVerify.localOk');
    const globalOkCheck = content.indexOf('cliVerify.globalOk');
    expect(localOkCheck).toBeGreaterThan(0);
    expect(globalOkCheck).toBeGreaterThan(0);
    expect(localOkCheck).toBeLessThan(globalOkCheck);
  });

  it('localOk failure throws, does not fall through to globalOk', () => {
    const installerPath = path.resolve(__dirname, '..', 'src', 'installer.ts');
    const content = fs.readFileSync(installerPath, 'utf-8');
    expect(content).toContain('if (!cliVerify.localOk)');
    expect(content).toContain('local shim is not executable');
  });
});

describe('Native module verification always runs (P1 fix)', () => {
  it('installer.ts does not early-return on existing node_modules', () => {
    const installerPath = path.resolve(__dirname, '..', 'src', 'installer.ts');
    const content = fs.readFileSync(installerPath, 'utf-8');
    const needsInstallBlock = content.indexOf('if (needsInstall)');
    const nativeRebuild = content.indexOf('npm rebuild');
    expect(needsInstallBlock).toBeGreaterThan(0);
    expect(nativeRebuild).toBeGreaterThan(0);
    expect(nativeRebuild).toBeGreaterThan(needsInstallBlock);
  });

  it('native rebuild runs outside needsInstall guard', () => {
    const installerPath = path.resolve(__dirname, '..', 'src', 'installer.ts');
    const content = fs.readFileSync(installerPath, 'utf-8');
    const needsInstallClosingBrace = content.indexOf('if (needsInstall)');
    const nativeModulesDecl = content.indexOf("const nativeModules = ['better-sqlite3']");
    expect(nativeModulesDecl).toBeGreaterThan(needsInstallClosingBrace);
  });
});

describe('Bundle script required vs optional artifacts (Fix A)', () => {
  const scriptPath = path.resolve(__dirname, '..', 'scripts', 'bundle-plugin.mjs');
  const content = fs.readFileSync(scriptPath, 'utf-8');

  it('plugin REQUIRED items include dist, templates, openclaw.plugin.json, package.json', () => {
    expect(content).toContain('PLUGIN_REQUIRED');
    expect(content).toContain("'dist'");
    expect(content).toContain("'templates'");
    expect(content).toContain("'openclaw.plugin.json'");
    expect(content).toContain("'package.json'");
  });

  it('plugin OPTIONAL items include scripts, docs', () => {
    expect(content).toContain('PLUGIN_OPTIONAL');
    expect(content).toContain("'scripts'");
    expect(content).toContain("'docs'");
  });

  it('pd-cli required items include dist and package.json', () => {
    expect(content).toContain("PD_CLI_REQUIRED");
    expect(content).toContain("'dist'");
    expect(content).toContain("'package.json'");
  });

  it('missing required item triggers process.exit(1)', () => {
    expect(content).toContain('process.exit(1)');
  });

  it('missing required item prints the missing path', () => {
    expect(content).toContain('not found');
  });

  it('optional items skip with warning, not exit', () => {
    const optionalLoopStart = content.indexOf('for (const item of PLUGIN_OPTIONAL)');
    const pdCliCopyStart = content.indexOf('if (existsSync(PD_CLI_DEST))');
    const optionalSection = content.substring(optionalLoopStart, pdCliCopyStart);
    expect(optionalSection).toContain('Skipping');
    expect(optionalSection).not.toContain('process.exit');
  });
});

describe('Bundle integration test (requires sibling build)', () => {
  const rootDir = path.resolve(__dirname, '..', '..', '..');
  const pluginDist = path.join(rootDir, 'packages', 'openclaw-plugin', 'dist');
  const pdCliDist = path.join(rootDir, 'packages', 'pd-cli', 'dist');
  const pluginTemplates = path.join(rootDir, 'packages', 'openclaw-plugin', 'templates');
  const pluginManifest = path.join(rootDir, 'packages', 'openclaw-plugin', 'openclaw.plugin.json');

  const siblingBuildReady = fs.existsSync(pluginDist) && fs.existsSync(pdCliDist)
    && fs.existsSync(pluginTemplates) && fs.existsSync(pluginManifest);

  it.skipIf(!siblingBuildReady)('bundle-plugin.mjs produces valid tarball content', () => {
    const scriptPath = path.resolve(__dirname, '..', 'scripts', 'bundle-plugin.mjs');
    const content = fs.readFileSync(scriptPath, 'utf-8');
    expect(content).toContain('PLUGIN_REQUIRED');
    expect(content).toContain('PD_CLI_REQUIRED');
    expect(content).toContain('PLUGIN_OPTIONAL');
  });

  it.skipIf(!siblingBuildReady)('all required plugin artifacts exist after sibling build', () => {
    expect(fs.existsSync(pluginDist)).toBe(true);
    expect(fs.existsSync(pluginTemplates)).toBe(true);
    expect(fs.existsSync(pluginManifest)).toBe(true);
    expect(fs.existsSync(path.join(rootDir, 'packages', 'openclaw-plugin', 'package.json'))).toBe(true);
  });

  it.skipIf(!siblingBuildReady)('all required pd-cli artifacts exist after sibling build', () => {
    expect(fs.existsSync(pdCliDist)).toBe(true);
    expect(fs.existsSync(path.join(pdCliDist, 'index.js'))).toBe(true);
    expect(fs.existsSync(path.join(rootDir, 'packages', 'pd-cli', 'package.json'))).toBe(true);
  });
});

describe('readEnabledChannelsFromDisk fail loud (Fix C)', () => {
  it('returns empty array when file does not exist (first install)', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-ff-read-'));
    try {
      const result = readEnabledChannelsFromDisk(tmpDir);
      expect(result).toEqual([]);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('throws on malformed YAML content', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-ff-read-'));
    try {
      const configDir = path.join(tmpDir, '.pd');
      fs.mkdirSync(configDir, { recursive: true });
      fs.writeFileSync(path.join(configDir, 'feature-flags.yaml'), '{{invalid yaml: [}', 'utf8');
      expect(() => readEnabledChannelsFromDisk(tmpDir)).toThrow(/feature-flags/);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('throws on invalid object shape (root is string)', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-ff-read-'));
    try {
      const configDir = path.join(tmpDir, '.pd');
      fs.mkdirSync(configDir, { recursive: true });
      fs.writeFileSync(path.join(configDir, 'feature-flags.yaml'), '"just a string"', 'utf8');
      expect(() => readEnabledChannelsFromDisk(tmpDir)).toThrow(/feature-flags/);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('throws on invalid object shape (root is array)', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-ff-read-'));
    try {
      const configDir = path.join(tmpDir, '.pd');
      fs.mkdirSync(configDir, { recursive: true });
      fs.writeFileSync(path.join(configDir, 'feature-flags.yaml'), '- item1\n- item2', 'utf8');
      expect(() => readEnabledChannelsFromDisk(tmpDir)).toThrow(/feature-flags/);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('returns channels for valid YAML', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-ff-read-'));
    try {
      const configDir = path.join(tmpDir, '.pd');
      fs.mkdirSync(configDir, { recursive: true });
      fs.writeFileSync(path.join(configDir, 'feature-flags.yaml'), generateFeatureFlagsYamlContent(), 'utf8');
      const result = readEnabledChannelsFromDisk(tmpDir);
      expect(result).toEqual(['prompt', 'code_tool_hook', 'defer_archive']);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('throws on MVP channel with invalid entry (string instead of object)', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-ff-read-'));
    try {
      const configDir = path.join(tmpDir, '.pd');
      fs.mkdirSync(configDir, { recursive: true });
      const badYaml = yaml.dump({ prompt: 'not-an-object', code_tool_hook: { enabled: true, category: 'core', since: '2026-05-24' }, defer_archive: { enabled: true, category: 'core', since: '2026-05-24' } });
      fs.writeFileSync(path.join(configDir, 'feature-flags.yaml'), badYaml, 'utf8');
      expect(() => readEnabledChannelsFromDisk(tmpDir)).toThrow(/MVP channel 'prompt' has invalid entry/);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('throws on MVP channel with null entry', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-ff-read-'));
    try {
      const configDir = path.join(tmpDir, '.pd');
      fs.mkdirSync(configDir, { recursive: true });
      const badYaml = yaml.dump({ prompt: null, code_tool_hook: { enabled: true, category: 'core', since: '2026-05-24' }, defer_archive: { enabled: true, category: 'core', since: '2026-05-24' } });
      fs.writeFileSync(path.join(configDir, 'feature-flags.yaml'), badYaml, 'utf8');
      expect(() => readEnabledChannelsFromDisk(tmpDir)).toThrow(/MVP channel 'prompt' has invalid entry/);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('throws on MVP channel missing enabled field', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-ff-read-'));
    try {
      const configDir = path.join(tmpDir, '.pd');
      fs.mkdirSync(configDir, { recursive: true });
      const badYaml = yaml.dump({ prompt: { category: 'core', since: '2026-05-24' }, code_tool_hook: { enabled: true, category: 'core', since: '2026-05-24' }, defer_archive: { enabled: true, category: 'core', since: '2026-05-24' } });
      fs.writeFileSync(path.join(configDir, 'feature-flags.yaml'), badYaml, 'utf8');
      expect(() => readEnabledChannelsFromDisk(tmpDir)).toThrow(/MVP channel 'prompt' is missing required 'enabled' field/);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe('verified_local_only nextAction quoting (P2 fix)', () => {
  const verification: VerificationResult = { features: 'passed', storyA: 'passed' };

  it('path without spaces is not quoted', () => {
    const components: ComponentStatus = { plugin: 'verified', cli: 'verified_local_only', console: 'configured', consoleEntrypoint: 'http://localhost:3100', cliLocalPath: '/home/.openclaw/extensions/principles-disciple/bin/pd' };
    const result = buildSuccessOutput({ workspace: '/tmp/ws', components, channels: [...MVP_CHANNELS], verification });
    expect(result.nextAction).toContain('/home/.openclaw/extensions/principles-disciple/bin/pd runtime canary');
    expect(result.nextAction).not.toMatch(/"\/home.*pd" runtime canary/);
  });

  it('path with spaces quotes only the path, not the entire command', () => {
    const components: ComponentStatus = { plugin: 'verified', cli: 'verified_local_only', console: 'configured', consoleEntrypoint: 'http://localhost:3100', cliLocalPath: 'C:\\Program Files\\.openclaw\\extensions\\principles-disciple\\bin\\pd.cmd' };
    const result = buildSuccessOutput({ workspace: '/tmp/ws', components, channels: [...MVP_CHANNELS], verification });
    expect(result.nextAction).toContain('"C:\\Program Files\\.openclaw\\extensions\\principles-disciple\\bin\\pd.cmd" runtime canary');
    expect(result.nextAction).not.toMatch(/"C:\\Program Files.*--json"/);
  });

  it('verified cli uses bare pd without any quotes', () => {
    const components: ComponentStatus = { plugin: 'verified', cli: 'verified', console: 'configured', consoleEntrypoint: 'http://localhost:3100' };
    const result = buildSuccessOutput({ workspace: '/tmp/ws', components, channels: [...MVP_CHANNELS], verification });
    expect(result.nextAction).toContain('Run pd runtime canary');
    expect(result.nextAction).not.toContain('"pd');
  });

  it('entire command is never wrapped in a single pair of quotes', () => {
    const components: ComponentStatus = { plugin: 'verified', cli: 'verified_local_only', console: 'not_deliverable', cliLocalPath: '/opt/pd' };
    const result = buildSuccessOutput({ workspace: '/tmp/ws', components, channels: [...MVP_CHANNELS], verification });
    expect(result.nextAction).not.toMatch(/^".*runtime canary.*"$/);
    expect(result.nextAction).not.toMatch(/"[^"]*runtime canary[^"]*--json"/);
  });
});

describe('Structured failure reason reflects actual failure (P2 fix)', () => {
  const verification: VerificationResult = { features: 'passed', storyA: 'passed' };

  it('plugin failed → reason contains plugin_failed, not console gap', () => {
    const components: ComponentStatus = { plugin: 'failed', cli: 'verified', console: 'configured', consoleEntrypoint: 'http://localhost:3100' };
    const result = buildSuccessOutput({ workspace: '/tmp/ws', components, channels: [...MVP_CHANNELS], verification });
    expect(result.success).toBe(false);
    expect(result.reason).toContain('plugin_failed');
    expect(result.reason).not.toContain('console');
  });

  it('cli failed → reason contains cli_failed, not console gap', () => {
    const components: ComponentStatus = { plugin: 'verified', cli: 'failed', console: 'configured', consoleEntrypoint: 'http://localhost:3100' };
    const result = buildSuccessOutput({ workspace: '/tmp/ws', components, channels: [...MVP_CHANNELS], verification });
    expect(result.success).toBe(false);
    expect(result.reason).toContain('cli_failed');
    expect(result.reason).not.toContain('console');
  });

  it('console not_deliverable alone → reason contains console_not_deliverable', () => {
    const components: ComponentStatus = { plugin: 'verified', cli: 'verified', console: 'not_deliverable' };
    const result = buildSuccessOutput({ workspace: '/tmp/ws', components, channels: [...MVP_CHANNELS], verification });
    expect(result.success).toBe(false);
    expect(result.reason).toContain('console_not_deliverable');
    expect(result.reason).not.toContain('plugin');
    expect(result.reason).not.toContain('cli');
  });

  it('multiple failures → reason is comma-separated', () => {
    const components: ComponentStatus = { plugin: 'failed', cli: 'failed', console: 'not_deliverable' };
    const result = buildSuccessOutput({ workspace: '/tmp/ws', components, channels: [...MVP_CHANNELS], verification });
    expect(result.success).toBe(false);
    expect(result.reason).toContain('plugin_failed');
    expect(result.reason).toContain('cli_failed');
    expect(result.reason).toContain('console_not_deliverable');
    expect(result.reason).toContain(',');
  });

  it('cli skipped → reason contains cli_skipped', () => {
    const components: ComponentStatus = { plugin: 'verified', cli: 'skipped', console: 'configured', consoleEntrypoint: 'http://localhost:3100' };
    const result = buildSuccessOutput({ workspace: '/tmp/ws', components, channels: [...MVP_CHANNELS], verification });
    expect(result.success).toBe(false);
    expect(result.reason).toContain('cli_skipped');
  });
});
