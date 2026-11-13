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
import { existsSync, readFileSync } from 'fs';
import * as path from 'path';
import * as os from 'os';
import { OpenClawHostInstaller } from './openclaw-host-installer.js';
import { CodexHostInstaller, detectCodexMarketplaceState } from './codex-host-installer.js';
import { WorkBuddyHostInstaller, readWorkbuddyHostState, resolveWorkbuddyPaths } from './workbuddy-host-installer.js';

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

/** A host id the install manifest may record (everything except the 'all' selector). */
export type RecordedHost = Exclude<HostTarget, 'all'>;
export const RECORDED_HOSTS: readonly RecordedHost[] = ['openclaw', 'codex', 'workbuddy'];

export function isRecordedHost(value: string): value is RecordedHost {
  return (RECORDED_HOSTS as readonly string[]).includes(value);
}

/**
 * Three-state presence judgment for ONE host already recorded in the install
 * manifest (PRI-1204 follow-up: repair of historical `hosts` pollution).
 *
 * Deliberately NOT the same question `detectInstalledHosts` answers:
 * - `installed`      — positive PD footprint (the same conservative detection
 *                      the upgrade chain trusts);
 * - `absent`         — absence PROVEN by reading the host's own evidence
 *                      surface (registry/config readable, no PD reference);
 * - `undecidable`    — the evidence surface exists but cannot be read, so
 *                      absence cannot be proven. Callers MUST keep the host.
 *
 * The safety inversion is intentional: a detector returning `false` is not
 * proof of absence (a malformed registry reads as "no plugin"), so every
 * `absent` verdict here requires a successful read that found no PD footprint.
 */
export type RecordedHostPresence =
  | { readonly status: 'installed'; readonly evidence: string }
  | { readonly status: 'absent'; readonly evidence: string }
  | { readonly status: 'undecidable'; readonly reason: string };

function errorCode(error: unknown): string | undefined {
  if (error instanceof Error && Object.hasOwn(error, 'code')) {
    const code: unknown = Reflect.get(error, 'code');
    return typeof code === 'string' ? code : undefined;
  }
  return undefined;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function evaluateRecordedHostPresence(
  host: RecordedHost,
  homeDir: string = os.homedir(),
): RecordedHostPresence {
  const detected = detectInstalledHosts(homeDir).find((entry) => entry.hostId === host);
  if (detected !== undefined) {
    return { status: 'installed', evidence: detected.evidence };
  }

  if (host === 'openclaw') {
    const openclawDir = path.join(homeDir, '.openclaw');
    const configPath = path.join(openclawDir, 'openclaw.json');
    let raw: string;
    try {
      raw = readFileSync(configPath, 'utf8');
    } catch (error) {
      if (errorCode(error) === 'ENOENT') {
        return { status: 'absent', evidence: `no PD extension and no ${configPath}` };
      }
      return { status: 'undecidable', reason: `cannot read ${configPath}: ${describeError(error)}` };
    }
    // Conservative: a config that still names PD counts as installed even when
    // the extension directory is gone — dropping the record would strand those
    // entries, and a false "installed" only keeps the manifest as it is.
    if (raw.includes('principles-disciple')) {
      return { status: 'installed', evidence: `${configPath} still references principles-disciple` };
    }
    return { status: 'absent', evidence: `no PD extension and ${configPath} does not reference principles-disciple` };
  }

  if (host === 'codex') {
    const detection = new CodexHostInstaller().detect();
    if (detection.installed) {
      const evidence = detection.paths.find((entry) => entry.exists);
      return { status: 'installed', evidence: evidence?.path ?? 'codex install detected' };
    }
    // The Marketplace cache is the supported install path: its three-state
    // detector distinguishes "absent" from "cannot judge".
    const marketplace = detectCodexMarketplaceState();
    if (marketplace.state === 'unknown') {
      return { status: 'undecidable', reason: marketplace.reason };
    }
    const hooks = detection.paths.find((entry) => entry.name === 'Codex hooks.json' && entry.exists);
    if (hooks !== undefined) {
      try {
        JSON.parse(readFileSync(hooks.path, 'utf8'));
      } catch (error) {
        return { status: 'undecidable', reason: `${hooks.path} exists but cannot be read as JSON: ${describeError(error)}` };
      }
    }
    return { status: 'absent', evidence: 'no PD marker, PD hook entries, or Marketplace plugin in the Codex home' };
  }

  const workbuddyPaths = resolveWorkbuddyPaths(homeDir);
  const workbuddy = readWorkbuddyHostState(homeDir);
  if (workbuddy.pluginState === undefined) {
    return { status: 'undecidable', reason: 'workbuddy plugin state could not be read' };
  }
  if (!workbuddy.pluginState.registryReadable) {
    return { status: 'undecidable', reason: `${workbuddyPaths.registryPath} exists but is not a readable plugin registry` };
  }
  return { status: 'absent', evidence: `PD is not registered in ${workbuddyPaths.registryPath}` };
}

