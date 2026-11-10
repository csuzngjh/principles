import * as path from 'node:path';

export const INSTALL_LAYOUT_VERSION = 1 as const;
export const INSTALL_LAYOUT_MODES = ['canonical', 'legacy'] as const;
export type InstallLayoutMode = (typeof INSTALL_LAYOUT_MODES)[number];
export const INSTALL_HOSTS = ['codex', 'openclaw', 'workbuddy'] as const;
export type InstallHost = (typeof INSTALL_HOSTS)[number];

export interface InstallManifest {
  layoutVersion: typeof INSTALL_LAYOUT_VERSION;
  mode: InstallLayoutMode;
  /**
   * Hosts THIS reader version recognizes. Host strings the reader does not
   * know are NOT here — they land in `unknownHosts` so an install registered
   * with a newer host keeps resolving instead of being rejected as malformed.
   */
  hosts: InstallHost[];
  /**
   * Host strings present in the persisted `hosts` array that this reader
   * version does not know (forward compatibility, 2026-10-16). A NEWER
   * installer may register a host an OLDER reader never heard of; that is a
   * compatibility warning, never "manifest malformed" — treating it as one
   * made every pre-WorkBuddy Companion report `console_runtime_not_installed`
   * against a healthy 3-host install and mass-stop its workers. Fail-closed
   * stays reserved for structural damage: wrong layoutVersion, non-array or
   * non-string hosts, bad mode, illegal workspace paths.
   */
  unknownHosts?: readonly string[];
  /**
   * Canonical absolute paths of Workspaces the install serves (PRI-624 Slice C).
   * Optional so pre-PRI-624 manifests stay valid; always normalized to
   * resolved absolute paths and deduped. The installer merges the install
   * Workspace in; the Companion worker discovers its per-Workspace workers
   * from this list (SPEC §13 "canonical install manifest").
   */
  workspaces?: readonly string[];
}

/** Structured forward-compatibility observation from manifest parsing (rc-9). */
export interface InstallManifestWarning {
  code: 'install_manifest_unknown_host';
  host: string;
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
  /**
   * PRI-672: the ReleaseManager authority component (payload dir
   * release-manager/, npm name create-principles-disciple).
   */
  releaseManagerDir: string;
  /**
   * PRI-711: the Codex host adapter component (payload dir codex-adapter/,
   * npm name @principles/codex-adapter). Lives inside the runtime layout
   * since PRI-624 bundled it, and pd-cli's eager import graph (health-codex)
   * statically resolves it — so updates must refresh it and its resolution
   * links like any other runtime component.
   */
  codexAdapterDir: string;
  /**
   * WorkBuddy host adapter component (payload dir workbuddy-adapter/, npm
   * name @principles/workbuddy-adapter; SPEC workbuddy-host-adapter §4.1).
   * The WorkBuddy plugin wrapper resolves this dir to load the adapter entry
   * the same way the Codex hook resolves the canonical runtime.
   */
  workbuddyAdapterDir: string;
  /**
   * Gate 4 (PRI-1071): the shared read-only MCP server component (payload dir
   * pd-mcp-server/, npm name @principles/pd-mcp-server). This is the Install
   * Layout SSoT for the canonical server entry OpenClaw/WorkBuddy launchers
   * bind to; Codex keeps its plugin-data runtime layout and records that dir
   * in its own binding.
   */
  mcpServerDir: string;
}

