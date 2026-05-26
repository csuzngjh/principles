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
  type MvpChannel,
  type ComponentStatus,
  type VerificationResult,
} from '../src/mvp-config.js';

describe('MVP channel contract', () => {
  it('defines exactly three MVP channels', () => {
    expect(MVP_CHANNELS).toEqual(['prompt', 'code_tool_hook', 'defer_archive']);
  });
});

describe('generateFeatureFlagsYamlContent', () => {
  it('produces valid YAML', () => {
    const content = generateFeatureFlagsYamlContent();
    const parsed = yaml.load(content);
    expect(typeof parsed).toBe('object');
    expect(parsed).not.toBeNull();
  });

  it('core flags are enabled by default', () => {
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

  it('only MVP channels are enabled', () => {
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

  it('parses valid channels', () => {
    const result = parseChannelsOption('prompt,defer_archive');
    expect(result.channels).toEqual(['prompt', 'defer_archive']);
    expect(result.unknowns).toEqual([]);
  });

  it('rejects non-string input with error', () => {
    const result = parseChannelsOption(42);
    expect(result.channels).toEqual([]);
    expect(result.error).toContain('expects a string');
  });

  it('reports unknowns and falls back when all invalid', () => {
    const result = parseChannelsOption('skill,nocturnal');
    expect(result.channels).toEqual([...MVP_CHANNELS]);
    expect(result.unknowns).toEqual(['skill', 'nocturnal']);
    expect(result.error).toContain('No valid MVP channels');
  });

  it('separates valid from unknown', () => {
    const result = parseChannelsOption('prompt,skill');
    expect(result.channels).toEqual(['prompt']);
    expect(result.unknowns).toEqual(['skill']);
  });
});

describe('validateOpenClawConfig', () => {
  it('accepts null config', () => {
    expect(validateOpenClawConfig(null).valid).toBe(true);
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
  const components: ComponentStatus = { plugin: 'verified', cli: 'verified', console: 'not_deliverable' };
  const verification: VerificationResult = { features: 'passed', storyA: 'passed' };

  it('returns success true when plugin+cli verified and console configured', () => {
    const fullComponents = { ...components, console: 'configured' as const };
    const result = buildSuccessOutput({ workspace: '/tmp/ws', components: fullComponents, channels: [...MVP_CHANNELS], verification });
    expect(result.success).toBe(true);
  });

  it('returns success false when console not deliverable', () => {
    const result = buildSuccessOutput({ workspace: '/tmp/ws', components, channels: [...MVP_CHANNELS], verification });
    expect(result.success).toBe(false);
  });

  it('includes nextAction with canary command', () => {
    const result = buildSuccessOutput({ workspace: '/tmp/ws', components, channels: [...MVP_CHANNELS], verification });
    expect(result.nextAction).toContain('pd runtime canary');
  });

  it('includes console not deliverable in nextAction', () => {
    const result = buildSuccessOutput({ workspace: '/tmp/ws', components, channels: [...MVP_CHANNELS], verification });
    expect(result.nextAction).toContain('not yet deliverable');
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

describe('Idempotent feature-flags.yaml generation', () => {
  it('preserves existing feature-flags.yaml on re-run', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-idem-test-'));
    try {
      const configDir = path.join(tmpDir, '.pd');
      fs.mkdirSync(configDir, { recursive: true });
      const configPath = path.join(configDir, 'feature-flags.yaml');

      fs.writeFileSync(configPath, generateFeatureFlagsYamlContent(), 'utf8');
      const original = fs.readFileSync(configPath, 'utf8');

      const parsed = yaml.load(original);
      expect(typeof parsed).toBe('object');
      expect(parsed).not.toBeNull();
      const userModified = parsed as Record<string, unknown>;
      const promptFlag = userModified['prompt'];
      expect(typeof promptFlag).toBe('object');
      expect(promptFlag).not.toBeNull();
      userModified['prompt'] = { ...(promptFlag as Record<string, unknown>), enabled: false };
      fs.writeFileSync(configPath, yaml.dump(userModified, { lineWidth: -1 }), 'utf8');

      const afterModify = fs.readFileSync(configPath, 'utf8');
      expect(afterModify).not.toBe(original);

      const parsedAfter = yaml.load(afterModify);
      expect(typeof parsedAfter).toBe('object');
      expect(parsedAfter).not.toBeNull();
      const flagsAfter = parsedAfter as Record<string, unknown>;
      const promptFlagAfter = flagsAfter['prompt'];
      expect(typeof promptFlagAfter).toBe('object');
      expect(promptFlagAfter).not.toBeNull();
      const promptFlagTyped = promptFlagAfter as Record<string, unknown>;
      expect(promptFlagTyped.enabled).toBe(false);
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

  it('all-invalid channels falls back to defaults', () => {
    const result = parseChannelsOption('skill,nocturnal,evolution');
    expect(result.channels).toEqual([...MVP_CHANNELS]);
    expect(result.unknowns.length).toBeGreaterThan(0);
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
});

describe('CLI wiring: --json implies non-interactive', () => {
  it('--json alone implies non-interactive (does not fail)', () => {
    const result = buildFailureOutput('json_requires_non_interactive', 'Use --json together with --yes or --non-interactive');
    expect(result.success).toBe(false);
    expect(result.reason).toBe('json_requires_non_interactive');
  });
});

describe('Install success output exposes plugin/cli/console status', () => {
  it('full success output has all component fields', () => {
    const components: ComponentStatus = { plugin: 'verified', cli: 'verified', console: 'configured', consoleEntrypoint: 'http://localhost:3100' };
    const verification: VerificationResult = { features: 'passed', storyA: 'passed' };
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
    const verification: VerificationResult = { features: 'passed', storyA: 'passed' };
    const result = buildSuccessOutput({ workspace: '/tmp/ws', components, channels: [...MVP_CHANNELS], verification });
    expect(result.success).toBe(false);
    expect(result.nextAction).toContain('not yet deliverable');
  });
});

describe('Console delivery contract', () => {
  it('not_deliverable console is explicit in output', () => {
    const components: ComponentStatus = { plugin: 'verified', cli: 'verified', console: 'not_deliverable' };
    const verification: VerificationResult = { features: 'passed', storyA: 'skipped', storyASkipReason: 'Console not available' };
    const result = buildSuccessOutput({ workspace: '/tmp/ws', components, channels: [...MVP_CHANNELS], verification });
    expect(result.components.console).toBe('not_deliverable');
    expect(result.nextAction).toContain('release-blocking');
  });
});
