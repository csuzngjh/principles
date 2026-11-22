/**
 * Scheduler adapter resolution + the install-level lifecycle service the CLI
 * commands call (SPEC-PD-SERVICE-HOST-001 §11 Phase 3, task §3.1/§5).
 *
 * One lifecycle logic set for every platform: resolve the TRUSTED install
 * identity (OS account home / explicit trusted injection — never env-derived
 * homes), resolve the active-release CLI entry, build the registration and
 * hand it to the platform adapter. The CLI never keeps three parallel
 * lifecycle paths.
 */
import { resolveCoordinatorInstallIdentity, type InstallIdentity } from '../install-identity.js';
import { resolveActiveReleaseCliEntry } from '../worker-adapter.js';
import {
  DEFAULT_SCHEDULER_INTERVAL_MS,
  schedulerIdentityFor,
  validateSchedulerIntervalMs,
  type SchedulerAdapter,
  type SchedulerCommandRunner,
  type SchedulerFileIo,
  type SchedulerFacts,
  type SchedulerOperationResult,
  type SchedulerRegistration,
} from './contract.js';
export * from './contract.js';
import { createWindowsSchedulerAdapter } from './windows.js';
import { createMacosSchedulerAdapter } from './macos.js';
import { createLinuxSchedulerAdapter } from './linux.js';
import { createSpawnSchedulerRunner, nodeSchedulerFileIo } from './runtime-io.js';

export { createWindowsSchedulerAdapter, buildWindowsTaskXml, windowsRepetitionDuration, parseWindowsIntervalMs } from './windows.js';
export type { WindowsSchedulerDeps } from './windows.js';
export { createMacosSchedulerAdapter, buildMacosLaunchAgentPlist, parseMacosStartIntervalMs } from './macos.js';
export type { MacosSchedulerDeps } from './macos.js';
export { createLinuxSchedulerAdapter, buildLinuxServiceUnit, buildLinuxTimerUnit, parseLinuxTimerIntervalMs } from './linux.js';
export type { LinuxSchedulerDeps } from './linux.js';
export { createSpawnSchedulerRunner, nodeSchedulerFileIo } from './runtime-io.js';

export type SchedulerAdapterResolution =
  | { readonly ok: true; readonly adapter: SchedulerAdapter }
  | { readonly ok: false; readonly reason: 'platform_unsupported'; readonly platform: string; readonly nextAction: string };

/** The three platforms a Phase 3 adapter exists for (process.platform values). */
export type SchedulerSupportedPlatform = 'win32' | 'darwin' | 'linux';

/** Select the platform adapter. process.platform unless injected. */
export function resolveSchedulerAdapter(deps?: {
  readonly platform?: SchedulerSupportedPlatform;
  readonly runner?: SchedulerCommandRunner;
  readonly fileIo?: SchedulerFileIo;
}): SchedulerAdapterResolution {
  const platform = deps?.platform ?? process.platform;
  const runner = deps?.runner ?? createSpawnSchedulerRunner();
  const fileIo = deps?.fileIo ?? nodeSchedulerFileIo;
  switch (platform) {
    case 'win32':
      return { ok: true, adapter: createWindowsSchedulerAdapter({ runner, fileIo }) };
    case 'darwin':
      return { ok: true, adapter: createMacosSchedulerAdapter({ runner, fileIo }) };
    case 'linux':
      return { ok: true, adapter: createLinuxSchedulerAdapter({ runner, fileIo }) };
    default:
      return {
        ok: false,
        reason: 'platform_unsupported',
        platform: String(platform),
        nextAction: `No user-level scheduler adapter exists for platform ${String(platform)}. Phase 3 supports Windows (Task Scheduler), macOS (LaunchAgent) and Linux (systemd --user).`,
      };
  }
}

export type SchedulerLifecycleOperation = 'install' | 'enable' | 'disable' | 'status' | 'uninstall';

export type SchedulerLifecycleResult =
  | {
      readonly ok: true;
      readonly operation: SchedulerLifecycleOperation;
      readonly identity: InstallIdentity;
      readonly registration: SchedulerRegistration;
      readonly changed: boolean;
      readonly facts: SchedulerFacts;
    }
  | {
      readonly ok: false;
      readonly operation: SchedulerLifecycleOperation;
      readonly reason: string;
      readonly nextAction: string;
      readonly identity?: InstallIdentity;
      readonly facts?: SchedulerFacts;
    };

