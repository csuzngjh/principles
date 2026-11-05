/**
 * Operator-facing install summary: is the installed host plugin ACTUALLY
 * enabled?
 *
 * SPEC §6.4 (install ≠ enable): a registered plugin whose `enabledPlugins`
 * entry is false loads no hooks. Reporting "governance is ON" without the
 * plugin state would read as "already working" while nothing runs — and the
 * explicit `PD记录痛苦：` intake (WorkBuddy's only intake after the 2026-11-05
 * Owner decision) is delivered through those hooks.
 */
export interface HostPluginEnablementSummary {
  readonly hostId: string;
  /**
   * Post-install `enabledPlugins[pluginKey]`. Hosts without an explicit
   * enablement gate omit it (the line is then not printed at all).
   */
  readonly pluginEnabled?: boolean;
}

const MANUAL_PAIN_PREFIX = 'PD记录痛苦：';

function hostLabel(hostId: string): string {
  return hostId === 'workbuddy' ? 'WorkBuddy' : hostId;
}

/** One summary line, or undefined when the host has no plugin-enablement gate. */
export function formatHostPluginEnablementLine(host: HostPluginEnablementSummary): string | undefined {
  if (host.pluginEnabled === undefined) return undefined;
  const label = hostLabel(host.hostId);
  if (host.pluginEnabled) {
    return `  ${host.hostId} plugin ............... enabled — the only Pain intake is the explicit "${MANUAL_PAIN_PREFIX}" prefix (automatic Pain detection is unavailable in WorkBuddy).`;
  }
  return `  ${host.hostId} plugin ............... installed but NOT enabled — enable it in ${label} plugin settings before use; until then its hooks do not run and "${MANUAL_PAIN_PREFIX}" has no effect (automatic Pain detection is unavailable in WorkBuddy).`;
}
