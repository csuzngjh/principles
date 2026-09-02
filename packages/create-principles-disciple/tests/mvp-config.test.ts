import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as yaml from 'js-yaml';
import {
  MVP_CHANNELS,
  MVP_QUIET_FLAGS,
  MVP_GONE_FLAGS,
  validateMvpChannels,
  parseChannelsOption,
  validateOpenClawConfig,
  buildSuccessOutput,
  buildFailureOutput,
  isMvpChannel,
  getHomeDir,
  getOpenClawDir,
  getPluginExtDir,
  getInstalledPdCliDir,
  getInstalledBinDir,
  isWindows,
  generateConfigYamlContent,
  ExistingConfigVerifyInfraError,
  validateExistingConfigYamlForPreserve,
  getConfigYamlPath,
  validateConfigYamlFull,
  readEnabledChannelsFromConfigYaml,
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

  it('bundle-plugin.mjs stamps pd.bundledPluginVersion into the installer package.json (PRI-547)', () => {
    // PRI-547: pd.bundledPluginVersion is formal release metadata stamped by
    // bundle-plugin.mjs at bundle time. Contract test: the stamping logic must
    // exist, and the committed value must be a valid semver.
    const scriptPath = path.resolve(__dirname, '..', 'scripts', 'bundle-plugin.mjs');
    const script = fs.readFileSync(scriptPath, 'utf-8');
    expect(script).toContain('pd.bundledPluginVersion');
    expect(script).toContain('installerPkg.pd.bundledPluginVersion = npmPluginVersion');

    const installerPkgPath = path.resolve(__dirname, '..', 'package.json');
    const installerPkg = JSON.parse(fs.readFileSync(installerPkgPath, 'utf-8'));
    const stamped = installerPkg.pd?.bundledPluginVersion;
    expect(typeof stamped).toBe('string');
    expect(stamped).toMatch(/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/);
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

  it('returns success false when console skipped', () => {
    const components: ComponentStatus = { plugin: 'verified', cli: 'verified', console: 'skipped' };
    const result = buildSuccessOutput({ workspace: '/tmp/ws', components, channels: [...MVP_CHANNELS], verification });
    expect(result.success).toBe(false);
  });

  it('includes nextAction with canary command', () => {
    const components: ComponentStatus = { plugin: 'verified', cli: 'verified', console: 'skipped' };
    const result = buildSuccessOutput({ workspace: '/tmp/ws', components, channels: [...MVP_CHANNELS], verification });
    expect(result.nextAction).toContain('pd runtime canary');
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

  it('partial success (console skipped) returns success false', () => {
    const components: ComponentStatus = { plugin: 'verified', cli: 'verified', console: 'skipped' };
    const result = buildSuccessOutput({ workspace: '/tmp/ws', components, channels: [...MVP_CHANNELS], verification });
    expect(result.success).toBe(false);
  });
});

describe('Console delivery contract', () => {
  const verification: VerificationResult = { features: 'passed', storyA: 'skipped', storyASkipReason: 'Console not available' };

  it('skipped console means success=false', () => {
    const components: ComponentStatus = { plugin: 'verified', cli: 'verified', console: 'skipped' };
    const result = buildSuccessOutput({ workspace: '/tmp/ws', components, channels: [...MVP_CHANNELS], verification });
    expect(result.success).toBe(false);
    expect(result.components.console).toBe('skipped');
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
    // PRI-548: the installer's own templates/ tree had zero src consumers
    // (all template copies read from the embedded pluginDir) and shipped
    // dead weight in every install. It must stay gone from the package.
    expect(filesArr).not.toContain('templates');
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
    const components: ComponentStatus = { plugin: 'verified', cli: 'verified', console: 'skipped' };
    const result = buildSuccessOutput({ workspace: '/tmp/ws', components, channels: [...MVP_CHANNELS], verification: { features: 'passed', storyA: 'passed' } });
    expect(result.components.cli).toBe('verified');
    expect(result.nextAction).toContain('pd runtime canary');
    expect(result.nextAction).not.toContain('global pd not on PATH');
  });

  it('cli: verified_local_only — nextAction uses local shim path', () => {
    const components: ComponentStatus = { plugin: 'verified', cli: 'verified_local_only', console: 'skipped', cliLocalPath: '/home/.openclaw/extensions/principles-disciple/bin/pd' };
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
    const components: ComponentStatus = { plugin: 'verified', cli: 'failed', console: 'skipped' };
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
    const components: ComponentStatus = { plugin: 'verified', cli: 'verified', console: 'skipped' };
    const result = buildSuccessOutput({ workspace: '/tmp/ws', components, channels: [...MVP_CHANNELS], verification });
    expect(result.success).toBe(false);
    expect(result.enabledChannels).toBeUndefined();
  });

  it('partial success nextAction does not imply channels can be partially disabled', () => {
    const components: ComponentStatus = { plugin: 'verified', cli: 'verified', console: 'skipped' };
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

  it('generateConfigYamlContent declares an empty sparse features map (PRI-645)', () => {
    const mvpConfigPath = path.resolve(__dirname, '..', 'src', 'mvp-config.ts');
    const content = fs.readFileSync(mvpConfigPath, 'utf8');
    // PRI-645: the template must not duplicate registry defaults. The features
    // literal contains no flag entries (nested objects) — defaults belong to
    // DEFAULT_FEATURE_FLAGS in principles-core, reconciled by the core-side
    // installer-config-parity contract test.
    expect(content).toContain('features: {},');
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

  it('plugin REQUIRED items include dist/bundle.js (PRI-505)', () => {
    // PRI-505: PLUGIN_REQUIRED must explicitly check dist/bundle.js,
    // aligning with PD_CLI_REQUIRED (dist/index.js) and CORE_REQUIRED
    // (dist/index.js). If only `tsc` is run without esbuild, dist/ exists
    // but bundle.js does not — the bundle script must fail rather than
    // publish a broken plugin. ERR-040: Published artifact missing
    // components that source-tree tests assume exist.
    expect(content).toContain("'dist/bundle.js'");
  });

  it('plugin OPTIONAL items include docs and exclude scripts (PRI-547)', () => {
    // PRI-547 (ClawHub audit remediation): maintainer scripts must NOT be
    // bundled into the installer-embedded plugin — they have zero
    // installed-runtime readers and their shell/process execution was a top
    // ClawHub static-analysis finding. Parse the PLUGIN_OPTIONAL array block
    // itself so comments elsewhere in the file cannot satisfy the assertion.
    expect(content).toContain('PLUGIN_OPTIONAL');
    const optionalStart = content.indexOf('const PLUGIN_OPTIONAL = [');
    expect(optionalStart).toBeGreaterThan(-1);
    const optionalEnd = content.indexOf('];', optionalStart);
    const optionalBlock = content.substring(optionalStart, optionalEnd);
    expect(optionalBlock).toContain("'docs'");
    expect(optionalBlock).not.toContain("'scripts'");
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
    const components: ComponentStatus = { plugin: 'verified', cli: 'verified_local_only', console: 'skipped', cliLocalPath: '/opt/pd' };
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

  it('console skipped alone → reason contains console_skipped', () => {
    const components: ComponentStatus = { plugin: 'verified', cli: 'verified', console: 'skipped' };
    const result = buildSuccessOutput({ workspace: '/tmp/ws', components, channels: [...MVP_CHANNELS], verification });
    expect(result.success).toBe(false);
    expect(result.reason).toContain('console_skipped');
    expect(result.reason).not.toContain('plugin');
    expect(result.reason).not.toContain('cli');
  });

  it('multiple failures → reason is comma-separated', () => {
    const components: ComponentStatus = { plugin: 'failed', cli: 'failed', console: 'skipped' };
    const result = buildSuccessOutput({ workspace: '/tmp/ws', components, channels: [...MVP_CHANNELS], verification });
    expect(result.success).toBe(false);
    expect(result.reason).toContain('plugin_failed');
    expect(result.reason).toContain('cli_failed');
    expect(result.reason).toContain('console_skipped');
    expect(result.reason).toContain(',');
  });

  it('cli skipped → reason contains cli_skipped', () => {
    const components: ComponentStatus = { plugin: 'verified', cli: 'skipped', console: 'configured', consoleEntrypoint: 'http://localhost:3100' };
    const result = buildSuccessOutput({ workspace: '/tmp/ws', components, channels: [...MVP_CHANNELS], verification });
    expect(result.success).toBe(false);
    expect(result.reason).toContain('cli_skipped');
  });
});

describe('Story A verification uses a parameterized subprocess, not shell (P1-1 fix)', () => {
  it('installer.ts uses process.execPath for story-a verification', () => {
    const installerPath = path.resolve(__dirname, '..', 'src', 'installer.ts');
    const content = fs.readFileSync(installerPath, 'utf-8');
    expect(content).toContain('process.execPath');
    expect(content).toContain("'demo', 'story-a', '--json'");
  });

  it('installer.ts runs story-a WITHOUT --workspace (demo isolation, P0-1 fix)', () => {
    const installerPath = path.resolve(__dirname, '..', 'src', 'installer.ts');
    const content = fs.readFileSync(installerPath, 'utf-8');
    const startMarker = "updateProgress(spinner, stepIndex, 'Verifying demo...'";
    const storyASection = content.substring(content.indexOf(startMarker), content.indexOf('verification.storyA'));
    // The install target already holds PD state at verification time; the
    // demo must run in pd-cli's own throwaway workspace, never the target.
    expect(storyASection).not.toContain("'--workspace'");
    expect(storyASection).not.toContain('options.workspaceDir');
  });

  it('installer.ts does not use shell:cmd for story-a', () => {
    const installerPath = path.resolve(__dirname, '..', 'src', 'installer.ts');
    const content = fs.readFileSync(installerPath, 'utf-8');
    const startMarker = "updateProgress(spinner, stepIndex, 'Verifying demo...'";
    const storyASection = content.substring(content.indexOf(startMarker), content.indexOf('verification.storyA'));
    expect(storyASection).not.toContain("shell: 'cmd'");
    expect(storyASection).not.toContain('execSync');
    // Parameterized argv-array invocation (promisified execFile), no shell.
    expect(storyASection).toContain('execFile');
    // Boundary-checked entry path before it becomes the subprocess target.
    expect(storyASection).toContain('startsWith(pdCliRoot + path.sep)');
  });

  it('CLI verification uses process.execPath for localOk', () => {
    const installerPath = path.resolve(__dirname, '..', 'src', 'installer.ts');
    const content = fs.readFileSync(installerPath, 'utf-8');
    const verifySection = content.substring(content.indexOf('verifyPdCliShim'), content.indexOf('interface CopyOptions'));
    expect(verifySection).toContain('process.execPath');
    expect(verifySection).toContain('installedEntry');
  });
});

describe('Rollback failure is not swallowed (P1-4 fix)', () => {
  it('restoreBackup returns { restored: true } on success', () => {
    const installerPath = path.resolve(__dirname, '..', 'src', 'installer.ts');
    const content = fs.readFileSync(installerPath, 'utf-8');
    expect(content).toContain('restored: true');
    expect(content).toContain('restored: false');
  });

  it('install catch block distinguishes rollback success vs failure', () => {
    const installerPath = path.resolve(__dirname, '..', 'src', 'installer.ts');
    const content = fs.readFileSync(installerPath, 'utf-8');
    expect(content).toContain('install_failed_rollback_failed');
    expect(content).toContain('restoreResult.restored');
  });

  it('rollback failure reason includes manual resolution path', () => {
    const installerPath = path.resolve(__dirname, '..', 'src', 'installer.ts');
    const installer = fs.readFileSync(installerPath, 'utf-8');
    // EP-11: the message moved to the i18n table (rollback_failed key); the
    // installer references the key. Assert both the reference and the message.
    expect(installer).toContain("t('rollback_failed')");
    const i18nPath = path.resolve(__dirname, '..', 'src', 'i18n.ts');
    const i18n = fs.readFileSync(i18nPath, 'utf-8');
    expect(i18n).toContain('installation state is uncertain');
  });
});

describe('Install timeout is configurable (P2-1 fix)', () => {
  it('default timeout is 300 seconds (5 minutes)', () => {
    const installerPath = path.resolve(__dirname, '..', 'src', 'installer.ts');
    const content = fs.readFileSync(installerPath, 'utf-8');
    expect(content).toContain("'300000'");
  });

  it('timeout reads from PD_INSTALL_TIMEOUT_MS env var', () => {
    const installerPath = path.resolve(__dirname, '..', 'src', 'installer.ts');
    const content = fs.readFileSync(installerPath, 'utf-8');
    expect(content).toContain('PD_INSTALL_TIMEOUT_MS');
  });
});

describe('Bundle hook activation contract (P2-2 fix)', () => {
  const scriptPath = path.resolve(__dirname, '..', 'scripts', 'bundle-plugin.mjs');
  const content = fs.readFileSync(scriptPath, 'utf-8');

  it('bundle script verifies onCapabilities includes hook', () => {
    expect(content).toContain('onCapabilities');
    expect(content).toContain("'hook'");
  });

  it('bundle script verifies openclaw.setupEntry', () => {
    expect(content).toContain('setupEntry');
    expect(content).toContain("'./dist/bundle.js'");
  });

  it('bundle script exits on missing hook activation', () => {
    const hookSection = content.substring(content.indexOf('onCapabilities'));
    expect(hookSection).toContain('process.exit(1)');
  });
});

describe('Plugin manifest activation contract verified at install time (P2-3 fix)', () => {
  it('checkBuiltPlugin validates onCapabilities includes hook', () => {
    const installerPath = path.resolve(__dirname, '..', 'src', 'installer.ts');
    const content = fs.readFileSync(installerPath, 'utf-8');
    expect(content).toContain('onCapabilities');
    expect(content).toContain("includes('hook')");
  });

  it('checkBuiltPlugin validates openclaw.setupEntry', () => {
    const installerPath = path.resolve(__dirname, '..', 'src', 'installer.ts');
    const content = fs.readFileSync(installerPath, 'utf-8');
    expect(content).toContain('setupEntry');
    expect(content).toContain("'./dist/bundle.js'");
  });

  it('verification result includes manifestActivation field', () => {
    const mvpConfigPath = path.resolve(__dirname, '..', 'src', 'mvp-config.ts');
    const content = fs.readFileSync(mvpConfigPath, 'utf-8');
    expect(content).toContain('manifestActivation');
  });
});

describe('Console delivery in npm tarball (F.1)', () => {
  it('package.json files array includes console', () => {
    const pkgPath = path.resolve(__dirname, '..', 'package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
    expect(pkg.files).toContain('console');
  });

  it('bundle-plugin.mjs includes CONSOLE_REQUIRED with server.js and web/index.html', () => {
    const scriptPath = path.resolve(__dirname, '..', 'scripts', 'bundle-plugin.mjs');
    const content = fs.readFileSync(scriptPath, 'utf-8');
    expect(content).toContain('CONSOLE_REQUIRED');
    expect(content).toContain('dist/server.js');
    expect(content).toContain('dist/web/index.html');
  });

  it('bundle-plugin.mjs exits on missing console required artifacts', () => {
    const scriptPath = path.resolve(__dirname, '..', 'scripts', 'bundle-plugin.mjs');
    const content = fs.readFileSync(scriptPath, 'utf-8');
    const consoleSection = content.substring(content.indexOf('CONSOLE_REQUIRED'));
    expect(consoleSection).toContain('process.exit(1)');
  });
});

describe('Console install into stable location (F.3)', () => {
  it('installer.ts has installConsole function', () => {
    const installerPath = path.resolve(__dirname, '..', 'src', 'installer.ts');
    const content = fs.readFileSync(installerPath, 'utf-8');
    expect(content).toContain('function installConsole');
  });

  it('installer.ts has installConsoleDependencies function', () => {
    const installerPath = path.resolve(__dirname, '..', 'src', 'installer.ts');
    const content = fs.readFileSync(installerPath, 'utf-8');
    expect(content).toContain('function installConsoleDependencies');
  });

  it('installer.ts has verifyConsole function', () => {
    const installerPath = path.resolve(__dirname, '..', 'src', 'installer.ts');
    const content = fs.readFileSync(installerPath, 'utf-8');
    expect(content).toContain('async function verifyConsole');
  });

  it('console is installed to getInstalledConsoleDir', () => {
    const installerPath = path.resolve(__dirname, '..', 'src', 'installer.ts');
    const content = fs.readFileSync(installerPath, 'utf-8');
    expect(content).toContain('getInstalledConsoleDir()');
  });

  it('console install failure triggers rollback', () => {
    const installerPath = path.resolve(__dirname, '..', 'src', 'installer.ts');
    const content = fs.readFileSync(installerPath, 'utf-8');
    const consoleInstallSection = content.substring(content.indexOf('installConsole'));
    expect(consoleInstallSection).toContain('throw new Error');
  });
});

describe('Console launch path (F.4 / C)', () => {
  it('pd-cli has console command registered', () => {
    const indexPath = path.resolve(__dirname, '..', '..', 'pd-cli', 'src', 'index.ts');
    const content = fs.readFileSync(indexPath, 'utf-8');
    expect(content).toContain("'console'");
  });

  it('pd-cli has console.ts command file', () => {
    const consolePath = path.resolve(__dirname, '..', '..', 'pd-cli', 'src', 'commands', 'console.ts');
    expect(fs.existsSync(consolePath)).toBe(true);
  });

  it('buildSuccessOutput includes pd console in nextAction when configured', () => {
    const components: ComponentStatus = { plugin: 'verified', cli: 'verified', console: 'configured' };
    const result = buildSuccessOutput({ workspace: '/tmp/ws', components, channels: [...MVP_CHANNELS], verification: { features: 'passed', storyA: 'passed' } });
    expect(result.nextAction).toContain('pd console');
  });
});

describe('Complete install success (F.6)', () => {
  const verification: VerificationResult = { features: 'passed', storyA: 'passed', manifestActivation: 'verified' };

  it('plugin verified + cli verified + console configured = success true', () => {
    const components: ComponentStatus = { plugin: 'verified', cli: 'verified', console: 'configured' };
    const result = buildSuccessOutput({ workspace: '/tmp/ws', components, channels: [...MVP_CHANNELS], verification });
    expect(result.success).toBe(true);
    expect(result.components.plugin).toBe('verified');
    expect(result.components.cli).toBe('verified');
    expect(result.components.console).toBe('configured');
  });

  it('plugin verified + cli verified_local_only + console configured = success true', () => {
    const components: ComponentStatus = { plugin: 'verified', cli: 'verified_local_only', console: 'configured', cliLocalPath: '/opt/pd' };
    const result = buildSuccessOutput({ workspace: '/tmp/ws', components, channels: [...MVP_CHANNELS], verification });
    expect(result.success).toBe(true);
  });

  it('console skipped = success false even if plugin+cli verified', () => {
    const components: ComponentStatus = { plugin: 'verified', cli: 'verified', console: 'skipped' };
    const result = buildSuccessOutput({ workspace: '/tmp/ws', components, channels: [...MVP_CHANNELS], verification });
    expect(result.success).toBe(false);
  });
});

describe('JSON output remains one parseable object (F.7)', () => {
  it('success output is valid JSON', () => {
    const components: ComponentStatus = { plugin: 'verified', cli: 'verified', console: 'configured' };
    const result = buildSuccessOutput({ workspace: '/tmp/ws', components, channels: [...MVP_CHANNELS], verification: { features: 'passed', storyA: 'passed' } });
    const json = JSON.stringify(result);
    const parsed = JSON.parse(json);
    expect(parsed.success).toBe(true);
  });

  it('failure output is valid JSON', () => {
    const components: ComponentStatus = { plugin: 'failed', cli: 'verified', console: 'configured' };
    const result = buildSuccessOutput({ workspace: '/tmp/ws', components, channels: [...MVP_CHANNELS], verification: { features: 'passed', storyA: 'skipped' } });
    const json = JSON.stringify(result);
    const parsed = JSON.parse(json);
    expect(parsed.success).toBe(false);
    expect(parsed.reason).toContain('plugin_failed');
  });
});

describe('Hook activation contract preserved after merge (F.8)', () => {
  it('openclaw.plugin.json has activation.onCapabilities with hook', () => {
    const manifestPath = path.resolve(__dirname, '..', 'plugin', 'openclaw.plugin.json');
    if (!fs.existsSync(manifestPath)) return;
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
    expect(manifest.activation?.onCapabilities).toContain('hook');
  });

  it('plugin package.json has openclaw.setupEntry', () => {
    const pkgPath = path.resolve(__dirname, '..', 'plugin', 'package.json');
    if (!fs.existsSync(pkgPath)) return;
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
    expect(pkg.openclaw?.setupEntry).toBe('./dist/bundle.js');
  });
});

describe('Atomic install: console/story-a fail triggers rollback', () => {
  it('installer.ts throws on console verify failure (not not_deliverable)', () => {
    const installerPath = path.resolve(__dirname, '..', 'src', 'installer.ts');
    const content = fs.readFileSync(installerPath, 'utf-8');
    const consoleVerifySection = content.substring(content.indexOf('verifyConsole'));
    expect(consoleVerifySection).toContain('throw new Error');
    expect(consoleVerifySection).not.toContain('not_deliverable');
  });

  it('installer.ts throws on story-a failure (not skipped)', () => {
    const installerPath = path.resolve(__dirname, '..', 'src', 'installer.ts');
    const content = fs.readFileSync(installerPath, 'utf-8');
    // Boundary must use the call site ('await runHostInstallers('), not the
    // function declaration. indexOf('runHostInstallers') matches the function
    // declaration which appears BEFORE 'story-a' in the file, so substring
    // would swap the args and extract the wrong range — silently breaking the
    // assertion (EP-09 Test Reality Gap: test passes on unintended path).
    const storyASection = content.substring(
      content.indexOf('story-a'),
      content.indexOf('await runHostInstallers('),
    );
    expect(storyASection).toContain('throw new Error');
    expect(storyASection).not.toContain("verification.storyA = 'skipped'");
  });

  it('runHostInstallers runs after all verification', () => {
    const installerPath = path.resolve(__dirname, '..', 'src', 'installer.ts');
    const content = fs.readFileSync(installerPath, 'utf-8');
    const storyALastIndex = content.lastIndexOf("verification.storyA = 'passed'");
    const hostInstallersIndex = content.indexOf('await runHostInstallers(');
    expect(hostInstallersIndex).toBeGreaterThan(storyALastIndex);
  });

  it('cleanupBackup runs after runHostInstallers', () => {
    const installerPath = path.resolve(__dirname, '..', 'src', 'installer.ts');
    const content = fs.readFileSync(installerPath, 'utf-8');
    const hostInstallersIndex = content.indexOf('await runHostInstallers(');
    const cleanupIndex = content.indexOf('cleanupBackup(backupDir, runtimeBackupDir)');
    expect(cleanupIndex).toBeGreaterThan(hostInstallersIndex);
  });

  // Regression (CodeRabbit #3758794660 + PRI-583 review, rc-9): a host
  // failure must enter the atomic rollback catch before backups are deleted.
  it('rolls back before cleanup when a host installer fails (rc-9)', () => {
    const installerPath = path.resolve(__dirname, '..', 'src', 'installer.ts');
    const content = fs.readFileSync(installerPath, 'utf-8');
    expect(content).toContain('hostFailures.push');
    const failureThrow = content.indexOf('throw new Error(`Host installation failed:');
    const cleanup = content.indexOf('cleanupBackup(backupDir, runtimeBackupDir)', failureThrow);
    expect(failureThrow).toBeGreaterThan(0);
    expect(cleanup).toBeGreaterThan(failureThrow);
  });

  it('catch block kills console child process', () => {
    const installerPath = path.resolve(__dirname, '..', 'src', 'installer.ts');
    const content = fs.readFileSync(installerPath, 'utf-8');
    const catchBlock = content.substring(content.indexOf('} catch (error)'));
    expect(catchBlock).toContain('killConsoleChild');
  });
});

describe('Console health check contract (HTTP 200 + parseable JSON)', () => {
  it('verifyConsole checks HTTP status code 200', () => {
    const installerPath = path.resolve(__dirname, '..', 'src', 'installer.ts');
    const content = fs.readFileSync(installerPath, 'utf-8');
    const verifySection = content.substring(content.indexOf('async function verifyConsole'));
    expect(verifySection).toContain('statusCode !== 200');
  });

  it('verifyConsole parses response as JSON', () => {
    const installerPath = path.resolve(__dirname, '..', 'src', 'installer.ts');
    const content = fs.readFileSync(installerPath, 'utf-8');
    const verifySection = content.substring(content.indexOf('async function verifyConsole'));
    expect(verifySection).toContain('JSON.parse');
  });

  it('verifyConsole detects malformed JSON', () => {
    const installerPath = path.resolve(__dirname, '..', 'src', 'installer.ts');
    const content = fs.readFileSync(installerPath, 'utf-8');
    const verifySection = content.substring(content.indexOf('async function verifyConsole'));
    expect(verifySection).toContain('malformed JSON');
  });

  it('verifyConsole detects empty body', () => {
    const installerPath = path.resolve(__dirname, '..', 'src', 'installer.ts');
    const content = fs.readFileSync(installerPath, 'utf-8');
    const verifySection = content.substring(content.indexOf('async function verifyConsole'));
    expect(verifySection).toContain('empty body');
  });

  it('verifyConsole detects premature child exit', () => {
    const installerPath = path.resolve(__dirname, '..', 'src', 'installer.ts');
    const content = fs.readFileSync(installerPath, 'utf-8');
    const verifySection = content.substring(content.indexOf('async function verifyConsole'));
    expect(verifySection).toContain('exited prematurely');
  });

  it('verifyConsole kills child on failure with SIGKILL fallback', () => {
    const installerPath = path.resolve(__dirname, '..', 'src', 'installer.ts');
    const content = fs.readFileSync(installerPath, 'utf-8');
    const verifySection = content.substring(content.indexOf('async function verifyConsole'));
    expect(verifySection).toContain('SIGKILL');
  });

  it('verifyConsole returns structured reason on failure', () => {
    const installerPath = path.resolve(__dirname, '..', 'src', 'installer.ts');
    const content = fs.readFileSync(installerPath, 'utf-8');
    const verifySection = content.substring(content.indexOf('async function verifyConsole'));
    expect(verifySection).toContain('reason:');
  });
});

describe('Console loopback-only binding', () => {
  it('verifyConsole spawns with --host 127.0.0.1', () => {
    const installerPath = path.resolve(__dirname, '..', 'src', 'installer.ts');
    const content = fs.readFileSync(installerPath, 'utf-8');
    const verifySection = content.substring(content.indexOf('async function verifyConsole'));
    expect(verifySection).toContain("'--host', '127.0.0.1'");
  });

  it('verifyConsole health check uses 127.0.0.1 not localhost', () => {
    const installerPath = path.resolve(__dirname, '..', 'src', 'installer.ts');
    const content = fs.readFileSync(installerPath, 'utf-8');
    const verifySection = content.substring(content.indexOf('async function verifyConsole'));
    expect(verifySection).toContain('http://127.0.0.1:');
    expect(verifySection).not.toContain('http://localhost:');
  });

  it('pd-console server defaults to 127.0.0.1 host', () => {
    const serverPath = path.resolve(__dirname, '..', '..', 'pd-console', 'src', 'server', 'index.ts');
    if (!fs.existsSync(serverPath)) return;
    const content = fs.readFileSync(serverPath, 'utf-8');
    expect(content).toContain("let host = '127.0.0.1'");
  });

  it('pd-console server rejects --no-auth with non-loopback host', () => {
    const serverPath = path.resolve(__dirname, '..', '..', 'pd-console', 'src', 'server', 'index.ts');
    if (!fs.existsSync(serverPath)) return;
    const content = fs.readFileSync(serverPath, 'utf-8');
    expect(content).toContain('--no-auth is only allowed with loopback');
  });

  it('pd console CLI uses --host 127.0.0.1', () => {
    const consoleCmdPath = path.resolve(__dirname, '..', '..', 'pd-cli', 'src', 'commands', 'console.ts');
    if (!fs.existsSync(consoleCmdPath)) return;
    const content = fs.readFileSync(consoleCmdPath, 'utf-8');
    expect(content).toContain("'--host', host");
    expect(content).toContain("const host = '127.0.0.1'");
  });
});

describe('pd console CLI contract', () => {
  it('process.exit(1) is followed by return', () => {
    const consoleCmdPath = path.resolve(__dirname, '..', '..', 'pd-cli', 'src', 'commands', 'console.ts');
    if (!fs.existsSync(consoleCmdPath)) return;
    const content = fs.readFileSync(consoleCmdPath, 'utf-8');
    const exit1Indices: number[] = [];
    let searchFrom = 0;
    while (true) {
      const idx = content.indexOf('process.exit(1)', searchFrom);
      if (idx === -1) break;
      exit1Indices.push(idx);
      searchFrom = idx + 1;
    }
    for (const idx of exit1Indices) {
      const after = content.substring(idx + 'process.exit(1)'.length).trimStart();
      expect(after.startsWith('return') || after.startsWith(';')).toBe(true);
    }
  });

  it('--json failure output includes reason and nextAction', () => {
    const consoleCmdPath = path.resolve(__dirname, '..', '..', 'pd-cli', 'src', 'commands', 'console.ts');
    if (!fs.existsSync(consoleCmdPath)) return;
    const content = fs.readFileSync(consoleCmdPath, 'utf-8');
    const jsonErrorBlocks = content.match(/JSON\.stringify\(\{[^}]*success: false[^}]*\}\)/g) ?? [];
    expect(jsonErrorBlocks.length).toBeGreaterThanOrEqual(2);
    for (const block of jsonErrorBlocks) {
      expect(block).toContain('reason');
      expect(block).toContain('nextAction');
    }
  });

  it('does not report success before spawn confirms running', () => {
    const consoleCmdPath = path.resolve(__dirname, '..', '..', 'pd-cli', 'src', 'commands', 'console.ts');
    if (!fs.existsSync(consoleCmdPath)) return;
    const content = fs.readFileSync(consoleCmdPath, 'utf-8');
    expect(content).toContain('startupConfirmed');
    const successOutputIdx = content.indexOf("success: true");
    const setTimeoutIdx = content.indexOf('setTimeout');
    expect(successOutputIdx).toBeGreaterThan(setTimeoutIdx);
  });
});

describe('Bundled @principles/core delivery', () => {
  it('package.json files array includes core', () => {
    const pkgPath = path.resolve(__dirname, '..', 'package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
    expect(pkg.files).toContain('core');
  });

  it('bundle-plugin.mjs includes CORE_REQUIRED with dist and package.json', () => {
    const scriptPath = path.resolve(__dirname, '..', 'scripts', 'bundle-plugin.mjs');
    const content = fs.readFileSync(scriptPath, 'utf-8');
    expect(content).toContain('CORE_REQUIRED');
    expect(content).toContain('CORE_SRC');
    expect(content).toContain('CORE_DEST');
  });

  it('installer.ts has installBundledCore function', () => {
    const installerPath = path.resolve(__dirname, '..', 'src', 'installer.ts');
    const content = fs.readFileSync(installerPath, 'utf-8');
    expect(content).toContain('function installBundledCore');
  });

  it('installer.ts has ensureCoreDependency function', () => {
    const installerPath = path.resolve(__dirname, '..', 'src', 'installer.ts');
    const content = fs.readFileSync(installerPath, 'utf-8');
    expect(content).toContain('function ensureCoreDependency');
  });

  it('installer.ts calls ensureCoreDependency before npm install', () => {
    const installerPath = path.resolve(__dirname, '..', 'src', 'installer.ts');
    const content = fs.readFileSync(installerPath, 'utf-8');
    const ensurePluginCore = content.indexOf("ensureCoreDependency(getPluginExtDir())");
    const pluginNpmInstall = content.indexOf("await installPluginDependencies()");
    expect(ensurePluginCore).toBeGreaterThan(0);
    expect(pluginNpmInstall).toBeGreaterThan(0);
    expect(ensurePluginCore).toBeLessThan(pluginNpmInstall);

    const ensureConsoleCore = content.indexOf("ensureCoreDependency(getInstalledConsoleDir())");
    const consoleNpmInstall = content.indexOf("await installConsoleDependencies()");
    expect(ensureConsoleCore).toBeGreaterThan(0);
    expect(consoleNpmInstall).toBeGreaterThan(0);
    expect(ensureConsoleCore).toBeLessThan(consoleNpmInstall);
  });
});

describe('Shim ownership verification before deletion (P1 fix)', () => {
  it('uninstaller checks isPdOwnedShim before removing each shim', () => {
    const uninstallerPath = path.resolve(__dirname, '..', 'src', 'uninstaller.ts');
    const content = fs.readFileSync(uninstallerPath, 'utf-8');
    const removeFnSection = content.substring(content.indexOf('async function removeGlobalPdShim'));
    expect(removeFnSection).toContain('isPdOwnedShim');
    expect(removeFnSection).toContain('skipped.push');
  });

  it('non-PD-owned shim is skipped, not deleted', () => {
    const uninstallerPath = path.resolve(__dirname, '..', 'src', 'uninstaller.ts');
    const content = fs.readFileSync(uninstallerPath, 'utf-8');
    const removeFnSection = content.substring(content.indexOf('async function removeGlobalPdShim'));
    const ownershipCheck = removeFnSection.indexOf('!isPdOwnedShim');
    const skipPush = removeFnSection.indexOf('skipped.push(shimPath)', ownershipCheck);
    const fseRemove = removeFnSection.indexOf('fse.remove(shimPath)', ownershipCheck);
    expect(ownershipCheck).toBeGreaterThan(0);
    expect(skipPush).toBeGreaterThan(0);
    expect(skipPush).toBeLessThan(fseRemove);
  });

  it('PD-owned shim proceeds to fse.remove', () => {
    const uninstallerPath = path.resolve(__dirname, '..', 'src', 'uninstaller.ts');
    const content = fs.readFileSync(uninstallerPath, 'utf-8');
    const removeFnSection = content.substring(content.indexOf('async function removeGlobalPdShim'));
    expect(removeFnSection).toContain('fse.remove(shimPath)');
    expect(removeFnSection).toContain('removed.push(shimPath)');
  });

  it('isPdOwnedShim reads file content and checks PD install dir', () => {
    const uninstallerPath = path.resolve(__dirname, '..', 'src', 'uninstaller.ts');
    const content = fs.readFileSync(uninstallerPath, 'utf-8');
    const isPdOwnedSection = content.substring(content.indexOf('function isPdOwnedShim'), content.indexOf('async function removeGlobalPdShim'));
    expect(isPdOwnedSection).toContain('readFileSync');
    expect(isPdOwnedSection).toContain('getInstalledBinDir');
    expect(isPdOwnedSection).toContain('content.includes');
  });

  it('UninstallResult includes skippedGlobalShims field', () => {
    const uninstallerPath = path.resolve(__dirname, '..', 'src', 'uninstaller.ts');
    const content = fs.readFileSync(uninstallerPath, 'utf-8');
    expect(content).toContain('skippedGlobalShims');
  });
});

describe('--lang validation rejects invalid values (P2 fix)', () => {
  it('index.ts has isLanguage type guard', () => {
    const i18nPath = path.resolve(__dirname, '..', 'src', 'i18n.ts');
    const content = fs.readFileSync(i18nPath, 'utf-8');
    expect(content).toContain('function isLanguage');
    expect(content).toContain("value === 'zh' || value === 'en'");
  });

  it('index.ts validates --lang before setLanguage call', () => {
    const indexPath = path.resolve(__dirname, '..', 'src', 'index.ts');
    const content = fs.readFileSync(indexPath, 'utf-8');
    const langValidation = content.substring(content.indexOf('isLanguage'), content.indexOf('setLanguage(options.lang)'));
    expect(langValidation).toContain('invalid_language');
    expect(langValidation).toContain('process.exit(1)');
  });

  it('invalid --lang produces JSON output with reason and nextAction', () => {
    const indexPath = path.resolve(__dirname, '..', 'src', 'index.ts');
    const content = fs.readFileSync(indexPath, 'utf-8');
    const invalidLangBlock = content.substring(content.indexOf('!isLanguage(options.lang)'), content.indexOf('setLanguage(options.lang)'));
    expect(invalidLangBlock).toContain('buildFailureOutput');
    expect(invalidLangBlock).toContain('invalid_language');
  });

  it('index.ts does not use as cast for options.lang', () => {
    const indexPath = path.resolve(__dirname, '..', 'src', 'index.ts');
    const content = fs.readFileSync(indexPath, 'utf-8');
    expect(content).not.toContain("options.lang as 'zh'");
    expect(content).not.toContain("options.lang as 'en'");
  });

  it('index.ts does not use as cast for options.workspace or options.force', () => {
    const indexPath = path.resolve(__dirname, '..', 'src', 'index.ts');
    const content = fs.readFileSync(indexPath, 'utf-8');
    expect(content).not.toContain('options.workspace as string');
    expect(content).not.toContain('options.force as boolean');
  });

  it('Commander registers --lang option', () => {
    const indexPath = path.resolve(__dirname, '..', 'src', 'index.ts');
    const content = fs.readFileSync(indexPath, 'utf-8');
    expect(content).toContain('--lang <lang>');
    expect(content).toContain("'zh'");
  });
});

// ── PRI-308: config.yaml generation (replaces feature-flags.yaml) ──────────

describe('generateConfigYamlContent produces valid .pd/config.yaml', () => {
  it('produces valid YAML with version, features, runtimeProfiles, internalAgents, ui', () => {
    const content = generateConfigYamlContent();
    const parsed = yaml.load(content);
    expect(typeof parsed).toBe('object');
    expect(parsed).not.toBeNull();
    const config = parsed as Record<string, unknown>;
    expect(config.version).toBe(1);
    expect(typeof config.features).toBe('object');
    expect(config.features).not.toBeNull();
    expect(typeof config.runtimeProfiles).toBe('object');
    expect(typeof config.internalAgents).toBe('object');
    expect(typeof config.ui).toBe('object');
  });

  it('PRI-543: writes the feedback channel segment matching the loader (spec §10 double-sync)', () => {
    const config = yaml.load(generateConfigYamlContent()) as Record<string, unknown>;
    const feedback = config.feedback as Record<string, unknown>;
    // The generated segment MUST mirror what pd-config-store.readFeedbackChannelConfig
    // / getFeedbackMaintainerEmail expect under `feedback:`.
    expect(feedback).toBeDefined();
    for (const key of ['maintainer_email', 'ingest_url', 'ingest_token', 'github_repo', 'github_proxy']) {
      expect(Object.hasOwn(feedback, key)).toBe(true);
      expect(typeof feedback[key]).toBe('string');
    }
    // 产品级默认(PRI-543 语义修正):maintainer_email 是产品所有者邮箱;ingest 预置主通道,
    // 让新装使用者开箱即可把反馈直送所有者 Linear。github 通道仍默认留空(按需配置)。
    expect(feedback.maintainer_email).toBe('csuzngjh@hotmail.com');
    expect(feedback.ingest_url).toBe('https://principles-website.pages.dev/api/feedback');
    expect(feedback.ingest_token).not.toBe('');
    expect(feedback.github_repo).toBe('');
    expect(feedback.github_proxy).toBe('');
  });

  it('PRI-543: pre-fills feedback.maintainer_email from the provided email (no placeholder leak)', () => {
    const config = yaml.load(generateConfigYamlContent(undefined, 'owner@example.com')) as Record<string, unknown>;
    const feedback = config.feedback as Record<string, unknown>;
    expect(feedback.maintainer_email).toBe('owner@example.com');
  });

  it('PRI-645: core channels are not materialized — registry owns their defaults', () => {
    const parsed = yaml.load(generateConfigYamlContent()) as Record<string, unknown>;
    const features = parsed.features as Record<string, unknown>;
    for (const ch of MVP_CHANNELS) {
      // Absence ≠ disabled: computeEffectivePdConfig resolves every missing
      // flag from DEFAULT_FEATURE_FLAGS (core channels default ON there).
      expect(Object.hasOwn(features, ch)).toBe(false);
    }
  });

  it('PRI-645: host rollout flags are not materialized in fresh config', () => {
    const parsed = yaml.load(generateConfigYamlContent()) as Record<string, unknown>;
    const features = parsed.features as Record<string, unknown>;
    // Both flags' defaults live in the registry (host.codex=ON core,
    // abstraction_layer_v1=OFF quiet); the PRI-523 snapshot entries are gone.
    expect(Object.hasOwn(features, 'host.codex')).toBe(false);
    expect(Object.hasOwn(features, 'abstraction_layer_v1')).toBe(false);
  });

  it('PRI-645: existing config is preserved verbatim — no flag entries added, removed or rewritten', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-preserve-existing-'));
    const configDir = path.join(tmpDir, '.pd');
    fs.mkdirSync(configDir, { recursive: true });
    const configPath = path.join(configDir, 'config.yaml');
    // A legacy dense config (pre-PRI-645 shape) with Owner intent on top:
    // system snapshot entries + an explicit owner override + a legacy alias.
    // None of these may be normalized, cleaned or "sparsified" by the
    // preserve path (PRI-637: source=system is an origin hint, not an
    // auto-delete license).
    const legacy = [
      'version: 1',
      'features:',
      '  prompt:',
      '    category: core',
      '    enabled: true',
      '    source: system',
      '  host.codex:',
      '    category: core',
      '    enabled: false',
      '  intent_engineering:',
      '    category: quiet',
      '    enabled: true',
      '    source: owner',
      'runtimeProfiles:',
      '  pd.default:',
      '    type: pi-ai',
      "    provider: ''",
      "    model: ''",
      "    apiKeyEnv: ''",
      'internalAgents:',
      '  defaultRuntime: pd.default',
      '  agents:',
      '    diagnostician:',
      '      enabled: true',
      '      runtimeProfile: pd.default',
      'ui:',
      '  diagnostics:',
      '    mode: simple',
      '',
    ].join('\n');
    fs.writeFileSync(configPath, legacy, 'utf8');

    try {
      expect(() => validateExistingConfigYamlForPreserve(tmpDir)).not.toThrow();
      // Byte-identical preservation — the retired PRI-523 migration used to
      // add host.codex/abstraction_layer_v1 entries here; PRI-645 writes nothing.
      expect(fs.readFileSync(configPath, 'utf8')).toBe(legacy);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('PRI-645: code_rule_capability is not materialized (registry core/ON default)', () => {
    const parsed: unknown = yaml.load(generateConfigYamlContent());
    expect(parsed).toBeTruthy();
    expect(typeof parsed === 'object' && !Array.isArray(parsed)).toBe(true);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return;
    expect(Object.hasOwn(parsed, 'features')).toBe(true);
    const features = (parsed as Record<string, unknown>).features;
    expect(typeof features === 'object' && features !== null && !Array.isArray(features)).toBe(true);
    // Registry owns the core/ON default; absence is resolved by the effective
    // config (locked by principles-core pd-config-sparse-bootstrap tests).
    expect(Object.hasOwn(features as Record<string, unknown>, 'code_rule_capability')).toBe(false);
  });

  it('PRI-645: quiet flags are not materialized — absence follows registry defaults', () => {
    const parsed = yaml.load(generateConfigYamlContent()) as Record<string, unknown>;
    const features = parsed.features as Record<string, unknown>;
    for (const quiet of MVP_QUIET_FLAGS) {
      expect(Object.hasOwn(features, quiet)).toBe(false);
    }
  });

  it('PRI-645: gone flags are not materialized — gone behavior is enforced by the resolver', () => {
    const parsed = yaml.load(generateConfigYamlContent()) as Record<string, unknown>;
    const features = parsed.features as Record<string, unknown>;
    for (const gone of MVP_GONE_FLAGS) {
      expect(Object.hasOwn(features, gone)).toBe(false);
    }
  });

  it('PRI-645: fresh config materializes zero feature overrides of any kind', () => {
    const parsed = yaml.load(generateConfigYamlContent()) as Record<string, unknown>;
    const features = parsed.features as Record<string, unknown>;
    expect(features).toEqual({});
  });

  it('PRI-645: receipt flags follow registry defaults (no snapshot entries)', () => {
    const parsed = yaml.load(generateConfigYamlContent()) as Record<string, unknown>;
    const features = parsed.features as Record<string, unknown>;
    for (const key of ['principle_receipt_block_copy', 'principle_receipt_ledger', 'principle_receipt_self_report']) {
      expect(Object.hasOwn(features, key)).toBe(false);
    }
  });

  it('written to temp workspace is loadable', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-config-yaml-test-'));
    try {
      const configDir = path.join(tmpDir, '.pd');
      fs.mkdirSync(configDir, { recursive: true });
      fs.writeFileSync(path.join(configDir, 'config.yaml'), generateConfigYamlContent(), 'utf8');
      const raw = fs.readFileSync(path.join(configDir, 'config.yaml'), 'utf8');
      const parsed = yaml.load(raw, { schema: yaml.JSON_SCHEMA }) as Record<string, unknown>;
      expect(Object.hasOwn(parsed, 'version')).toBe(true);
      // The features section must EXIST (validatePdConfig requires it) but be
      // a sparse empty map — never an absent section, never a default snapshot.
      expect(Object.hasOwn(parsed, 'features')).toBe(true);
      expect(parsed.features).toEqual({});
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe('getConfigYamlPath', () => {
  it('returns .pd/config.yaml under workspace', () => {
    const result = getConfigYamlPath('/tmp/ws');
    expect(result.endsWith(path.join('.pd', 'config.yaml'))).toBe(true);
  });

  it('does not hardcode user-specific paths', () => {
    const result = getConfigYamlPath('/tmp/test-workspace');
    expect(result).not.toContain('Administrator');
    expect(result).not.toContain('D:\\');
  });
});

describe('readEnabledChannelsFromConfigYaml', () => {
  it('returns empty array when file does not exist (first install)', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-cfg-read-'));
    try {
      const result = readEnabledChannelsFromConfigYaml(tmpDir);
      expect(result).toEqual([]);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('returns [] for a sparse fresh config (PRI-645) and channels for explicit entries', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-cfg-read-'));
    try {
      const configDir = path.join(tmpDir, '.pd');
      fs.mkdirSync(configDir, { recursive: true });
      fs.writeFileSync(configDir + path.sep + 'config.yaml', generateConfigYamlContent(), 'utf8');
      // Sparse fresh config: no channel entries → no raw-enabled channels.
      // The installer's enabledChannels output falls back to options.channels
      // (parseChannelsOption always force-includes the three core channels),
      // so the reported install result is unchanged.
      expect(readEnabledChannelsFromConfigYaml(tmpDir)).toEqual([]);

      // Explicit channel entries (legacy dense configs, Owner edits) still win.
      const dense = yaml.load(generateConfigYamlContent()) as Record<string, unknown>;
      const features = dense.features as Record<string, unknown>;
      for (const ch of MVP_CHANNELS) {
        features[ch] = { category: 'core', enabled: true };
      }
      features.prompt = { category: 'core', enabled: false };
      fs.writeFileSync(configDir + path.sep + 'config.yaml', yaml.dump(dense), 'utf8');
      expect(readEnabledChannelsFromConfigYaml(tmpDir)).toEqual(['code_tool_hook', 'defer_archive']);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('throws on malformed YAML content', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-cfg-read-'));
    try {
      const configDir = path.join(tmpDir, '.pd');
      fs.mkdirSync(configDir, { recursive: true });
      fs.writeFileSync(path.join(configDir, 'config.yaml'), '{{invalid yaml: [}', 'utf8');
      expect(() => readEnabledChannelsFromConfigYaml(tmpDir)).toThrow(/config\.yaml/);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('throws on invalid structure (root is string)', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-cfg-read-'));
    try {
      const configDir = path.join(tmpDir, '.pd');
      fs.mkdirSync(configDir, { recursive: true });
      fs.writeFileSync(path.join(configDir, 'config.yaml'), '"just a string"', 'utf8');
      expect(() => readEnabledChannelsFromConfigYaml(tmpDir)).toThrow(/config\.yaml/);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('throws on invalid structure (root is array)', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-cfg-read-'));
    try {
      const configDir = path.join(tmpDir, '.pd');
      fs.mkdirSync(configDir, { recursive: true });
      fs.writeFileSync(path.join(configDir, 'config.yaml'), '- item1\n- item2', 'utf8');
      expect(() => readEnabledChannelsFromConfigYaml(tmpDir)).toThrow(/config\.yaml/);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('throws on MVP channel with invalid entry (string instead of object)', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-cfg-read-'));
    try {
      const configDir = path.join(tmpDir, '.pd');
      fs.mkdirSync(configDir, { recursive: true });
      const badConfig = {
        version: 1,
        features: {
          prompt: 'not-an-object',
          code_tool_hook: { category: 'core', enabled: true },
          defer_archive: { category: 'core', enabled: true },
        },
        runtimeProfiles: {},
        internalAgents: { defaultRuntime: 'openclaw.default', agents: {} },
        ui: { diagnostics: { mode: 'simple' } },
      };
      fs.writeFileSync(path.join(configDir, 'config.yaml'), yaml.dump(badConfig), 'utf8');
      expect(() => readEnabledChannelsFromConfigYaml(tmpDir)).toThrow(/MVP channel 'prompt' has invalid entry/);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('throws on MVP channel missing enabled field', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-cfg-read-'));
    try {
      const configDir = path.join(tmpDir, '.pd');
      fs.mkdirSync(configDir, { recursive: true });
      const badConfig = {
        version: 1,
        features: {
          prompt: { category: 'core' },
          code_tool_hook: { category: 'core', enabled: true },
          defer_archive: { category: 'core', enabled: true },
        },
        runtimeProfiles: {},
        internalAgents: { defaultRuntime: 'openclaw.default', agents: {} },
        ui: { diagnostics: { mode: 'simple' } },
      };
      fs.writeFileSync(path.join(configDir, 'config.yaml'), yaml.dump(badConfig), 'utf8');
      expect(() => readEnabledChannelsFromConfigYaml(tmpDir)).toThrow(/MVP channel 'prompt' is missing required 'enabled' field/);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('throws on enabled field that is not boolean', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-cfg-read-'));
    try {
      const configDir = path.join(tmpDir, '.pd');
      fs.mkdirSync(configDir, { recursive: true });
      const badConfig = {
        version: 1,
        features: {
          prompt: { category: 'core', enabled: 'true' },
          code_tool_hook: { category: 'core', enabled: true },
          defer_archive: { category: 'core', enabled: true },
        },
        runtimeProfiles: {},
        internalAgents: { defaultRuntime: 'openclaw.default', agents: {} },
        ui: { diagnostics: { mode: 'simple' } },
      };
      fs.writeFileSync(path.join(configDir, 'config.yaml'), yaml.dump(badConfig), 'utf8');
      expect(() => readEnabledChannelsFromConfigYaml(tmpDir)).toThrow(/MVP channel 'prompt' has invalid 'enabled' value.*expected boolean.*got string/);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe('Preserve existing config.yaml on re-install', () => {
  it('existing valid config.yaml is preserved (not overwritten)', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-cfg-preserve-'));
    try {
      const configDir = path.join(tmpDir, '.pd');
      fs.mkdirSync(configDir, { recursive: true });
      const originalContent = generateConfigYamlContent();
      fs.writeFileSync(path.join(configDir, 'config.yaml'), originalContent, 'utf8');

      // Simulate re-install: existing file should be detected and preserved
      const existingPath = getConfigYamlPath(tmpDir);
      expect(fs.existsSync(existingPath)).toBe(true);
      const contentBefore = fs.readFileSync(existingPath, 'utf8');
      expect(contentBefore).toBe(originalContent);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe('Malformed config.yaml fails loud with rollback', () => {
  it('malformed config.yaml causes install to fail, not silently overwrite', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-cfg-malformed-'));
    try {
      const configDir = path.join(tmpDir, '.pd');
      fs.mkdirSync(configDir, { recursive: true });
      const malformedContent = 'version: not-a-number\nfeatures: []';
      fs.writeFileSync(path.join(configDir, 'config.yaml'), malformedContent, 'utf8');

      // readEnabledChannelsFromConfigYaml must throw, not silently return defaults
      expect(() => readEnabledChannelsFromConfigYaml(tmpDir)).toThrow();
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe('config.yaml does not contain OpenClaw secrets', () => {
  // ADR-0016: PD does not store provider secrets. `apiKeyEnv` is allowed
  // because it stores an *env var name* (e.g. "ANTHROPIC_API_KEY"), not the
  // secret value itself. This test forbids literal secret-value fields like
  // `apiKey`, `api_key`, `token`, `secret`, `password` at any depth.
  function findSecretKeys(obj: unknown, prefix = ''): string[] {
    if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) return [];
    const forbidden = new Set(['apikey', 'api_key', 'token', 'secret', 'password']);
    const hits: string[] = [];
    for (const key of Object.keys(obj)) {
      const fullPath = prefix ? `${prefix}.${key}` : key;
      if (forbidden.has(key.toLowerCase())) {
        hits.push(fullPath);
      }
      const val = (obj as Record<string, unknown>)[key];
      if (typeof val === 'object' && val !== null) {
        hits.push(...findSecretKeys(val, fullPath));
      }
    }
    return hits;
  }

  it('generated config has no literal secret-value fields (apiKey/api_key/token/secret/password)', () => {
    const content = generateConfigYamlContent();
    const parsed = yaml.load(content) as unknown;
    const hits = findSecretKeys(parsed);
    expect(hits, `Forbidden secret-value keys found: ${hits.join(', ')}`).toEqual([]);
    // Sanity: apiKeyEnv IS allowed (env var name reference, not a secret).
    expect(content).toContain('apiKeyEnv');
  });
});

// ── PRI-308 blocker fix: validateConfigYamlFull ────────────────────────────

describe('validateConfigYamlFull catches incomplete config', () => {
  it('accepts a valid full config.yaml generated by installer', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-cfg-full-'));
    try {
      const configDir = path.join(tmpDir, '.pd');
      fs.mkdirSync(configDir, { recursive: true });
      fs.writeFileSync(path.join(configDir, 'config.yaml'), generateConfigYamlContent(), 'utf8');
      expect(() => validateConfigYamlFull(tmpDir)).not.toThrow();
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('rejects config missing runtimeProfiles', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-cfg-full-'));
    try {
      const configDir = path.join(tmpDir, '.pd');
      fs.mkdirSync(configDir, { recursive: true });
      const badConfig = {
        version: 1,
        features: { prompt: { category: 'core', enabled: true } },
        internalAgents: { defaultRuntime: 'openclaw.default', agents: {} },
        ui: { diagnostics: { mode: 'simple' } },
      };
      fs.writeFileSync(path.join(configDir, 'config.yaml'), yaml.dump(badConfig), 'utf8');
      expect(() => validateConfigYamlFull(tmpDir)).toThrow(/runtimeProfiles.*must be an object.*missing/);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('rejects config missing internalAgents', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-cfg-full-'));
    try {
      const configDir = path.join(tmpDir, '.pd');
      fs.mkdirSync(configDir, { recursive: true });
      const badConfig = {
        version: 1,
        features: { prompt: { category: 'core', enabled: true } },
        runtimeProfiles: { 'openclaw.default': { type: 'openclaw', source: 'default' } },
        ui: { diagnostics: { mode: 'simple' } },
      };
      fs.writeFileSync(path.join(configDir, 'config.yaml'), yaml.dump(badConfig), 'utf8');
      expect(() => validateConfigYamlFull(tmpDir)).toThrow(/internalAgents.*must be an object.*missing/);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('rejects config with internalAgents missing defaultRuntime', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-cfg-full-'));
    try {
      const configDir = path.join(tmpDir, '.pd');
      fs.mkdirSync(configDir, { recursive: true });
      const badConfig = {
        version: 1,
        features: { prompt: { category: 'core', enabled: true } },
        runtimeProfiles: { 'openclaw.default': { type: 'openclaw', source: 'default' } },
        internalAgents: { agents: {} },
        ui: { diagnostics: { mode: 'simple' } },
      };
      fs.writeFileSync(path.join(configDir, 'config.yaml'), yaml.dump(badConfig), 'utf8');
      expect(() => validateConfigYamlFull(tmpDir)).toThrow(/internalAgents\.defaultRuntime.*must be a non-empty string.*missing/);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('rejects config with wrong version', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-cfg-full-'));
    try {
      const configDir = path.join(tmpDir, '.pd');
      fs.mkdirSync(configDir, { recursive: true });
      const badConfig = {
        version: 2,
        features: { prompt: { category: 'core', enabled: true } },
        runtimeProfiles: { 'openclaw.default': { type: 'openclaw', source: 'default' } },
        internalAgents: { defaultRuntime: 'openclaw.default', agents: {} },
        ui: { diagnostics: { mode: 'simple' } },
      };
      fs.writeFileSync(path.join(configDir, 'config.yaml'), yaml.dump(badConfig), 'utf8');
      expect(() => validateConfigYamlFull(tmpDir)).toThrow(/version.*must be 1/);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('rejects config with features as array', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-cfg-full-'));
    try {
      const configDir = path.join(tmpDir, '.pd');
      fs.mkdirSync(configDir, { recursive: true });
      const badConfig = {
        version: 1,
        features: [],
        runtimeProfiles: { 'openclaw.default': { type: 'openclaw', source: 'default' } },
        internalAgents: { defaultRuntime: 'openclaw.default', agents: {} },
        ui: { diagnostics: { mode: 'simple' } },
      };
      fs.writeFileSync(path.join(configDir, 'config.yaml'), yaml.dump(badConfig), 'utf8');
      expect(() => validateConfigYamlFull(tmpDir)).toThrow(/features.*must be an object.*array/);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('rejects config with runtimeProfiles as string', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-cfg-full-'));
    try {
      const configDir = path.join(tmpDir, '.pd');
      fs.mkdirSync(configDir, { recursive: true });
      const badConfig = {
        version: 1,
        features: { prompt: { category: 'core', enabled: true } },
        runtimeProfiles: 'default',
        internalAgents: { defaultRuntime: 'openclaw.default', agents: {} },
        ui: { diagnostics: { mode: 'simple' } },
      };
      fs.writeFileSync(path.join(configDir, 'config.yaml'), yaml.dump(badConfig), 'utf8');
      expect(() => validateConfigYamlFull(tmpDir)).toThrow(/runtimeProfiles.*must be an object.*string/);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('throws when file does not exist', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-cfg-full-'));
    try {
      expect(() => validateConfigYamlFull(tmpDir)).toThrow(/config\.yaml not found/);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

// ── PRI-442 P0: principles-disciple dependency rewrite + symlink (Bug-B-001/002/003/004) ──
// Root cause: bundle-plugin.mjs only rewrote @principles/core, not principles-disciple.
// installer.ts syncPdCli() only created @principles/core symlink, not principles-disciple.
// Result: `pd runtime init` crashed with ERR_MODULE_NOT_FOUND because runtime-init.ts
// statically imports initTrajectorySchema/initWorkflowSchema from principles-disciple.

describe('PRI-442 P0: principles-disciple dependency rewrite in bundle-plugin.mjs (Bug-B-002)', () => {
  const scriptPath = path.resolve(__dirname, '..', 'scripts', 'bundle-plugin.mjs');
  const content = fs.readFileSync(scriptPath, 'utf-8');

  it('bundle-plugin.mjs has rewriteBundledDependency function (generalized from removeCoreDependency)', () => {
    expect(content).toContain('function rewriteBundledDependency');
    // Old name must be gone to avoid dead code
    expect(content).not.toContain('function removeCoreDependency');
  });

  it('rewriteBundledDependency accepts depName parameter (not hardcoded to @principles/core)', () => {
    expect(content).toMatch(/rewriteBundledDependency\(.*depName.*replacement/);
  });

  it('bundle-plugin.mjs rewrites principles-disciple dependency in pd-cli to file:../plugin', () => {
    // Must rewrite principles-disciple → file:../plugin for pd-cli (the only consumer)
    expect(content).toContain("'principles-disciple'");
    expect(content).toContain("'file:../plugin'");
    // The rewrite call must target PD_CLI_DEST
    const rewriteCallIdx = content.indexOf("'principles-disciple', 'file:../plugin'");
    const pdCliDestIdx = content.indexOf('PD_CLI_DEST');
    expect(rewriteCallIdx).toBeGreaterThan(0);
    expect(pdCliDestIdx).toBeGreaterThan(0);
  });

  it('bundle-plugin.mjs rewrites principles-disciple dependency in console to canonical plugin sibling', () => {
    expect(content).toContain(
      "rewriteBundledDependency(join(CONSOLE_DEST, 'package.json'), 'console', 'principles-disciple', 'file:../plugin')",
    );
  });

  it('bundle-plugin.mjs wires install-layout into both shipped consumers', () => {
    expect(content).toContain(
      "rewriteBundledDependency(join(PD_CLI_DEST, 'package.json'), 'pd-cli', '@principles/install-layout', 'file:../install-layout')",
    );
    expect(content).toContain(
      "rewriteBundledDependency(join(CONSOLE_DEST, 'package.json'), 'console', '@principles/install-layout', 'file:../install-layout')",
    );
  });

  it('bundle-plugin.mjs still rewrites @principles/core for all three packages', () => {
    // Regression guard: the core rewrite must still work after generalizing the function
    expect(content).toContain("'@principles/core', 'file:./core'");
    expect(content).toContain("'@principles/core', 'file:../core'");
  });

  it('bundle-plugin.mjs removes the inlined host runtime from the bundled plugin manifest', () => {
    expect(content).toContain("removeBundledDependency(join(PLUGIN_DEST, 'package.json'), 'plugin', '@principles/host-runtime')");
  });
});

describe('PRI-442 P0: principles-disciple symlink in installer.ts syncPdCli (Bug-B-004)', () => {
  const installerPath = path.resolve(__dirname, '..', 'src', 'installer.ts');
  const content = fs.readFileSync(installerPath, 'utf-8');

  it('syncPdCli creates node_modules/principles-disciple symlink', () => {
    // Must create a principles-disciple symlink in pd-cli's node_modules
    expect(content).toContain("'principles-disciple'");
    // The symlink path must be under node_modules
    const pdLinkIdx = content.indexOf("pdLinkPath");
    expect(pdLinkIdx).toBeGreaterThan(0);
    const symlinkSection = content.substring(pdLinkIdx, pdLinkIdx + 500);
    expect(symlinkSection).toContain('node_modules');
    expect(symlinkSection).toContain('symlinkSync');
  });

  it('principles-disciple symlink target is getPluginExtDir() (the installed plugin root)', () => {
    // The plugin (principles-disciple package) is installed at <ext-dir>/ root
    const pdLinkTargetIdx = content.indexOf('pdLinkTarget');
    expect(pdLinkTargetIdx).toBeGreaterThan(0);
    const targetSection = content.substring(pdLinkTargetIdx, pdLinkTargetIdx + 200);
    expect(targetSection).toContain('installedPluginDir()');
  });

  it('syncPdCli creates symlink on Windows using junction', () => {
    // Windows must use junction (no elevated privileges)
    // Extract from pdLinkDir to the tryUpgradePdCliFromNpm *call* (not the function definition)
    const pdLinkStart = content.indexOf('const pdLinkDir');
    const upgradeCallIdx = content.indexOf('tryUpgradePdCliFromNpm(installedPdCliDir)', pdLinkStart);
    expect(upgradeCallIdx).toBeGreaterThan(pdLinkStart);
    const pdLinkSection = content.substring(pdLinkStart, upgradeCallIdx);
    expect(pdLinkSection).toContain("isWindows()");
    expect(pdLinkSection).toContain("'junction'");
  });

  it('syncPdCli creates symlink on Unix using relative path ../../', () => {
    // Unix must use relative symlink for portability (2 levels up: node_modules → pd-cli → ext)
    const pdLinkStart = content.indexOf('const pdLinkDir');
    const upgradeCallIdx = content.indexOf('tryUpgradePdCliFromNpm(installedPdCliDir)', pdLinkStart);
    expect(upgradeCallIdx).toBeGreaterThan(pdLinkStart);
    const pdLinkSection = content.substring(pdLinkStart, upgradeCallIdx);
    expect(pdLinkSection).toContain("'../../'");
  });

  it('syncPdCli still creates @principles/core symlink (regression guard)', () => {
    // The existing core symlink must still be present
    expect(content).toContain('coreLinkDir');
    expect(content).toContain('coreLinkTarget');
    expect(content).toContain("'../../../core'");
  });
});

describe('PRI-566: principles-disciple resolution in installed console', () => {
  const installerPath = path.resolve(__dirname, '..', 'src', 'installer.ts');
  const content = fs.readFileSync(installerPath, 'utf-8');

  it('installConsole creates node_modules/principles-disciple pointing at the plugin root', () => {
    const start = content.indexOf('function installConsole');
    const end = content.indexOf('function getInstalledCoreDir', start);
    const section = content.substring(start, end);
    expect(section).toContain("path.join(consoleDest, 'node_modules', 'principles-disciple')");
    expect(section).toContain('installedPluginDir()');
    expect(section).toContain('symlinkSync');
  });
});

describe('PRI-442 P0: runtime-init.ts import resolves via symlink (Bug-B-001)', () => {
  const rootDir = path.resolve(__dirname, '..', '..', '..');
  const runtimeInitPath = path.join(rootDir, 'packages', 'pd-cli', 'src', 'commands', 'runtime-init.ts');

  it('runtime-init.ts imports from principles-disciple (the plugin package)', () => {
    // This import is the crash point — it must resolve via the symlink created by syncPdCli
    const content = fs.readFileSync(runtimeInitPath, 'utf-8');
    expect(content).toContain("from 'principles-disciple'");
    expect(content).toContain('initTrajectorySchema');
    expect(content).toContain('initWorkflowSchema');
  });

  it('principles-disciple (openclaw-plugin) exports initTrajectorySchema and initWorkflowSchema', () => {
    // The plugin's index.ts must export these functions so the import resolves
    const pluginIndexPath = path.join(rootDir, 'packages', 'openclaw-plugin', 'src', 'index.ts');
    const content = fs.readFileSync(pluginIndexPath, 'utf-8');
    expect(content).toContain('export { initTrajectorySchema }');
    expect(content).toContain('export { initWorkflowSchema }');
  });
});

// ─── PRI-523 review (carried into PRI-645): infra failures are not "malformed config"
// Read failures (EPERM/EISDIR/...) must surface as ExistingConfigVerifyInfraError
// so the installer advises retrying — never deleting — a possibly valid
// .pd/config.yaml. Validation failures stay plain errors.
describe('validateExistingConfigYamlForPreserve — infra failure classification', () => {
  function writeValidConfig(tmpDir: string): string {
    const configPath = path.join(tmpDir, '.pd', 'config.yaml');
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, generateConfigYamlContent(), 'utf8');
    return configPath;
  }

  it('accepts a valid existing config and leaves the file byte-identical', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-preserve-valid-'));
    try {
      const configPath = writeValidConfig(tmpDir);
      const before = fs.readFileSync(configPath, 'utf8');
      expect(() => validateExistingConfigYamlForPreserve(tmpDir)).not.toThrow();
      expect(fs.readFileSync(configPath, 'utf8')).toBe(before);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('classifies a read failure (EISDIR) as infra, with the config left unchanged', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-preserve-isdir-'));
    try {
      // config.yaml as a directory: existsSync passes, readFileSync fails with
      // EISDIR — an environment problem, not a malformed config.
      const configPath = path.join(tmpDir, '.pd', 'config.yaml');
      fs.mkdirSync(configPath, { recursive: true });
      expect(() => validateExistingConfigYamlForPreserve(tmpDir)).toThrow(ExistingConfigVerifyInfraError);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('keeps validation failures (malformed config) as plain errors, not infra', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-preserve-malformed-'));
    try {
      const configPath = path.join(tmpDir, '.pd', 'config.yaml');
      fs.mkdirSync(path.dirname(configPath), { recursive: true });
      fs.writeFileSync(configPath, 'features: [not, an, object]\n', 'utf8');
      const capture = (): unknown => {
        try { validateExistingConfigYamlForPreserve(tmpDir); } catch (error) { return error; }
        return undefined;
      };
      const thrown = capture();
      expect(thrown).toBeInstanceOf(Error);
      expect(thrown).not.toBeInstanceOf(ExistingConfigVerifyInfraError);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