export interface SchedulerLifecycleOptions {
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Trusted home injection (installer / tests) — never env-derived. */
  readonly trustedHomeDir?: string;
  /** Install-time interval override (install only). */
  readonly intervalMs?: number;
  readonly probes?: {
    readonly runner?: SchedulerCommandRunner;
    readonly fileIo?: SchedulerFileIo;
    readonly platform?: SchedulerSupportedPlatform;
    /** CLI-entry resolution injection (tests; prod = active release). */
    readonly resolveCliEntry?: typeof resolveActiveReleaseCliEntry;
    /** Node executable pinned into the registration (tests; prod = process.execPath). */
    readonly nodePath?: string;
  };
}

/** Project an adapter operation result into the lifecycle result shape. */
function projectResult(args: {
  operation: SchedulerLifecycleOperation;
  identity: InstallIdentity;
  registration: SchedulerRegistration;
  result: SchedulerOperationResult;
}): SchedulerLifecycleResult {
  const { operation, identity, registration, result } = args;
  if (result.ok) {
    return { ok: true, operation, identity, registration, changed: result.changed, facts: result.facts };
  }
  return {
    ok: false,
    operation,
    identity,
    reason: result.reason,
    nextAction: result.nextAction,
    ...(result.facts !== undefined ? { facts: result.facts } : {}),
  };
}

/**
 * Run one lifecycle operation against the real install identity. Never
 * throws for expected refusals — structured results only (rc-9).
 */
export async function runSchedulerLifecycle(
  operation: SchedulerLifecycleOperation,
  options: SchedulerLifecycleOptions,
): Promise<SchedulerLifecycleResult> {
  // Trusted identity only: the OS account record or an explicit trusted
  // injection. Inherited HOME/USERPROFILE/PD_EXPERIMENT_ROOT never steer the
  // registration (task §6.3, §8.6).
  const identityResult = resolveCoordinatorInstallIdentity(options.env ?? process.env, {
    ...(options.trustedHomeDir !== undefined ? { trustedHomeDir: options.trustedHomeDir } : {}),
    canonicalHostRootsOnly: true,
  });
  if (!identityResult.ok) {
    return { ok: false, operation, reason: identityResult.reason, nextAction: identityResult.nextAction };
  }
  const {identity} = identityResult;

  const {probes} = options;
  const adapterResolution = resolveSchedulerAdapter(
    probes === undefined ? undefined : {
      ...(probes.runner !== undefined ? { runner: probes.runner } : {}),
      ...(probes.fileIo !== undefined ? { fileIo: probes.fileIo } : {}),
      ...(probes.platform !== undefined ? { platform: probes.platform } : {}),
    },
  );
  if (!adapterResolution.ok) {
    return { ok: false, operation, identity, reason: `${adapterResolution.reason}:${adapterResolution.platform}`, nextAction: adapterResolution.nextAction };
  }

  // The registration must invoke the INSTALLED CLI entry (active release),
  // never the currently-running program file (task §6.2).
  const resolveEntry = probes?.resolveCliEntry ?? resolveActiveReleaseCliEntry;
  const entry = resolveEntry(identity);
  if (entry.kind === 'missing') {
    return {
      ok: false,
      operation,
      identity,
      reason: entry.reason,
      nextAction: entry.nextAction,
    };
  }

  if (operation === 'install') {
    const interval = validateSchedulerIntervalMs(options.intervalMs);
    if (!interval.ok) {
      return { ok: false, operation, identity, reason: interval.reason, nextAction: interval.nextAction };
    }
    const registration: SchedulerRegistration = {
      pdHome: identity.pdHome,
      homeDir: identity.homeDir,
      cliEntry: entry.entry,
      nodePath: probes?.nodePath ?? process.execPath,
      intervalMs: interval.intervalMs,
      intervalExplicit: options.intervalMs !== undefined,
      identity: schedulerIdentityFor(identity.pdHome),
    };
    const result = await adapterResolution.adapter.install(registration);
    return projectResult({ operation, identity, registration, result });
  }

  // Non-install operations use the CURRENT registration definition for
  // identity checks (the adapter compares it against the on-OS state); the
  // interval is not consulted outside install.
  const registration: SchedulerRegistration = {
    pdHome: identity.pdHome,
    homeDir: identity.homeDir,
    cliEntry: entry.entry,
    nodePath: probes?.nodePath ?? process.execPath,
    intervalMs: DEFAULT_SCHEDULER_INTERVAL_MS,
    identity: schedulerIdentityFor(identity.pdHome),
  };
  const result = await adapterResolution.adapter[operation](registration);
  return projectResult({ operation, identity, registration, result });
}