export interface LayoutResolution {
  mode: InstallLayoutMode | 'missing';
  paths: InstallLayoutPaths;
  manifest?: InstallManifest;
  reason?: string;
  nextAction?: string;
  /** Forward-compatibility warnings surfaced while parsing the manifest. */
  warnings?: readonly InstallManifestWarning[];
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

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

/** Workspace entries must be non-empty absolute paths — the Companion spawns per-Workspace workers keyed by canonical path. */
function parseWorkspaceList(value: unknown): { workspaces?: string[]; error?: string } {
  if (value === undefined) return { workspaces: [] };
  if (!Array.isArray(value)) return { error: 'install_manifest_malformed: workspaces must be non-empty absolute paths' };
  const resolved: string[] = [];
  for (const entry of value) {
    if (typeof entry !== 'string' || entry.length === 0 || !path.isAbsolute(entry)) {
      return { error: 'install_manifest_malformed: workspaces must be non-empty absolute paths' };
    }
    const canonical = path.resolve(entry);
    if (!resolved.includes(canonical)) resolved.push(canonical);
  }
  return { workspaces: resolved };
}

/**
 * Merge one Workspace into a manifest's workspace list (installer write path). Idempotent by canonical path. */
export function mergeInstallManifestWorkspaces(current: InstallManifest | undefined, workspaceDir: string): string[] {
  const canonical = path.resolve(workspaceDir);
  const resolved: string[] = [];
  for (const entry of current?.workspaces ?? []) {
    const normalized = path.resolve(entry);
    if (!resolved.includes(normalized)) resolved.push(normalized);
  }
  if (!resolved.includes(canonical)) resolved.push(canonical);
  return resolved;
}

/**
 * The `hosts` array a manifest WRITER must persist: every registration the
 * reader recognized plus every unknown one, deduped, known hosts first.
 * Writers that rebuild `hosts` from `manifest.hosts` alone silently DELETE a
 * newer host's registration — the write-side twin of the read-side
 * unknown-host brick (2026-10-16). `undefined` yields `[]` so the installer's
 * fresh-install path keeps working unchanged.
 */
export function installManifestHostsForPersist(manifest: InstallManifest | undefined): string[] {
  return [...new Set([...(manifest?.hosts ?? []), ...(manifest?.unknownHosts ?? [])])];
}

/**
 * Parse the install manifest. Structural damage fails closed with `error`;
 * a host string this reader version does not know is a `warnings` entry and
 * the manifest still parses (forward compatibility — see `InstallManifest.unknownHosts`).
 */
export function parseInstallManifest(value: unknown): { manifest?: InstallManifest; warnings?: readonly InstallManifestWarning[]; error?: string } {
  if (!isRecord(value)) return { error: 'install_manifest_malformed: expected an object' };
  if (value.layoutVersion !== INSTALL_LAYOUT_VERSION) {
    return { error: `install_manifest_unsupported_version: ${String(value.layoutVersion)}` };
  }
  if (value.mode !== 'canonical' && value.mode !== 'legacy') {
    return { error: 'install_manifest_malformed: mode must be canonical or legacy' };
  }
  // Host entries must be non-empty strings; WHICH strings are valid hosts is
  // version-relative knowledge, so unknown strings warn instead of failing.
  if (!Array.isArray(value.hosts) || !value.hosts.every(isNonEmptyString)) {
    return { error: 'install_manifest_malformed: hosts must be an array of host name strings' };
  }
  // Idempotency: the parser must re-read its own output. An all-unknown-hosts
  // manifest parses to hosts: [] + unknownHosts, so the optional persisted
  // `unknownHosts` field is accepted on input too (installManifestHostsForPersist
  // reunifies them on write; writers persist the union into `hosts`).
  let carriedUnknownHosts: readonly string[] = [];
  if (value.unknownHosts !== undefined) {
    if (!Array.isArray(value.unknownHosts) || !value.unknownHosts.every(isNonEmptyString)) {
      return { error: 'install_manifest_malformed: unknownHosts must be an array of host name strings' };
    }
    carriedUnknownHosts = value.unknownHosts.filter((host) => !isHost(host));
  }
  if (value.hosts.length === 0 && carriedUnknownHosts.length === 0) {
    return { error: 'install_manifest_malformed: hosts must contain at least one host' };
  }
  const hosts: InstallHost[] = [];
  const unknownHosts: string[] = [];
  const warnings: InstallManifestWarning[] = [];
  for (const host of [...new Set(value.hosts)]) {
    if (isHost(host)) hosts.push(host);
    else {
      unknownHosts.push(host);
      warnings.push({ code: 'install_manifest_unknown_host', host });
    }
  }
  for (const host of carriedUnknownHosts) {
    if (!unknownHosts.includes(host)) {
      unknownHosts.push(host);
      warnings.push({ code: 'install_manifest_unknown_host', host });
    }
  }
  const workspaces = parseWorkspaceList(value.workspaces);
  if (workspaces.error) return { error: workspaces.error };
  return {
    manifest: {
      layoutVersion: INSTALL_LAYOUT_VERSION,
      mode: value.mode,
      hosts,
      ...(unknownHosts.length > 0 ? { unknownHosts } : {}),
      workspaces: workspaces.workspaces,
    },
    ...(warnings.length > 0 ? { warnings } : {}),
  };
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
    releaseManagerDir: path.join(runtimeDir, 'release-manager'),
    codexAdapterDir: path.join(runtimeDir, 'codex-adapter'),
    workbuddyAdapterDir: path.join(runtimeDir, 'workbuddy-adapter'),
    mcpServerDir: path.join(runtimeDir, 'pd-mcp-server'),
  };
}

