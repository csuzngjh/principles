/**
 * WorkBuddyHostInstaller — implements HostInstaller for WorkBuddy Desktop
 * (ADR-0020 third host, SPEC workbuddy-host-adapter v0.3.0 §4.1/§6).
 *
 * Registration model (frozen Phase 0 probe P01, 2026-10-12 — see
 * packages/workbuddy-adapter/tests/fixtures/host-contract/manifest-facts.json):
 * - PD owns a local marketplace directory (~/.pd/workbuddy-marketplace/) with
 *   .codebuddy-plugin/marketplace.json + the plugin skeleton copied from the
 *   bundled @principles/workbuddy-adapter payload (source must stay inside the
 *   marketplace root — the engine rejects escapes).
 * - Registration runs through the REAL engine commands when reachable:
 *     node <engine> plugin marketplace add <dir>
 *     node <engine> plugin install principles-disciple@principles-disciple-market
 * - When the engine binary is unreachable, a direct-write path may register in
 *   the frozen formats instead (enabledPlugins["name@marketplace"]:true in
 *   settings.json + installed_plugins.json v2 + versioned cache copy). The
 *   result always reports WHICH mode ran (rc-9 — never a silent degradation).
 *
 * Install ≠ enable (OD-03): install registers the plugin but NEVER flips the
 * host.workbuddy feature flag (quiet, default OFF). Explicit enable is a
 * separate, user-visible step (enableGovernance below).
 *
 * Governance workspace (OD-07, frozen by probe P06): install explicitly
 * creates ~/.workbuddy/pd-workspace via install-layout's
 * getWorkbuddyWorkspaceDir() and registers it in ~/.pd/install.json. The dir is
 * NEVER auto-reused from Codex/OpenClaw state and NEVER deleted on uninstall
 * (it owns the governance database).
 *
 * Uninstall deletes ONLY provably-PD-owned files: our marketplace dir and our
 * versioned cache dirs. It preserves the governance database, other plugins,
 * other hosts' runtimes and the shared worker.
 *
 * Runtime Contract Rules:
 * - rc-1-treat-as-unknown: settings.json / installed_plugins.json / config.yaml
 *   are parsed as unknown and validated with guards.
 * - rc-2-no-as-bypass: membership checks use Object.hasOwn + typeof guards.
 * - rc-3-fail-loud-missing: a malformed settings.json/registry STOPS all
 *   writes (zero modification) with reason + nextAction.
 * - rc-5-object-hasown-not-in: untrusted key membership via Object.hasOwn.
 * - rc-8-safe-serialization: only strings/numbers recorded in results.
 * - rc-9-no-silent-fallback: engine-unreachable fallback is reported in the
 *   result reason; every result carries reason + nextAction.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, cpSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import * as yaml from 'js-yaml';
import {
  getInstallLayoutPaths,
  getWorkbuddyWorkspaceDir,
  mergeInstallManifestWorkspaces,
  parseInstallManifest,
  INSTALL_LAYOUT_VERSION,
  type InstallHost,
} from '@principles/install-layout';
import { atomicReplaceTextFile } from '../utils/config-file-io.js';
import { getHomeDir, generateConfigYamlContent } from '../mvp-config.js';
import type {
  HostInstaller,
  HostInstallContext,
  HostInstallResult,
  HostUninstallContext,
  HostUninstallResult,
  HostDetectResult,
} from '@principles/core/host';

// Type-only import from @principles/core — erased at compile time; this
// package ships self-contained without @principles/core (PRI-625/PRI-669).

// ─── Frozen host contract constants ─────────────────────────────────────────
/** Plugin name inside the PD-owned marketplace (kebab-case per plugin.json contract). */
export const WORKBUDDY_PLUGIN_NAME = 'principles-disciple';
/** PD-owned local marketplace name. enabledPlugins keys use "plugin@marketplace". */
export const WORKBUDDY_MARKETPLACE_NAME = 'principles-disciple-market';
/** Registry/settings key: "principles-disciple@principles-disciple-market". */
export const WORKBUDDY_PLUGIN_KEY = `${WORKBUDDY_PLUGIN_NAME}@${WORKBUDDY_MARKETPLACE_NAME}`;

/** Engine CLI shipped with WorkBuddy Desktop (probe P01 frozen path). */
const WORKBUDDY_ENGINE_RELATIVE = ['resources', 'app.asar.unpacked', 'cli', 'dist', 'codebuddy-lite-wb.mjs'];

/** Engine command success markers (frozen by probe P01 regexes). */
const MARKETPLACE_ADD_OK = /added successfully|already/i;
const PLUGIN_INSTALL_OK = /Successfully installed/i;
const PLUGIN_UNINSTALL_OK = /Successfully uninstalled/i;

const ENGINE_COMMAND_TIMEOUT_MS = 120_000;

// ─── Type guards (rc-2: no `as` bypass) ─────────────────────────────────────
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export interface WorkbuddyCommandResult {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: string;
}

export interface WorkbuddyHostInstallerDeps {
  /** Home directory resolver (tests inject a temp dir; default: getHomeDir()). */
  homeDir?: () => string;
  /** Engine path resolver (default: env override + Program Files probe). */
  enginePath?: () => string | undefined;
  /** Command runner (default: spawnSync). Tests inject a fake engine boundary. */
  runCommand?: (file: string, args: readonly string[], opts?: { timeoutMs?: number }) => WorkbuddyCommandResult;
}

/** All WorkBuddy paths PD may touch, derived from install-layout (never hand-joined ad hoc). */
export interface WorkbuddyPaths {
  homeDir: string;
  /** Host config dir (engine honors WORKBUDDY_CONFIG_DIR when set). */
  configDir: string;
  settingsPath: string;
  registryPath: string;
  /** <config>/plugins/cache/<marketplace>/<plugin> — our versioned cache subtree root. */
  cachePluginRoot: string;
  /** PD-owned marketplace root: ~/.pd/workbuddy-marketplace. */
  marketplaceRoot: string;
  /** ~/.workbuddy/pd-workspace (OD-07 governance workspace). */
  governanceDir: string;
  /** ~/.pd/runtime/workbuddy-adapter (frozen install-layout path). */
  runtimeAdapterDir: string;
  /** ~/.pd/install.json. */
  installManifestPath: string;
}

