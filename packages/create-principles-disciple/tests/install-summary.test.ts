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
import {
  formatHostStateSummary,
  buildPostInstallGuidance,
  formatPostInstallGuidanceLines,
  type HostStateSummaryResult,
} from '../src/install-summary.js';

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
    expect(lines).toContain('  Manual PD记录痛苦：............... available once the plugin is enabled');
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
    expect(lines).toContain('  Manual PD记录痛苦：............... available');
    expect(lines.join('\n')).not.toContain('Next action:');
    expect(lines.join('\n')).not.toContain('Hooks stay INACTIVE');
  });

  it('keeps automatic detection and manual entry on separate lines (plugin disabled)', () => {
    const lines = formatHostStateSummary([workbuddy()], true);
    const autoLine = lines.find((line) => line.includes('Automatic keyword Pain'));
    const manualLine = lines.find((line) => line.includes('Manual PD记录痛苦：'));
    expect(autoLine).toBe('  Automatic keyword Pain ........... OFF');
    expect(manualLine).toBe('  Manual PD记录痛苦：............... available once the plugin is enabled');
    expect(autoLine).not.toContain('PD记录痛苦');
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

// ─── buildPostInstallGuidance — per-host restart/verify derivation ───────────

describe('buildPostInstallGuidance — restart semantics per host', () => {
  const baseInput = {
    components: { cli: 'verified' as const },
    operatorWorkspaceDir: 'C:\\ws\\demo',
  };

  it('openclaw success: no restart required (the installer restarted the gateway), verify via pd health', () => {
    const guidance = buildPostInstallGuidance({
      ...baseInput,
      hostResults: [{ hostId: 'openclaw', success: true, nextAction: 'verify: openclaw plugin list' }],
    });
    const openclaw = guidance.hosts.find((host) => host.hostId === 'openclaw');
    expect(openclaw?.state).toBe('installed');
    expect(openclaw?.restartRequired).toBe(false);
    expect(openclaw?.restartHint).toContain('restarted the OpenClaw gateway automatically');
    expect(openclaw?.verifyCommand).toBe('pd health --host openclaw --workspace "C:\\ws\\demo" --json');
  });

  it('openclaw with a gatewayNotice flips to restart-required with the manual start hint', () => {
    const guidance = buildPostInstallGuidance({
      ...baseInput,
      hostResults: [{ hostId: 'openclaw', success: true, nextAction: 'verify' }],
      gatewayNotice: 'restart failed: exit 1',
    });
    const openclaw = guidance.hosts.find((host) => host.hostId === 'openclaw');
    expect(openclaw?.restartRequired).toBe(true);
    expect(openclaw?.restartHint).toContain('openclaw gateway start');
    expect(guidance.gatewayNotice).toBe('restart failed: exit 1');
  });

  it('codex manual action: state manual_action_required carries the host installer nextAction', () => {
    const guidance = buildPostInstallGuidance({
      ...baseInput,
      hostResults: [{
        hostId: 'codex',
        success: false,
        manualActionRequired: true,
        reason: 'codex marketplace not installed',
        nextAction: 'codex plugin add principles-disciple@principles',
      }],
    });
    const codex = guidance.hosts.find((host) => host.hostId === 'codex');
    expect(codex?.state).toBe('manual_action_required');
    expect(codex?.restartRequired).toBe(true);
    expect(codex?.restartHint).toContain('Start a new Codex session');
    expect(codex?.nextAction).toBe('codex plugin add principles-disciple@principles');
    expect(codex?.verifyCommand).toBe('pd health --host codex --workspace "C:\\ws\\demo" --json');
  });

  it('workbuddy success: restart required with the enable + new-session hint', () => {
    const guidance = buildPostInstallGuidance({
      ...baseInput,
      hostResults: [{ hostId: 'workbuddy', success: true, nextAction: 'x' }],
    });
    const workbuddyHost = guidance.hosts.find((host) => host.hostId === 'workbuddy');
    expect(workbuddyHost?.state).toBe('installed');
    expect(workbuddyHost?.restartRequired).toBe(true);
    expect(workbuddyHost?.restartHint).toContain('/reload-plugins');
    expect(workbuddyHost?.verifyCommand).toBe('pd health --host workbuddy --workspace "C:\\ws\\demo" --json');
  });

  it('a genuinely failed host reports failed (never manual_action_required)', () => {
    const guidance = buildPostInstallGuidance({
      ...baseInput,
      hostResults: [{ hostId: 'openclaw', success: false, reason: 'EPERM', nextAction: 'retry' }],
    });
    const openclaw = guidance.hosts.find((host) => host.hostId === 'openclaw');
    expect(openclaw?.state).toBe('failed');
    expect(openclaw?.reason).toBe('EPERM');
  });

  it('an unknown future host fails loud instead of guessing "no restart needed"', () => {
    const guidance = buildPostInstallGuidance({
      ...baseInput,
      hostResults: [{ hostId: 'newhost', success: true, nextAction: 'x' }],
    });
    const unknown = guidance.hosts.find((host) => host.hostId === 'newhost');
    expect(unknown?.restartRequired).toBe(true);
    expect(unknown?.restartHint).toContain('not recorded');
  });

  it('verified_local_only CLI degrades to the absolute shim path in every command', () => {
    const guidance = buildPostInstallGuidance({
      ...baseInput,
      hostResults: [{ hostId: 'openclaw', success: true, nextAction: 'x' }],
      components: { cli: 'verified_local_only', cliLocalPath: 'C:\\Users\\u\\.pd\\runtime\\bin\\pd.cmd' },
    });
    expect(guidance.cliCommand).toBe('"C:\\Users\\u\\.pd\\runtime\\bin\\pd.cmd"');
    expect(guidance.mcpProbeCommand).toContain('"C:\\Users\\u\\.pd\\runtime\\bin\\pd.cmd" mcp probe');
  });

  it('empty operatorWorkspaceDir omits the --workspace argument (generic/test form)', () => {
    const guidance = buildPostInstallGuidance({
      components: { cli: 'verified' },
      operatorWorkspaceDir: '',
      hostResults: [{ hostId: 'openclaw', success: true, nextAction: 'x' }],
    });
    expect(guidance.mcpProbeCommand).toBe('pd mcp probe --json');
  });

  it('renders the checklist block with take-effect, verify and the active MCP check', () => {
    const guidance = buildPostInstallGuidance({
      ...baseInput,
      hostResults: [{ hostId: 'codex', success: true, nextAction: 'x' }],
      consoleUrl: 'http://127.0.0.1:3100/#/welcome',
    });
    const lines = formatPostInstallGuidanceLines(guidance, 'Post-install checklist:').join('\n');
    expect(lines).toContain('Post-install checklist:');
    expect(lines).toContain('codex ... installed — host restart needed');
    expect(lines).toContain('take effect: Start a new Codex session');
    expect(lines).toContain('verify: pd health --host codex --workspace "C:\\ws\\demo" --json');
    expect(lines).toContain('active MCP check: pd mcp probe');
    expect(lines).toContain('console: http://127.0.0.1:3100/#/welcome');
  });
});
