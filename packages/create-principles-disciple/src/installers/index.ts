/**
 * Host installers barrel (ADR-0020 §2.3)
 *
 * Exports HostTarget type + factory for selecting host installers by CLI --host.
 *
 * MVP hosts:
 * - 'openclaw' (default) — OpenClawHostInstaller writes ~/.openclaw/openclaw.json.
 * - 'codex'              — CodexHostInstaller writes ~/.codex/hooks.json.
 * - 'workbuddy'          — WorkBuddyHostInstaller registers the PD plugin into
 *                          WorkBuddy's marketplace/plugin system (quiet, opt-in:
 *                          'all' deliberately does NOT include it — SPEC
 *                          workbuddy-host-adapter §6 install≠enable).
 * - 'all'                — openclaw + codex (both legacy install flows).
 *
 * Runtime Contract Rules:
 * - rc-1-treat-as-unknown: --host CLI value is `unknown` until validated here.
 * - rc-3-fail-loud-missing: invalid --host value throws with valid options.
 * - rc-9-no-silent-fallback: factory returns concrete installers, not nulls.
 */
import type { HostInstaller } from '@principles/core/host';
import { existsSync } from 'fs';
import * as path from 'path';
import * as os from 'os';
import { OpenClawHostInstaller } from './openclaw-host-installer.js';
import { CodexHostInstaller } from './codex-host-installer.js';
import { WorkBuddyHostInstaller, readWorkbuddyHostState } from './workbuddy-host-installer.js';

export { OpenClawHostInstaller } from './openclaw-host-installer.js';
export { CodexHostInstaller } from './codex-host-installer.js';
export { WorkBuddyHostInstaller } from './workbuddy-host-installer.js';

/**
 * Host target selector. 'all' runs openclaw + codex. WorkBuddy is an explicit,
 * separate target: installing it is an opt-in decision (OD-03/OD-04), so 'all'
 * must not silently register a third host.
 */
export type HostTarget = 'openclaw' | 'codex' | 'workbuddy' | 'all';

export const HOST_TARGETS: readonly HostTarget[] = ['openclaw', 'codex', 'workbuddy', 'all'];

/**
 * Validate a CLI --host value. rc-1/rc-3: treat input as unknown, fail loud.
 */
export function isHostTarget(value: unknown): value is HostTarget {
  return typeof value === 'string' && (HOST_TARGETS as readonly string[]).includes(value);
}

/**
 * Factory: return the concrete HostInstaller instances for a given target.
 *
 * - 'openclaw'  → [OpenClawHostInstaller]
 * - 'codex'     → [CodexHostInstaller]
 * - 'workbuddy' → [WorkBuddyHostInstaller]
 * - 'all'       → [OpenClawHostInstaller, CodexHostInstaller]
 *
 * Note: uninstall flows that need "every host PD ever registered with" (the
 * uninstall --host all contract) widen the list at their call site to include
 * WorkBuddyHostInstaller — uninstalling a registration is cleanup, not opt-in.
 *
 * Callers iterate the returned array and call install()/uninstall()/detect()
 * on each. This keeps the CLI install/uninstall flow host-agnostic.
 */
export function getHostInstallers(target: HostTarget): HostInstaller[] {
  if (!isHostTarget(target)) {
    throw new Error(`Invalid host target: ${JSON.stringify(target)}. Valid: ${HOST_TARGETS.join(', ')}`);
  }
  switch (target) {
    case 'openclaw':
      return [new OpenClawHostInstaller()];
    case 'codex':
      return [new CodexHostInstaller()];
    case 'workbuddy':
      return [new WorkBuddyHostInstaller()];
    case 'all':
      return [new OpenClawHostInstaller(), new CodexHostInstaller()];
  }
}

export type DetectedHostId = Exclude<HostTarget, 'all'>;

export interface DetectedHost {
  readonly hostId: DetectedHostId;
  /** The filesystem fact that proves the host already carries PD. */
  readonly evidence: string;
}

/**
 * Detect which hosts on THIS machine already carry a PD install (update chain,
 * 2026-11-11).
 *
 * Why this exists: `--host` defaulted to 'openclaw' and the install manifest
 * only refreshed hosts PD had recorded before. A host installed outside that
 * manifest was silently left on the old release during an upgrade — the Owner
 * had to uninstall/reinstall it by hand, which is not an acceptable update
 * chain. The installer now unions this detection into its refresh targets.
 *
 * Detection is deliberately conservative: "the app directory exists" is NOT
 * enough (WorkBuddy is opt-in, OD-03). Each entry requires PD's own footprint:
 * - openclaw: the installed extension directory;
 * - codex:    a Marketplace cache / legacy PD hook registration;
 * - workbuddy: PD registered in its plugin registry.
 */
export function detectInstalledHosts(homeDir: string = os.homedir(), codexHome?: string): DetectedHost[] {
  const detected: DetectedHost[] = [];

  const openclawExtension = path.join(homeDir, '.openclaw', 'extensions', 'principles-disciple');
  if (existsSync(openclawExtension)) {
    detected.push({ hostId: 'openclaw', evidence: openclawExtension });
  }

  const codex = new CodexHostInstaller(codexHome === undefined ? {} : { codexHome }).detect();
  if (codex.installed) {
    const evidence = codex.paths.find((entry) => entry.exists && entry.name.startsWith('Codex Marketplace plugin'))
      ?? codex.paths.find((entry) => entry.exists);
    detected.push({ hostId: 'codex', evidence: evidence?.path ?? 'codex install detected' });
  }

  const workbuddy = readWorkbuddyHostState(homeDir);
  if (workbuddy.pluginState !== undefined && workbuddy.pluginState.registryReadable && workbuddy.pluginState.registered) {
    detected.push({ hostId: 'workbuddy', evidence: path.join(homeDir, '.workbuddy', 'plugins', 'installed_plugins.json') });
  }

  return detected;
}

