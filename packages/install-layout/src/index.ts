import * as path from 'node:path';

export const INSTALL_LAYOUT_VERSION = 1 as const;
export const INSTALL_LAYOUT_MODES = ['canonical', 'legacy'] as const;
export type InstallLayoutMode = (typeof INSTALL_LAYOUT_MODES)[number];
export const INSTALL_HOSTS = ['codex', 'openclaw'] as const;
export type InstallHost = (typeof INSTALL_HOSTS)[number];

export interface InstallManifest {
  layoutVersion: typeof INSTALL_LAYOUT_VERSION;
  mode: InstallLayoutMode;
  hosts: InstallHost[];
}

export interface InstallLayoutPaths {
  homeDir: string;
  pdDir: string;
  manifest: string;
  runtimeDir: string;
  pluginDir: string;
  installLayoutDir: string;
  coreDir: string;
  hostRuntimeDir: string;
  pdCliDir: string;
  consoleDir: string;
  binDir: string;
  codexDir: string;
  openClawDir: string;
  openClawExtensionDir: string;
}

export interface LayoutResolution {
  mode: InstallLayoutMode | 'missing';
  paths: InstallLayoutPaths;
  manifest?: InstallManifest;
  reason?: string;
  nextAction?: string;
}

export interface ResolveInstallLayoutOptions {
  homeDir: string;
  manifest?: unknown;
  canonicalRuntimeExists: boolean;
  legacyExtensionExists: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isHost(value: unknown): value is InstallHost {
  return typeof value === 'string' && (INSTALL_HOSTS as readonly string[]).includes(value);
}

export function parseInstallManifest(value: unknown): { manifest?: InstallManifest; error?: string } {
  if (!isRecord(value)) return { error: 'install_manifest_malformed: expected an object' };
  if (value.layoutVersion !== INSTALL_LAYOUT_VERSION) {
    return { error: `install_manifest_unsupported_version: ${String(value.layoutVersion)}` };
  }
  if (value.mode !== 'canonical' && value.mode !== 'legacy') {
    return { error: 'install_manifest_malformed: mode must be canonical or legacy' };
  }
  if (!Array.isArray(value.hosts) || value.hosts.length === 0 || !value.hosts.every(isHost)) {
    return { error: 'install_manifest_malformed: hosts must contain codex and/or openclaw' };
  }
  const hosts = [...new Set(value.hosts)];
  return { manifest: { layoutVersion: INSTALL_LAYOUT_VERSION, mode: value.mode, hosts } };
}

export function getInstallLayoutPaths(homeDir: string): InstallLayoutPaths {
  const home = path.resolve(homeDir);
  const pdDir = path.join(home, '.pd');
  const runtimeDir = path.join(pdDir, 'runtime');
  const openClawDir = path.join(home, '.openclaw');
  return {
    homeDir: home,
    pdDir,
    manifest: path.join(pdDir, 'install.json'),
    runtimeDir,
    pluginDir: path.join(runtimeDir, 'plugin'),
    installLayoutDir: path.join(runtimeDir, 'install-layout'),
    coreDir: path.join(runtimeDir, 'core'),
    hostRuntimeDir: path.join(runtimeDir, 'host-runtime'),
    pdCliDir: path.join(runtimeDir, 'pd-cli'),
    consoleDir: path.join(runtimeDir, 'console'),
    binDir: path.join(runtimeDir, 'bin'),
    codexDir: path.join(pdDir, 'codex'),
    openClawDir,
    openClawExtensionDir: path.join(openClawDir, 'extensions', 'principles-disciple'),
  };
}

export function resolveInstallLayout(options: ResolveInstallLayoutOptions): LayoutResolution {
  const paths = getInstallLayoutPaths(options.homeDir);
  const parsed = parseInstallManifest(options.manifest);
  if (parsed.manifest && parsed.manifest.mode === 'canonical' && options.canonicalRuntimeExists) {
    return { mode: 'canonical', paths, manifest: parsed.manifest };
  }
  if (options.legacyExtensionExists) {
    return {
      mode: 'legacy',
      paths,
      ...(parsed.manifest ? { manifest: parsed.manifest } : {}),
      reason: parsed.error ?? 'install_layout_legacy_fallback',
      nextAction: 'Run the installer update to migrate the shared runtime to ~/.pd/runtime.',
    };
  }
  return {
    mode: 'missing',
    paths,
    reason: parsed.error ?? 'install_runtime_missing',
    nextAction: 'Run npx create-principles-disciple to install or repair PD.',
  };
}

export function getConsoleServerEntry(paths: InstallLayoutPaths, mode: InstallLayoutMode): string {
  const root = mode === 'canonical' ? paths.consoleDir : path.join(paths.openClawExtensionDir, 'console');
  return path.join(root, 'dist', 'server.js');
}

export function getConsoleWebIndex(paths: InstallLayoutPaths, mode: InstallLayoutMode): string {
  const root = mode === 'canonical' ? paths.consoleDir : path.join(paths.openClawExtensionDir, 'console');
  return path.join(root, 'dist', 'web', 'index.html');
}

export function getPdCliEntry(paths: InstallLayoutPaths, mode: InstallLayoutMode): string {
  const root = mode === 'canonical' ? paths.pdCliDir : path.join(paths.openClawExtensionDir, 'pd-cli');
  return path.join(root, 'dist', 'index.js');
}