/**
 * Canonical installed MCP server entry for the shared runtime layout
 * (~/.pd/runtime/pd-mcp-server/dist/index.js). Launchers, binding writers and
 * health diagnostics derive the path from this single owner instead of each
 * repeating the segment list.
 */
export function getMcpServerEntry(paths: InstallLayoutPaths): string {
  return path.join(paths.mcpServerDir, 'dist', 'index.js');
}

/**
 * WorkBuddy governance workspace (SPEC workbuddy-host-adapter §4.1 OD-07,
 * frozen by Phase 0 probe P06 2026-10-12): an explicit user-level directory
 * under the WorkBuddy config root, shared across projects, never auto-reused
 * from Codex/OpenClaw state. projectDir stays the host cwd; this dir owns
 * governance state (state.db / trajectory). The dir is CREATED only by the
 * explicit setup flow — its absence means "not initialized", never a silent
 * fallback to another host's database.
 */
export function getWorkbuddyWorkspaceDir(homeDir: string): string {
  return path.join(path.resolve(homeDir), '.workbuddy', 'pd-workspace');
}

// ─── WorkBuddy host state (2026-11-07, read-only state contract) ────────────
/**
 * The ONE registration/enablement state definition shared by the installer
 * (install summary + `status`) and pd-cli (`pd health --host workbuddy`).
 * Pure: no fs, no env — callers read the host files and hand the parsed
 * values in. Neither fact may be inferred from the other (SPEC §6.4
 * install ≠ enable); an unreadable source must never collapse into a
 * definite value.
 */

export const WORKBUDDY_PLUGIN_NAME = 'principles-disciple';
export const WORKBUDDY_MARKETPLACE_NAME = 'principles-disciple-market';
/** Registry/settings key: "principles-disciple@principles-disciple-market". */
export const WORKBUDDY_PLUGIN_KEY = `${WORKBUDDY_PLUGIN_NAME}@${WORKBUDDY_MARKETPLACE_NAME}`;

export interface WorkbuddyPluginStateView {
  /** The host registry (installed_plugins.json) carries the PD plugin entry. */
  readonly registered: boolean;
  /** False when the registry file could not be read/parsed — installed must NOT be claimed. */
  readonly registryReadable: boolean;
  /** `enabledPlugins[key]`: true/false, or null when absent/unreadable/non-boolean (activation unknown). */
  readonly enabled: boolean | null;
}

export interface WorkbuddyHostConfigPaths {
  /** Host config root (the engine honors WORKBUDDY_CONFIG_DIR when set). */
  readonly configDir: string;
  readonly settingsPath: string;
  readonly registryPath: string;
}

/**
 * Resolve the WorkBuddy HOST config paths from one authority. The frozen
 * governance dir (~/.workbuddy/pd-workspace) defines the config root;
 * WORKBUDDY_CONFIG_DIR is the isolation override (Phase 0 lab discipline).
 * The WorkBuddyHostInstaller resolves its full path set by delegating here,
 * so installer / status / health can never disagree about where the host
 * files live.
 */
export function getWorkbuddyHostConfigPaths(homeDir: string, configDirOverride?: string): WorkbuddyHostConfigPaths {
  const configDir = configDirOverride !== undefined && configDirOverride.length > 0
    ? path.resolve(configDirOverride)
    : path.dirname(getWorkbuddyWorkspaceDir(homeDir));
  return {
    configDir,
    settingsPath: path.join(configDir, 'settings.json'),
    registryPath: path.join(configDir, 'plugins', 'installed_plugins.json'),
  };
}

