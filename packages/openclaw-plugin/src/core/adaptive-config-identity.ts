/**
 * PRI-1110 — minimal "effective configuration identity" for AA runtime evidence.
 *
 * Scope: OpenClaw only, six SPEC v0.6 §5.2 fields. This module does NOT build a
 * configuration management system, audit the host, or prove behaviour change.
 * It records only what the running process can actually confirm and keeps
 * unprovable fields `unknown`.
 *
 * Snapshot ownership:
 * - One snapshot is built when an AA prompt invocation opens (see
 *   `beginAdaptivePromptInvocation`).
 * - The same frozen snapshot is reused by the terminal record of that
 *   invocation, so an environment change mid-invocation cannot rewrite
 *   already-recorded evidence.
 * - The next invocation builds a new snapshot.
 */
import { createHash } from 'node:crypto';
import { closeSync, openSync, readSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isSurfaceEnabled } from '@principles/core/runtime';

export type AdaptiveEvidenceCoverage = 'complete' | 'partial' | 'unknown';

export type AdaptiveConfigIdentityField =
  | 'host'
  | 'hostVersion'
  | 'runtimeMode'
  | 'pluginVersion'
  | 'effectiveHookSetFingerprint'
  | 'evidenceCoverage';

export interface AdaptiveConfigIdentityCoverage {
  confirmed: readonly AdaptiveConfigIdentityField[];
  partial: readonly AdaptiveConfigIdentityField[];
  missing: readonly AdaptiveConfigIdentityField[];
  /** Bounded machine-readable reason codes. No paths, config bodies or prompts. */
  notes: readonly string[];
}

export interface AdaptiveConfigIdentitySnapshot {
  host: string;
  hostVersion: string;
  runtimeMode: string;
  pluginVersion: string;
  effectiveHookSetFingerprint: string;
  evidenceCoverage: AdaptiveEvidenceCoverage;
  configIdentityCoverage: AdaptiveConfigIdentityCoverage;
}

export interface AdaptiveHookRegistration {
  surfaceId: string;
  event: string;
  enabled: boolean;
}

export interface HookRegistrationSink {
  on: (event: string, handler: (...args: any[]) => unknown, opts?: { priority?: number; timeoutMs?: number }) => void;
}

export interface AdaptiveHookRegistrationRecorder {
  /**
   * Records the registration only AFTER it was handed to the host. This is the
   * actual registration path, not a declared/static hook list.
   */
  register: (
    surfaceId: string,
    event: string,
    handler: (...args: any[]) => unknown,
    opts?: { priority?: number; timeoutMs?: number },
  ) => void;
  snapshot: () => AdaptiveHookRegistration[];
}

const MANIFEST_NAME = 'principles-disciple';
const MAX_MANIFEST_BYTES = 64 * 1024;
const MAX_MANIFEST_WALK_DEPTH = 4;
const MAX_VERSION_LENGTH = 64;
const VERSION_PATTERN = /^[0-9]+(\.[0-9]+){0,3}(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/;

const HOOK_FINGERPRINT_DOMAIN = 'pd-aa-effective-hook-set-v1';
const MAX_INVOCATION_SNAPSHOTS = 64;
const INVOCATION_SNAPSHOT_TTL_MS = 30 * 60 * 1000;

interface ParsedManifest {
  name: string;
  version: string;
}

/**
 * Test-only observation of how many bytes a manifest read actually consumed.
 * Production never sets it; it exists so the bounded-read contract can be
 * asserted instead of assumed.
 */
let manifestReadProbe: ((bytesRead: number) => void) | null = null;

export function setManifestReadProbeForTest(probe: ((bytesRead: number) => void) | null): void {
  manifestReadProbe = probe;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readManifestFile(filePath: string): { manifest?: ParsedManifest; reason?: string } {
  let fd: number | undefined;
  try {
    fd = openSync(filePath, 'r');
    // Read at most MAX + 1 bytes. A full-file read would allocate the whole
    // manifest before the size check, and stat-then-read would race (CodeQL
    // js/file-system-race); one bounded read does neither.
    const buffer = Buffer.alloc(MAX_MANIFEST_BYTES + 1);
    const bytesRead = readSync(fd, buffer, 0, buffer.length, 0);
    manifestReadProbe?.(bytesRead);
    if (bytesRead > MAX_MANIFEST_BYTES) {
      return { reason: 'manifest_too_large' };
    }
    const raw = buffer.subarray(0, bytesRead).toString('utf8');
    const parsed: unknown = JSON.parse(raw);
    if (!isPlainRecord(parsed)) {
      return { reason: 'manifest_invalid_shape' };
    }
    const name = parsed['name'];
    const version = parsed['version'];
    if (typeof name !== 'string' || typeof version !== 'string') {
      return { reason: 'manifest_missing_fields' };
    }
    return { manifest: { name, version } };
  } catch (error) {
    const code = isPlainRecord(error) && typeof error['code'] === 'string' ? error['code'] : null;
    return { reason: code ? `manifest_${code}` : 'manifest_unreadable' };
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // A failed close cannot become identity evidence.
      }
    }
  }
}