export function resolveWorkbuddyPaths(homeDir: string): WorkbuddyPaths {
  const layout = getInstallLayoutPaths(homeDir);
  // The frozen governance dir (~/.workbuddy/pd-workspace) defines the host
  // config root; deriving configDir from it keeps one path authority.
  //
  // HOST BOUNDARY (review P3, probe P0 fact): this installer targets the
  // WorkBuddy DESKTOP host, whose registration root is ~/.workbuddy (real
  // desktop plugins observed there). The standalone CLI engine's user-scope
  // root is ~/.codebuddy (CODEBUDDY_CONFIG_DIR); a CLI-only user's engine
  // will not read a registration written here. WORKBUDDY_CONFIG_DIR remains
  // the isolation override (Phase 0 lab discipline).
  const configDir = process.env.WORKBUDDY_CONFIG_DIR && process.env.WORKBUDDY_CONFIG_DIR.length > 0
    ? path.resolve(process.env.WORKBUDDY_CONFIG_DIR)
    : path.dirname(getWorkbuddyWorkspaceDir(homeDir));
  return {
    homeDir: layout.homeDir,
    configDir,
    settingsPath: path.join(configDir, 'settings.json'),
    registryPath: path.join(configDir, 'plugins', 'installed_plugins.json'),
    cachePluginRoot: path.join(configDir, 'plugins', 'cache', WORKBUDDY_MARKETPLACE_NAME, WORKBUDDY_PLUGIN_NAME),
    marketplaceRoot: path.join(layout.pdDir, 'workbuddy-marketplace'),
    governanceDir: getWorkbuddyWorkspaceDir(homeDir),
    runtimeAdapterDir: layout.workbuddyAdapterDir,
    installManifestPath: layout.manifest,
  };
}

/**
 * Resolve the WorkBuddy engine CLI path.
 *
 * Order: PD_WORKBUDDY_ENGINE / WB_ENGINE env override (probe convention) →
 * the Desktop install location under Program Files (frozen by probe P01).
 * The engine is NOT exposed on PATH — absence is a detectable, reportable
 * fact, never a guess.
 */