/** rc-1 minimal guard: a plain JSON object, not an array/null/primitive. */
function isPlainJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The shared plugin-state judgment (rc-2: no `as` bypass; rc-4/5). The exact
 * semantics the installer has applied since PR #2355, extracted so pd-cli
 * health reports the SAME three facts from the same rules:
 *   - registered:  registry readable AND carried a plugins mapping with our key;
 *   - registryReadable: false only when the registry could not be read/parsed;
 *   - enabled: the boolean in settings.enabledPlugins[our key], or null when
 *     settings are unreadable, the key is absent, or the value is not boolean.
 */
export function interpretWorkbuddyPluginState(input: {
  registryParsed: unknown;
  settingsParsed: unknown;
  registryReadable: boolean;
}): WorkbuddyPluginStateView {
  const registry = isPlainJsonObject(input.registryParsed) ? input.registryParsed : undefined;
  const plugins = registry !== undefined && isPlainJsonObject(registry.plugins) ? registry.plugins : undefined;
  const registered = input.registryReadable && plugins !== undefined
    ? Object.hasOwn(plugins, WORKBUDDY_PLUGIN_KEY)
    : false;
  const settings = isPlainJsonObject(input.settingsParsed) ? input.settingsParsed : undefined;
  const enabledPlugins = settings !== undefined && isPlainJsonObject(settings.enabledPlugins) ? settings.enabledPlugins : undefined;
  const raw = enabledPlugins === undefined ? undefined : enabledPlugins[WORKBUDDY_PLUGIN_KEY];
  return {
    registered,
    registryReadable: input.registryReadable,
    enabled: typeof raw === 'boolean' ? raw : null,
  };
}

export function resolveInstallLayout(options: ResolveInstallLayoutOptions): LayoutResolution {
  const paths = getInstallLayoutPaths(options.homeDir);
  const parsed = parseInstallManifest(options.manifest);
  const { warnings } = parsed;
  if (parsed.manifest && parsed.manifest.mode === 'canonical' && options.canonicalRuntimeExists) {
    return { mode: 'canonical', paths, manifest: parsed.manifest, ...(warnings !== undefined ? { warnings } : {}) };
  }
  // RF-01 (review 2026-10-16): when a canonical runtime EXISTS, the manifest
  // is the install-state authority. A manifest that was READ but cannot be
  // honored (newer layoutVersion, structural damage) must refuse the whole
  // resolution — falling through to the legacy extension dir would launch a
  // runtime that does not match the installed protocol. Legacy fallback stays
  // legitimate only when the reader genuinely saw NO manifest (absent file →
  // `options.manifest === undefined`), i.e. a real legacy-only install, or
  // when there is no canonical runtime to bypass.
  if (options.canonicalRuntimeExists && options.manifest !== undefined && parsed.manifest === undefined) {
    return {
      mode: 'missing',
      paths,
      reason: parsed.error ?? 'install_manifest_malformed',
      nextAction: parsed.error?.startsWith('install_manifest_unsupported_version')
        ? 'Update PD Companion from https://github.com/csuzngjh/principles/releases (companion-v* Windows installer); do not reinstall the healthy PD runtime.'
        : 'Run the PD installer/updater to repair the structurally damaged installation manifest.',
      ...(warnings !== undefined ? { warnings } : {}),
    };
  }
  if (options.legacyExtensionExists) {
    return {
      mode: 'legacy',
      paths,
      ...(parsed.manifest ? { manifest: parsed.manifest } : {}),
      reason: parsed.error ?? 'install_layout_legacy_fallback',
      nextAction: 'Run the installer update to migrate the shared runtime to ~/.pd/runtime.',
      ...(warnings !== undefined ? { warnings } : {}),
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

/**
 * PD home resolution (PRI-872): production keeps the historical `os.homedir()`
 * derivation; `PD_EXPERIMENT_ROOT` opts into a fail-closed isolated root. This
 * is the ONE authority for "which PD home does this process own" — components
 * must not re-derive it locally.
 */
export {
  PD_EXPERIMENT_ROOT_ENV,
  PD_OPENCLAW_HOME_ENV,
  PD_OPENCLAW_STATE_DIR_ENV,
  PD_HOME_MODES,
  PD_HOME_FAILURE_REASONS,
  resolvePdHome,
  isPathWithinRoot,
  type PdHomeMode,
  type PdHomePaths,
  type PdHomeFailure,
  type PdHomeFailureReason,
  type PdHomeSuccess,
  type PdHomeResolution,
  type ResolvePdHomeOptions,
} from './pd-home.js';
