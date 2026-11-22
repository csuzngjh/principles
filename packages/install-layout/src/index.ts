import * as fs from 'node:fs';
import * as path from 'node:path';
import { resolvePdHome, type PdHomePaths, type ResolvePdHomeOptions } from './pd-home.js';

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
  /**
   * Per-Workspace background-execution OWNERSHIP records (ADR-0020 §11.6
   * narrow scope / SPEC-PD-SERVICE-HOST-001 §8.4), keyed by canonical
   * absolute workspace path — the same identity `workspaces` carries.
   * Optional so pre-record manifests stay valid; a Workspace with no entry
   * means "legacy Companion owns background execution" for THAT Workspace
   * only. Each Workspace migrates independently: one entry's transition
   * never touches another key, so Workspace A can be `service_host_owned`
   * while Workspace B is still `legacy_owned` or mid-`handover_preparing`.
   *
   * This is the CAS contract between the legacy consumer and the Service
   * Host: only the state machine defined in the SPEC may advance an entry,
   * every transition is a monotonic-generation compare-and-set, and PID /
   * delays / startup order are NEVER ownership proof — this record is.
   * The schema stores the record; the CAS write itself is NOT implemented
   * yet (Phase 5 acceptance).
   */
  backgroundExecutions?: Readonly<Record<string, BackgroundExecutionRecord>>;
}

export const BACKGROUND_EXECUTION_OWNERS = ['legacy', 'service_host'] as const;
export type BackgroundExecutionOwner = (typeof BACKGROUND_EXECUTION_OWNERS)[number];
export const BACKGROUND_EXECUTION_STATES = [
  'legacy_owned',
  'handover_preparing',
  'service_host_owned',
  'rollback_pending',
] as const;
export type BackgroundExecutionState = (typeof BACKGROUND_EXECUTION_STATES)[number];

/**
 * The persisted ownership fact for background execution (SPEC §8.4).
 *  - `state`/`effectiveOwner`: where the state machine currently stands and
 *    which consumer is allowed to execute work RIGHT NOW;
 *  - `generation`: strictly monotonic per accepted transition — the CAS key
 *    (a writer must observe `generation` then write `generation+1` under the
 *    manifest write lock; a stale observed generation loses);
 *  - `operationId`: idempotency key of the handover/rollback operation —
 *    replaying the same operationId must be a no-op;
 *  - `previousOwner`/`targetOwner`: the two parties of an in-flight
 *    transition (both null in a steady state);
 *  - `updatedAt`: ISO-8601 timestamp of the last accepted transition.
 */
