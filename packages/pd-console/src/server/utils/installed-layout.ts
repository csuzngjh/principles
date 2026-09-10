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
  releaseManagerDir: string;
  /**
   * PRI-711: codex-adapter is a runtime-layout component pd-cli resolves
   * eagerly. Undefined only when the canonical runtime root itself cannot be
   * resolved: a one-generation-old deployed install-layout (this update runs
   * inside the currently-running console, which resolves the layout helper
   * installed by the PREVIOUS update) lacks the codexAdapterDir field, but
   * PRI-724 derives the destination from the stable runtimeDir instead of
   * degrading to a silent skip.
   */
  codexAdapterDir: string | undefined;
  hosts: InstallHost[];
}

/**
 * Resolve where the codex-adapter component lives in a CANONICAL layout.
 *
 * PRI-724: a one-generation-old deployed install-layout does not export the
 * codexAdapterDir field (introduced 2026-09-09, PRI-711). The full update
 * runs inside the currently-running console, which resolves the layout
 * helper installed by the PREVIOUS update — so during exactly one update
 * generation the field is always missing. Derive the destination from the
 * stable runtimeDir (the adapter has always been installed at
 * <runtimeDir>/codex-adapter) instead of degrading the update to skipping
 * the adapter copy, which left the deployed adapter one release behind
 * while the update reported success (observed 2026-09-10).
 */
function resolveCanonicalCodexAdapterDir(paths: { runtimeDir: string; codexAdapterDir?: string }): string | undefined {
  if (typeof paths.codexAdapterDir === 'string' && paths.codexAdapterDir.length > 0) {
    return paths.codexAdapterDir;
  }
  // rc-1/rc-2: the deployed module's shape is not trusted — only derive from
  // a runtimeDir that is actually a non-empty string.
  return typeof paths.runtimeDir === 'string' && paths.runtimeDir.length > 0
    ? path.join(paths.runtimeDir, 'codex-adapter')
    : undefined;
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
      releaseManagerDir: paths.releaseManagerDir,
      // PRI-711: the deployed install-layout may predate the codexAdapterDir
      // field — guard instead of trusting the shape. PRI-724: when the field
      // is missing, derive the destination from runtimeDir so the update
      // still swaps the adapter (see resolveCanonicalCodexAdapterDir).
      codexAdapterDir: resolveCanonicalCodexAdapterDir(paths),
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
    releaseManagerDir: path.join(legacyPluginDir, 'release-manager'),
    codexAdapterDir: path.join(legacyPluginDir, 'codex-adapter'),
    hosts: ['openclaw'],
  };
}

export function resolvePluginDir(_workspaceDir: string): string {
  return resolveUpdateLayout()?.pluginDir ?? path.join(resolveExtensionsDir(), 'principles-disciple');
}

/**
 * The canonical runtime root (~/.pd/runtime) — the PD-owned directory the
 * canonical layout keeps plugin/console/core/host-runtime/pd-cli under.
 * Pure path computation (no manifest read), so it is safe to use as a path
 * guard allow-root even when the install resolves to legacy mode.
 */
export function resolveCanonicalRuntimeRoot(): string {
  return getInstallLayoutPaths(os.homedir()).runtimeDir;
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
