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
 * existing host.workbuddy feature flag (quiet, registry default OFF). Explicit enable remains a
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
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, cpSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import * as yaml from 'js-yaml';
import semver from 'semver';
import {
  getInstallLayoutPaths,
  getWorkbuddyWorkspaceDir,
  installManifestHostsForPersist,
  mergeInstallManifestWorkspaces,
  parseInstallManifest,
  INSTALL_LAYOUT_VERSION,
  type InstallHost,
} from '@principles/install-layout';
import { atomicReplaceTextFile, errnoCode } from '../utils/config-file-io.js';
import { getHomeDir, generateConfigYamlContent, getConfigYamlPath, resolveDefaultModelForProvider, isValidHttpBaseUrl } from '../mvp-config.js';
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
const WORKBUDDY_REQUIRED_SKILLS = ['pd-cli-operator', 'pd-pain-signal', 'pd-review', 'pd-control'];

/**
 * Files the host needs to load this plugin. One list serves both the
 * "is the cached payload current?" comparison and the "did the staged copy
 * finish?" proof — two copies of this set would drift apart silently.
 */
const WORKBUDDY_PAYLOAD_FILES = [
  path.join('.codebuddy-plugin', 'plugin.json'),
  path.join('hooks', 'hooks.json'),
  path.join('scripts', 'wrapper.cjs'),
  path.join('scripts', 'pd-control.cjs'),
  ...WORKBUDDY_REQUIRED_SKILLS.map((skill) => path.join('skills', skill, 'SKILL.md')),
];


/** Engine CLI shipped with WorkBuddy Desktop (probe P01 frozen path). */
export const WORKBUDDY_ENGINE_RELATIVE = ['resources', 'app.asar.unpacked', 'cli', 'dist', 'codebuddy-lite-wb.mjs'];

/** Engine command success markers (frozen by probe P01 regexes). */
const MARKETPLACE_ADD_OK = /added successfully|already/i;
const PLUGIN_INSTALL_OK = /Successfully installed/i;
const PLUGIN_UNINSTALL_OK = /Successfully uninstalled/i;

const ENGINE_COMMAND_TIMEOUT_MS = 120_000;

/** `pd runtime init` for the governance workspace (schema + config + state.db). */
const GOVERNANCE_INIT_TIMEOUT_MS = 180_000;

// ─── Type guards (rc-2: no `as` bypass) ─────────────────────────────────────
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Native v2 stores scope records as an array; old PD installs used one object. */
function userInstalledPluginRecord(value: unknown): Record<string, unknown> | undefined {
  const records = Array.isArray(value) ? value : [value];
  return records.find((record): record is Record<string, unknown> =>
    isRecord(record) && record.scope === 'user' && record.projectPath === undefined);
}

function isSafePluginVersion(version: unknown): version is string {
  return typeof version === 'string'
    && /^[0-9][0-9A-Za-z.+-]*$/.test(version)
    && semver.valid(version) !== null;
}

/** Deletion/writes may target only a strict child of our fixed cache root. */
function workbuddyCacheVersionDir(cacheRoot: string, version: string): string | undefined {
  if (!isSafePluginVersion(version)) return undefined;
  const root = path.resolve(cacheRoot);
  const target = path.resolve(root, version);
  const relative = path.relative(root, target);
  if (relative.length === 0 || path.isAbsolute(relative) || relative === '..' || relative.startsWith(`..${path.sep}`)) return undefined;
  return target;
}

/** Every scope record PD may have written for its key (native array or legacy object). */
function installedPluginRecords(value: unknown): Record<string, unknown>[] {
  return (Array.isArray(value) ? value : [value]).filter(isRecord);
}

/**
 * Proof that a *staged* cache payload is complete before it replaces the live
 * one. Returns the first missing/empty required file, or undefined when the
 * payload is loadable. Never trusts `cpSync` returning without throwing.
 */
function missingWorkbuddyPayloadFile(root: string): string | undefined {
  for (const file of WORKBUDDY_PAYLOAD_FILES) {
    try {
      if (readFileSync(path.join(root, file)).length > 0) continue;
    } catch { /* unreachable payload — reported below, never guessed */ }
    return file;
  }
  return undefined;
}

export interface WorkbuddyCommandResult {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: string;
}

export interface WorkbuddyCommandOptions {
  timeoutMs?: number;
  /**
   * Extra environment for the engine child (merged over process.env).
   * S2 (review 2026-10-13): the REAL engine resolves its config root from
   * CODEBUDDY_CONFIG_DIR first (Phase 0 P0 isolation recipe) — without an
   * explicit override it registers into ~/.codebuddy or a pre-existing
   * CodeBuddy root while the installer verifies the declared WorkBuddy root.
   */
  env?: Record<string, string>;
}

export interface WorkbuddyHostInstallerDeps {
  /** Home directory resolver (tests inject a temp dir; default: getHomeDir()). */
  homeDir?: () => string;
  /** Engine path resolver (default: env override + Program Files probe). */
  enginePath?: () => string | undefined;
  /**
   * pd-cli runtime entry resolver (default: the installed runtime pd-cli under
   * install-layout's pdCliDir). Its `runtime init` is the SHARED initializer
   * that creates the governance workspace's .pd/config.yaml (core defaults),
   * .pd/state.db and the canonical .state/trajectory.db schema — the same
   * entry the main installer runs for the generic workspace (review R1).
   */
  pdCliEntry?: () => string | undefined;
  /** Command runner (default: spawnSync). Tests inject a fake engine boundary. */
  runCommand?: (file: string, args: readonly string[], opts?: WorkbuddyCommandOptions) => WorkbuddyCommandResult;
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
 * Enumerate Windows FIXED drives only. Letters can represent network or
 * removable volumes; never treat A-Z as equivalent to fixed media.
 * A failed/unsupported probe falls back to explicit ProgramFiles/SystemDrive
 * paths, not a guess across mapped network drives.
 */
function workbuddyFixedDriveLetters(): string[] {
  if (process.platform !== 'win32') return [];
  const probe = spawnSync('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-Command',
    '[System.IO.DriveInfo]::GetDrives() | Where-Object { $_.DriveType -eq [System.IO.DriveType]::Fixed } | ForEach-Object { $_.Name }',
  ], { encoding: 'utf8', windowsHide: true, timeout: 5_000, maxBuffer: 8 * 1024 });
  if (probe.error || probe.status !== 0 || typeof probe.stdout !== 'string') return [];
  return probe.stdout.split(/\r?\n/).map((line) => line.trim())
    .filter((root) => /^[A-Za-z]:\\$/.test(root))
    .map((root) => root.slice(0, 2).toUpperCase());
}

/**
 * Candidate Program Files roots probed for the WorkBuddy engine, in order:
 * the env-declared Program Files (both variants), the SystemDrive root, then —
 * Windows only — the same directories on each discovered fixed drive.
 *
 * G1 (2026-10-15): a Desktop install outside the SystemDrive's Program Files
 * (e.g. D:\Program Files\WorkBuddy, the machine this gap was proven on)
 * previously resolved to "engine not found", so install skipped its engine
 * verification and detect() reported an absent engine on a real installation.
 */
export function workbuddyEngineCandidateRoots(
  env: Record<string, string | undefined> = process.env,
  fixedDriveLetters?: readonly string[],
): string[] {
  const roots: string[] = [];
  const push = (value: unknown): void => {
    if (typeof value === 'string' && value.length > 0 && !roots.includes(value)) roots.push(value);
  };
  push(env.ProgramFiles);
  push(env['ProgramFiles(x86)']);
  const systemDrive = typeof env.SystemDrive === 'string' ? env.SystemDrive : '';
  if (systemDrive.length > 0) push(path.join(systemDrive, 'Program Files'));
  if (process.platform === 'win32') {
    for (const drive of fixedDriveLetters ?? workbuddyFixedDriveLetters()) {
      if (!/^[A-Za-z]:$/.test(drive)) continue;
      if (systemDrive.length > 0 && drive.toLowerCase() === systemDrive.toLowerCase()) continue;
      push(path.win32.join(drive + path.win32.sep, 'Program Files'));
      push(path.win32.join(drive + path.win32.sep, 'Program Files (x86)'));
    }
  }
  return roots;
}

/**
 * Resolve the WorkBuddy engine CLI path.
 *
 * Order: PD_WORKBUDDY_ENGINE / WB_ENGINE env override (probe convention) →
 * the Desktop install location under Program Files (frozen by probe P01),
 * multi-drive per workbuddyEngineCandidateRoots. The engine is NOT exposed on
 * PATH — absence is a detectable, reportable fact, never a guess.
 */
