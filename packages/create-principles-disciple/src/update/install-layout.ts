/**
 * Installation layout contract (SPEC §5).
 *
 * Production installation state lives under `~/.pd`:
 *
 *   bootstrap/  installer-owned; a product release can never overwrite it
 *   install.json  channel selection + automatic check settings
 *   trust/      TUF trusted root metadata cache
 *   channels/   cached signed channel metadata
 *   releases/<release-id>/
 *   staging/<transaction-id>/
 *   transactions/<transaction-id>.json
 *   active.json / previous.json
 *   logs/
 *
 * This module owns ONLY path derivation and strict readers. Every read of
 * untrusted on-disk JSON returns `unknown` until validated (rc-1) and fails
 * loud on malformed required fields (rc-3).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { parseProductVersion, ProductIdentityError, isReleaseChannelName, type ReleaseChannelName } from './product-identity.js';
import { normalizeReleaseMetadataUrl } from './release-metadata-source.js';

export interface PdHomePaths {
  readonly home: string;
  readonly bootstrapDir: string;
  readonly bootstrapManifestPath: string;
  readonly installConfigPath: string;
  readonly trustDir: string;
  readonly channelsDir: string;
  readonly releasesDir: string;
  readonly stagingDir: string;
  readonly transactionsDir: string;
  readonly activeRecordPath: string;
  readonly previousRecordPath: string;
  readonly logsDir: string;
}

export function resolvePdHomePaths(pdHome: string): PdHomePaths {
  const home = path.resolve(pdHome);
  return {
    home,
    bootstrapDir: path.join(home, 'bootstrap'),
    bootstrapManifestPath: path.join(home, 'bootstrap', 'bootstrap.json'),
    installConfigPath: path.join(home, 'install.json'),
    trustDir: path.join(home, 'trust'),
    channelsDir: path.join(home, 'channels'),
    releasesDir: path.join(home, 'releases'),
    stagingDir: path.join(home, 'staging'),
    transactionsDir: path.join(home, 'transactions'),
    activeRecordPath: path.join(home, 'active.json'),
    previousRecordPath: path.join(home, 'previous.json'),
    logsDir: path.join(home, 'logs'),
  };
}

/** Creates the installation skeleton once; never touches an existing file. */
export function ensurePdHomeLayout(paths: PdHomePaths): void {
  for (const directory of [
    paths.bootstrapDir, paths.trustDir, paths.channelsDir,
    paths.releasesDir, paths.stagingDir, paths.transactionsDir, paths.logsDir,
  ]) {
    fs.mkdirSync(directory, { recursive: true });
  }
}

export class InstallLayoutError extends Error {
  readonly field: string;

  constructor(field: string, message: string) {
    super(message);
    this.name = 'InstallLayoutError';
    this.field = field;
  }
}

export interface BootstrapManifest {
  readonly bootstrapVersion: string;
  readonly installedAt: string;
}

function readJsonFileIfExists(filePath: string, label: string): unknown | undefined {
  if (!fs.existsSync(filePath)) return undefined;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8')) as unknown;
  } catch (error) {
    // A bare SyntaxError would escape every typed reader below; corrupt
    // installation state fails loud with its own field-tagged error (rc-3).
    throw new InstallLayoutError(
      label,
      `${label} is not valid JSON (${filePath}): ${error instanceof Error ? error.message : String(error)}. Restore it with the official installer; do not guess a partial state.`,
    );
  }
}

/** Strict reader for the installer-owned bootstrap manifest. */
export function readBootstrapManifest(paths: PdHomePaths): BootstrapManifest | null {
  const value = readJsonFileIfExists(paths.bootstrapManifestPath, 'bootstrap.json');
  if (value === undefined) return null;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new InstallLayoutError('bootstrap', `bootstrap manifest must be a JSON object: ${paths.bootstrapManifestPath}`);
  }
  const record = value as Record<string, unknown>;
  if (!Object.hasOwn(record, 'bootstrapVersion')) {
    throw new InstallLayoutError('bootstrapVersion', 'bootstrap manifest is missing bootstrapVersion');
  }
  try {
    const { bootstrapVersion } = { bootstrapVersion: parseProductVersion(record.bootstrapVersion, 'bootstrapVersion') };
    const {installedAt} = record;
    if (typeof installedAt !== 'string' || installedAt.length === 0) {
      throw new InstallLayoutError('installedAt', 'bootstrap manifest installedAt must be a non-empty timestamp string');
    }
    return { bootstrapVersion: bootstrapVersion.productVersion, installedAt };
  } catch (error) {
    if (error instanceof ProductIdentityError) {
      throw new InstallLayoutError(error.field, error.message);
    }
    throw error;
  }
}