/**
 * Finds the manifest of the artifact that actually loaded this module by
 * walking up from the executing file. Works for both layouts:
 *   src/core/x.ts   -> src -> package root
 *   dist/core/x.js  -> dist -> package root
 *   dist/bundle.js  -> dist -> package root
 *
 * Reason precedence: `manifest_ENOENT` only means "no manifest at this
 * directory, keep walking". It says nothing about the artifact's own manifest,
 * so a shallower directory without a package.json must never replace a deeper
 * read failure (for example `manifest_too_large`). The nearest specific
 * failure wins, and a pure "nothing anywhere" walk stays `manifest_ENOENT`.
 */
const MANIFEST_MISSING = 'manifest_ENOENT';

function findExecutingManifest(startDir: string): { manifest?: ParsedManifest; reason?: string } {
  let dir = startDir;
  let specificReason: string | undefined;
  let sawMissingManifest = false;
  for (let depth = 0; depth <= MAX_MANIFEST_WALK_DEPTH; depth += 1) {
    const read = readManifestFile(join(dir, 'package.json'));
    if (read.manifest?.name === MANIFEST_NAME) {
      return { manifest: read.manifest };
    }
    const reason = read.reason ?? (read.manifest ? 'manifest_name_mismatch' : undefined);
    if (reason === MANIFEST_MISSING) {
      sawMissingManifest = true;
    } else if (reason !== undefined && specificReason === undefined) {
      specificReason = reason;
    }
    const parent = dirname(dir);
    if (parent === dir) {
      break;
    }
    dir = parent;
  }
  return { reason: specificReason ?? (sawMissingManifest ? MANIFEST_MISSING : 'manifest_not_found') };
}

interface BoundPluginVersion {
  version: string;
  reason?: string;
}

function resolvePluginVersion(executingFileUrl: string): BoundPluginVersion {
  let startDir: string;
  try {
    startDir = dirname(fileURLToPath(executingFileUrl));
  } catch {
    return { version: 'unknown', reason: 'executing_url_invalid' };
  }

  const found = findExecutingManifest(startDir);
  if (!found.manifest) {
    return { version: 'unknown', reason: found.reason ?? 'manifest_not_found' };
  }
  if (!VERSION_PATTERN.test(found.manifest.version) || found.manifest.version.length > MAX_VERSION_LENGTH) {
    return { version: 'unknown', reason: 'plugin_version_invalid' };
  }
  return { version: found.manifest.version };
}

/**
 * Bound once when this module is evaluated. It describes the artifact whose
 * code the running process actually loaded, so a later on-disk manifest edit
 * (upgrade, rollback, restored backup) cannot relabel already-loaded behaviour.
 */
const LOADED_PLUGIN_VERSION: BoundPluginVersion = resolvePluginVersion(import.meta.url);

let boundPluginVersion: BoundPluginVersion = LOADED_PLUGIN_VERSION;

/** Test-only: simulate a process whose module was loaded from another artifact. */
export function bindAdaptivePluginVersionForTest(executingFileUrl: string): void {
  boundPluginVersion = resolvePluginVersion(executingFileUrl);
}

/**
 * Returns the version of the loaded plugin artifact.
 *
 * The disk is never re-read to "refresh" this value. When the host also
 * supplies `rootDir`, a readable manifest there must agree with the bound
 * version; a disagreement (for example an in-place upgrade while the old code
 * still runs) yields `unknown` instead of promoting the new disk value.
 */
export function readExecutingPluginVersion(options: {
  pluginRootDir?: string;
} = {}): BoundPluginVersion {
  const bound = boundPluginVersion;
  if (bound.version === 'unknown') {
    return bound;
  }

  if (options.pluginRootDir) {
    const rootManifest = readManifestFile(join(options.pluginRootDir, 'package.json'));
    if (rootManifest.manifest?.name === MANIFEST_NAME
      && rootManifest.manifest.version !== bound.version) {
      return { version: 'unknown', reason: 'plugin_version_manifest_conflict' };
    }
  }

  return bound;
}