export function resolveWorkbuddyEnginePath(): string | undefined {
  for (const envName of ['PD_WORKBUDDY_ENGINE', 'WB_ENGINE']) {
    const value = process.env[envName];
    if (value && value.length > 0 && existsSync(value)) return value;
  }
  for (const root of workbuddyEngineCandidateRoots()) {
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
  } catch (error) {
    if (errnoCode(error) === 'ENOENT') return { ok: true, value: undefined, existed: false };
    return {
      ok: false, path: filePath,
      reason: `workbuddy_settings_unreadable: cannot read ${filePath} (${error instanceof Error ? error.message : String(error)}). No PD write was performed.`,
      nextAction: 'Restore host file read access before installing or uninstalling; do not delete caches while registry references are unknown.',
    };
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
    if (!isSafePluginVersion(manifest.version)) {
      return { reason: `workbuddy_plugin_version_invalid: ${manifestPath} must declare a safe single-segment semantic version.` };
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
    // Plugin-root discovery is the WorkBuddy skill delivery boundary. Do not
    // register an old hook-only payload as a complete install.
    for (const skill of WORKBUDDY_REQUIRED_SKILLS) {
      const skillPath = path.join(root, 'skills', skill, 'SKILL.md');
      try {
        if (readFileSync(skillPath, 'utf-8').trim().length > 0) continue;
      } catch { /* Missing/unreadable required skills fail before registration. */ }
      return { reason: `workbuddy_plugin_skill_missing: required nonempty skill ${skillPath}. Reinstall with a complete WorkBuddy payload.` };
    }
    if (!existsSync(path.join(root, 'scripts', 'pd-control.cjs'))) {
      return { reason: `workbuddy_plugin_control_missing: ${root} must ship scripts/pd-control.cjs for the pd-disable skill.` };
    }
    const { version } = manifest;
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
  // Persisted hosts carry forward unknown registrations too
  // (installManifestHostsForPersist) — rebuilding from parsed.manifest.hosts
  // alone would silently unregister a host this reader version does not know.
  const hosts: string[] = [...new Set([...installManifestHostsForPersist(parsed.manifest), 'workbuddy'])];
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
const WORKBUDDY_CATEGORY_LINE = /^ {4}category:(?:\s.*)?(?:#.*)?$/;

/**
 * Registry-required category for the host.workbuddy flag entry. SSoT:
 * packages/principles-core/src/runtime-v2/feature-flags/feature-flag-contract.ts
 * ({ id: 'host.workbuddy', category: 'quiet', ... }). The production config
 * validator (pd-config-validate) REJECTS feature entries without a category,
 * so an enabled-only override makes every hook invocation degrade (review R1).
 * tests/workbuddy-governance-chain.test.ts pins this literal against
 * DEFAULT_FEATURE_FLAGS to catch registry drift.
 */
const WORKBUDDY_FLAG_CATEGORY = 'quiet';

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

/**
 * PRI-1064 (Owner directive 2026-10-31): governance is ON by default at
 * install time. The only state preserved as OFF is an EXPLICIT opt-out
 * (`enabled: false` the Owner wrote). A pre-existing config with sparse
 * flags (e.g. left by a failed install round) no longer silently keeps
 * governance off — the user saw "Install complete!" while every hook
 * skipped with host.workbuddy_disabled.
 * Both entries are validated and atomically committed in one file write;
 * an already-correct config is left byte-identical (no rewrite).
 */
export function ensureWorkbuddyGovernanceEnabled(governanceDir: string): FlagOverrideResult & {
  hostExplicitOff: boolean;
  keywordExplicitOff: boolean;
  changed: boolean;
} {
  const configPath = path.join(governanceDir, '.pd', 'config.yaml');
  let raw: unknown;
  try { raw = yaml.load(readFileSync(configPath, 'utf-8')); }
  catch { return { ok: false, reason: 'fresh_workbuddy_config_unreadable', nextAction: 'Repair governance config and retry.', hostExplicitOff: false, keywordExplicitOff: false, changed: false }; }
  if (!isRecord(raw) || !isRecord(raw.features)) {
    return { ok: false, reason: 'fresh_workbuddy_features_invalid', nextAction: 'Governance config needs a features mapping.', hostExplicitOff: false, keywordExplicitOff: false, changed: false };
  }
  const oldHost = raw.features['host.workbuddy'];
  const oldKeyword = raw.features.workbuddy_live_keyword_pain;
  const hostExplicitOff = isRecord(oldHost) && oldHost.enabled === false;
  const keywordExplicitOff = isRecord(oldKeyword) && oldKeyword.enabled === false;
  const features = {
    ...raw.features,
    'host.workbuddy': { ...(isRecord(oldHost) ? oldHost : {}), enabled: !hostExplicitOff, category: WORKBUDDY_FLAG_CATEGORY },
    workbuddy_live_keyword_pain: { ...(isRecord(oldKeyword) ? oldKeyword : {}), enabled: !keywordExplicitOff, category: WORKBUDDY_FLAG_CATEGORY },
  };
  const next = yaml.dump({ ...raw, features }, { lineWidth: -1, noRefs: true });
  const alreadyCorrect = isRecord(oldHost) && oldHost.enabled === !hostExplicitOff && oldHost.category === WORKBUDDY_FLAG_CATEGORY
    && isRecord(oldKeyword) && oldKeyword.enabled === !keywordExplicitOff && oldKeyword.category === WORKBUDDY_FLAG_CATEGORY;
  if (alreadyCorrect) {
    return { ok: true, configPath, enabled: !hostExplicitOff, hostExplicitOff, keywordExplicitOff, changed: false };
  }
  try {
    const verify: unknown = yaml.load(next);
    if (!isRecord(verify) || !isRecord(verify.features) ||
      !isRecord(verify.features['host.workbuddy']) || verify.features['host.workbuddy'].enabled !== !hostExplicitOff ||
      !isRecord(verify.features.workbuddy_live_keyword_pain) || verify.features.workbuddy_live_keyword_pain.enabled !== !keywordExplicitOff) {
      return { ok: false, reason: 'fresh_workbuddy_flags_verification_failed', nextAction: 'No changes written.', hostExplicitOff, keywordExplicitOff, changed: false };
    }
    atomicReplaceTextFile(configPath, next);
  } catch {
    return { ok: false, reason: 'fresh_workbuddy_flag_write_failed', nextAction: 'Repair config storage and retry.', hostExplicitOff, keywordExplicitOff, changed: false };
  }
  return { ok: true, configPath, enabled: !hostExplicitOff, hostExplicitOff, keywordExplicitOff, changed: true };
}

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
    // Remediation (review 2026-10-13 §3 P2 + round-3 P2): locate the existing
    // `enabled` and `category` fields WITHIN the flag's mapping block. The
    // block boundary is INDENTATION, not field identity: it spans every
    // non-blank line indented ≥ 4 spaces after the 2-space `host.workbuddy:`
    // key, plus the comments/blank lines interleaved with them, and ends at
    // the first structural line indented < 4 spaces (dedent / next key) or
    // EOF. Legal entry fields other than the two we manage — e.g. `source:`
    // (PRI-637 provenance, FeatureFlagEntry source?: 'owner' | 'system') —
    // live INSIDE the block and must NEVER end the scan: the previous
    // first-unrecognized-line break mistook `source: owner` for the block end
    // and spliced duplicate keys above it, so the rewrite verification threw
    // (config_rewrite_invalid) and enable/disable was refused with the stale
    // value preserved.
    let enabledIndex = -1;
    let categoryIndex = -1;
    for (let i = keyIndex + 1; i < lines.length; i++) {
      const line = lines[i];
      if (typeof line !== 'string') break; // EOF — block ended
      if (line.trim() === '' || /^\s*#/.test(line)) continue; // blank / comment — transparent, inside the block
      if (!/^ {4}/.test(line)) break; // dedent — mapping entry ended
      if (WORKBUDDY_ENABLED_LINE.test(line)) { enabledIndex = i; continue; }
      if (WORKBUDDY_CATEGORY_LINE.test(line)) { categoryIndex = i; continue; }
      // Any other legal field (source: …) or nested content — inside the
      // block: keep scanning, never touch it.
    }
    if (enabledIndex >= 0) {
      // In-place flip; nothing else in the block moves.
      lines[enabledIndex] = `    enabled: ${enabled}`;
    } else {
      // No enabled field anywhere in the block: insert it under the key line.
      lines.splice(keyIndex + 1, 0, `    enabled: ${enabled}`);
      if (categoryIndex > keyIndex) categoryIndex += 1;
    }
    // R1 write contract: EVERY entry this function writes carries the
    // schema-required category (production validator requirement). Insert it
    // only when the block has none — never alongside an existing one.
    if (categoryIndex >= 0) {
      lines[categoryIndex] = `    category: ${WORKBUDDY_FLAG_CATEGORY}`;
    } else if (enabledIndex >= 0) {
      lines.splice(enabledIndex + 1, 0, `    category: ${WORKBUDDY_FLAG_CATEGORY}`);
    } else {
      lines.splice(keyIndex + 2, 0, `    category: ${WORKBUDDY_FLAG_CATEGORY}`);
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
      lines.splice(featuresIndex + 1, 0, `  host.workbuddy:`, `    enabled: ${enabled}`, `    category: ${WORKBUDDY_FLAG_CATEGORY}`);
    } else {
      // No features: mapping at all — append a block at the end.
      lines.push('features:', `  host.workbuddy:`, `    enabled: ${enabled}`, `    category: ${WORKBUDDY_FLAG_CATEGORY}`);
    }
  }

  const next = lines.join('\n');
  // Round-trip verification: the rewritten config must parse with the flag at
  // the intended value AND the registry-required category before it is
  // committed (same discipline as codex-setup).
  let verify: unknown;
  try {
    verify = yaml.load(next);
  } catch (error) {
    return { ok: false, reason: `config_rewrite_invalid: verification parse failed (${error instanceof Error ? error.message : String(error)}). Nothing was written.`, nextAction: 'Report this failure — the flag edit produced invalid YAML.' };
  }
  const flagOk = isRecord(verify)
    && isRecord(verify.features)
    && isRecord(verify.features['host.workbuddy'])
    && verify.features['host.workbuddy'].enabled === enabled
    && verify.features['host.workbuddy'].category === WORKBUDDY_FLAG_CATEGORY;
  if (!flagOk) {
    return { ok: false, reason: 'config_rewrite_mismatch: round-trip verification did not observe the intended flag value + category. Nothing was written.', nextAction: 'Report this failure with the config.yaml content.' };
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

// ─── Governance LLM runtime profile (round-3 remediation P1) ────────────────

/**
 * Profile id the installer writes — the same id `generateConfigYamlContent`
 * pre-fills for the project config (Fix-4 shape), so the WorkBuddy governance
 * profile and the other hosts' project profile have ONE shape.
 */
const GOVERNANCE_PROFILE_ID = 'pd.default';

type GovernanceProfileApplyResult =
  | {
    ok: true;
    configPath: string;
    profileId: string;
    /** The model actually written (explicit, preserved, or per-provider default). */
    model: string;
    /** Agents whose EXPLICIT per-agent runtimeProfile still points elsewhere
     *  after the override (legacy init rows / Owner rows). Reported, never
     *  silently overridden (round-4 S1). */
    pendingAgents: string[];
  }
  | { ok: false; reason: string; nextAction: string };

/**
 * Apply the install-collected LLM runtime profile (--provider/--api-key-env/
 * --model/--base-url) to the GOVERNANCE workspace's .pd/config.yaml — the
 * single config the WorkBuddy worker/console/hook chain reads (round-3 P1:
 * the main installer previously wrote the profile into the PROJECT
 * config.yaml while this host's governance workspace kept the runtime-init
 * defaults, so the diagnostician had no usable profile).
 *
 * Semantics (frozen remediation contract):
 * - explicit install profile ⇒ override `runtimeProfiles.pd.default` (same
 *   write shape as generateConfigYamlContent; unknown extra fields of an
 *   existing pd.default such as baseUrl/maxTokens are preserved) and point
 *   `internalAgents.defaultRuntime` + the diagnostician binding at it.
 *   Other profiles and every other agent binding are preserved; the
 *   diagnostician's `enabled` kill switch is never touched (PRI-638: Owner
 *   capability authority stays with the Owner).
 * - Model (round-4 S2): an explicit non-empty --model wins; when --model is
 *   omitted, an existing non-empty pd.default model is PRESERVED
 *   (existing-coverage contract) and otherwise the shared per-provider
 *   default (resolveDefaultModelForProvider) is applied so the profile is
 *   genuinely ready. An explicit BLANK --model fails loud — it never passes
 *   validation and never writes an empty model.
 * - Pending-config honesty (round-4 S1): agents whose EXPLICIT per-agent
 *   runtimeProfile still points elsewhere after the override (legacy init
 *   rows indistinguishable from Owner choices) are returned as
 *   `pendingAgents` for the installer result — kept as-is, never silently
 *   rebound.
 * - Only `apiKeyEnv` (an environment variable NAME) is ever written — no key
 *   material reaches config, logs or errors.
 * - The leading comment header of the existing config is preserved; the
 *   rewrite carries an explicit installer marker so the provenance of the
 *   override stays observable. (Inline comments inside the rewritten nested
 *   blocks cannot survive a parse-mutate-dump edit; the previous content is
 *   only ever replaced atomically AFTER a full round-trip verification.)
 * - Round-trip verified loader-grade (JSON_SCHEMA parse + non-empty
 *   provider/model/apiKeyEnv + binding assertions) BEFORE the atomic replace;
 *   any mismatch or write failure leaves the file untouched and fails the
 *   install loudly (rc-3/rc-9).
 *
 * Module-private: the only writer/reader is install() below (step 6.5); the
 * regression suite exercises it through the REAL install() boundary.
 */
function applyWorkbuddyGovernanceRuntimeProfile(
  governanceDir: string,
  profile: { readonly provider?: string; readonly model?: string; readonly apiKeyEnv?: string; readonly baseUrl?: string },
): GovernanceProfileApplyResult {
  // rc-1/rc-3: validate here — upstream CLI validation is not trusted as a
  // substitute for a guard at the write boundary.
  const provider = typeof profile.provider === 'string' ? profile.provider.trim() : '';
  const apiKeyEnv = typeof profile.apiKeyEnv === 'string' ? profile.apiKeyEnv.trim() : '';
  if (provider.length === 0 || apiKeyEnv.length === 0) {
    return {
      ok: false,
      reason: `workbuddy_governance_profile_invalid: --provider/--api-key-env must both be non-empty (got provider=${JSON.stringify(provider || undefined)}, apiKeyEnv=${JSON.stringify(apiKeyEnv || undefined)}).`,
      nextAction: 'Re-run the installer with both --provider <openai|anthropic|deepseek> and --api-key-env <ENV_VAR_NAME>.',
    };
  }
  // Round-4 R3 / round-5 S3: an explicit --base-url must be a usable http(s)
  // endpoint — pi-ai treats its PRESENCE as "custom endpoint, skip the model
  // catalog", so a junk value would silently break every governance LLM call.
  // EXPLICIT blank fails loud (same rule as blank --model); validity is real
  // URL parsing via the ONE shared validation (a prefix regex let `https://`
  // through — round-5 independent repro round5-badurl-results.json).
  const baseUrlRaw = typeof profile.baseUrl === 'string' ? profile.baseUrl : undefined;
  const baseUrl = baseUrlRaw !== undefined ? baseUrlRaw.trim() : '';
  if (baseUrlRaw !== undefined && baseUrl.length === 0) {
    return {
      ok: false,
      reason: `workbuddy_governance_profile_invalid: --base-url was given but blank. Pass a valid http(s) endpoint URL, or omit --base-url to use the provider default.`,
      nextAction: 'Re-run the installer with --base-url <https endpoint> (or omit it).',
    };
  }
  if (baseUrl.length > 0 && !isValidHttpBaseUrl(baseUrl)) {
    return {
      ok: false,
      reason: `workbuddy_governance_profile_invalid: --base-url "${baseUrl}" is not a valid http(s) URL with a hostname.`,
      nextAction: 'Re-run the installer with --base-url <https endpoint> (or omit it to use the provider default).',
    };
  }
  // Round-4 S2: a blank --model is an EXPLICIT invalid value — reject it
  // instead of silently treating it as omitted (an empty written model would
  // fail the resolver later with needs_setup).
  if (typeof profile.model === 'string' && profile.model.trim().length === 0) {
    return {
      ok: false,
      reason: `workbuddy_governance_profile_invalid: --model was given but blank. Pass a non-empty model id, or omit --model to keep the existing configured model (or apply the per-provider default).`,
      nextAction: 'Re-run the installer with --model <model-id> (or without --model).',
    };
  }
  const modelArg = typeof profile.model === 'string' ? profile.model.trim() : '';

  const configPath = getConfigYamlPath(governanceDir);
  if (!existsSync(configPath)) {
    return {
      ok: false,
      reason: `workbuddy_governance_profile_read_failed: ${configPath} does not exist after governance initialization.`,
      nextAction: `Re-run the installer; if it repeats, run "pd runtime init --confirm --workspace ${governanceDir}" manually to see the underlying error.`,
    };
  }
  let raw: string;
  try {
    raw = readFileSync(configPath, 'utf-8');
  } catch (error) {
    return {
      ok: false,
      reason: `workbuddy_governance_profile_read_failed: ${configPath} (${error instanceof Error ? error.message : String(error)}).`,
      nextAction: 'Close other tools holding the config file, check permissions, then re-run the installer.',
    };
  }
  // A config that cannot parse is a hard stop (rc-3) — never edited blind.
  let parsed: unknown;
  try {
    parsed = yaml.load(raw);
  } catch (error) {
    return {
      ok: false,
      reason: `workbuddy_governance_profile_unparsable: ${configPath} is not valid YAML (${error instanceof Error ? error.message : String(error)}). No write was performed.`,
      nextAction: 'Fix or delete the malformed governance config.yaml, then re-run the installer.',
    };
  }
  // rc-2: structural guards with explicit narrowing — the sections the edit
  // touches must already exist (a loader-valid config always carries them).
  const configRecord = isRecord(parsed) ? parsed : undefined;
  const runtimeProfiles = configRecord !== undefined && isRecord(configRecord.runtimeProfiles) ? configRecord.runtimeProfiles : undefined;
  const internalAgents = configRecord !== undefined && isRecord(configRecord.internalAgents) ? configRecord.internalAgents : undefined;
  const agentBindings = internalAgents !== undefined && isRecord(internalAgents.agents) ? internalAgents.agents : undefined;
  if (runtimeProfiles === undefined || internalAgents === undefined || agentBindings === undefined) {
    return {
      ok: false,
      reason: `workbuddy_governance_profile_invalid_structure: ${configPath} is missing runtimeProfiles/internalAgents (the loader would reject it). No write was performed.`,
      nextAction: `Restore a loader-valid governance config ("pd runtime init --confirm --workspace ${governanceDir}" never overwrites an existing file — fix the sections manually), then re-run the installer.`,
    };
  }

  // Preserve unknown extra fields of an existing pd.default (baseUrl,
  // timeoutMs, maxTokens, …); the install-collected fields win.
  const existingProfile = isRecord(runtimeProfiles[GOVERNANCE_PROFILE_ID]) ? runtimeProfiles[GOVERNANCE_PROFILE_ID] : {};
  // Round-4 S2 model resolution: explicit --model wins; omitted → preserve
  // the existing valid model (existing-coverage contract); otherwise apply
  // the shared per-provider default. No path writes an empty model.
  const existingModel = typeof existingProfile.model === 'string' ? existingProfile.model.trim() : '';
  let model = modelArg;
  if (model.length === 0) {
    if (existingModel.length > 0) {
      model = existingModel;
    } else {
      model = resolveDefaultModelForProvider(provider);
      if (model.length === 0) {
        return {
          ok: false,
          reason: `workbuddy_governance_profile_model_unresolvable: --model was omitted and provider '${provider}' has no known default model.`,
          nextAction: 'Re-run the installer with --model <model-id> for the selected provider.',
        };
      }
    }
  }
  runtimeProfiles[GOVERNANCE_PROFILE_ID] = {
    ...existingProfile,
    type: 'pi-ai',
    provider,
    model,
    apiKeyEnv,
    // Custom endpoint only when collected; an existing pd.default.baseUrl
    // survives via the spread above when the arg is omitted.
    ...(baseUrl.length > 0 ? { baseUrl } : {}),
  };
  internalAgents.defaultRuntime = GOVERNANCE_PROFILE_ID;
  // Preserve the diagnostician's other binding fields (its `enabled` kill
  // switch stays Owner-authoritative — PRI-638 — never re-enabled here).
  const existingBinding = isRecord(agentBindings.diagnostician) ? agentBindings.diagnostician : {};
  agentBindings.diagnostician = { ...existingBinding, runtimeProfile: GOVERNANCE_PROFILE_ID };
  // Round-4 S1 pending-config honesty: agents whose EXPLICIT per-agent row
  // still points elsewhere (legacy init rows / Owner rows — indistinguishable
  // here, so never overridden) keep resolving to their own profile. Report
  // them; the installer result carries the honest state and the rebind path.
  // Data-driven from the config's own agents map — no second agent-name list.
  const pendingAgents = Object.keys(agentBindings).filter((name) => {
    const binding = agentBindings[name];
    return isRecord(binding)
      && typeof binding.runtimeProfile === 'string'
      && binding.runtimeProfile !== GOVERNANCE_PROFILE_ID;
  });

  // Preserve the leading comment header (the "single source of truth" banner
  // pd runtime init writes) and mark the installer override.
  const headerLines: string[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '' && headerLines.length === 0) continue;
    if (trimmed.startsWith('#')) headerLines.push(line);
    else break;
  }
  const marker = '# runtimeProfiles.pd.default + internalAgents default/diagnostician binding written by the Principles Disciple installer (--provider/--api-key-env/--model/--base-url).';
  const body = yaml.dump(parsed, { lineWidth: -1, quoteStyle: 'double' });
  const next = headerLines.length > 0 ? `${headerLines.join('\n')}\n${marker}\n${body}` : `${marker}\n${body}`;

  // Round-trip verification, loader-grade: parse with the SAME schema the
  // production loader uses and assert exactly what the install promised
  // before anything touches the disk.
  let verify: unknown;
  try {
    verify = yaml.load(next, { schema: yaml.JSON_SCHEMA });
  } catch (error) {
    return {
      ok: false,
      reason: `workbuddy_governance_profile_rewrite_invalid: verification parse failed (${error instanceof Error ? error.message : String(error)}). Nothing was written.`,
      nextAction: 'Report this failure — the profile edit produced invalid YAML.',
    };
  }
  const verifiedRecord = isRecord(verify) ? verify : undefined;
  const verifiedProfiles = verifiedRecord !== undefined && isRecord(verifiedRecord.runtimeProfiles) ? verifiedRecord.runtimeProfiles : undefined;
  const verifiedInternal = verifiedRecord !== undefined && isRecord(verifiedRecord.internalAgents) ? verifiedRecord.internalAgents : undefined;
  const verifiedAgentBindings = verifiedInternal !== undefined && isRecord(verifiedInternal.agents) ? verifiedInternal.agents : undefined;
  const verifiedProfile = verifiedProfiles !== undefined ? verifiedProfiles[GOVERNANCE_PROFILE_ID] : undefined;
  const verifiedBinding = verifiedAgentBindings !== undefined ? verifiedAgentBindings.diagnostician : undefined;
  const verifyOk = isRecord(verifiedProfile)
    && verifiedProfile.type === 'pi-ai'
    && verifiedProfile.provider === provider && provider.length > 0
    && verifiedProfile.model === model && typeof model === 'string' && model.length > 0
    && verifiedProfile.apiKeyEnv === apiKeyEnv && apiKeyEnv.length > 0
    // A requested custom endpoint must survive the round trip (dropping it
    // would silently reintroduce provider catalog validation).
    && (baseUrl.length === 0 || verifiedProfile.baseUrl === baseUrl)
    && verifiedInternal !== undefined
    && verifiedInternal.defaultRuntime === GOVERNANCE_PROFILE_ID
    && isRecord(verifiedBinding)
    && verifiedBinding.runtimeProfile === GOVERNANCE_PROFILE_ID;
  if (!verifyOk) {
    return {
      ok: false,
      reason: 'workbuddy_governance_profile_rewrite_mismatch: round-trip verification did not observe the requested profile + binding. Nothing was written.',
      nextAction: 'Report this failure with the governance config.yaml content.',
    };
  }

  try {
    mkdirSync(path.dirname(configPath), { recursive: true });
    atomicReplaceTextFile(configPath, next);
  } catch (error) {
    return {
      ok: false,
      reason: `workbuddy_governance_profile_write_failed: could not write ${configPath} (${error instanceof Error ? error.message : String(error)}). The previous governance config was left unchanged.`,
      nextAction: `Check permissions under ${path.dirname(configPath)}, close tools holding the file, then re-run the installer.`,
    };
  }
  return { ok: true, configPath, profileId: GOVERNANCE_PROFILE_ID, model, pendingAgents };
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
    const homeDir = deps.homeDir ?? getHomeDir;
    this.deps = {
      homeDir,
      enginePath: deps.enginePath ?? resolveWorkbuddyEnginePath,
      pdCliEntry: deps.pdCliEntry ?? (() => {
        // install-layout SSoT: the shared runtime pd-cli the main installer
        // deploys and invokes (getInstallLayoutPaths(home).pdCliDir).
        const entry = path.join(getInstallLayoutPaths(homeDir()).pdCliDir, 'dist', 'index.js');
        return existsSync(entry) ? entry : undefined;
      }),
      runCommand: deps.runCommand ?? ((file, args, opts) => {
        const result = spawnSync(file, [...args], {
          encoding: 'utf-8',
          timeout: opts?.timeoutMs ?? ENGINE_COMMAND_TIMEOUT_MS,
          windowsHide: true,
          ...(opts?.env !== undefined ? { env: { ...process.env, ...opts.env } } : {}),
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

  /**
   * Run `node <engine> <args>`; returns undefined when the invocation itself
   * failed.
   *
   * S2 (review 2026-10-13): every engine command is pinned to the DECLARED
   * config root by injecting BOTH isolation variables (the Phase 0 P0
   * recipe). The real engine prefers CODEBUDDY_CONFIG_DIR; without the
   * injection it registered into ~/.codebuddy / a pre-existing CodeBuddy root
   * while this installer verified the declared WorkBuddy root — command
   * success and target registration diverged. WORKBUDDY_CONFIG_DIR is
   * injected as well so engine versions that honor the WorkBuddy-scoped
   * variable stay on the same root.
   */
  private runEngine(args: readonly string[]): WorkbuddyCommandResult & { engine: string } | undefined {
    const engine = this.deps.enginePath();
    if (engine === undefined) return undefined;
    const {configDir} = this.paths();
    const result = this.deps.runCommand(process.execPath, [engine, ...args], {
      env: {
        CODEBUDDY_CONFIG_DIR: configDir,
        WORKBUDDY_CONFIG_DIR: configDir,
      },
    });
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

    // 6. Initialize the governance workspace (OD-07 explicit creation) with
    //    the FULL loader-valid state the hook/console/worker chain reads:
    //    .pd/config.yaml, .pd/state.db and the canonical .state/trajectory.db
    //    schema. Review 2026-10-13 R1: this step previously only mkdir'd the
    //    directory, so install reported success while the hook chain saw an
    //    uninitialized workspace.
    const governance = this.initializeGovernanceWorkspace(p.governanceDir);
    if (!governance.ok) {
      return {
        success: false,
        hostId: this.hostId,
        configPath: p.settingsPath,
        configAction: registration.settingsAction,
        reason: governance.reason,
        nextAction: governance.nextAction,
      };
    }

    // 6.5 Round-3 remediation P1: the install-collected LLM runtime profile
    //     (--provider/--api-key-env/--model) is GOVERNANCE state for this
    //     host — it must land in the governance workspace config the
    //     worker/console/hook chain actually reads. (The main installer no
    //     longer writes it into the project config.yaml for this host, so
    //     this is the single writer — no second truth.) Without a profile the
    //     governance config keeps its runtime-init default untouched.
    //     Round-4 S1/S2: the applied result carries the model actually
    //     written (explicit / preserved / per-provider default) and the
    //     agents whose explicit bindings still resolve elsewhere — both are
    //     reported on the installer result surface, never silently smoothed.
    let profileNote = '';
    let profilePendingAgents: string[] = [];
    if (ctx.runtimeProfile) {
      const applied = applyWorkbuddyGovernanceRuntimeProfile(p.governanceDir, ctx.runtimeProfile);
      if (!applied.ok) {
        return {
          success: false,
          hostId: this.hostId,
          configPath: p.settingsPath,
          configAction: registration.settingsAction,
          reason: applied.reason,
          nextAction: applied.nextAction,
        };
      }
      profileNote = ` LLM runtime profile '${applied.profileId}' (provider ${ctx.runtimeProfile.provider}, model ${applied.model}) written to ${applied.configPath}.`;
      if (applied.pendingAgents.length > 0) {
        profilePendingAgents = applied.pendingAgents;
        profileNote += ` Learning agent(s) ${applied.pendingAgents.join(', ')} still bound to their explicit runtime profiles — they keep resolving to their current runtime, not '${applied.profileId}'.`;
      }
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

    // 8. Install ⇒ governance ON by default (PRI-1064, Owner directive
    //    2026-10-31): the ONLY preserved-off state is an explicit opt-out the
    //    Owner wrote (enabled: false). Sparse/legacy configs left OFF by a
    //    failed install round are turned ON here — an install that ends with
    //    every hook skipping (host.workbuddy_disabled) is the P1 defect this
    //    replaces. The summary line below always states the effective state.
    const governanceConfigExists = existsSync(path.join(p.governanceDir, '.pd', 'config.yaml'));
    const governanceDefaults = governanceConfigExists ? ensureWorkbuddyGovernanceEnabled(p.governanceDir) : null;
    if (governanceDefaults !== null && !governanceDefaults.ok) {
      return { success: false, hostId: this.hostId, configPath: p.settingsPath,
        configAction: registration.settingsAction, reason: governanceDefaults.reason, nextAction: governanceDefaults.nextAction };
    }
    const keywordDefaultsNote = governanceDefaults === null
      ? ` Governance flag state is UNKNOWN — no governance config exists at ${p.governanceDir} (run "pd runtime init --workspace ${p.governanceDir}", then re-run the installer).`
      : governanceDefaults.hostExplicitOff
      ? ' WorkBuddy governance is OFF — your explicit opt-out (features.host.workbuddy.enabled=false) was preserved.'
      : ` WorkBuddy governance and four-term keyword Pain detection are ON${governanceDefaults.changed ? ' (enabled by this install)' : ' (already enabled)'}.`;
    const effectiveNote = 'Registration takes effect in NEW WorkBuddy sessions (or /reload-plugins in a running CLI session).';
    // Round-4 S1: honest pending-config surface — legacy init rows and Owner
    // rows are kept (no silent override); the rebind path is stated, never
    // executed behind the Owner's back.
    const pendingRebindNote = profilePendingAgents.length > 0
      ? ` Pending config: agent(s) ${profilePendingAgents.join(', ')} still bind to their explicit runtime profiles; to rebind them to the install profile, set internalAgents.agents.<name>.runtimeProfile to '${GOVERNANCE_PROFILE_ID}' (or remove the per-agent runtimeProfile row so they inherit internalAgents.defaultRuntime) in ${path.join(p.governanceDir, '.pd', 'config.yaml')}.`
      : '';
    return {
      success: true,
      hostId: this.hostId,
      configPath: p.settingsPath,
      configAction: registration.settingsAction,
      governance: governanceDefaults === null
        ? undefined
        : {
            enabled: !governanceDefaults.hostExplicitOff,
            explicitOptOut: governanceDefaults.hostExplicitOff,
            keywordPainEnabled: !governanceDefaults.keywordExplicitOff,
            configPath: governanceDefaults.configPath,
          },
      reason: `Registered ${WORKBUDDY_PLUGIN_KEY} via ${registration.mode}${registration.mode === 'engine' ? '' : ` (engine unreachable: ${registration.engineNote})`}. Governance workspace initialized at ${p.governanceDir}${governance.dbInit === 'skipped' ? ` (${governance.note})` : ''}.${profileNote}${keywordDefaultsNote}`,
      nextAction: `${effectiveNote}${governance.dbInit === 'skipped' ? ` After the install, run "pd runtime init --workspace ${p.governanceDir}" to create the governance databases.` : ''} To disable keyword Pain, set features.workbuddy_live_keyword_pain.enabled=false; to disable all WorkBuddy governance, set features.host.workbuddy.enabled=false.${pendingRebindNote}`,
    };
  }

  /**
   * Initialize the OD-07 governance workspace with the FULL state the
   * hook/console/worker chain reads (review 2026-10-13 R1).
   *
   * Preferred path: the SHARED initializer — `pd-cli runtime init --confirm
   * --workspace <governanceDir>` — the exact entry the main installer runs for
   * the generic workspace. It generates .pd/config.yaml from the core default
   * config authority, .pd/state.db, and .state/trajectory.db with the
   * canonical schema (idempotent; an existing config.yaml is never
   * overwritten). Failure is a LOUD install failure — a registration without
   * working governance state is exactly the R1 defect.
   *
   * Degraded path (pd-cli entry not resolvable — standalone host-installer
   * use): the installer lays down the loader-valid default config from its own
   * authority (generateConfigYamlContent, the same content the main installer
   * writes for other hosts) so the hook CONFIG chain works, and reports the
   * database initialization as an observable skip with an explicit next
   * action — never a silent mkdir-only "success".
   */
  private initializeGovernanceWorkspace(governanceDir: string): { ok: true; dbInit: 'initialized' | 'skipped'; note?: string } | { ok: false; reason: string; nextAction: string } {
    try {
      mkdirSync(governanceDir, { recursive: true });
    } catch (error) {
      return {
        ok: false,
        reason: `workbuddy_governance_dir_failed: could not create ${governanceDir} (${error instanceof Error ? error.message : String(error)}). The plugin is registered but governance state has no home.`,
        nextAction: `Create ${governanceDir} manually (or free the parent directory) and re-run the installer.`,
      };
    }

    const configPath = path.join(governanceDir, '.pd', 'config.yaml');
    const pdCli = this.deps.pdCliEntry();
    if (pdCli !== undefined) {
      const init = this.deps.runCommand(process.execPath, [pdCli, 'runtime', 'init', '--confirm', '--workspace', governanceDir], { timeoutMs: GOVERNANCE_INIT_TIMEOUT_MS });
      if (init.status !== 0) {
        return {
          ok: false,
          reason: `workbuddy_governance_init_failed: pd runtime init exited ${init.status}: ${(init.stderr || init.stdout).trim().slice(0, 300)}`,
          nextAction: `Run "node ${pdCli} runtime init --confirm --workspace ${governanceDir}" manually to see the full error, fix it, then re-run the installer.`,
        };
      }
      // Evidence over assumption: the artifacts the hook chain requires must
      // actually exist after the initializer reported success.
      if (!existsSync(configPath) || !existsSync(path.join(governanceDir, '.state', 'trajectory.db'))) {
        return {
          ok: false,
          reason: `workbuddy_governance_init_incomplete: runtime init reported success but ${configPath} or ${path.join(governanceDir, '.state', 'trajectory.db')} is missing.`,
          nextAction: 'Re-run the installer; if it repeats, report the pd runtime init output.',
        };
      }
      return { ok: true, dbInit: 'initialized' };
    }

    // Degraded path: no pd-cli runtime entry. Lay down the loader-valid
    // default config from the installer's own authority; never overwrite an
    // existing config (preservation — the runtime init contract matches).
    if (!existsSync(configPath)) {
      try {
        mkdirSync(path.dirname(configPath), { recursive: true });
        atomicReplaceTextFile(configPath, generateConfigYamlContent());
      } catch (error) {
        return {
          ok: false,
          reason: `workbuddy_governance_config_failed: could not write ${configPath} (${error instanceof Error ? error.message : String(error)}).`,
          nextAction: `Check permissions under ${governanceDir} and re-run the installer.`,
        };
      }
    }
    return {
      ok: true,
      dbInit: 'skipped',
      note: `governance database initialization SKIPPED: pd-cli runtime entry not found — run "pd runtime init --workspace ${governanceDir}" after the install; until then pain evidence degrades with an explicit trajectory_db_not_found note.`,
    };
  }

  private registerPlugin(
    details: WorkbuddyDetectDetails,
    version: string,
  ): { ok: true; mode: 'engine' | 'direct-write' | 'already-registered'; settingsAction: 'created' | 'updated' | 'preserved'; engineNote?: string } | { ok: false; reason: string; nextAction: string } {
    const p = this.paths();

    // A registered old plugin can still be hook-only, even at the same
    // manifest version. Reuse the installer-owned registration/cache writer
    // rather than reporting a stale cache as an idempotent successful install.
    if (details.registered && !this.pluginCacheMatchesPayload(version)) {
      return this.directWriteRegistration(details, version, 'registered plugin cache differs from the current bundled payload; refreshed by installer');
    }

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
          let after = this.detectDetails();
          if (after.registered && !after.pluginEnabled) {
            // Engine-version reality (observed on 2.161.0, 2026-10-13): the
            // engine honors the payload manifest's `defaultEnabled` and
            // installs hooks-carrying plugins with enabledPlugins[key]=false.
            // The installer contract (P01 frozen facts + this installer's own
            // direct-write path) is installed ⇒ enabledPlugins[key]=true —
            // the explicit host-level act of installing. PD governance stays
            // OFF either way (OD-03: features.host.workbuddy is a separate,
            // later, user-visible enable).
            const enabled = this.enableRegisteredPlugin();
            if (!enabled.ok) {
              return { ok: false, reason: enabled.reason, nextAction: enabled.nextAction };
            }
            after = this.detectDetails();
          }
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

  private pluginCacheMatchesPayload(version: string): boolean {
    const p = this.paths();
    const registry = readHostJsonFile(p.registryPath);
    const rawEntry = registry.ok && isRecord(registry.value?.plugins)
      ? registry.value.plugins[WORKBUDDY_PLUGIN_KEY] : undefined;
    const entry = userInstalledPluginRecord(rawEntry);
    const cacheDir = workbuddyCacheVersionDir(p.cachePluginRoot, version);
    if (cacheDir === undefined) return false;
    // The host may write the same install path in a different (but equivalent)
    // textual form; comparing raw strings would re-register on every run.
    const entryInstallPath = typeof entry?.installPath === 'string' ? path.resolve(entry.installPath) : undefined;
    if (!isRecord(entry) || entry.version !== version || entryInstallPath !== path.resolve(cacheDir)) return false;
    const sourceDir = path.join(p.marketplaceRoot, WORKBUDDY_PLUGIN_NAME);
    try {
      return WORKBUDDY_PAYLOAD_FILES.every((file) => readFileSync(path.join(sourceDir, file)).equals(readFileSync(path.join(cacheDir, file))));
    } catch {
      return false;
    }
  }

  /**
   * Set enabledPlugins[OUR_KEY]=true in settings.json, preserving every other
   * key (same protected write discipline as the direct-write registration).
   * Converges the engine install path (which honors the payload manifest's
   * defaultEnabled) onto the installer's frozen installed ⇒ enabled contract.
   */
  private enableRegisteredPlugin(): { ok: true } | { ok: false; reason: string; nextAction: string } {
    const p = this.paths();
    const settings = readHostJsonFile(p.settingsPath);
    if (!settings.ok) return { ok: false, reason: settings.reason, nextAction: settings.nextAction };
    const nextSettings: Record<string, unknown> = { ...(settings.value ?? {}) };
    const enabledPlugins = isRecord(nextSettings.enabledPlugins) ? { ...nextSettings.enabledPlugins } : {};
    enabledPlugins[WORKBUDDY_PLUGIN_KEY] = true;
    nextSettings.enabledPlugins = enabledPlugins;
    const write = writeHostJsonFileProtected(p.settingsPath, JSON.stringify(nextSettings, null, 2) + '\n');
    if (!write.ok) return { ok: false, reason: write.reason, nextAction: write.nextAction };
    return { ok: true };
  }

  /**
   * Direct-write registration for engine-unreachable machines, aligned with the
   * frozen P01 formats: enabledPlugins[key]=true in settings.json (other keys
   * and other plugins preserved), installed_plugins.json v2 user registration
   * (native scope array or legacy object), and the versioned cache
   * copy under plugins/cache/<marketplace>/<plugin>/<version>/.
   */
  private directWriteRegistration(
    details: WorkbuddyDetectDetails,
    version: string,
    engineNote: string,
  ): { ok: true; mode: 'direct-write'; settingsAction: 'created' | 'updated' | 'preserved'; engineNote: string } | { ok: false; reason: string; nextAction: string } {
    const p = this.paths();
    const cacheVersionDir = workbuddyCacheVersionDir(p.cachePluginRoot, version);
    if (cacheVersionDir === undefined) {
      return { ok: false, reason: 'workbuddy_cache_path_invalid: version must resolve strictly inside the PD plugin cache root. No registration/cache write was performed.', nextAction: 'Reinstall with a valid WorkBuddy plugin payload.' };
    }
    const settings = readHostJsonFile(p.settingsPath);
    if (!settings.ok) return { ok: false, reason: settings.reason, nextAction: settings.nextAction };
    const registry = readHostJsonFile(p.registryPath);
    if (!registry.ok) return { ok: false, reason: registry.reason, nextAction: registry.nextAction };
    // Capture exact pre-install bytes so a later JSON commit failure can undo
    // *both* host settings and the cache swap, including original formatting.
    let originalSettingsBytes: string | undefined;
    let originalRegistryBytes: string | undefined;
    try {
      if (settings.existed) originalSettingsBytes = readFileSync(p.settingsPath, 'utf-8');
      if (registry.existed) originalRegistryBytes = readFileSync(p.registryPath, 'utf-8');
    } catch (error) {
      return { ok: false, reason: `workbuddy_registration_snapshot_failed: ${error instanceof Error ? error.message : String(error)}. No change was made.`, nextAction: 'Check host registry/settings permissions, then retry.' };
    }

    // settings.json merge — computed here, WRITTEN after the cache lands (see
    // below): a failed payload must leave no registration state behind.
    const nextSettings: Record<string, unknown> = { ...(settings.value ?? {}) };
    const enabledPlugins = isRecord(nextSettings.enabledPlugins) ? { ...nextSettings.enabledPlugins } : {};
    enabledPlugins[WORKBUDDY_PLUGIN_KEY] = true;
    nextSettings.enabledPlugins = enabledPlugins;
    const settingsAction = settings.existed ? 'updated' : 'created';

    // installed_plugins.json v2 merge (create with version 2 when absent)
    const nextRegistry: Record<string, unknown> = { ...(registry.value ?? {}) };
    if (typeof nextRegistry.version !== 'number') nextRegistry.version = 2;
    const plugins = isRecord(nextRegistry.plugins) ? { ...nextRegistry.plugins } : {};
    const existingEntry = plugins[WORKBUDDY_PLUGIN_KEY];
    const previousUser = userInstalledPluginRecord(existingEntry);
    const now = new Date().toISOString();
    const userEntry = {
      ...previousUser,
      scope: 'user',
      installPath: cacheVersionDir,
      version,
      installedAt: typeof previousUser?.installedAt === 'string' ? previousUser.installedAt : now,
      lastUpdated: now,
    };
    // Update only the user registration. Project/local/managed records and
    // unknown fields remain owned by the host, even under the same plugin key.
    plugins[WORKBUDDY_PLUGIN_KEY] = Array.isArray(existingEntry)
      ? previousUser !== undefined
        ? existingEntry.map((record) => record === previousUser ? userEntry : record)
        : [...existingEntry, userEntry]
      : isRecord(existingEntry) && previousUser === undefined
        ? [existingEntry, userEntry]
        : userEntry;
    nextRegistry.plugins = plugins;
    // The registry write is DEFERRED until the cache payload is proven in place:
    // pointing the host at a version whose directory was never materialized
    // would turn a failed upgrade into an unloadable plugin.

    // Versioned cache copy from our marketplace source.
    //
    // A same-version refresh REPLACES the payload the host is currently loading,
    // so the copy never targets the live directory: build it in a staging
    // sibling, prove it complete, and only then swap. A failure (ENOSPC, EPERM
    // on a locked file, a partial cpSync) must leave the previous cache intact —
    // otherwise a failed upgrade trades a working old plugin for a broken one.
    const previousCacheExisted = existsSync(cacheVersionDir);
    const cacheParent = path.resolve(path.dirname(p.cachePluginRoot));
    const stagingDir = path.join(cacheParent, `.pd-staging-${process.pid}-${Date.now()}`);
    const backupDir = path.join(cacheParent, `.pd-backup-${process.pid}-${Date.now()}`);
    const swapFailedReason = (error: unknown): string =>
      `workbuddy_cache_write_failed: ${error instanceof Error ? error.message : String(error)}`;
    let restoreFailure: string | undefined;
    try {
      if (workbuddyCacheVersionDir(p.cachePluginRoot, version) !== cacheVersionDir) throw new Error('workbuddy_cache_path_invalid');
      // Both temp paths are derived locally, but a future refactor must not be
      // able to point them outside the marketplace cache parent.
      if (path.dirname(path.resolve(stagingDir)) !== cacheParent || path.dirname(path.resolve(backupDir)) !== cacheParent) {
        throw new Error('workbuddy_cache_path_invalid');
      }
      rmSync(stagingDir, { recursive: true, force: true });
      rmSync(backupDir, { recursive: true, force: true });
      cpSync(path.join(p.marketplaceRoot, WORKBUDDY_PLUGIN_NAME), stagingDir, { recursive: true });
      const missing = missingWorkbuddyPayloadFile(stagingDir);
      if (missing !== undefined) throw new Error(`staged payload is incomplete (missing or empty ${missing})`);
      // Swap: move the live dir aside, move the verified payload in, drop the backup.
      if (existsSync(cacheVersionDir)) renameSync(cacheVersionDir, backupDir);
      try {
        mkdirSync(path.dirname(cacheVersionDir), { recursive: true });
        renameSync(stagingDir, cacheVersionDir);
      } catch (swapError) {
        // Never leave the host without a payload: put the previous one back.
        try {
          if (existsSync(backupDir)) renameSync(backupDir, cacheVersionDir);
        } catch (restoreError) {
          restoreFailure = restoreError instanceof Error ? restoreError.message : String(restoreError);
          throw new Error(`workbuddy_cache_swap_failed: ${swapError instanceof Error ? swapError.message : String(swapError)}; restoring the previous cache also failed`, { cause: restoreError });
        }
        throw swapError;
      }
      // Do not discard the old cache until *both* JSON files are committed.
      // A registry/settings write can still fail after a successful swap.
    } catch (error) {
      // The live cache is untouched (or restored); only our temp dir may remain.
      try { rmSync(stagingDir, { recursive: true, force: true }); } catch { /* reported below */ }
      const cacheState = restoreFailure === undefined
        ? 'the previous cache payload was left in place'
        : `the previous cache payload is preserved at ${backupDir} but could NOT be restored in place (${restoreFailure})`;
      return {
        ok: false,
        reason: `${swapFailedReason(error)}. No registration state was changed; ${cacheState}.`,
        nextAction: `Re-run the installer (idempotent), or run the engine command manually: node <engine> plugin install ${WORKBUDDY_PLUGIN_KEY}.`,
      };
    }

    // Cache is verified and in place. Commit the two host files, retaining
    // the old cache until they both succeed; failures restore all three.
    const rollbackCommit = (failedWrite: { reason: string; nextAction: string }) => {
      const rollbackErrors: string[] = [];
      try {
        if (previousCacheExisted) {
          if (!existsSync(backupDir)) throw new Error('previous cache backup missing');
          rmSync(cacheVersionDir, { recursive: true, force: true });
          renameSync(backupDir, cacheVersionDir);
        } else {
          rmSync(cacheVersionDir, { recursive: true, force: true });
        }
      } catch (error) {
        rollbackErrors.push(`cache: ${error instanceof Error ? error.message : String(error)} (backup: ${backupDir})`);
      }
      const restoreJson = (file: string, original: string | undefined) => {
        try {
          if (original === undefined) {
            rmSync(file, { force: true });
          } else if (readFileSync(file, 'utf-8') !== original) {
            const restored = writeHostJsonFileProtected(file, original);
            if (!restored.ok) throw new Error(restored.reason);
          }
        } catch (error) {
          rollbackErrors.push(`${file}: ${error instanceof Error ? error.message : String(error)}`);
        }
      };
      restoreJson(p.settingsPath, originalSettingsBytes);
      restoreJson(p.registryPath, originalRegistryBytes);
      return {
        ok: false as const,
        reason: `workbuddy_registration_commit_failed: ${failedWrite.reason}. ${rollbackErrors.length === 0 ? 'Previous cache and registration state restored.' : `Rollback incomplete: ${rollbackErrors.join('; ')}`}`,
        nextAction: rollbackErrors.length === 0 ? failedWrite.nextAction : 'Preserve the reported backup and repair the host registration before retrying.',
      };
    };
    const settingsWrite = writeHostJsonFileProtected(p.settingsPath, JSON.stringify(nextSettings, null, 2) + '\n');
    if (!settingsWrite.ok) return rollbackCommit(settingsWrite);
    const registryWrite = writeHostJsonFileProtected(p.registryPath, JSON.stringify(nextRegistry, null, 2) + '\n');
    if (!registryWrite.ok) return rollbackCommit(registryWrite);
    // The new installation is now committed; cleanup must not invalidate it.
    try { rmSync(backupDir, { recursive: true, force: true }); } catch { /* orphan backup is recoverable, not a failed registration */ }
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

    // Fail before ANY destructive operation when the native registry cannot be
    // read. Treating an unreadable registry as "no references" risks deleting
    // caches still owned by another scope.
    const registryPreflight = readHostJsonFile(p.registryPath);
    if (!registryPreflight.ok) {
      return {
        success: false, hostId: this.hostId, removedPaths,
        preservedPaths: [p.registryPath, p.cachePluginRoot, p.marketplaceRoot],
        reason: registryPreflight.reason, nextAction: registryPreflight.nextAction,
      };
    }
    const settingsPreflight = readHostJsonFile(p.settingsPath);
    if (!settingsPreflight.ok) {
      return {
        success: false, hostId: this.hostId, removedPaths,
        preservedPaths: [p.settingsPath, p.registryPath, p.cachePluginRoot],
        reason: settingsPreflight.reason, nextAction: settingsPreflight.nextAction,
      };
    }
    const registeredEntry = isRecord(registryPreflight.value?.plugins)
      ? registryPreflight.value.plugins[WORKBUDDY_PLUGIN_KEY] : undefined;
    const otherScopesPresent = installedPluginRecords(registeredEntry)
      .some((record) => !(record.scope === 'user' && record.projectPath === undefined));

    // The native engine's disable/uninstall commands affect the entire plugin
    // key (all scopes). They must not be used for a USER-only uninstall when
    // project/local/managed registrations coexist.
    if (otherScopesPresent) notes.push('other scopes remain: bypassed host-wide engine commands and preserved their registrations');
    // 1. Disable first only if this key has no other scope owners.
    if (details.pluginEnabled && !otherScopesPresent) {
      const disable = details.engineFound
        ? this.runEngine(['plugin', 'disable', WORKBUDDY_PLUGIN_KEY])
        : undefined;
      if (disable === undefined || disable.status !== 0) {
        notes.push('engine disable command unavailable or failed — proceeding to full uninstall/removal.');
      }
    }

    // 2. Unregister via the engine when possible.
    if (details.registered && details.engineFound && !otherScopesPresent) {
      const uninstall = this.runEngine(['plugin', 'uninstall', WORKBUDDY_PLUGIN_KEY]);
      const engineUninstalled = uninstall !== undefined && uninstall.status === 0 && PLUGIN_UNINSTALL_OK.test(uninstall.stdout + uninstall.stderr);
      if (!engineUninstalled && uninstall !== undefined) {
        notes.push(`engine uninstall did not confirm success (${(uninstall.stderr || uninstall.stdout).trim().slice(0, 200) || `exit ${uninstall.status}`}).`);
      }
    }

    // 3. Direct-write removal of the frozen-format entries when the engine did
    //    not (or could not) remove them. Only OUR key is touched, and only the
    //    USER scope: a project/local/managed record under the same key owns its
    //    own installPath and survives this uninstall.
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
      if (removal.wroteSettings) removedPaths.push(p.settingsPath);
      if (removal.wroteRegistry) removedPaths.push(p.registryPath);
      if (removal.preservedScopes.length > 0) {
        preservedPaths.push(p.registryPath);
        notes.push(`preserved ${removal.preservedScopes.join('/')} scope registration(s) under ${WORKBUDDY_PLUGIN_KEY}; only the user scope was uninstalled.`);
      }
    }

    // 4. Remove only cache versions that no surviving scope record references.
    //    Another scope may still load an older version from this same root, so
    //    the version dirs are swept individually instead of deleting the root.
    if (existsSync(p.cachePluginRoot)) {
      const references = this.referencedCacheDirs();
      if (!references.ok) {
        return {
          success: false, hostId: this.hostId, removedPaths,
          preservedPaths: [...preservedPaths, p.cachePluginRoot, p.marketplaceRoot],
          reason: references.reason, nextAction: references.nextAction,
        };
      }
      const referenced = references.directories;
      let entries: string[] = [];
      try {
        entries = readdirSync(p.cachePluginRoot);
      } catch (error) {
        failedPaths.push(p.cachePluginRoot);
        preservedPaths.push(p.cachePluginRoot);
        notes.push(`cache listing failed: ${error instanceof Error ? error.message : String(error)}`);
      }
      for (const name of entries) {
        const versionDir = workbuddyCacheVersionDir(p.cachePluginRoot, name);
        // Preserve unexpected/unknown cache children; only validated version
        // directories may be removed by a user-scope uninstall.
        if (versionDir === undefined) {
          preservedPaths.push(path.join(p.cachePluginRoot, name));
          continue;
        }
        if (referenced.has(path.resolve(versionDir))) {
          preservedPaths.push(versionDir);
          continue;
        }
        try {
          rmSync(versionDir, { recursive: true, force: true });
          removedPaths.push(versionDir);
        } catch (error) {
          failedPaths.push(versionDir);
          preservedPaths.push(versionDir);
          notes.push(`cache removal failed for ${versionDir}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      // Drop the root itself only once nothing survives inside it.
      try {
        if (existsSync(p.cachePluginRoot) && readdirSync(p.cachePluginRoot).length === 0) {
          rmSync(p.cachePluginRoot, { recursive: true, force: true });
          removedPaths.push(p.cachePluginRoot);
        }
      } catch {
        notes.push(`cache root cleanup skipped: ${p.cachePluginRoot} is not removable yet.`);
      }
    }

    // 5. Remove the PD-owned marketplace dir.
    if (otherScopesPresent) {
      preservedPaths.push(p.marketplaceRoot);
      notes.push('preserved marketplace and host manifest for remaining non-user scopes');
    } else if (existsSync(p.marketplaceRoot)) {
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
    if (!otherScopesPresent) removeWorkbuddyFromInstallManifestHosts(p.installManifestPath);
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

  /**
   * Remove the USER-scope registration only (frozen formats). Other scopes of
   * the same key are host-owned: dropping the whole key would delete a
   * project/local/managed install PD never owned.
   */
  private directWriteRemoval():
    | { ok: true; wroteSettings: boolean; wroteRegistry: boolean; preservedScopes: string[] }
    | { ok: false; reason: string; nextAction: string } {
    const p = this.paths();
    const settings = readHostJsonFile(p.settingsPath);
    if (!settings.ok) return { ok: false, reason: settings.reason, nextAction: settings.nextAction };
    const registry = readHostJsonFile(p.registryPath);
    if (!registry.ok) return { ok: false, reason: registry.reason, nextAction: registry.nextAction };

    const registered = registry.existed && isRecord(registry.value?.plugins)
      ? registry.value.plugins[WORKBUDDY_PLUGIN_KEY] : undefined;
    const allRecords = installedPluginRecords(registered);
    const remaining = allRecords.filter((record) => !(record.scope === 'user' && record.projectPath === undefined));
    const preservedScopes = [...new Set(remaining
      .map((record) => (typeof record.scope === 'string' && record.scope.length > 0 ? record.scope : 'unknown')))];
    const removedUserRecord = remaining.length !== allRecords.length;

    // enabledPlugins is a single host-level value for the key: clear it only
    // when no scope remains installed.
    let wroteSettings = false;
    if (remaining.length === 0
      && settings.existed && isRecord(settings.value?.enabledPlugins)
      && Object.hasOwn(settings.value.enabledPlugins, WORKBUDDY_PLUGIN_KEY)) {
      const nextSettings: Record<string, unknown> = { ...settings.value };
      const enabledPlugins = { ...nextSettings.enabledPlugins as Record<string, unknown> };
      delete enabledPlugins[WORKBUDDY_PLUGIN_KEY];
      nextSettings.enabledPlugins = enabledPlugins;
      const write = writeHostJsonFileProtected(p.settingsPath, JSON.stringify(nextSettings, null, 2) + '\n');
      if (!write.ok) return { ok: false, reason: write.reason, nextAction: write.nextAction };
      wroteSettings = true;
    }

    let wroteRegistry = false;
    if (removedUserRecord) {
      const nextRegistry: Record<string, unknown> = { ...registry.value };
      const plugins = { ...nextRegistry.plugins as Record<string, unknown> };
      if (remaining.length === 0) delete plugins[WORKBUDDY_PLUGIN_KEY];
      else plugins[WORKBUDDY_PLUGIN_KEY] = Array.isArray(registered) ? remaining : remaining[0];
      nextRegistry.plugins = plugins;
      const write = writeHostJsonFileProtected(p.registryPath, JSON.stringify(nextRegistry, null, 2) + '\n');
      if (!write.ok) return { ok: false, reason: write.reason, nextAction: write.nextAction };
      wroteRegistry = true;
    }
    return { ok: true, wroteSettings, wroteRegistry, preservedScopes };
  }

  /** installPaths still referenced by ANY surviving scope record of our key. */
  private referencedCacheDirs():
    | { ok: true; directories: Set<string> }
    | { ok: false; reason: string; nextAction: string } {
    const p = this.paths();
    const registry = readHostJsonFile(p.registryPath);
    if (!registry.ok) return { ok: false, reason: registry.reason, nextAction: registry.nextAction };
    const referenced = new Set<string>();
    if (isRecord(registry.value?.plugins)) {
      for (const record of installedPluginRecords(registry.value.plugins[WORKBUDDY_PLUGIN_KEY])) {
        if (typeof record.installPath === 'string' && record.installPath.length > 0) {
          referenced.add(path.resolve(record.installPath));
        }
      }
    }
    return { ok: true, directories: referenced };
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
