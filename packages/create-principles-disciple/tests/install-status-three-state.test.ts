/**
 * `status` must report the SAME three independent host facts the install
 * summary reports (SPEC §6.4, install ≠ enable):
 *
 *   1. registration     ← `installed_plugins.json` (and whether it is readable)
 *   2. host enablement  ← `settings.json` → `enabledPlugins`
 *   3. governance gates ← `.pd/config.yaml` `host.workbuddy` +
 *                          `workbuddy_live_keyword_pain`
 *
 * It reads those three sources for real and renders them through the ONE
 * authority (`formatHostStateSummary`). An unreadable source renders
 * UNKNOWN / UNREADABLE — never a guessed value.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { getWorkbuddyWorkspaceDir } from '@principles/install-layout';
import { formatHostStateSummary, type HostStateSummaryResult } from '../src/install-summary.js';
import {
  WORKBUDDY_PLUGIN_KEY,
  ensureWorkbuddyGovernanceEnabled,
  readWorkbuddyHostState,
  readWorkbuddyPluginState,
  resolveWorkbuddyPaths,
} from '../src/installers/workbuddy-host-installer.js';

let homeDir: string;
let configDir: string;
let previousConfigDir: string | undefined;

function writeJson(file: string, value: unknown): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(value, null, 2), 'utf-8');
}

function writeRaw(file: string, contents: string): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, contents, 'utf-8');
}

function configPath(): string {
  return path.join(getWorkbuddyWorkspaceDir(homeDir), '.pd', 'config.yaml');
}

function writeGovernanceConfig(hostEnabled: boolean, keywordEnabled: boolean): void {
  writeRaw(configPath(), [
    'version: 1',
    'features:',
    `  host.workbuddy: { enabled: ${hostEnabled}, category: quiet }`,
    `  workbuddy_live_keyword_pain: { enabled: ${keywordEnabled}, category: quiet }`,
    '',
  ].join('\n'));
}

function writeRegistry(registered: boolean): void {
  writeJson(path.join(configDir, 'plugins', 'installed_plugins.json'), {
    version: 2,
    plugins: registered ? { [WORKBUDDY_PLUGIN_KEY]: [{ scope: 'user', version: '0.3.0' }] } : {},
  });
}

function writeSettings(enabled: boolean | null): void {
  writeJson(path.join(configDir, 'settings.json'), {
    enabledPlugins: enabled === null ? {} : { [WORKBUDDY_PLUGIN_KEY]: enabled },
  });
}

function statusLines(): string[] {
  return formatHostStateSummary([readWorkbuddyHostState(homeDir)], true);
}

beforeEach(() => {
  homeDir = mkdtempSync(path.join(os.tmpdir(), 'pd-status-home-'));
  configDir = mkdtempSync(path.join(os.tmpdir(), 'pd-status-config-'));
  previousConfigDir = process.env.WORKBUDDY_CONFIG_DIR;
  process.env.WORKBUDDY_CONFIG_DIR = configDir;
});

afterEach(() => {
  if (previousConfigDir === undefined) delete process.env.WORKBUDDY_CONFIG_DIR;
  else process.env.WORKBUDDY_CONFIG_DIR = previousConfigDir;
  rmSync(homeDir, { recursive: true, force: true });
  rmSync(configDir, { recursive: true, force: true });
});

describe('status — WorkBuddy plugin state is read, not inferred', () => {
  it('1. not installed: no registry entry and no governance config', () => {
    const lines = statusLines();

    expect(lines).toContain('  WorkBuddy plugin ................. NOT INSTALLED');
    expect(lines).toContain('  WorkBuddy governance ............. UNKNOWN (config unreadable)');
    expect(lines).toContain('Re-run the installer to register Principles Disciple in WorkBuddy plugin management.');
    expect(lines.join('\n')).not.toContain('INSTALLED / ');
    expect(lines.join('\n')).not.toContain('Automatic keyword Pain');
  });

  it('2. installed but disabled: INSTALLED / DISABLED with the real governance gates', () => {
    writeRegistry(true);
    writeSettings(false);
    writeGovernanceConfig(true, false);

    const lines = statusLines();

    expect(lines).toContain('  WorkBuddy plugin ................. INSTALLED / DISABLED');
    expect(lines).toContain('  WorkBuddy governance ............. ON');
    expect(lines).toContain('  Automatic keyword Pain ........... OFF');
    expect(lines).toContain('  Manual PD记录痛苦：............... available once the plugin is enabled');
    expect(lines).toContain('Enable Principles Disciple in WorkBuddy plugin management.');
    expect(lines).toContain('Hooks stay INACTIVE while the plugin is disabled, so "PD记录痛苦：" is not delivered.');
  });

  it('3. installed and enabled: INSTALLED / ENABLED and manual entry available', () => {
    writeRegistry(true);
    writeSettings(true);
    writeGovernanceConfig(true, false);

    const lines = statusLines();

    expect(lines).toContain('  WorkBuddy plugin ................. INSTALLED / ENABLED');
    expect(lines).toContain('  Manual PD记录痛苦：............... available');
    expect(lines.join('\n')).not.toContain('Next action:');
    expect(lines.join('\n')).not.toContain('Hooks stay INACTIVE');
  });

  it('4. unreadable registry: REGISTRY UNREADABLE / NOT VERIFIED, never INSTALLED', () => {
    writeRaw(path.join(configDir, 'plugins', 'installed_plugins.json'), '{ this is not json');
    writeSettings(true);
    writeGovernanceConfig(true, false);

    const lines = statusLines();

    expect(lines).toContain('  WorkBuddy plugin ................. REGISTRY UNREADABLE / NOT VERIFIED');
    expect(lines).toContain('The WorkBuddy plugin registry (installed_plugins.json) could not be read — installation is UNVERIFIED.');
    expect(lines.join('\n')).not.toContain('INSTALLED / ');
  });

  it('5. registered but enablement unknown (settings.json absent)', () => {
    writeRegistry(true);
    writeGovernanceConfig(true, false);

    const lines = statusLines();

    expect(lines).toContain('  WorkBuddy plugin ................. INSTALLED / ENABLEMENT UNKNOWN');
    expect(lines).toContain('Check Principles Disciple in WorkBuddy plugin management: its enabled state could not be read.');
    expect(lines.join('\n')).not.toContain('INSTALLED / ENABLED');
  });

  it('reports an unset governance flag as OFF, never the install-time ON projection', () => {
    writeRegistry(true);
    writeSettings(true);
    writeRaw(configPath(), 'version: 1\nfeatures: {}\n');

    const lines = statusLines();

    expect(lines).toContain('  WorkBuddy governance ............. OFF');
    expect(lines).toContain('  Automatic keyword Pain ........... OFF');
    expect(lines.join('\n')).not.toContain('explicit opt-out');
  });

  it('reports an explicit governance opt-out as OFF and names it', () => {
    writeRegistry(true);
    writeSettings(true);
    writeGovernanceConfig(false, false);

    const lines = statusLines();

    expect(lines).toContain('  WorkBuddy governance ............. OFF (your explicit opt-out was preserved)');
    expect(lines.join('\n')).toContain('             to enable: in ');
  });

  it('reads the keyword gate from the config: ON when the config says ON', () => {
    writeRegistry(true);
    writeSettings(true);
    writeGovernanceConfig(true, true);

    const lines = statusLines();

    expect(lines).toContain('  Automatic keyword Pain ........... ON');
  });

  it('unreadable governance config: UNKNOWN with the real reason, gates never guessed', () => {
    writeRegistry(true);
    writeSettings(true);
    writeRaw(configPath(), 'features: [unclosed\n');

    const lines = statusLines();

    expect(lines).toContain('  WorkBuddy governance ............. UNKNOWN (config unreadable)');
    expect(lines.join('\n')).toContain('reason: fresh_workbuddy_config_unreadable');
    expect(lines.join('\n')).not.toContain('Automatic keyword Pain');
    expect(lines.join('\n')).not.toContain('to enable:');
  });

  it('renders the SAME lines as the install summary for the same on-disk state', () => {
    writeRegistry(true);
    writeSettings(false);
    writeGovernanceConfig(true, false);

    const paths = resolveWorkbuddyPaths(homeDir);
    const configBefore = readFileSync(configPath(), 'utf-8');
    const governance = ensureWorkbuddyGovernanceEnabled(paths.governanceDir);
    expect(governance.ok).toBe(true);
    if (!governance.ok) return;

    const installResult: HostStateSummaryResult = {
      success: true,
      hostId: 'workbuddy',
      pluginState: readWorkbuddyPluginState(paths),
      governance: {
        enabled: !governance.hostExplicitOff,
        explicitOptOut: governance.hostExplicitOff,
        keywordPainEnabled: governance.keywordPainEnabled,
        configPath: governance.configPath,
      },
    };

    expect(formatHostStateSummary([installResult], true)).toEqual(statusLines());
    // The read-only status path must not mutate the governance config.
    expect(readFileSync(configPath(), 'utf-8')).toBe(configBefore);
  });
});
