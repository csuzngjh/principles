/**
 * The install summary must present THREE independent facts separately
 * (SPEC §6.4, install ≠ enable):
 *
 *   1. registration   ← WorkBuddy `installed_plugins.json`
 *   2. host enablement ← `settings.json` → `enabledPlugins`
 *   3. governance     ← `.pd/config.yaml` `host.workbuddy`
 *
 * "Governance ON" never means hooks run, and an unreadable registry never
 * means "installed". These tests pin the rendered text for each combination.
 */
import { describe, it, expect } from 'vitest';
import { formatHostStateSummary, type HostStateSummaryResult } from '../src/install-summary.js';

function workbuddy(overrides: Partial<HostStateSummaryResult> = {}): HostStateSummaryResult {
  return {
    success: true,
    hostId: 'workbuddy',
    pluginState: { registered: true, registryReadable: true, enabled: false },
    governance: { enabled: true, explicitOptOut: false, keywordPainEnabled: false },
    ...overrides,
  };
}

describe('formatHostStateSummary — WorkBuddy three-state block', () => {
  it('default install: INSTALLED / DISABLED, governance ON, keyword Pain OFF and a real enable path', () => {
    const lines = formatHostStateSummary([workbuddy()], true);

    expect(lines).toContain('  WorkBuddy plugin ................. INSTALLED / DISABLED');
    expect(lines).toContain('  WorkBuddy governance ............. ON');
    expect(lines).toContain('  Automatic keyword Pain ........... OFF');
    expect(lines).toContain('Next action:');
    expect(lines).toContain('Enable Principles Disciple in WorkBuddy plugin management.');
    expect(lines).toContain('Then start a new session or run /reload-plugins.');
    // Governance ON must never be implied to mean hooks are running.
    expect(lines).toContain('Hooks stay INACTIVE while the plugin is disabled, so "PD记录痛苦：" is not delivered.');
  });

  it('Owner-enabled install: INSTALLED / ENABLED with no activation guidance', () => {
    const lines = formatHostStateSummary([
      workbuddy({ pluginState: { registered: true, registryReadable: true, enabled: true } }),
    ], true);

    expect(lines).toContain('  WorkBuddy plugin ................. INSTALLED / ENABLED');
    expect(lines.join('\n')).not.toContain('Next action:');
    expect(lines.join('\n')).not.toContain('Hooks stay INACTIVE');
  });

  it('unreadable registry: never claims INSTALLED', () => {
    const lines = formatHostStateSummary([
      workbuddy({ pluginState: { registered: false, registryReadable: false, enabled: null } }),
    ], true);

    expect(lines).toContain('  WorkBuddy plugin ................. REGISTRY UNREADABLE / NOT VERIFIED');
    expect(lines.join('\n')).not.toContain('INSTALLED / ');
    expect(lines).toContain('The WorkBuddy plugin registry (installed_plugins.json) could not be read — installation is UNVERIFIED.');
  });

  it('readable registry without our entry: NOT INSTALLED', () => {
    const lines = formatHostStateSummary([
      workbuddy({ pluginState: { registered: false, registryReadable: true, enabled: null } }),
    ], true);

    expect(lines).toContain('  WorkBuddy plugin ................. NOT INSTALLED');
    expect(lines).toContain('Re-run the installer to register Principles Disciple in WorkBuddy plugin management.');
  });

  it('registered but enabledPlugins entry absent: ENABLEMENT UNKNOWN, not ENABLED', () => {
    const lines = formatHostStateSummary([
      workbuddy({ pluginState: { registered: true, registryReadable: true, enabled: null } }),
    ], true);

    expect(lines).toContain('  WorkBuddy plugin ................. INSTALLED / ENABLEMENT UNKNOWN');
    expect(lines).toContain('Check Principles Disciple in WorkBuddy plugin management: its enabled state could not be read.');
  });

  it('governance OFF: states the explicit opt-out and the exact flat-key edit', () => {
    const lines = formatHostStateSummary([
      workbuddy({ governance: { enabled: false, explicitOptOut: true, keywordPainEnabled: false, configPath: '/tmp/pd/config.yaml' } }),
    ], true);

    expect(lines).toContain('  WorkBuddy governance ............. OFF (your explicit opt-out was preserved)');
    expect(lines.join('\n')).toContain('to enable: in /tmp/pd/config.yaml');
  });

  it('prints NOTHING when the install failed, even if a partial host result exists', () => {
    expect(formatHostStateSummary([workbuddy()], false)).toEqual([]);
    expect(formatHostStateSummary([workbuddy({ success: false })], true)).toEqual([]);
    expect(formatHostStateSummary(undefined, true)).toEqual([]);
  });
});

describe('formatHostStateSummary — legacy hosts', () => {
  it('keeps the pre-existing single governance line for hosts without an enablement gate', () => {
    const lines = formatHostStateSummary([
      { success: true, hostId: 'openclaw', governance: { enabled: true, explicitOptOut: false, keywordPainEnabled: true } },
    ], true);

    expect(lines).toContain('  openclaw governance ............. ON (default), keyword Pain: ON');
    expect(lines.join('\n')).not.toContain('plugin .................');
  });
});