export function resolveWorkbuddyEnginePath(): string | undefined {
  for (const envName of ['PD_WORKBUDDY_ENGINE', 'WB_ENGINE']) {
    const value = process.env[envName];
    if (value && value.length > 0 && existsSync(value)) return value;
  }
  const roots = [
    process.env.ProgramFiles,
    process.env['ProgramFiles(x86)'],
    process.env.SystemDrive ? path.join(process.env.SystemDrive, 'Program Files') : undefined,
  ].filter((v): v is string => typeof v === 'string' && v.length > 0);
  for (const root of roots) {
    const candidate = path.join(root, 'WorkBuddy', ...WORKBUDDY_ENGINE_RELATIVE);
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

// ─── settings.json / registry read helpers (fail-loud discipline) ───────────

export type JsonFileRead =
  | { ok: true; value: Record<string, unknown>; existed: true }
  | { ok: true; value: undefined; existed: false }
  | { ok: false; reason: string; nextAction: string; path: string };

/** Read + validate a host JSON file. Malformed content is a HARD STOP (rc-3). */
export function readHostJsonFile(filePath: string): JsonFileRead {
  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf-8');
  } catch {
    return { ok: true, value: undefined, existed: false };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return {
      ok: false,
      path: filePath,
      reason: `workbuddy_settings_unparsable: ${filePath} exists but is not valid JSON (${error instanceof Error ? error.message : String(error)}). No PD write was performed.`,
      nextAction: `Fix or remove the malformed file manually, then re-run: npx create-principles-disciple --host workbuddy. PD never merges into a config it cannot parse.`,
    };
  }
  if (!isRecord(parsed)) {
    return {
      ok: false,
      path: filePath,
      reason: `workbuddy_settings_unparsable: ${filePath} parsed to ${Array.isArray(parsed) ? 'an array' : typeof parsed}, expected an object. No PD write was performed.`,
      nextAction: `Fix or remove the malformed file manually, then re-run: npx create-principles-disciple --host workbuddy.`,
    };
  }
  return { ok: true, value: parsed, existed: true };
}

/**
 * Atomic, backup-protected JSON write for host config files.
 *
 * Discipline (SPEC §6): parse-failure callers never reach this function; the
 * write itself backs up the previous bytes, replaces atomically (temp file +
 * rename), and restores the backup when the replacement fails.
 */
export function writeHostJsonFileProtected(filePath: string, content: string): { ok: true } | { ok: false; reason: string; nextAction: string } {
  let backupPath: string | undefined;
  if (existsSync(filePath)) {
    backupPath = `${filePath}.pd-backup-${Date.now()}`;
    try {
      cpSync(filePath, backupPath);
    } catch (error) {
      return {
        ok: false,
        reason: `workbuddy_settings_backup_failed: could not back up ${filePath} (${error instanceof Error ? error.message : String(error)}). No write was performed.`,
        nextAction: `Free the file (close WorkBuddy) and re-run, or back it up manually and re-run.`,
      };
    }
  }
  try {
    // The registry/settings may live in directories the host has not created
    // yet (direct-write on a fresh config dir) — creating the PARENT is part
    // of creating a new host file, not a mutation of existing host state.
    mkdirSync(path.dirname(filePath), { recursive: true });
    atomicReplaceTextFile(filePath, content);
    if (backupPath !== undefined) {
      try { rmSync(backupPath, { force: true }); } catch { /* best effort — the write already succeeded */ }
    }
    return { ok: true };
  } catch (error) {
    // Restore the backup before reporting — the file must not stay half-written.
    let restoreError: string | undefined;
    if (backupPath !== undefined) {
      try {
        cpSync(backupPath, filePath);
        rmSync(backupPath, { force: true });
      } catch (restoreErr) {
        restoreError = restoreErr instanceof Error ? restoreErr.message : String(restoreErr);
      }
    }
    return {
      ok: false,
      reason: `workbuddy_settings_write_failed: atomic replace of ${filePath} failed (${error instanceof Error ? error.message : String(error)})${restoreError !== undefined ? `; backup restore also failed (${restoreError}) — the previous content is preserved at ${backupPath}` : '; previous content restored from backup'}.`,
      nextAction: restoreError !== undefined && backupPath !== undefined
        ? `Manually restore ${backupPath} to ${filePath}, then re-run the installer.`
        : `Re-run the installer after closing WorkBuddy (the file may be locked).`,
    };
  }
}

// ─── Plugin payload (adapter package contract) ──────────────────────────────

/**
 * Locate the WorkBuddy plugin skeleton shipped by @principles/workbuddy-adapter.
 *
 * Contract with the adapter package (SPEC §4.1 — the adapter owns decoder,
 * encoder, entries AND the plugin skeleton): the bundled payload contains
 * `plugin/` with `.codebuddy-plugin/plugin.json` (name === principles-disciple)
 * and `hooks/hooks.json` at the plugin ROOT (frozen manifest-facts layout).
 * Lookup order: the installer payload being deployed (ctx.pluginDir), then the
 * installed runtime copy (~/.pd/runtime/workbuddy-adapter) for re-runs.
 */
export interface WorkbuddyPluginPayload {
  pluginDir: string;
  version: string;
}

export function findWorkbuddyPluginPayload(pluginDir: string, runtimeAdapterDir: string): { payload?: WorkbuddyPluginPayload; reason?: string } {
  for (const root of [path.join(pluginDir, 'workbuddy-adapter', 'plugin'), path.join(runtimeAdapterDir, 'plugin')]) {
    const manifestPath = path.join(root, '.codebuddy-plugin', 'plugin.json');
    const hooksPath = path.join(root, 'hooks', 'hooks.json');
    if (!existsSync(manifestPath) || !existsSync(hooksPath)) continue;
    let manifest: unknown;
    try {
      manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
    } catch {
      return { reason: `workbuddy_plugin_manifest_unparsable: ${manifestPath} is not valid JSON. Refusing to register a plugin whose identity cannot be verified.` };
    }
    if (!isRecord(manifest) || manifest.name !== WORKBUDDY_PLUGIN_NAME) {
      return { reason: `workbuddy_plugin_manifest_invalid: ${manifestPath} must declare name "${WORKBUDDY_PLUGIN_NAME}" (got ${isRecord(manifest) ? JSON.stringify(manifest.name) : 'unparsable manifest'}).` };
    }
    let hooks: unknown;
    try {
      hooks = JSON.parse(readFileSync(hooksPath, 'utf-8'));
    } catch {
      return { reason: `workbuddy_plugin_hooks_unparsable: ${hooksPath} is not valid JSON. Refusing to register a plugin whose hook wiring cannot be verified.` };
    }
    if (!isRecord(hooks) || !isRecord(hooks.hooks)) {
      return { reason: `workbuddy_plugin_hooks_invalid: ${hooksPath} must contain a "hooks" object (frozen manifest-facts shape).` };
    }
    const version = typeof manifest.version === 'string' && manifest.version.length > 0 ? manifest.version : '0.0.0';
    return { payload: { pluginDir: root, version } };
  }
  return {
    reason: `workbuddy_adapter_payload_missing: no WorkBuddy plugin skeleton found (looked for workbuddy-adapter/plugin/.codebuddy-plugin/plugin.json under the installer payload and ${runtimeAdapterDir}). The @principles/workbuddy-adapter component is not part of this installer build.`,
  };
}

// ─── Install manifest merge (hosts ∪ workbuddy, workspaces ∪ governance) ────

/** Read install.json preserving unknown keys (PRI-709 P0-1 merge semantics). */
function readInstallJsonRecord(manifestPath: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(manifestPath, 'utf-8'));
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Merge 'workbuddy' + the governance workspace into ~/.pd/install.json.
 *
 * Set-union semantics: existing hosts (codex/openclaw) and workspaces are
 * always preserved; unknown top-level keys (the update side owns
 * channel/autoCheck/releaseMetadataUrl — PRI-709 P0-1) are carried through.
 * Malformed existing manifest → hard stop, zero modification.
 */
export function mergeWorkbuddyIntoInstallManifest(
  manifestPath: string,
  governanceDir: string,
): { ok: true } | { ok: false; reason: string; nextAction: string } {
  let current: unknown;
  let existed = false;
  try {
    current = JSON.parse(readFileSync(manifestPath, 'utf-8'));
    existed = true;
  } catch (error) {
    if (existsSync(manifestPath)) {
      return {
        ok: false,
        reason: `install_manifest_unparsable: ${manifestPath} exists but is not valid JSON (${error instanceof Error ? error.message : String(error)}). No write was performed.`,
        nextAction: `Repair or remove ~/.pd/install.json manually, then re-run the installer.`,
      };
    }
  }
  const parsed = parseInstallManifest(current);
  if (existed && current !== undefined && !parsed.manifest) {
    return {
      ok: false,
      reason: `install_manifest_malformed: ${parsed.error ?? 'unknown'}. No write was performed.`,
      nextAction: `Repair ~/.pd/install.json (layoutVersion ${INSTALL_LAYOUT_VERSION}, mode canonical, hosts array) and re-run.`,
    };
  }
  const hosts: InstallHost[] = [...new Set([...(parsed.manifest?.hosts ?? []), 'workbuddy' as const])];
  const workspaces = mergeInstallManifestWorkspaces(parsed.manifest, governanceDir);
  let existingRecord: Record<string, unknown> = {};
  if (existed) {
    const raw = readInstallJsonRecord(manifestPath);
    if (raw !== undefined) existingRecord = raw;
  }
  const payload: Record<string, unknown> = {
    ...existingRecord,
    layoutVersion: INSTALL_LAYOUT_VERSION,
    mode: 'canonical',
    hosts,
    workspaces,
  };
  try {
    mkdirSync(path.dirname(manifestPath), { recursive: true });
    writeFileSync(manifestPath, JSON.stringify(payload, null, 2) + '\n', 'utf-8');
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      reason: `install_manifest_write_failed: ${manifestPath} could not be written (${error instanceof Error ? error.message : String(error)}).`,
      nextAction: `Check permissions on ~/.pd and re-run the installer.`,
    };
  }
}

/** Remove 'workbuddy' from manifest hosts (uninstall bookkeeping; workspaces/governance data preserved). */
function removeWorkbuddyFromInstallManifestHosts(manifestPath: string): void {
  try {
    const parsed: unknown = JSON.parse(readFileSync(manifestPath, 'utf-8'));
    if (!isRecord(parsed) || !Array.isArray(parsed.hosts)) return;
    const hosts = parsed.hosts.filter((h): h is InstallHost => typeof h === 'string' && h !== 'workbuddy');
    const payload: Record<string, unknown> = { ...parsed, hosts };
    writeFileSync(manifestPath, JSON.stringify(payload, null, 2) + '\n', 'utf-8');
  } catch {
    // Uninstall must not fail on manifest bookkeeping; the preserved-state
    // report below still names the governance dir. rc-9: surfaced via paths.
  }
}

