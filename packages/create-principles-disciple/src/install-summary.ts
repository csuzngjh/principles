/**
 * Install summary rendering.
 *
 * SPEC §6.4 (install ≠ enable): an install can leave behind THREE independent
 * facts, and the summary must never derive one from another:
 *
 *   1. the host registry carries the plugin (`installed_plugins.json`);
 *   2. the host has the plugin enabled (`settings.json` → `enabledPlugins`);
 *   3. the governance config is ON (`host.workbuddy`).
 *
 * "Governance ON" does not mean hooks run, and "configured" does not mean
 * "installed". A failed or unverifiable install must not print success lines.
 */

export interface HostPluginStateSummary {
  readonly registered: boolean;
  /** False when the host registry could not be read — INSTALLED must not be claimed. */
  readonly registryReadable: boolean;
  /** `enabledPlugins[key]`; null when absent/unreadable (activation unknown). */
  readonly enabled: boolean | null;
}

export interface HostGovernanceSummary {
  readonly enabled: boolean;
  readonly explicitOptOut: boolean;
  readonly keywordPainEnabled?: boolean;
  readonly configPath?: string;
  /** False when the governance config could not be read/parsed — never guess. */
  readonly readable?: boolean;
  readonly unreadableReason?: string;
}

export interface HostStateSummaryResult {
  readonly success: boolean;
  readonly hostId: string;
  readonly pluginState?: HostPluginStateSummary;
  readonly governance?: HostGovernanceSummary;
  /**
   * Non-fatal facts the host install produced (e.g. a retired skill that was
   * preserved because it could not be proven to be an unmodified published
   * payload). Printed here so the Owner sees them on the summary screen, not
   * only in a log (rc-9).
   */
  readonly warnings?: readonly string[];
}

const MANUAL_PAIN_PREFIX = 'PD记录痛苦：';

function pluginStateText(state: HostPluginStateSummary): string {
  if (!state.registryReadable) return 'REGISTRY UNREADABLE / NOT VERIFIED';
  if (!state.registered) return 'NOT INSTALLED';
  if (state.enabled === true) return 'INSTALLED / ENABLED';
  if (state.enabled === false) return 'INSTALLED / DISABLED';
  return 'INSTALLED / ENABLEMENT UNKNOWN';
}

function governanceText(governance: HostGovernanceSummary, withDefaultNote: boolean): string {
  if (governance.readable === false) return 'UNKNOWN (config unreadable)';
  if (governance.enabled) return `ON${withDefaultNote && !governance.explicitOptOut ? ' (default)' : ''}`;
  return governance.explicitOptOut ? 'OFF (your explicit opt-out was preserved)' : 'OFF';
}

function workbuddyLines(host: HostStateSummaryResult, state: HostPluginStateSummary): string[] {
  const lines = [`  WorkBuddy plugin ................. ${pluginStateText(state)}`];

  if (host.governance !== undefined) {
    lines.push(`  WorkBuddy governance ............. ${governanceText(host.governance, false)}`);
    if (host.governance.readable === false) {
      lines.push(`             reason: ${host.governance.unreadableReason ?? 'the governance config could not be read'}`);
    }
    if (host.governance.readable !== false && host.governance.keywordPainEnabled !== undefined) {
      lines.push(`  Automatic keyword Pain ........... ${host.governance.keywordPainEnabled ? 'ON' : 'OFF'}`);
    }
    // Manual entry is a SEPARATE fact from automatic detection: the prefix is
    // available regardless of the keyword gate, but only once the plugin (and
    // therefore the hook that delivers the prompt) is enabled.
    lines.push(`  Manual PD记录痛苦：............... ${state.enabled === true ? 'available' : 'available once the plugin is enabled'}`);
    if (host.governance.readable !== false && !host.governance.enabled) {
      const target = host.governance.configPath ?? 'the governance workspace .pd/config.yaml';
      lines.push(`             to enable: in ${target}, inside the existing "features:" block set host.workbuddy: {enabled: true}`);
    }
  }

  const enabled = state.enabled === true;
  const installed = state.registryReadable && state.registered;
  if (!installed || !enabled) {
    lines.push('');
    lines.push('Next action:');
    if (!state.registryReadable) {
      lines.push('The WorkBuddy plugin registry (installed_plugins.json) could not be read — installation is UNVERIFIED.');
      lines.push('Restore read access to it and re-run the installer; do not treat this as installed.');
    } else if (!state.registered) {
      lines.push('Re-run the installer to register Principles Disciple in WorkBuddy plugin management.');
    } else if (state.enabled === null) {
      lines.push('Check Principles Disciple in WorkBuddy plugin management: its enabled state could not be read.');
    } else {
      lines.push('Enable Principles Disciple in WorkBuddy plugin management.');
      lines.push('Then start a new session or run /reload-plugins.');
    }
    if (installed) {
      lines.push(`Hooks stay INACTIVE while the plugin is disabled, so "${MANUAL_PAIN_PREFIX}" is not delivered.`);
    }
  }
  return lines;
}

/** Legacy per-host governance block (hosts without an enablement gate). */
function governanceLines(hostId: string, governance: HostGovernanceSummary): string[] {
  const lines = [`  ${hostId} governance ............. ${governanceText(governance, true)}${
    governance.readable === false || governance.keywordPainEnabled === undefined
      ? ''
      : `, keyword Pain: ${governance.keywordPainEnabled ? 'ON' : 'OFF'}`
  }`];
  if (governance.readable === false) {
    lines.push(`             reason: ${governance.unreadableReason ?? 'the governance config could not be read'}`);
    return lines;
  }
  const disabledFlags: string[] = [];
  if (!governance.enabled) disabledFlags.push('host.workbuddy');
  if (governance.keywordPainEnabled === false) disabledFlags.push('workbuddy_live_keyword_pain');
  if (disabledFlags.length > 0) {
    // PRI-1063/1064 review: name the exact flag ids and the exact edit. The
    // dotted id is ONE flat key inside the existing `features:` block.
    const target = governance.configPath ?? 'the governance workspace .pd/config.yaml';
    const edits = disabledFlags.map((flag) => `${flag}: {enabled: true}`).join(' or ');
    lines.push(`             to enable: in ${target}, inside the existing "features:" block set ${edits}`);
  }
  return lines;
}

/**
 * The single install-summary authority. Returns NO lines when the install did
 * not succeed, so a failure can never print success/state claims.
 */
export function formatHostStateSummary(
  results: readonly HostStateSummaryResult[] | undefined,
  success: boolean,
): string[] {
  if (!success) return [];
  const lines: string[] = [];
  for (const host of results ?? []) {
    // A host whose own install failed must not contribute state claims.
    if (!host.success) continue;
    // Warnings describe the host install itself, so they are printed even when
    // the host has no plugin/governance block to render.
    for (const warning of host.warnings ?? []) lines.push(`  ${warning}`);
    const { pluginState, governance } = host;
    if (host.hostId === 'workbuddy' && pluginState !== undefined) {
      lines.push(...workbuddyLines(host, pluginState));
      continue;
    }
    if (governance === undefined) continue;
    lines.push(...governanceLines(host.hostId, governance));
  }
  return lines;
}