/**
 * Deterministic digest over the hooks that were actually registered.
 *
 * State is `partial` even when registrations are complete for this plugin:
 * OpenClaw's own dispatch filtering, host configuration and other extensions'
 * hooks are not observable from here, so the identity never claims a complete
 * effective hook set.
 */
export function computeEffectiveHookSetFingerprint(
  registrations: readonly AdaptiveHookRegistration[],
): { fingerprint: string; state: 'partial' | 'unknown'; reason?: string } {
  if (registrations.length === 0) {
    return { fingerprint: 'unknown', state: 'unknown', reason: 'no_registered_hooks' };
  }
  const canonical = registrations
    .map(registration => `${registration.surfaceId}\u001f${registration.event}\u001f${registration.enabled ? 'enabled' : 'disabled'}`)
    .sort()
    .join('\n');
  const digest = createHash('sha256').update(`${HOOK_FINGERPRINT_DOMAIN}\n${canonical}`).digest('hex');
  return { fingerprint: `sha256:${digest}`, state: 'partial', reason: 'host_dispatch_not_observable' };
}

/**
 * Derives the coverage state from how many identity sources were confirmed,
 * partial or missing. Exported so complete/partial/all-unknown can be verified
 * without fabricating a host version.
 */
export function deriveAdaptiveEvidenceCoverage(counts: {
  confirmed: number;
  partial: number;
  missing: number;
}): AdaptiveEvidenceCoverage {
  if (counts.confirmed === 0) {
    return 'unknown';
  }
  return counts.missing === 0 && counts.partial === 0 ? 'complete' : 'partial';
}

let registeredHooks: AdaptiveHookRegistration[] = [];

export function setAdaptiveHookSet(registrations: readonly AdaptiveHookRegistration[]): void {
  registeredHooks = registrations.map(registration => ({ ...registration }));
}

export interface AdaptiveConfigIdentityInput {
  runtimeMode: string;
  pluginRootDir?: string;
  hookRegistrations?: readonly AdaptiveHookRegistration[];
}

/**
 * Builds the immutable identity snapshot for one AA invocation.
 *
 * Never throws for unreadable sources: each field degrades to `unknown` with a
 * machine-readable reason, and coverage reflects what was actually confirmed.
 */
export function buildAdaptiveConfigIdentitySnapshot(
  input: AdaptiveConfigIdentityInput,
): AdaptiveConfigIdentitySnapshot {
  const confirmed: AdaptiveConfigIdentityField[] = [];
  const partial: AdaptiveConfigIdentityField[] = [];
  const missing: AdaptiveConfigIdentityField[] = [];
  const notes: string[] = [];

  const host = 'openclaw';
  confirmed.push('host');

  const runtimeMode = input.runtimeMode === 'shared' || input.runtimeMode === 'plugin_local'
    ? input.runtimeMode
    : 'unknown';
  if (runtimeMode === 'unknown') {
    missing.push('runtimeMode');
    // Fixed reason code: never echo caller-supplied values into evidence.
    notes.push('runtimeMode:unsupported_execution_path');
  } else {
    confirmed.push('runtimeMode');
  }

  // No trusted running-host version interface exists in OpenClawPluginApi.
  // Never substitute a source checkout, an npm package or a config file version.
  const hostVersion = 'unknown';
  missing.push('hostVersion');
  notes.push('hostVersion:no_runtime_interface');

  const pluginVersionResult = readExecutingPluginVersion({
    pluginRootDir: input.pluginRootDir,
  });
  const pluginVersion = pluginVersionResult.version;
  if (pluginVersion === 'unknown') {
    missing.push('pluginVersion');
    notes.push(`pluginVersion:${pluginVersionResult.reason ?? 'unknown'}`);
  } else {
    confirmed.push('pluginVersion');
  }

  const hookRegistrations = input.hookRegistrations ?? registeredHooks;
  const hookFingerprint = computeEffectiveHookSetFingerprint(hookRegistrations);
  const effectiveHookSetFingerprint = hookFingerprint.fingerprint;
  if (hookFingerprint.state === 'partial') {
    partial.push('effectiveHookSetFingerprint');
    if (hookFingerprint.reason) {
      notes.push(`effectiveHookSetFingerprint:${hookFingerprint.reason}`);
    }
  } else {
    missing.push('effectiveHookSetFingerprint');
    if (hookFingerprint.reason) {
      notes.push(`effectiveHookSetFingerprint:${hookFingerprint.reason}`);
    }
  }

  const evidenceCoverage = deriveAdaptiveEvidenceCoverage({
    confirmed: confirmed.length,
    partial: partial.length,
    missing: missing.length,
  });

  const coverage: AdaptiveConfigIdentityCoverage = Object.freeze({
    confirmed: Object.freeze([...confirmed]),
    partial: Object.freeze([...partial]),
    missing: Object.freeze([...missing]),
    notes: Object.freeze([...notes]),
  });

  return Object.freeze({
    host,
    hostVersion,
    runtimeMode,
    pluginVersion,
    effectiveHookSetFingerprint,
    evidenceCoverage,
    configIdentityCoverage: coverage,
  });
}

