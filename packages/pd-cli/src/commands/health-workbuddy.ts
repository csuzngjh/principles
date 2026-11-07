/**
 * WorkBuddy host-fact diagnostics for `pd health --host workbuddy`
 * (2026-11-07, install ≠ enable ≠ governance ≠ MCP ≠ runtime).
 *
 * Read-only. It separates FOUR independent facts and never infers one from
 * another (SPEC §6.4):
 *   1. plugin registration  — WorkBuddy installed_plugins.json (the host
 *      registry), via the SHARED install-layout interpreter (same judgment
 *      as the installer summary / `status`);
 *   2. plugin enablement    — settings.json enabledPlugins[key], tri-state;
 *      an unreadable settings file is UNKNOWN, never DISABLED;
 *   3. governance           — the PD feature flag `host.workbuddy` read from
 *      the governance workspace config the same way the production worker
 *      reads it (loadPdConfigForPlugin + computeFeatureFlagsFromConfig);
 *      an explicit Owner opt-out is reported as EXPLICITLY_DISABLED, never
 *      silently folded into a generic OFF;
 *   4. MCP static config    — the existing assessMcpHealth() section is the
 *      single authority for payload/binding/entry/pin/host-config/workspace
 *      integrity (unchanged); a present `pd-recall` MCP entry proves nothing
 *      about plugin registration or enablement.
 *
 * Runtime truthfulness (no probe): this module NEVER starts WorkBuddy, the
 * MCP server, or any tool call. `pd health` stays read-only:
 *   - MCP static config correct ≠ plugin enabled ≠ real host runtime OK
 *     ≠ model actually invoked a PD tool.
 * The facts carry probe.performed=false and modelToolCall=NOT_VERIFIED
 * explicitly instead of implying health from static evidence.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  getWorkbuddyHostConfigPaths,
  getWorkbuddyWorkspaceDir,
  interpretWorkbuddyPluginState,
  type WorkbuddyPluginStateView,
} from '@principles/install-layout';
import { loadPdConfigForPlugin } from '@principles/host-runtime';
import { computeFeatureFlagsFromConfig } from '@principles/core/runtime';

export type WorkbuddyGovernanceState = 'ENABLED' | 'EXPLICITLY_DISABLED' | 'DEFAULT_OFF' | 'UNKNOWN';

export interface WorkbuddyHostFacts {
  /** Registry + enablement, interpreted by the shared install-layout judgment. */
  plugin: WorkbuddyPluginStateView;
  governance: {
    state: WorkbuddyGovernanceState;
    /** The governance config file the flag was read from (null when absent/unreadable). */
    configPath: string | null;
    /** Structured reason when state === 'UNKNOWN' (rc-9). */
    reason?: string;
  };
  /** Honest runtime boundary: static health never implies a live host. */
  runtime: {
    /** Always false — pd health never spawns WorkBuddy or the MCP server. */
    probePerformed: false;
    reason: string;
    modelToolCall: 'NOT_VERIFIED';
  };
  paths: {
    registryPath: string;
    settingsPath: string;
    governanceDir: string;
  };
}

function isPlainJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Read + parse a JSON host file. Returns { ok:false } when unreadable/unparsable/non-object. */
function readJsonHostFile(filePath: string): { ok: true; value: Record<string, unknown> | undefined } | { ok: false; reason: string } {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (error) {
    const { code } = error as { code?: unknown };
    if (code === 'ENOENT') return { ok: true, value: undefined };
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isPlainJsonObject(parsed)) return { ok: false, reason: 'not a JSON object' };
    return { ok: true, value: parsed };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

export function assessWorkbuddyHostFacts(options: {
  homeDir?: string;
  configDirOverride?: string;
} = {}): WorkbuddyHostFacts {
  const homeDir = options.homeDir ?? os.homedir();
  // Same override the installer honors (WORKBUDDY_CONFIG_DIR, Phase 0 lab
  // discipline) — health must resolve the SAME registration root, never a
  // second path authority.
  const configDirOverride = options.configDirOverride ?? (process.env.WORKBUDDY_CONFIG_DIR !== undefined && process.env.WORKBUDDY_CONFIG_DIR.length > 0 ? process.env.WORKBUDDY_CONFIG_DIR : undefined);
  const hostPaths = getWorkbuddyHostConfigPaths(homeDir, configDirOverride);
  const governanceDir = getWorkbuddyWorkspaceDir(homeDir);

  // Facts 1 + 2 — shared interpretation (rc-1: parsed values stay unknown
  // until the interpreter validates them).
  const registry = readJsonHostFile(hostPaths.registryPath);
  const settings = readJsonHostFile(hostPaths.settingsPath);
  const plugin = interpretWorkbuddyPluginState({
    registryParsed: registry.ok ? registry.value : undefined,
    settingsParsed: settings.ok ? settings.value : undefined,
    registryReadable: registry.ok,
  });

  // Fact 3 — governance flag read the SAME way the production worker reads it.
  const governanceConfigPath = path.join(governanceDir, '.pd', 'config.yaml');
  let governance: WorkbuddyHostFacts['governance'];
  if (!fs.existsSync(governanceConfigPath)) {
    governance = { state: 'UNKNOWN', configPath: null, reason: 'governance workspace config absent (workspace not initialized?)' };
  } else {
    const loaded = loadPdConfigForPlugin(governanceDir);
    if (!loaded.ok || loaded.source === 'malformed') {
      governance = {
        state: 'UNKNOWN',
        configPath: governanceConfigPath,
        reason: loaded.errors[0]?.reason ?? 'the governance config could not be read/parsed',
      };
    } else {
      const flag = computeFeatureFlagsFromConfig(loaded.effective).flags['host.workbuddy'];
      // Explicit-vs-default distinction reads the loader-VALIDATED config
      // (rc-2: no second YAML parse): the presence of the flat
      // `features.host.workbuddy` key means the Owner's config wrote it.
      const configFeatures = isPlainJsonObject(loaded.effective.config) && isPlainJsonObject(loaded.effective.config.features)
        ? loaded.effective.config.features
        : undefined;
      const explicitEntry = configFeatures !== undefined && Object.hasOwn(configFeatures, 'host.workbuddy')
        ? configFeatures['host.workbuddy']
        : undefined;
      const explicitOff = explicitEntry !== undefined && isPlainJsonObject(explicitEntry) && explicitEntry.enabled === false;
      if (flag === undefined) {
        governance = { state: 'UNKNOWN', configPath: governanceConfigPath, reason: 'host.workbuddy flag missing from the effective flag set' };
      } else if (flag.enabled === true) {
        governance = { state: 'ENABLED', configPath: governanceConfigPath };
      } else if (explicitOff) {
        // The Owner's config explicitly disables the flag — reported as its
        // own state, never folded into a generic OFF.
        governance = { state: 'EXPLICITLY_DISABLED', configPath: governanceConfigPath };
      } else {
        governance = { state: 'DEFAULT_OFF', configPath: governanceConfigPath };
      }
    }
  }

  return {
    plugin,
    governance,
    runtime: {
      probePerformed: false,
      reason: 'pd health is read-only: it never starts WorkBuddy or the MCP server, so real runtime health is not probed.',
      modelToolCall: 'NOT_VERIFIED',
    },
    paths: {
      registryPath: hostPaths.registryPath,
      settingsPath: hostPaths.settingsPath,
      governanceDir,
    },
  };
}

const LABELS: Record<WorkbuddyGovernanceState, string> = {
  ENABLED: 'ENABLED',
  EXPLICITLY_DISABLED: 'EXPLICITLY_DISABLED (your explicit opt-out was preserved)',
  DEFAULT_OFF: 'DEFAULT_OFF (registry default — the config does not set the flag)',
  UNKNOWN: 'UNKNOWN (config unreadable)',
};

export function formatWorkbuddyHostFactLines(facts: WorkbuddyHostFacts): string[] {
  const lines: string[] = [];
  lines.push('workbuddyPlugin:');
  lines.push(`  registration: ${facts.plugin.registryReadable ? (facts.plugin.registered ? 'REGISTERED' : 'NOT_REGISTERED') : 'UNKNOWN / REGISTRY UNREADABLE'}`);
  lines.push(`  enabled: ${facts.plugin.enabled === true ? 'ENABLED' : facts.plugin.enabled === false ? 'DISABLED' : 'UNKNOWN'}`);
  lines.push(`  governance: ${LABELS[facts.governance.state]}`);
  if (facts.governance.reason !== undefined) {
    lines.push(`  governance.reason: ${facts.governance.reason}`);
  }
  lines.push('  runtime: RUNTIME_PROBE_NOT_PERFORMED (read-only health)');
  lines.push('  modelToolCall: MODEL_TOOL_CALL_NOT_VERIFIED');
  lines.push(`  registryPath: ${facts.paths.registryPath}`);
  lines.push(`  settingsPath: ${facts.paths.settingsPath}`);
  lines.push(`  governanceDir: ${facts.paths.governanceDir}`);
  return lines;
}
