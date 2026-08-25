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

function readJsonFileIfExists(filePath: string): unknown | undefined {
  if (!fs.existsSync(filePath)) return undefined;
  return JSON.parse(fs.readFileSync(filePath, 'utf8')) as unknown;
}

/** Strict reader for the installer-owned bootstrap manifest. */
export function readBootstrapManifest(paths: PdHomePaths): BootstrapManifest | null {
  const value = readJsonFileIfExists(paths.bootstrapManifestPath);
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
}

/**
 * Installation-level settings (SPEC §2.3). Missing file yields the safe
 * default (stable channel, automatic checks off); a malformed file fails
 * loud instead of degrading to guesses.
 */
export function readInstallConfig(paths: PdHomePaths): InstallConfig {
  const value = readJsonFileIfExists(paths.installConfigPath);
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
  return { channel: channelValue, autoCheck: autoCheckValue };
}

export function writeInstallConfig(paths: PdHomePaths, config: InstallConfig): void {
  const payload = {
    channel: config.channel,
    autoCheck: config.autoCheck,
  };
  fs.mkdirSync(paths.home, { recursive: true });
  fs.writeFileSync(paths.installConfigPath, `${JSON.stringify(payload, null, 2)}\n`);
}
