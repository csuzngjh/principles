/**
 * Installed PD layout resolution — where the PD plugin (and its bundled
 * components) live on this machine, and which version they report.
 *
 * Single authority (P4) for the "installed PD version": both the update page
 * (`routes/update.ts`) and the health diagnostics
 * (`models/HealthCheckModel.ts`) read the same plugin package.json through
 * `readInstalledPdVersion()`. The previous health implementation resolved a
 * monorepo-root package.json via a fixed five-level relative path, which only
 * worked in the dev tree — in the installed legacy layout it resolved into
 * `<openclawHome>/extensions/` and returned 'unknown' forever.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { getInstallLayoutPaths, resolveInstallLayout, type InstallHost } from '@principles/install-layout';
import { resolveOpenClawHome } from './pd-backups.js';

export function resolveExtensionsDir(): string {
  return path.join(resolveOpenClawHome(), 'extensions');
}

export interface UpdateLayout {
  pluginDir: string;
  consoleDir: string;
  coreDir: string;
  hostRuntimeDir: string;
  pdCliDir: string;
  installLayoutDir: string;
  hosts: InstallHost[];
}

export function resolveUpdateLayout(): UpdateLayout | undefined {
  const homeDir = os.homedir();
  const paths = getInstallLayoutPaths(homeDir);
  const legacyPluginDir = path.join(resolveExtensionsDir(), 'principles-disciple');
  let manifest: unknown;
  try {
    manifest = JSON.parse(fs.readFileSync(paths.manifest, 'utf8')) as unknown;
  } catch {
    manifest = undefined;
  }
  const resolution = resolveInstallLayout({
    homeDir,
    manifest,
    canonicalRuntimeExists: fs.existsSync(paths.runtimeDir),
    legacyExtensionExists: fs.existsSync(legacyPluginDir),
  });
  if (resolution.mode === 'missing') return undefined;
  if (resolution.mode === 'canonical') {
    return {
      pluginDir: paths.pluginDir,
      consoleDir: paths.consoleDir,
      coreDir: paths.coreDir,
      hostRuntimeDir: paths.hostRuntimeDir,
      pdCliDir: paths.pdCliDir,
      installLayoutDir: paths.installLayoutDir,
      hosts: resolution.manifest?.hosts ?? [],
    };
  }
  return {
    pluginDir: legacyPluginDir,
    consoleDir: path.join(legacyPluginDir, 'console'),
    coreDir: path.join(legacyPluginDir, 'core'),
    hostRuntimeDir: path.join(legacyPluginDir, 'host-runtime'),
    pdCliDir: path.join(legacyPluginDir, 'pd-cli'),
    installLayoutDir: path.join(legacyPluginDir, 'install-layout'),
    hosts: ['openclaw'],
  };
}

export function resolvePluginDir(_workspaceDir: string): string {
  return resolveUpdateLayout()?.pluginDir ?? path.join(resolveExtensionsDir(), 'principles-disciple');
}

// rc-2: type-guard the parsed JSON instead of an `as` cast (ERR-001).
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function readCurrentVersion(pluginDir: string): string | undefined {
  const pkgPath = path.join(pluginDir, 'package.json');
  try {
    if (!fs.existsSync(pkgPath)) return undefined;
    const raw = fs.readFileSync(pkgPath, 'utf-8');
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed) || !Object.hasOwn(parsed, 'version')) return undefined;
    const { version } = parsed;
    return typeof version === 'string' ? version : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The PD version this console governs — the installed plugin's package.json
 * version, i.e. the same "当前版本" the update page shows. Returns undefined
 * when no installation can be resolved (dev tree without a local install);
 * callers decide their own fallback display (rc-9).
 */
export function readInstalledPdVersion(): string | undefined {
  return readCurrentVersion(resolvePluginDir(''));
}