export interface InstallConfig {
  readonly channel: ReleaseChannelName;
  readonly autoCheck: boolean;
  /**
   * PRI-709 P0-1: durable base URL of the signed release metadata repository.
   *
   * Additive and optional — an install.json written before this field existed
   * (or by a writer that does not know about it) stays valid and resolves to
   * `unconfigured`. Written by the installer at install time so a new shell,
   * a new process or a restarted Console resolves the same source without an
   * environment variable (see `release-metadata-source.ts`).
   */
  readonly releaseMetadataUrl?: string;
}

/** Strict validator for the optional `releaseMetadataUrl` field (rc-3). */
function parseReleaseMetadataUrlField(value: unknown, paths: PdHomePaths): string | undefined {
  if (value === undefined) return undefined;
  const normalized = normalizeReleaseMetadataUrl(value);
  if (normalized === null) {
    throw new InstallLayoutError(
      'releaseMetadataUrl',
      `install.json releaseMetadataUrl must be a non-empty http(s) URL, got: ${JSON.stringify(value)} (${paths.installConfigPath})`,
    );
  }
  return normalized;
}

/**
 * Installation-level settings (SPEC §2.3). Missing file yields the safe
 * default (stable channel, automatic checks off, no metadata source); a
 * malformed file fails loud instead of degrading to guesses.
 */
export function readInstallConfig(paths: PdHomePaths): InstallConfig {
  const value = readJsonFileIfExists(paths.installConfigPath, 'install.json');
  if (value === undefined) return { channel: 'stable', autoCheck: false };
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new InstallLayoutError('install.json', `install.json must be a JSON object: ${paths.installConfigPath}`);
  }
  const record = value as Record<string, unknown>;
  const channelValue = Object.hasOwn(record, 'channel') ? record.channel : 'stable';
  if (!isReleaseChannelName(channelValue)) {
    throw new InstallLayoutError('channel', `install.json channel must be "stable" or "candidate", got: ${JSON.stringify(channelValue)}`);
  }
  const autoCheckValue = Object.hasOwn(record, 'autoCheck') ? record.autoCheck : false;
  if (typeof autoCheckValue !== 'boolean') {
    throw new InstallLayoutError('autoCheck', `install.json autoCheck must be a boolean, got: ${JSON.stringify(autoCheckValue)}`);
  }
  const releaseMetadataUrl = parseReleaseMetadataUrlField(
    Object.hasOwn(record, 'releaseMetadataUrl') ? record.releaseMetadataUrl : undefined,
    paths,
  );
  return {
    channel: channelValue,
    autoCheck: autoCheckValue,
    ...(releaseMetadataUrl !== undefined ? { releaseMetadataUrl } : {}),
  };
}

/**
 * Read `install.json` as an untyped record for merge-preserving writers.
 *
 * PRI-709 P0-1: `~/.pd/install.json` historically had more than one writer
 * with disjoint schemas — the installer wrote `{layoutVersion, mode, hosts,
 * workspaces}` and `writeInstallConfig` wrote `{channel, autoCheck}`, each
 * wholesale-clobbering the other's fields (and making the manifest parser fail
 * on the victim's shape). Every writer of this file must therefore merge into
 * the existing record instead of replacing it. Corrupt JSON still fails loud
 * (rc-3): overwriting an unreadable file would destroy state we cannot
 * inspect.
 */
export function readInstallJsonRecord(filePath: string): Record<string, unknown> | undefined {
  const value = readJsonFileIfExists(filePath, 'install.json');
  if (value === undefined) return undefined;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new InstallLayoutError('install.json', `install.json must be a JSON object: ${filePath}`);
  }
  return { ...(value as Record<string, unknown>) };
}

/**
 * Merge-preserving write (PRI-709 P0-1). Own fields are overwritten; every
 * other field already present is preserved so the installer-owned manifest
 * fields (`layoutVersion`, `mode`, `hosts`, `workspaces`) survive an
 * update-side config write and vice versa.
 */
export function writeInstallConfig(paths: PdHomePaths, config: InstallConfig): void {
  const existing = readInstallJsonRecord(paths.installConfigPath);
  const payload: Record<string, unknown> = {
    ...(existing ?? {}),
    channel: config.channel,
    autoCheck: config.autoCheck,
  };
  if (config.releaseMetadataUrl !== undefined) {
    payload.releaseMetadataUrl = config.releaseMetadataUrl;
  } else {
    delete payload.releaseMetadataUrl;
  }
  fs.mkdirSync(paths.home, { recursive: true });
  fs.writeFileSync(paths.installConfigPath, `${JSON.stringify(payload, null, 2)}\n`);
}

/** Field-level merge for writers that do not own the whole record. */
export function mergeIntoInstallJson(
  filePath: string,
  patch: Record<string, unknown>,
): void {
  const existing = readInstallJsonRecord(filePath);
  const payload: Record<string, unknown> = { ...(existing ?? {}), ...patch };
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`);
}