export interface BackgroundExecutionRecord {
  state: BackgroundExecutionState;
  effectiveOwner: BackgroundExecutionOwner;
  generation: number;
  operationId: string | null;
  previousOwner: BackgroundExecutionOwner | null;
  targetOwner: BackgroundExecutionOwner | null;
  updatedAt: string;
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
  /** Real OS home; ignored when a pre-resolved PD Home is supplied. */
  homeDir: string;
  /** Reuse the already-validated PD Home without resolving an experiment root twice. */
  homePaths?: PdHomePaths;
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
type WorkspacePathApi = Pick<typeof path, 'isAbsolute' | 'resolve'>;

/**
 * Path rules are selected by an injected platform rather than the ambient one,
 * so the win32 rule can be exercised on POSIX CI (same pattern as
 * `isSameMcpBindingPath` in the MCP binding contract). Production callers keep
 * the default `process.platform` and therefore behave exactly as before.
 */
function workspacePathApi(platform: string): WorkspacePathApi {
  return platform === 'win32' ? path.win32 : path.posix;
}

function parseWorkspaceList(value: unknown, platform: string): { workspaces?: string[]; error?: string } {
  if (value === undefined) return { workspaces: [] };
  if (!Array.isArray(value)) return { error: 'install_manifest_malformed: workspaces must be non-empty absolute paths' };
  const api = workspacePathApi(platform);
  const resolved: string[] = [];
  for (const entry of value) {
    if (typeof entry !== 'string' || entry.length === 0 || !api.isAbsolute(entry)) {
      return { error: 'install_manifest_malformed: workspaces must be non-empty absolute paths' };
    }
    const canonical = api.resolve(entry);
    if (!resolved.includes(canonical)) resolved.push(canonical);
  }
  return { workspaces: resolved };
}

/**
 * Merge one Workspace into a manifest's workspace list (installer write path). Idempotent by canonical path. */
export function mergeInstallManifestWorkspaces(
  current: InstallManifest | undefined,
  workspaceDir: string,
  platform: string = process.platform,
): string[] {
  const api = workspacePathApi(platform);
  const canonical = api.resolve(workspaceDir);
  const resolved: string[] = [];
  for (const entry of current?.workspaces ?? []) {
    const normalized = api.resolve(entry);
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
function isBackgroundExecutionOwner(value: unknown): value is BackgroundExecutionOwner {
  return typeof value === 'string'
    && (BACKGROUND_EXECUTION_OWNERS as readonly string[]).includes(value);
}

function isBackgroundExecutionState(value: unknown): value is BackgroundExecutionState {
  return typeof value === 'string'
    && (BACKGROUND_EXECUTION_STATES as readonly string[]).includes(value);
}

function isNullableOwner(value: unknown): value is BackgroundExecutionOwner | null {
  return value === null || isBackgroundExecutionOwner(value);
}

/**
 * Fail-closed semantic check for one ownership record. Absent is fine
 * (legacy default); present-but-malformed is structural damage — an
 * ownership fact that cannot be trusted must not be honored.
 *
 * Field types alone are NOT enough: the legal combination of
 * state/effectiveOwner/previousOwner/targetOwner/operationId/generation is
 * part of the contract (SPEC §8.4). Illegal combinations are refused at
 * parse time so a corrupt marker can never be honored as ownership proof:
 *  - legacy_owned:        effectiveOwner=legacy,       prev/target/operationId=null, generation>=0;
 *  - service_host_owned:  effectiveOwner=service_host, prev/target/operationId=null, generation>=1;
 *  - handover_preparing:  effectiveOwner=legacy (old consumer still owns until the CAS flips),
 *                         prev=legacy, target=service_host, operationId set, generation>=1;
 *  - rollback_pending:    effectiveOwner=service_host (still owned until the CAS restores),
 *                         prev=service_host, target=legacy, operationId set, generation>=1.
 * A transition state implies at least one accepted transition already
 * happened, so generation 0 there is unreachable and rejected.
 */
function parseBackgroundExecutionRecord(
  value: unknown,
): { record?: BackgroundExecutionRecord; error?: string } {
  if (value === undefined) return {};
  const malformed = 'install_manifest_malformed: backgroundExecution must be a complete ownership record';
  if (!isRecord(value)) return { error: malformed };
  if (!isBackgroundExecutionState(value.state)) return { error: malformed };
  if (!isBackgroundExecutionOwner(value.effectiveOwner)) return { error: malformed };
  if (typeof value.generation !== 'number' || !Number.isInteger(value.generation) || value.generation < 0) {
    return { error: malformed };
  }
  if (value.operationId !== null && !isNonEmptyString(value.operationId)) return { error: malformed };
  if (!isNullableOwner(value.previousOwner)) return { error: malformed };
  if (!isNullableOwner(value.targetOwner)) return { error: malformed };
  if (typeof value.updatedAt !== 'string' || value.updatedAt.length === 0) return { error: malformed };
  const combination =
    `install_manifest_malformed: backgroundExecution ${value.state} has an illegal ` +
    'effectiveOwner/previousOwner/targetOwner/operationId/generation combination';
  switch (value.state) {
    case 'legacy_owned':
      if (value.effectiveOwner !== 'legacy' || value.previousOwner !== null
        || value.targetOwner !== null || value.operationId !== null) {
        return { error: combination };
      }
      break;
    case 'service_host_owned':
      if (value.effectiveOwner !== 'service_host' || value.previousOwner !== null
        || value.targetOwner !== null || value.operationId !== null || value.generation < 1) {
        return { error: combination };
      }
      break;
    case 'handover_preparing':
      if (value.effectiveOwner !== 'legacy' || value.previousOwner !== 'legacy'
        || value.targetOwner !== 'service_host' || value.operationId === null || value.generation < 1) {
        return { error: combination };
      }
      break;
    case 'rollback_pending':
      if (value.effectiveOwner !== 'service_host' || value.previousOwner !== 'service_host'
        || value.targetOwner !== 'legacy' || value.operationId === null || value.generation < 1) {
        return { error: combination };
      }
      break;
  }
  return {
    record: {
      state: value.state,
      effectiveOwner: value.effectiveOwner,
      generation: value.generation,
      operationId: value.operationId,
      previousOwner: value.previousOwner,
      targetOwner: value.targetOwner,
      updatedAt: value.updatedAt,
    },
  };
}

/**
 * Parse the per-Workspace ownership map. Every key must be the canonical
 * absolute path of a Workspace declared in `workspaces` — a record keyed to
 * an undeclared identity is ambiguous ownership and fails closed rather
 * than being silently honored or dropped.
 *
 * Backward compatibility: the pre-per-Workspace field `backgroundExecution`
 * (a single record, no workspace identity) is migrated ONLY when the
 * manifest declares exactly one Workspace — the only case where the owner
 * is unambiguous. With zero or several Workspaces it is refuse-to-guess
 * structural damage; both spellings present is a conflict and also fails.
 */
function parseBackgroundExecutions(
  value: { backgroundExecution?: unknown; backgroundExecutions?: unknown },
  workspaces: readonly string[],
  platform: string,
): { records?: Record<string, BackgroundExecutionRecord>; error?: string } {
  const mapMalformed =
    'install_manifest_malformed: backgroundExecutions must be keyed by canonical paths of declared workspaces';
  const api = workspacePathApi(platform);
  const legacy = parseBackgroundExecutionRecord(value.backgroundExecution);
  if (legacy.error) return { error: legacy.error };
  if (value.backgroundExecutions !== undefined && !isRecord(value.backgroundExecutions)) {
    return { error: mapMalformed };
  }
  const records: Record<string, BackgroundExecutionRecord> = {};
  for (const [key, raw] of Object.entries(value.backgroundExecutions ?? {})) {
    if (!api.isAbsolute(key) || api.resolve(key) !== key || !workspaces.includes(key)) {
      return { error: mapMalformed };
    }
    const parsed = parseBackgroundExecutionRecord(raw);
    if (parsed.error || !parsed.record) return { error: parsed.error ?? mapMalformed };
    records[key] = parsed.record;
  }
  if (legacy.record !== undefined) {
    if (Object.keys(records).length > 0) {
      return { error: 'install_manifest_malformed: backgroundExecution conflicts with backgroundExecutions' };
    }
    const only = workspaces.length === 1 ? workspaces[0] : undefined;
    if (only === undefined) {
      return {
        error: 'install_manifest_malformed: legacy backgroundExecution cannot be attributed to a unique workspace',
      };
    }
    records[only] = legacy.record;
  }
  return { records };
}

/**
 * Set or clear ONE Workspace's ownership record, preserving every other
 * Workspace's entry — the write-side half of "one migration never overwrites
 * another Workspace's state". `record` must already satisfy the semantic
 * contract (build it through the SPEC §8.4 state machine; absent record
 * removes the entry and restores the legacy default for that Workspace).
 */
export function setInstallManifestBackgroundExecution(
  manifest: InstallManifest | undefined,
  target: { workspaceDir: string; platform?: string },
  record: BackgroundExecutionRecord | undefined,
): Record<string, BackgroundExecutionRecord> {
  const api = workspacePathApi(target.platform ?? process.platform);
  const canonical = api.resolve(target.workspaceDir);
  const next: Record<string, BackgroundExecutionRecord> = { ...(manifest?.backgroundExecutions ?? {}) };
  if (record === undefined) delete next[canonical];
  else next[canonical] = record;
  return next;
}

export function parseInstallManifest(
  value: unknown,
  platform: string = process.platform,
): { manifest?: InstallManifest; warnings?: readonly InstallManifestWarning[]; error?: string } {
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
  const workspaces = parseWorkspaceList(value.workspaces, platform);
  if (workspaces.error) return { error: workspaces.error };
  const backgroundExecutions = parseBackgroundExecutions(
    { backgroundExecution: value.backgroundExecution, backgroundExecutions: value.backgroundExecutions },
    workspaces.workspaces ?? [],
    platform,
  );
  if (backgroundExecutions.error) return { error: backgroundExecutions.error };
  return {
    manifest: {
      layoutVersion: INSTALL_LAYOUT_VERSION,
      mode: value.mode,
      hosts,
      ...(unknownHosts.length > 0 ? { unknownHosts } : {}),
      workspaces: workspaces.workspaces,
      ...(Object.keys(backgroundExecutions.records ?? {}).length > 0
        ? { backgroundExecutions: backgroundExecutions.records } : {}),
    },
    ...(warnings.length > 0 ? { warnings } : {}),
  };
}


function requirePdHome(options: ResolvePdHomeOptions) {
  const resolution = resolvePdHome(options);
  if (!resolution.ok) {
    throw new Error(
      `PD home resolution refused (${resolution.reason}): ${resolution.message} Next action: ${resolution.nextAction}`,
    );
  }
  return resolution;
}

/** Build install paths from an already-resolved PD Home (e.g. Console request scope). */
export function getInstallLayoutPathsFromPdHome(homePaths: PdHomePaths): InstallLayoutPaths {
  const {
    homeDir: home,
    pdHome: pdDir,
    runtimeDir,
    openclawHome: openClawDir,
    openclawExtensionDir,
  } = homePaths;
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
    openClawExtensionDir: openclawExtensionDir,
    releaseManagerDir: path.join(runtimeDir, 'release-manager'),
    codexAdapterDir: path.join(runtimeDir, 'codex-adapter'),
    workbuddyAdapterDir: path.join(runtimeDir, 'workbuddy-adapter'),
    mcpServerDir: path.join(runtimeDir, 'pd-mcp-server'),
  };
}

/**
 * Every install path derives from the same PD Home resolution. In particular,
 * OpenClaw's extension directory follows OPENCLAW_STATE_DIR > OPENCLAW_HOME,
 * while the shared runtime remains host-neutral under <PD_HOME>/.pd/runtime.
 */
export function getInstallLayoutPaths(
  homeDir: string,
  env: ResolvePdHomeOptions['env'] = process.env,
): InstallLayoutPaths {
  return getInstallLayoutPathsFromPdHome(requirePdHome({ homeDir, env }));
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
export function getWorkbuddyWorkspaceDir(
  homeDir: string,
  configDirOverride?: string,
  env: ResolvePdHomeOptions['env'] = process.env,
): string {
  const effectiveEnv = configDirOverride !== undefined
    ? { ...env, WORKBUDDY_CONFIG_DIR: configDirOverride }
    : env;
  return requirePdHome({ homeDir, env: effectiveEnv }).workbuddyWorkspaceDir;
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

/** Build WorkBuddy host config paths from an already-validated PD Home. */
export function getWorkbuddyHostConfigPathsFromPdHome(homePaths: PdHomePaths): WorkbuddyHostConfigPaths {
  const configDir = homePaths.workbuddyConfigDir;
  return {
    configDir,
    settingsPath: path.join(configDir, 'settings.json'),
    registryPath: path.join(configDir, 'plugins', 'installed_plugins.json'),
  };
}

/**
 * Resolve the WorkBuddy HOST config paths from one authority. The frozen
 * governance dir (~/.workbuddy/pd-workspace) defines the config root;
 * WORKBUDDY_CONFIG_DIR is the isolation override (Phase 0 lab discipline).
 * The WorkBuddyHostInstaller resolves its full path set by delegating here,
 * so installer / status / health can never disagree about where the host
 * files live.
 */
export function getWorkbuddyHostConfigPaths(
  homeDir: string,
  configDirOverride?: string,
  env: ResolvePdHomeOptions['env'] = process.env,
): WorkbuddyHostConfigPaths {
  const effectiveEnv = configDirOverride !== undefined
    ? { ...env, WORKBUDDY_CONFIG_DIR: configDirOverride }
    : env;
  return getWorkbuddyHostConfigPathsFromPdHome(requirePdHome({ homeDir, env: effectiveEnv }));
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
  const paths = options.homePaths !== undefined
    ? getInstallLayoutPathsFromPdHome(options.homePaths)
    : getInstallLayoutPaths(options.homeDir);
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
 * PD home resolution (PRI-872): production keeps the historical home
 * precedence (explicit `HOME` first, then `os.homedir()`);
 * `PD_EXPERIMENT_ROOT` opts into a fail-closed isolated root. This is the ONE
 * authority for "which PD home does this process own" — components must not
 * re-derive it locally.
 */
export {
  PD_EXPERIMENT_ROOT_ENV,
  PD_OPENCLAW_HOME_ENV,
  PD_OPENCLAW_STATE_DIR_ENV,
  PD_CODEX_HOME_ENV,
  PD_WORKBUDDY_CONFIG_DIR_ENV,
  PD_HOST_WORKSPACE_DIR_NAME,
  PD_HOME_MODES,
  PD_HOME_FAILURE_REASONS,
  resolvePdHome,
  resolveRealUserHome,
  isPathWithinRoot,
  type PdHomeMode,
  type PdHomePaths,
  type PdHomeFailure,
  type PdHomeFailureReason,
  type PdHomeSuccess,
  type PdHomeResolution,
  type ResolvePdHomeOptions,
} from './pd-home.js';
export {
  ACTIVE_RELEASE_SCHEMA_VERSION,
  activeReleaseRecordPath,
  parseActiveReleaseRecord,
  readActiveReleaseRecord,
  type ActiveReleaseFailureReason,
  type ActiveReleaseRecord,
  type ActiveReleaseVerdict,
} from './active-release.js';

/**
 * Codex host-persistent binding location. The versioned payload directory is
 * REPLACED by a host cache refresh, taking any binding written inside it with
 * it (PRI-1248). PLUGIN_DATA survives; this resolves the same
 * `principles-disciple-<marketplace>` data root the installer uses.
 */
export function resolveCodexPluginDataRoot(codexHome: string, marketplace: string): string | undefined {
  const dataRoot = path.join(codexHome, 'plugins', 'data');
  try {
    // The installer treats a single existing data directory as authoritative;
    // the launcher/health reader must resolve the SAME directory.
    const matches = fs.readdirSync(dataRoot).filter((name) => name.startsWith('principles-disciple-'));
    if (matches.length === 1) return path.join(dataRoot, matches[0] as string);
  } catch {
    // The data root is created by the first setup; fall through to the
    // canonical name derived from the payload's marketplace.
  }
  return /^[A-Za-z0-9._-]+$/.test(marketplace)
    ? path.join(dataRoot, `principles-disciple-${marketplace}`)
    : undefined;
}

/** Marketplace segment of `<codexHome>/plugins/cache/<marketplace>/principles-disciple/<version>`. */
export function getCodexMarketplaceFromPayload(pluginRoot: string): string {
  return path.basename(path.dirname(path.dirname(pluginRoot)));
}

export interface CodexMcpBindingLocations {
  readonly persistent: string | null;
  readonly legacy: string;
}

export function getCodexMcpBindingLocations(codexHome: string, pluginRoot: string): CodexMcpBindingLocations {
  const pluginData = resolveCodexPluginDataRoot(codexHome, getCodexMarketplaceFromPayload(pluginRoot));
  return {
    persistent: pluginData === undefined ? null : path.join(pluginData, 'mcp-binding.json'),
    legacy: path.join(pluginRoot, 'mcp-binding.json'),
  };
}

function isBindingFile(file: string): boolean {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

/**
 * Pick the binding authority exactly as launcher.cjs does: the host-persistent
 * copy when present, otherwise the legacy payload-local copy. `undefined` means
 * neither exists.
 */
export function selectCodexMcpBindingPath(
  codexHome: string,
  pluginRoot: string,
): { readonly path: string; readonly persistent: boolean } | undefined {
  const locations = getCodexMcpBindingLocations(codexHome, pluginRoot);
  if (locations.persistent !== null && isBindingFile(locations.persistent)) {
    return {path: locations.persistent, persistent: true};
  }
  if (isBindingFile(locations.legacy)) return {path: locations.legacy, persistent: false};
  return undefined;
}

/**
 * MCP binding contract (schema `pd.mcp-binding.v1`). This is the single
 * declaration of a valid binding; the launcher's payload copies are verified
 * against it by the parity test, and the installer / `pd health` import it
 * directly so neither can drift into a more permissive check.
 */
export {
  MCP_BINDING_SCHEMA_VERSION,
  MCP_BINDING_HOSTS,
  MCP_BINDING_SERVER_ENTRY_SEGMENTS,
  MCP_BINDING_SHAPE_CODES,
  MCP_BINDING_LAUNCHER_ONLY_REASONS,
  MCP_BINDING_FIXTURES,
  getCanonicalMcpServerEntry,
  getHostDefaultWorkspaceDirs,
  findForeignWorkspaceHost,
  collectHostWorkspaceClaims,
  findForeignWorkspaceOwner,
  isSameMcpBindingPath,
  validateMcpBinding,
  buildMcpBindingFixture,
  isMcpBindingHost,
  isSupportedBindingSchemaVersion,
  isSemverVersion,
  type McpBindingHost,
  type McpHostWorkspaceOptions,
  type McpBindingRecord,
  type McpBindingVerdict,
  type McpBindingShapeCode,
  type McpBindingFixture,
  type McpBindingFixtureId,
  type McpBindingFixtureContext,
  type HostWorkspaceClaim,
  type HostWorkspaceClaimVia,
  type HostClaimReaders,
  type HostClaimOptions,
  type JsonFileReadStatus,
  type BindingReadDiagnostic,
  type DirReadStatus,
  type ForeignWorkspaceOwnerVerdict,
} from './mcp-binding-contract.js';

/**
 * Workspace background-execution ownership transitions (SPEC §8.4 CAS write
 * path, PRI-1282 Phase 4): cross-process lock + generation-fenced state
 * machine + the single read-side ownership projection shared by the OpenClaw
 * Gateway gate, the `pd openclaw worker` gate and the handover/rollback
 * commands. Phase 5 reuses the same primitive for Codex / WorkBuddy.
 */
export {
  DEFAULT_CAS_LOCK_STALE_MS,
  BACKGROUND_EXECUTION_TRANSITIONS,
  acquireBackgroundExecutionCasLock,
  defaultCasFsOps,
  readWorkspaceBackgroundOwnership,
  transitionWorkspaceBackgroundExecution,
  withInstallManifestWriteLock,
  type BackgroundExecutionTransitionKind,
  type TransitionBackgroundExecutionFailure,
  type TransitionBackgroundExecutionSuccess,
  type CasFsOps,
  type CasLockAcquireOptions,
  type CasLockAcquireResult,
  type CasLockHandle,
  type CasLockOwner,
  type ReadOwnershipOptions,
  type TransitionBackgroundExecutionInput,
  type WithManifestWriteLockOptions,
  type WithManifestWriteLockResult,
  type WorkspaceBackgroundOwnership,
} from './background-execution-transition.js';
