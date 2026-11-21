/**
 * Shared coordinator steps (SPEC-PD-SERVICE-HOST-001 §8.2 steps 3–5, TD §5).
 *
 * The dry-run coordinator (run-once.ts, Phase 1) and the shadow coordinator
 * (shadow-run.ts, Phase 2) execute the SAME prefix pipeline: manifest read
 * with the five fail-closed verdicts, per-host root reporting, and manifest
 * section projection. Those steps live here once so the two flows can never
 * drift apart; each flow keeps its own execution phase.
 */
import * as fs from 'node:fs';
import {
  parseInstallManifest,
  type BindingReadDiagnostic,
  type HostClaimReaders,
  type HostClaimOptions,
  type InstallManifest,
} from '@principles/install-layout';
import type { InstallIdentity } from './install-identity.js';
import type { HostRootReport, ServiceRunStatus } from './status/service-run-status.js';
import type { WorkspaceDiscoveryResult } from './workspace-discovery.js';

/** Read + parse the manifest with the five task-required verdicts. */
export function readManifest(identity: InstallIdentity): {
  manifest: InstallManifest | undefined;
  verdict: ServiceRunStatus['manifest']['verdict'];
  reason?: string;
} {
  let raw: string;
  try {
    raw = fs.readFileSync(identity.manifestPath, 'utf8');
  } catch (error) {
    const code = typeof error === 'object' && error !== null && Object.hasOwn(error, 'code')
      ? String(Reflect.get(error, 'code'))
      : '';
    if (code === 'ENOENT') {
      return { manifest: undefined, verdict: 'missing', reason: 'install_manifest_missing' };
    }
    return {
      manifest: undefined,
      verdict: 'read_failed',
      reason: code !== '' ? `install_manifest_read_failed:${code}` : 'install_manifest_read_failed',
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { manifest: undefined, verdict: 'unparsable', reason: `install_manifest_unparsable:${message.slice(0, 120)}` };
  }
  const result = parseInstallManifest(parsed);
  if (result.manifest === undefined) {
    const error = result.error ?? 'install_manifest_malformed';
    return {
      manifest: undefined,
      verdict: error.startsWith('install_manifest_unsupported_version') ? 'version_mismatch' : 'invalid',
      reason: error,
    };
  }
  return { manifest: result.manifest, verdict: 'ok' };
}

/** Empty discovery counts for refusal statuses. */
export function zeroCounts(): WorkspaceDiscoveryResult['counts'] {
  return { authorized: 0, degraded: 0, unavailable: 0, conflicting: 0, invalid: 0, discovered: 0 };
}

/** Build the empty discovery result used by refusal statuses. */
export function buildEmptyDiscovery(): WorkspaceDiscoveryResult {
  return { workspaces: [], discoveredTotal: 0, counts: zeroCounts() };
}

/**
 * The default host-root listability probe (P2-1). `statSync` succeeding is
 * not enough — a directory the OS reports but `readdir` refuses (EACCES /
 * EPERM) or fails on (EIO, transient FS errors) is NOT listable, and the
 * claims collector could not have seen the workspaces under it. The four
 * verdicts are distinct and none is ever faked:
 *  - `missing`       — ENOENT/ENOTDIR at stat, or the dir vanished before readdir;
 *  - `not_directory` — the path exists but is not a directory;
 *  - `unreadable`    — exists, is a directory, readdir failed for any reason;
 *  - `readable`      — readdir actually succeeded.
 */
export function defaultListDir(dir: string): 'readable' | 'missing' | 'not_directory' | 'unreadable' {
  try {
    if (!fs.statSync(dir).isDirectory()) return 'not_directory';
  } catch (error) {
    const code =
      typeof error === 'object' && error !== null && Object.hasOwn(error, 'code')
        ? String(Reflect.get(error, 'code'))
        : '';
    return code === 'ENOENT' || code === 'ENOTDIR' ? 'missing' : 'unreadable';
  }
  try {
    fs.readdirSync(dir);
    return 'readable';
  } catch (error) {
    const code =
      typeof error === 'object' && error !== null && Object.hasOwn(error, 'code')
        ? String(Reflect.get(error, 'code'))
        : '';
    return code === 'ENOENT' || code === 'ENOTDIR' ? 'missing' : 'unreadable';
  }
}

/**
 * Per-host root report (P1-2/P2-1): for every host, which root the claims
 * collector consulted, whether it came from an env override, and whether
 * the directory was actually LISTABLE. An unreadable root — env-selected
 * or default — is surfaced as incomplete discovery, never silently folded
 * into "no workspaces".
 */
export function hostRootReports(
  identity: InstallIdentity,
  env: Readonly<Record<string, string | undefined>>,
  listDir: (dir: string) => 'readable' | 'missing' | 'not_directory' | 'unreadable',
): HostRootReport[] {
  const hasEnv = (name: string): boolean => {
    const value = env[name];
    return value !== undefined && value.trim().length > 0;
  };
  const roots: { host: HostRootReport['host']; root: string; source: HostRootReport['source'] }[] = [
    {
      host: 'openclaw',
      root: identity.hostRoots.openclawHome,
      source: hasEnv('OPENCLAW_STATE_DIR') || hasEnv('OPENCLAW_HOME') ? 'env' : 'default',
    },
    { host: 'codex', root: identity.hostRoots.codexHome, source: hasEnv('CODEX_HOME') ? 'env' : 'default' },
    {
      host: 'workbuddy',
      root: identity.hostRoots.workbuddyConfigDir,
      source: hasEnv('WORKBUDDY_CONFIG_DIR') ? 'env' : 'default',
    },
  ];
  return roots.map((entry) => ({ ...entry, status: listDir(entry.root) }));
}

/** True when at least one consulted host root exists but could not be listed. */
export function discoveryIncompleteRoots(hostRoots: readonly HostRootReport[]): HostRootReport[] {
  return hostRoots.filter((r) => r.status === 'unreadable' || r.status === 'not_directory');
}

/** Project a manifest read into the persisted status section. */
export function manifestSection(read: ReturnType<typeof readManifest>): ServiceRunStatus['manifest'] {
  return read.manifest === undefined
    ? {
        verdict: read.verdict,
        ...(read.reason !== undefined ? { reason: read.reason } : {}),
        hosts: [],
        unknownHosts: [],
        workspacesCount: 0,
      }
    : {
        verdict: 'ok',
        hosts: [...read.manifest.hosts, ...(read.manifest.unknownHosts ?? [])],
        unknownHosts: [...(read.manifest.unknownHosts ?? [])],
        workspacesCount: (read.manifest.workspaces ?? []).length,
      };
}

/**
 * Claim-collection options for the shared prefix (P1-2): custom host roots
 * (env overrides) reach the collector so workspaces under them stay
 * discoverable; they can never steer pdHome itself.
 */
export function claimOptionsFor(
  identity: InstallIdentity,
  readDiagnostics: BindingReadDiagnostic[],
  claimReaders?: HostClaimReaders,
): HostClaimOptions {
  return {
    homeDir: identity.homeDir,
    codexHome: identity.hostRoots.codexHome,
    openclawHome: identity.hostRoots.openclawHome,
    workbuddyConfigDir: identity.hostRoots.workbuddyConfigDir,
    platform: process.platform,
    readDiagnostics,
    ...(claimReaders !== undefined ? { readers: claimReaders } : {}),
  };
}