// ─── Feature flag override (config.yaml line-targeted edit) ─────────────────

const FEATURES_LINE = /^features:\s*(?:#.*)?$/;
const FEATURES_EMPTY_MAPPING_LINE = /^features:\s*\{\}\s*(?:#.*)?$/;
const WORKBUDDY_KEY_LINE = /^ {2}host\.workbuddy:\s*(?:#.*)?$/;
const WORKBUDDY_ENABLED_LINE = /^ {4}enabled:\s*(?:true|false)\s*(?:#.*)?$/;

function stripYamlComment(line: string): string {
  const hash = line.indexOf('#');
  return (hash === -1 ? line : line.slice(0, hash)).trim();
}

function isEmptyFeaturesMapping(line: string): boolean {
  return stripYamlComment(line).replace(/\s+/g, '') === 'features:' + String.fromCharCode(123, 125);
}

export type FlagOverrideResult = { ok: true; configPath: string; enabled: boolean } | { ok: false; reason: string; nextAction: string };

/**
 * Enable/disable `features.host.workbuddy.enabled` in the GOVERNANCE
 * workspace's .pd/config.yaml with a line-targeted edit (comments and unknown
 * keys preserved), creating a loader-valid config from the installer template
 * when absent. Atomic write; round-trip verified.
 */
export function setWorkbuddyGovernanceFlag(governanceDir: string, enabled: boolean): FlagOverrideResult {
  const configDir = path.join(governanceDir, '.pd');
  const configPath = path.join(configDir, 'config.yaml');
  let raw: string;
  if (existsSync(configPath)) {
    try {
      raw = readFileSync(configPath, 'utf-8');
    } catch (error) {
      return { ok: false, reason: `config_read_failed: ${configPath} (${error instanceof Error ? error.message : String(error)})`, nextAction: 'Fix file permissions and retry.' };
    }
    // A config that cannot parse is a hard stop (rc-3) — never edited blind.
    try {
      yaml.load(raw);
    } catch (error) {
      return {
        ok: false,
        reason: `config_unparsable: ${configPath} is not valid YAML (${error instanceof Error ? error.message : String(error)}). No write was performed.`,
        nextAction: 'Fix or delete the malformed config.yaml, then retry the enable.',
      };
    }
  } else {
    raw = generateConfigYamlContent();
  }

  const lines = raw.split('\n');
  let keyIndex = -1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (typeof line === 'string' && WORKBUDDY_KEY_LINE.test(line)) { keyIndex = i; break; }
  }
  if (keyIndex >= 0) {
    // Replace/insert the enabled line directly under the key.
    const enabledLine = lines[keyIndex + 1];
    if (typeof enabledLine === 'string' && WORKBUDDY_ENABLED_LINE.test(enabledLine)) {
      lines[keyIndex + 1] = `    enabled: ${enabled}`;
    } else {
      lines.splice(keyIndex + 1, 0, `    enabled: ${enabled}`);
    }
  } else {
    // Match BOTH an existing mapping header (`features:`) and the empty flow
    // mapping the installer template writes (`features: {}`) — appending a
    // SECOND features block instead would create a duplicate YAML key.
    const featuresIndex = lines.findIndex((line) => FEATURES_LINE.test(line) || FEATURES_EMPTY_MAPPING_LINE.test(line));
    if (featuresIndex >= 0) {
      const featuresLine = lines[featuresIndex];
      if (typeof featuresLine === 'string' && isEmptyFeaturesMapping(featuresLine)) {
        lines[featuresIndex] = 'features:';
      }
      lines.splice(featuresIndex + 1, 0, `  host.workbuddy:`, `    enabled: ${enabled}`);
    } else {
      // No features: mapping at all — append a block at the end.
      lines.push('features:', `  host.workbuddy:`, `    enabled: ${enabled}`);
    }
  }

  const next = lines.join('\n');
  // Round-trip verification: the rewritten config must parse with the flag at
  // the intended value before it is committed (same discipline as codex-setup).
  let verify: unknown;
  try {
    verify = yaml.load(next);
  } catch (error) {
    return { ok: false, reason: `config_rewrite_invalid: verification parse failed (${error instanceof Error ? error.message : String(error)}). Nothing was written.`, nextAction: 'Report this failure — the flag edit produced invalid YAML.' };
  }
  const flagOk = isRecord(verify)
    && isRecord(verify.features)
    && isRecord(verify.features['host.workbuddy'])
    && verify.features['host.workbuddy'].enabled === enabled;
  if (!flagOk) {
    return { ok: false, reason: 'config_rewrite_mismatch: round-trip verification did not observe the intended flag value. Nothing was written.', nextAction: 'Report this failure with the config.yaml content.' };
  }

  try {
    mkdirSync(configDir, { recursive: true });
    atomicReplaceTextFile(configPath, next);
  } catch (error) {
    return { ok: false, reason: `config_write_failed: ${configPath} (${error instanceof Error ? error.message : String(error)})`, nextAction: 'Fix permissions/free the file and retry.' };
  }
  return { ok: true, configPath, enabled };
}

/** Read the explicit host.workbuddy override state (null = no explicit override → registry default OFF). */
export function readWorkbuddyGovernanceFlagOverride(governanceDir: string): boolean | null {
  const configPath = path.join(governanceDir, '.pd', 'config.yaml');
  if (!existsSync(configPath)) return null;
  try {
    const parsed: unknown = yaml.load(readFileSync(configPath, 'utf-8'));
    if (!isRecord(parsed) || !isRecord(parsed.features)) return null;
    const entry = parsed.features['host.workbuddy'];
    if (!isRecord(entry) || typeof entry.enabled !== 'boolean') return null;
    return entry.enabled;
  } catch {
    return null;
  }
}

// ─── Detect details ─────────────────────────────────────────────────────────

export interface WorkbuddyDetectDetails extends HostDetectResult {
  /** WorkBuddy host discovered (config dir exists). */
  hostFound: boolean;
  /** Engine CLI binary located. */
  engineFound: boolean;
  /** Resolved engine path when found. */
  enginePath?: string;
  /** installed_plugins.json v2 carries our registration. */
  registered: boolean;
  /** settings.json enabledPlugins[key] === true. */
  pluginEnabled: boolean;
  /** Explicit host.workbuddy override in the governance config (null = default OFF). */
  flagOverride: boolean | null;
  /** ~/.pd/runtime/workbuddy-adapter present (package.json + dist). */
  runtimeReachable: boolean;
  /** Governance workspace dir created (OD-07 initialized). */
  governanceInitialized: boolean;
  /** settings.json exists AND parsed (false also when unparsable — install fails loud there). */
  settingsExisted: boolean;
}

// ─── WorkBuddyHostInstaller ─────────────────────────────────────────────────

/** Materialize the PD-owned marketplace dir (source never escapes its root). */
function materializeMarketplace(marketplaceRoot: string, pluginDir: string): void {
  rmSync(marketplaceRoot, { recursive: true, force: true });
  const marketplaceManifestDir = path.join(marketplaceRoot, '.codebuddy-plugin');
  mkdirSync(marketplaceManifestDir, { recursive: true });
  const marketplaceManifest = {
    name: WORKBUDDY_MARKETPLACE_NAME,
    plugins: [{ name: WORKBUDDY_PLUGIN_NAME, source: `./${WORKBUDDY_PLUGIN_NAME}` }],
  };
  writeFileSync(path.join(marketplaceManifestDir, 'marketplace.json'), JSON.stringify(marketplaceManifest, null, 2) + '\n', 'utf-8');
  // Plugin skeleton copied INSIDE the marketplace root — the engine rejects
  // sources that escape it ("Path escapes marketplace root", frozen facts).
  cpSync(pluginDir, path.join(marketplaceRoot, WORKBUDDY_PLUGIN_NAME), { recursive: true });
}

export class WorkBuddyHostInstaller implements HostInstaller {
  readonly hostId = 'workbuddy';

  private readonly deps: Required<WorkbuddyHostInstallerDeps>;

  constructor(deps: WorkbuddyHostInstallerDeps = {}) {
    this.deps = {
      homeDir: deps.homeDir ?? getHomeDir,
      enginePath: deps.enginePath ?? resolveWorkbuddyEnginePath,
      runCommand: deps.runCommand ?? ((file, args, opts) => {
        const result = spawnSync(file, [...args], {
          encoding: 'utf-8',
          timeout: opts?.timeoutMs ?? ENGINE_COMMAND_TIMEOUT_MS,
          windowsHide: true,
        });
        return {
          status: result.status,
          stdout: typeof result.stdout === 'string' ? result.stdout : '',
          stderr: typeof result.stderr === 'string' ? result.stderr : '',
          error: result.error instanceof Error ? result.error.message : result.error !== undefined ? String(result.error) : undefined,
        };
      }),
    };
  }

  private paths(): WorkbuddyPaths {
    return resolveWorkbuddyPaths(this.deps.homeDir());
  }

  /** Run `node <engine> <args>`; returns undefined when the invocation itself failed. */
  private runEngine(args: readonly string[]): WorkbuddyCommandResult & { engine: string } | undefined {
    const engine = this.deps.enginePath();
    if (engine === undefined) return undefined;
    const result = this.deps.runCommand(process.execPath, [engine, ...args]);
    return { ...result, engine };
  }

  // ── Preconditions ──────────────────────────────────────────────────────────

  /** Hooks run via `node` on PATH through Git Bash (frozen hook-runtime-contract shellAndRuntime). */
  private preflightRuntime(): { ok: true } | { ok: false; reason: string; nextAction: string } {
    const nodeCheck = this.deps.runCommand('node', ['--version'], { timeoutMs: 15_000 });
    if (nodeCheck.status !== 0) {
      return {
        ok: false,
        reason: `node_not_available: WorkBuddy command hooks start with "node" resolved from PATH, but invoking it failed (${nodeCheck.error ?? `exit ${nodeCheck.status}`}). PD cannot install a hook chain that would never start.`,
        nextAction: 'Install Node.js (>= 20) and make "node" resolvable on PATH, then re-run the installer.',
      };
    }
    if (process.platform === 'win32') {
      const bashCheck = this.deps.runCommand('bash', ['-c', 'exit 0'], { timeoutMs: 15_000 });
      if (bashCheck.status !== 0) {
        return {
          ok: false,
          reason: `git_bash_not_available: WorkBuddy executes command hooks through Git Bash on Windows, but "bash" is not resolvable (${bashCheck.error ?? `exit ${bashCheck.status}`}). Hooks would fail to launch.`,
          nextAction: 'Install Git for Windows (or otherwise provide bash.exe on PATH), then re-run the installer.',
        };
      }
    }
    return { ok: true };
  }

  // ─── install ──────────────────────────────────────────────────────────────

  async install(ctx: HostInstallContext): Promise<HostInstallResult> {
    const p = this.paths();
    const details = this.detectDetails();

    // 1. Preflight: host presence + hook runtime prerequisites.
    if (!details.hostFound && !details.engineFound) {
      return {
        success: false,
        hostId: this.hostId,
        configPath: p.settingsPath,
        configAction: 'skipped',
        reason: 'workbuddy_host_not_found: neither a WorkBuddy config directory nor the WorkBuddy engine was found on this machine.',
        nextAction: 'Install WorkBuddy Desktop (the engine ships inside it), start it once, then re-run: npx create-principles-disciple --host workbuddy.',
      };
    }
    const runtime = this.preflightRuntime();
    if (!runtime.ok) {
      return { success: false, hostId: this.hostId, configPath: p.settingsPath, configAction: 'skipped', reason: runtime.reason, nextAction: runtime.nextAction };
    }

    // 2. Preflight the host JSON files BEFORE any write: a malformed
    //    settings.json / installed_plugins.json must stop the install with
    //    ZERO side effects (rc-3) — not fail halfway after the marketplace
    //    dir was already materialized.
    const settingsPre = readHostJsonFile(p.settingsPath);
    if (!settingsPre.ok) {
      return { success: false, hostId: this.hostId, configPath: p.settingsPath, configAction: 'skipped', reason: settingsPre.reason, nextAction: settingsPre.nextAction };
    }
    const registryPre = readHostJsonFile(p.registryPath);
    if (!registryPre.ok) {
      return { success: false, hostId: this.hostId, configPath: p.settingsPath, configAction: 'skipped', reason: registryPre.reason, nextAction: registryPre.nextAction };
    }

    // 3. Locate the bundled plugin skeleton (adapter payload).
    const payloadFind = findWorkbuddyPluginPayload(ctx.pluginDir, p.runtimeAdapterDir);
    if (!payloadFind.payload) {
      return {
        success: false,
        hostId: this.hostId,
        configPath: p.settingsPath,
        configAction: 'skipped',
        reason: payloadFind.reason ?? 'workbuddy_adapter_payload_missing',
        nextAction: 'Update the installer (npx create-principles-disciple@latest) — this build does not carry the @principles/workbuddy-adapter component.',
      };
    }
    const {payload} = payloadFind;

    // 4. Materialize the PD-owned marketplace (source stays inside its root).
    try {
      materializeMarketplace(p.marketplaceRoot, payload.pluginDir);
    } catch (error) {
      return {
        success: false,
        hostId: this.hostId,
        configPath: p.settingsPath,
        configAction: 'skipped',
        reason: `workbuddy_marketplace_write_failed: ${error instanceof Error ? error.message : String(error)}`,
        nextAction: `Check permissions under ${path.dirname(p.marketplaceRoot)} and re-run the installer.`,
      };
    }

    // 5. Register: engine commands first; observable direct-write fallback.
    const registration = this.registerPlugin(details, payload.version);
    if (!registration.ok) {
      return {
        success: false,
        hostId: this.hostId,
        configPath: p.settingsPath,
        configAction: 'skipped',
        reason: registration.reason,
        nextAction: registration.nextAction,
      };
    }

    // 6. Initialize the governance workspace (OD-07 explicit creation).
    try {
      mkdirSync(p.governanceDir, { recursive: true });
    } catch (error) {
      return {
        success: false,
        hostId: this.hostId,
        configPath: p.settingsPath,
        configAction: registration.settingsAction,
        reason: `workbuddy_governance_dir_failed: could not create ${p.governanceDir} (${error instanceof Error ? error.message : String(error)}). The plugin is registered but governance state has no home.`,
        nextAction: `Create ${p.governanceDir} manually (or free the parent directory) and re-run the installer.`,
      };
    }

    // 7. Record host + governance workspace in the install manifest (set union).
    const manifest = mergeWorkbuddyIntoInstallManifest(p.installManifestPath, p.governanceDir);
    if (!manifest.ok) {
      return {
        success: false,
        hostId: this.hostId,
        configPath: p.settingsPath,
        configAction: registration.settingsAction,
        reason: manifest.reason,
        nextAction: manifest.nextAction,
      };
    }

    // 8. Install ≠ enable (OD-03): the host.workbuddy flag stays at its quiet
    // default (OFF). No config.yaml override is written here.
    const effectiveNote = 'Registration takes effect in NEW WorkBuddy sessions (or /reload-plugins in a running CLI session).';
    return {
      success: true,
      hostId: this.hostId,
      configPath: p.settingsPath,
      configAction: registration.settingsAction,
      reason: `Registered ${WORKBUDDY_PLUGIN_KEY} via ${registration.mode}${registration.mode === 'engine' ? '' : ` (engine unreachable: ${registration.engineNote})`}. Governance workspace: ${p.governanceDir}. PD governance stays DISABLED until you explicitly enable it.`,
      nextAction: `${effectiveNote} To enable PD governance, set host.workbuddy: { enabled: true } in ${path.join(p.governanceDir, '.pd', 'config.yaml')} (the console flag surface or the installer enable API shows the target config first).`,
    };
  }

  private registerPlugin(
    details: WorkbuddyDetectDetails,
    version: string,
  ): { ok: true; mode: 'engine' | 'direct-write' | 'already-registered'; settingsAction: 'created' | 'updated' | 'preserved'; engineNote?: string } | { ok: false; reason: string; nextAction: string } {
    const p = this.paths();

    // Idempotent fast path: already registered AND enabled AND cached.
    if (details.registered && details.pluginEnabled && existsSync(p.cachePluginRoot)) {
      return { ok: true, mode: 'already-registered', settingsAction: 'preserved' };
    }

    // Engine path (preferred — real marketplace/cache/settings chain).
    if (details.engineFound) {
      const add = this.runEngine(['plugin', 'marketplace', 'add', p.marketplaceRoot]);
      if (add !== undefined && add.status === 0 && MARKETPLACE_ADD_OK.test(add.stdout + add.stderr)) {
        if (details.registered) {
          // Already installed: engine marketplace re-add is enough; installing
          // again is not idempotent-tested, so preserve the existing entry.
          return { ok: true, mode: 'engine', settingsAction: 'preserved' };
        }
        const install = this.runEngine(['plugin', 'install', WORKBUDDY_PLUGIN_KEY]);
        if (install !== undefined && install.status === 0 && PLUGIN_INSTALL_OK.test(install.stdout + install.stderr)) {
          const after = this.detectDetails();
          if (after.registered && after.pluginEnabled) {
            return { ok: true, mode: 'engine', settingsAction: after.settingsExisted ? 'updated' : 'created' };
          }
          return {
            ok: false,
            reason: `workbuddy_engine_install_unverified: engine reported success but the frozen-format state (enabledPlugins + installed_plugins.json) does not carry ${WORKBUDDY_PLUGIN_KEY} afterwards.`,
            nextAction: `Run "node <engine> plugin list" to inspect the host state, then re-run the installer.`,
          };
        }
        return {
          ok: false,
          reason: `workbuddy_engine_install_failed: ${install !== undefined ? (install.stderr || install.stdout).trim().slice(0, 300) || `exit ${install.status}` : 'engine invocation failed'}.`,
          nextAction: `Resolve the engine error above (run "node <engine> plugin install ${WORKBUDDY_PLUGIN_KEY}" manually to see full output), then re-run the installer.`,
        };
      }
      // Engine present but the command failed → direct-write fallback with an
      // observable note (rc-9). Fall through.
      const note = add !== undefined
        ? `engine marketplace add failed: ${((add.stderr || add.stdout).trim().slice(0, 200) || `exit ${add.status}`)}`
        : 'engine invocation failed';
      const direct = this.directWriteRegistration(details, version, note);
      if (direct.ok) return direct;
      return { ok: false, reason: direct.reason, nextAction: direct.nextAction };
    }

    // Engine unreachable: direct-write path, strictly aligned with the frozen
    // formats, and always reported as a distinct mode.
    const direct = this.directWriteRegistration(details, version, 'engine binary not found');
    if (direct.ok) return direct;
    return { ok: false, reason: direct.reason, nextAction: direct.nextAction };
  }

  /**
   * Direct-write registration for engine-unreachable machines, aligned with the
   * frozen P01 formats: enabledPlugins[key]=true in settings.json (other keys
   * and other plugins preserved), installed_plugins.json v2 entry
   * {scope:'user', installPath, version, installedAt}, and the versioned cache
   * copy under plugins/cache/<marketplace>/<plugin>/<version>/.
   */
  private directWriteRegistration(
    details: WorkbuddyDetectDetails,
    version: string,
    engineNote: string,
  ): { ok: true; mode: 'direct-write'; settingsAction: 'created' | 'updated' | 'preserved'; engineNote: string } | { ok: false; reason: string; nextAction: string } {
    const p = this.paths();
    const settings = readHostJsonFile(p.settingsPath);
    if (!settings.ok) return { ok: false, reason: settings.reason, nextAction: settings.nextAction };
    const registry = readHostJsonFile(p.registryPath);
    if (!registry.ok) return { ok: false, reason: registry.reason, nextAction: registry.nextAction };

    // settings.json merge
    const nextSettings: Record<string, unknown> = { ...(settings.value ?? {}) };
    const enabledPlugins = isRecord(nextSettings.enabledPlugins) ? { ...nextSettings.enabledPlugins } : {};
    enabledPlugins[WORKBUDDY_PLUGIN_KEY] = true;
    nextSettings.enabledPlugins = enabledPlugins;
    const settingsWrite = writeHostJsonFileProtected(p.settingsPath, JSON.stringify(nextSettings, null, 2) + '\n');
    if (!settingsWrite.ok) return { ok: false, reason: settingsWrite.reason, nextAction: settingsWrite.nextAction };
    const settingsAction = settings.existed ? 'updated' : 'created';

    // installed_plugins.json v2 merge (create with version 2 when absent)
    const nextRegistry: Record<string, unknown> = { ...(registry.value ?? {}) };
    if (typeof nextRegistry.version !== 'number') nextRegistry.version = 2;
    const plugins = isRecord(nextRegistry.plugins) ? { ...nextRegistry.plugins } : {};
    const cacheVersionDir = path.join(p.cachePluginRoot, version);
    plugins[WORKBUDDY_PLUGIN_KEY] = {
      scope: 'user',
      installPath: cacheVersionDir,
      version,
      installedAt: new Date().toISOString(),
    };
    nextRegistry.plugins = plugins;
    const registryWrite = writeHostJsonFileProtected(p.registryPath, JSON.stringify(nextRegistry, null, 2) + '\n');
    if (!registryWrite.ok) return { ok: false, reason: registryWrite.reason, nextAction: registryWrite.nextAction };

    // Versioned cache copy from our marketplace source.
    try {
      rmSync(p.cachePluginRoot, { recursive: true, force: true });
      cpSync(path.join(p.marketplaceRoot, WORKBUDDY_PLUGIN_NAME), cacheVersionDir, { recursive: true });
    } catch (error) {
      return {
        ok: false,
        reason: `workbuddy_cache_write_failed: ${error instanceof Error ? error.message : String(error)}. Settings and registry were updated; the cache copy is incomplete.`,
        nextAction: `Re-run the installer (idempotent), or run the engine command manually: node <engine> plugin install ${WORKBUDDY_PLUGIN_KEY}.`,
      };
    }
    return { ok: true, mode: 'direct-write', settingsAction, engineNote };
  }

  // ─── enable / disable (explicit, user-visible — OD-03) ─────────────────────

  /** Human-readable preview of exactly what enabling will change (shown BEFORE any write). */
  describeGovernanceEnable(): { flag: 'host.workbuddy'; configPath: string; value: boolean; takesEffect: string } {
    const p = this.paths();
    return {
      flag: 'host.workbuddy',
      configPath: path.join(p.governanceDir, '.pd', 'config.yaml'),
      value: true,
      takesEffect: 'next hook invocation (hooks read the flag fresh per event)',
    };
  }

  /** Explicit enable of PD governance (install never calls this). */
  enableGovernance(): FlagOverrideResult {
    const p = this.paths();
    return setWorkbuddyGovernanceFlag(p.governanceDir, true);
  }

  /** Explicit disable of PD governance (reversible rollback path). */
  disableGovernance(): FlagOverrideResult {
    const p = this.paths();
    return setWorkbuddyGovernanceFlag(p.governanceDir, false);
  }

  // ─── uninstall ────────────────────────────────────────────────────────────

  async uninstall(_ctx: HostUninstallContext): Promise<HostUninstallResult> {
    const p = this.paths();
    const details = this.detectDetails();
    const removedPaths: string[] = [];
    const preservedPaths: string[] = [];
    const failedPaths: string[] = [];
    const notes: string[] = [];

    // 1. Disable first so hooks stop even if later steps fail (belt).
    if (details.pluginEnabled) {
      const disable = details.engineFound
        ? this.runEngine(['plugin', 'disable', WORKBUDDY_PLUGIN_KEY])
        : undefined;
      if (disable === undefined || disable.status !== 0) {
        notes.push('engine disable command unavailable or failed — proceeding to full uninstall/removal.');
      }
    }

    // 2. Unregister via the engine when possible.
    if (details.registered && details.engineFound) {
      const uninstall = this.runEngine(['plugin', 'uninstall', WORKBUDDY_PLUGIN_KEY]);
      const engineUninstalled = uninstall !== undefined && uninstall.status === 0 && PLUGIN_UNINSTALL_OK.test(uninstall.stdout + uninstall.stderr);
      if (!engineUninstalled && uninstall !== undefined) {
        notes.push(`engine uninstall did not confirm success (${(uninstall.stderr || uninstall.stdout).trim().slice(0, 200) || `exit ${uninstall.status}`}).`);
      }
    }

    // 3. Direct-write removal of the frozen-format entries when the engine did
    //    not (or could not) remove them. Only OUR key is touched.
    const afterEngine = this.detectDetails();
    if (afterEngine.registered || afterEngine.pluginEnabled) {
      const removal = this.directWriteRemoval();
      if (!removal.ok) {
        failedPaths.push(p.settingsPath, p.registryPath);
        preservedPaths.push(p.settingsPath, p.registryPath);
        return {
          success: false,
          hostId: this.hostId,
          removedPaths,
          preservedPaths,
          reason: removal.reason,
          nextAction: removal.nextAction,
        };
      }
      removedPaths.push(p.settingsPath, p.registryPath);
    }

    // 4. Remove OUR cache subtree (provable: cache/<OUR_MARKETPLACE>/<OUR_PLUGIN>).
    if (existsSync(p.cachePluginRoot)) {
      try {
        rmSync(p.cachePluginRoot, { recursive: true, force: true });
        removedPaths.push(p.cachePluginRoot);
      } catch (error) {
        failedPaths.push(p.cachePluginRoot);
        preservedPaths.push(p.cachePluginRoot);
        notes.push(`cache removal failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    // 5. Remove the PD-owned marketplace dir.
    if (existsSync(p.marketplaceRoot)) {
      try {
        rmSync(p.marketplaceRoot, { recursive: true, force: true });
        removedPaths.push(p.marketplaceRoot);
      } catch (error) {
        failedPaths.push(p.marketplaceRoot);
        preservedPaths.push(p.marketplaceRoot);
        notes.push(`marketplace removal failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    // 6. Manifest bookkeeping: drop 'workbuddy' from hosts. The governance
    //    workspace entry and ALL governance data are preserved (§18 default).
    removeWorkbuddyFromInstallManifestHosts(p.installManifestPath);
    const governancePreservedByDesign = existsSync(p.governanceDir);
    if (governancePreservedByDesign) {
      preservedPaths.push(p.governanceDir);
    }

    // Success = every INTENDED removal happened. The governance database is
    // preserved BY DESIGN (never a failure); only failed removals fail.
    return {
      success: failedPaths.length === 0,
      hostId: this.hostId,
      removedPaths,
      preservedPaths,
      reason: failedPaths.length > 0
        ? `Partially uninstalled: ${failedPaths.join(', ')} could not be removed. ${notes.join(' ')}`
        : `Uninstalled ${WORKBUDDY_PLUGIN_KEY}. ${notes.join(' ')}`.trim(),
      nextAction: [
        'Registration removal takes effect in NEW WorkBuddy sessions (or /reload-plugins in a running CLI session).',
        governancePreservedByDesign
          ? `The governance database at ${p.governanceDir} is PRESERVED by design — delete it manually only after exporting what you need.`
          : '',
      ].filter(Boolean).join(' '),
    };
  }

  /** Remove only OUR entries from settings.json + installed_plugins.json (frozen formats). */
  private directWriteRemoval(): { ok: true } | { ok: false; reason: string; nextAction: string } {
    const p = this.paths();
    const settings = readHostJsonFile(p.settingsPath);
    if (!settings.ok) return { ok: false, reason: settings.reason, nextAction: settings.nextAction };
    if (settings.existed && isRecord(settings.value?.enabledPlugins) && Object.hasOwn(settings.value.enabledPlugins, WORKBUDDY_PLUGIN_KEY)) {
      const nextSettings: Record<string, unknown> = { ...settings.value };
      const enabledPlugins = { ...nextSettings.enabledPlugins as Record<string, unknown> };
      delete enabledPlugins[WORKBUDDY_PLUGIN_KEY];
      nextSettings.enabledPlugins = enabledPlugins;
      const write = writeHostJsonFileProtected(p.settingsPath, JSON.stringify(nextSettings, null, 2) + '\n');
      if (!write.ok) return { ok: false, reason: write.reason, nextAction: write.nextAction };
    }
    const registry = readHostJsonFile(p.registryPath);
    if (!registry.ok) return { ok: false, reason: registry.reason, nextAction: registry.nextAction };
    if (registry.existed && isRecord(registry.value?.plugins) && Object.hasOwn(registry.value.plugins, WORKBUDDY_PLUGIN_KEY)) {
      const nextRegistry: Record<string, unknown> = { ...registry.value };
      const plugins = { ...nextRegistry.plugins as Record<string, unknown> };
      delete plugins[WORKBUDDY_PLUGIN_KEY];
      nextRegistry.plugins = plugins;
      const write = writeHostJsonFileProtected(p.registryPath, JSON.stringify(nextRegistry, null, 2) + '\n');
      if (!write.ok) return { ok: false, reason: write.reason, nextAction: write.nextAction };
    }
    return { ok: true };
  }

  // ─── detect ───────────────────────────────────────────────────────────────

  detect(): HostDetectResult {
    return this.detectDetails();
  }

  /** Detailed detect: install presence vs host discovery vs registration vs enablement vs runtime reachability. */
  detectDetails(): WorkbuddyDetectDetails {
    const p = this.paths();
    const enginePath = this.deps.enginePath();
    const hostFound = existsSync(p.configDir);
    const engineFound = enginePath !== undefined;
    const settings = readHostJsonFile(p.settingsPath);
    const registry = readHostJsonFile(p.registryPath);
    let registered = false;
    if (registry.ok && registry.existed && isRecord(registry.value?.plugins)) {
      registered = Object.hasOwn(registry.value.plugins, WORKBUDDY_PLUGIN_KEY);
    }
    let pluginEnabled = false;
    if (settings.ok && settings.existed && isRecord(settings.value?.enabledPlugins)) {
      pluginEnabled = settings.value.enabledPlugins[WORKBUDDY_PLUGIN_KEY] === true;
    }
    const runtimeReachable = existsSync(path.join(p.runtimeAdapterDir, 'package.json')) && existsSync(path.join(p.runtimeAdapterDir, 'dist'));
    const governanceInitialized = existsSync(p.governanceDir);
    const installed = existsSync(p.marketplaceRoot) || registered || pluginEnabled;

    const result: WorkbuddyDetectDetails = {
      installed,
      hostFound,
      engineFound,
      ...(enginePath !== undefined ? { enginePath } : {}),
      registered,
      pluginEnabled,
      flagOverride: readWorkbuddyGovernanceFlagOverride(p.governanceDir),
      runtimeReachable,
      governanceInitialized,
      settingsExisted: settings.ok && settings.existed,
      paths: [
        { exists: hostFound, path: p.configDir, name: 'WorkBuddy config dir', type: 'dir' as const },
        { exists: engineFound, path: enginePath ?? '(engine not found)', name: 'WorkBuddy engine CLI', type: 'file' as const },
        { exists: existsSync(p.marketplaceRoot), path: p.marketplaceRoot, name: 'PD WorkBuddy marketplace (PD-owned)', type: 'dir' as const },
        { exists: registered, path: p.registryPath, name: 'installed_plugins.json carries PD registration', type: 'file' as const },
        { exists: pluginEnabled, path: p.settingsPath, name: 'settings.json enabledPlugins entry', type: 'file' as const },
        { exists: runtimeReachable, path: p.runtimeAdapterDir, name: 'PD runtime workbuddy-adapter', type: 'dir' as const },
        { exists: governanceInitialized, path: p.governanceDir, name: 'Governance workspace (OD-07)', type: 'dir' as const },
      ],
    };
    return result;
  }
}