/**
 * Explicit "identity unavailable" snapshot. Used when collection itself fails;
 * no random value or fabricated digest is produced.
 */
export function buildUnavailableAdaptiveConfigIdentity(
  runtimeMode: string,
  note: string,
): AdaptiveConfigIdentitySnapshot {
  const normalizedMode = runtimeMode === 'shared' || runtimeMode === 'plugin_local'
    ? runtimeMode
    : 'unknown';
  const missing: AdaptiveConfigIdentityField[] = [
    'host',
    'hostVersion',
    'pluginVersion',
    'effectiveHookSetFingerprint',
  ];
  if (normalizedMode === 'unknown') {
    missing.push('runtimeMode');
  }
  return Object.freeze({
    host: 'unknown',
    hostVersion: 'unknown',
    runtimeMode: normalizedMode,
    pluginVersion: 'unknown',
    effectiveHookSetFingerprint: 'unknown',
    evidenceCoverage: 'unknown' as const,
    configIdentityCoverage: Object.freeze({
      confirmed: Object.freeze([] as AdaptiveConfigIdentityField[]),
      partial: Object.freeze([] as AdaptiveConfigIdentityField[]),
      missing: Object.freeze(missing),
      notes: Object.freeze([note]),
    }),
  });
}

const invocationSnapshots = new Map<string, { identity: AdaptiveConfigIdentitySnapshot; storedAt: number }>();

function evictExpiredSnapshots(now: number): void {
  for (const [id, entry] of invocationSnapshots) {
    if (now - entry.storedAt > INVOCATION_SNAPSHOT_TTL_MS) {
      invocationSnapshots.delete(id);
    }
  }
}

export function rememberAdaptiveConfigIdentity(
  hookInvocationId: string,
  identity: AdaptiveConfigIdentitySnapshot,
): void {
  const now = Date.now();
  evictExpiredSnapshots(now);
  while (invocationSnapshots.size >= MAX_INVOCATION_SNAPSHOTS) {
    const oldest = invocationSnapshots.keys().next().value;
    if (oldest === undefined) {
      break;
    }
    invocationSnapshots.delete(oldest);
  }
  invocationSnapshots.set(hookInvocationId, { identity, storedAt: now });
}

export function getRememberedAdaptiveConfigIdentity(
  hookInvocationId: string,
): AdaptiveConfigIdentitySnapshot | undefined {
  const entry = invocationSnapshots.get(hookInvocationId);
  if (!entry) {
    return undefined;
  }
  if (Date.now() - entry.storedAt > INVOCATION_SNAPSHOT_TTL_MS) {
    invocationSnapshots.delete(hookInvocationId);
    return undefined;
  }
  return entry.identity;
}

export function forgetAdaptiveConfigIdentity(hookInvocationId: string): void {
  invocationSnapshots.delete(hookInvocationId);
}

/** Test-only reset for module-level state. */
export function resetAdaptiveConfigIdentityStateForTest(): void {
  registeredHooks = [];
  invocationSnapshots.clear();
  boundPluginVersion = LOADED_PLUGIN_VERSION;
  manifestReadProbe = null;
}

export function createAdaptiveHookRegistrationRecorder(
  sink: HookRegistrationSink,
): AdaptiveHookRegistrationRecorder {
  const registrations: AdaptiveHookRegistration[] = [];
  return {
    register(surfaceId, event, handler, opts) {
      sink.on(event, handler, opts);
      const check = isSurfaceEnabled(surfaceId);
      registrations.push({ surfaceId, event, enabled: check.enabled });
    },
    snapshot() {
      return registrations.map(registration => ({ ...registration }));
    },
  };
}
