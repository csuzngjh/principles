/**
 * Locate the installed PD extension, the pd-cli entry, and the system Node
 * command the companion uses to launch the console server.
 *
 * Pure functions only — fs existence checks happen at spawn time in the
 * supervisor/main layer, so these helpers stay unit-testable.
 */

import * as path from 'path';
import {
  getInstallLayoutPaths,
  resolveInstallLayout,
  type InstallLayoutMode,
} from '@principles/install-layout';

/** Absolute path of the installed PD extension dir, or undefined if no home. */
export function resolveExtensionDir(homeDir: string | undefined): string | undefined {
  if (homeDir === undefined || homeDir.trim() === '') return undefined;
  return path.join(homeDir, '.openclaw', 'extensions', 'principles-disciple');
}

export function resolveInstalledRuntime(
  options: {
    homeDir: string | undefined;
    manifest: unknown;
    canonicalRuntimeExists: boolean;
    legacyExtensionExists: boolean;
  },
): { root: string; pluginRoot: string; mode: InstallLayoutMode } | undefined {
  const { homeDir, manifest, canonicalRuntimeExists, legacyExtensionExists } = options;
  if (homeDir === undefined || homeDir.trim() === '') return undefined;
  const paths = getInstallLayoutPaths(homeDir);
  const result = resolveInstallLayout({ homeDir, manifest, canonicalRuntimeExists, legacyExtensionExists });
  if (result.mode === 'missing') return undefined;
  return {
    root: result.mode === 'canonical' ? paths.runtimeDir : paths.openClawExtensionDir,
    pluginRoot: result.mode === 'canonical' ? paths.pluginDir : paths.openClawExtensionDir,
    mode: result.mode,
  };
}

/** pd-cli entry inside the extension dir (mirrors installer's autoLaunchConsole). */
export function resolvePdCliEntry(extDir: string): string {
  return path.join(extDir, 'pd-cli', 'dist', 'index.js');
}

/** Plugin package.json inside the extension dir — the installed-version source. */
export function resolvePluginPackageJson(extDir: string): string {
  return path.join(extDir, 'package.json');
}

/**
 * Node command used to run the console server: the literal `node` resolved
 * via PATH by the OS. Deliberately NOT configurable by environment — an
 * env-controlled executable would be an untrusted-program-selection risk.
 * The server depends on better-sqlite3 built for the SYSTEM Node ABI, so
 * Electron's bundled Node (ELECTRON_RUN_AS_NODE) must NOT be used.
 */
export function resolveSystemNodeCommand(): string {
  return 'node';
}

/**
 * Arguments for `pd console open` in companion mode:
 * --json (machine-readable result), --no-browser (companion owns the window),
 * Authentication remains secret-free at this boundary. When a token is
 * configured the child inherits PD_CONSOLE_TOKEN from the environment; the
 * token is never copied into argv.
 */
export function buildConsoleOpenArgs(opts: { workspaceDir?: string; tokenConfigured?: boolean } = {}): string[] {
  const args = ['console', 'open', '--json', '--no-browser'];
  if (opts.tokenConfigured !== true) args.push('--no-auth');
  if (opts.workspaceDir !== undefined && opts.workspaceDir.length > 0) {
    args.push('--workspace', opts.workspaceDir);
  }
  return args;
}
