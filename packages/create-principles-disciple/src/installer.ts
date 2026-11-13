import { existsSync, lstatSync, mkdtempSync, readdirSync, realpathSync, statSync, readFileSync, writeFileSync, mkdirSync, rmSync, copyFileSync, cpSync, renameSync, chmodSync, symlinkSync, type Dirent, type Stats } from 'fs';
import { tmpdir } from 'os';
import { createHash, randomInt, randomUUID } from 'node:crypto';
import { pathToFileURL, fileURLToPath } from 'node:url';
import fse from 'fs-extra';
import * as path from 'path';
import * as http from 'http';
import { execFileSync, spawn, type ChildProcess } from 'child_process';
import ora, { type Ora } from 'ora';
import { select } from '@inquirer/prompts';
import { logger } from './utils/logger.js';
import { checkOpenClawGateway, stopOpenClawGateway, restartOpenClawGateway, type OpenClawGatewayStatus } from './utils/env.js';
import { t } from './i18n.js';
import type { InstallOptions } from './prompts.js';
import {
  generateConfigYamlContent,
  ExistingConfigVerifyInfraError,
  validateExistingConfigYamlForPreserve,
  getConfigYamlPath,
  readEnabledChannelsFromConfigYaml,
  getOpenClawDir,
  getPdDir,
  getPdRuntimeDir,
  getInstallManifestPath,
  getPdRuntimeBackupsDir,
  getPluginExtDir,
  getInstalledPluginDir,
  getInstalledLayoutPackageDir,
  getPdBackupsDir,
  getInstalledPdCliDir,
  getInstalledBinDir,
  getInstalledConsoleDir,
  getHomeDir,
  isWindows,
  type ComponentStatus,
  type VerificationResult,
  type RuntimeProfileInput,
} from './mvp-config.js';
import { detectInstalledHosts, evaluateRecordedHostPresence, getHostInstallers, isRecordedHost, type DetectedHost, type HostTarget } from './installers/index.js';
import { readCanonicalRuntimeCohort, readInstalledRuntimeCohort, resolvePluginDataRoot } from './installers/codex-host-installer.js';
import { runWorkbuddyEarlyPreflight } from './installers/workbuddy-host-installer.js';
import type { HostInstallContext, HostInstallResult } from '@principles/core/host';
import { INSTALL_LAYOUT_VERSION, getInstallLayoutPaths, getWorkbuddyWorkspaceDir, installManifestHostsForPersist, mergeInstallManifestWorkspaces, parseInstallManifest } from '@principles/install-layout';
import { resolveMcpServerDir } from './mcp-server-layout-compat.js';
import { detectOpenClawMainWorkspaceDivergence } from './utils/workspace-divergence.js';
import { applySkillLanguageSelection, type SkillLanguage } from './skill-language.js';
import {
  parseReleaseAssetIdentity,
  parseReleaseAssetManifest,
  ReleaseAssetManifestError,
  verifyReleaseAssetManifestAsync,
  verifyReleaseAssetTarget,
} from './update/release-asset-manifest.js';
import { parseEmbeddedProductIdentity, ProductIdentityError } from './update/product-identity.js';
import {
  digestDirectory,
  ensurePdHomeLayout,
  mergeIntoInstallJson,
  readBootstrapManifest,
  readInstallConfig,
  readInstallJsonRecord,
  resolvePdHomePaths,
} from './update/install-layout.js';
import { RELEASE_METADATA_URL_ENV, normalizeReleaseMetadataUrl } from './update/release-metadata-source.js';
import { provisionBootstrapTrustRoot, TrustRootValidationError } from './update/trust-root-provisioning.js';
import {
  appendJournalTransition,
  findRecoveryPendingTransactionIds,
  readActiveRecord,
  writeActiveRecord,
  writeRecoveryResolution,
  type ActiveRecord,
  type ReleaseMetadataDigestSource,
  type TransactionState,
} from './update/transaction-journal.js';

/** PRI-343: Keep in sync with @principles/core CONVERSATION_ACCESS_CONFIG_KEY */
export const CONVERSATION_ACCESS_CONFIG_KEY = 'allowConversationAccess' as const;

/** PRI-853: the maintained official signed-release metadata repository.
 * Served from the repo's GitHub Pages (gh-pages branch, enabled 2026-09-19). */
export const DEFAULT_RELEASE_METADATA_URL = 'https://csuzngjh.github.io/principles';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * PRI-343: Pure function — deep-merges allowConversationAccess: true into
 * the openclaw.json config without mutating the input.
 *
 * Ensures plugins.entries['principles-disciple'].hooks.allowConversationAccess
 * is set to true, creating intermediate objects if missing.
 * Preserves all other fields.
 */
export function ensureConversationAccess(config: Record<string, unknown>): Record<string, unknown> {
  const result = { ...config };

  // Guard: plugins must be a non-null object
  if (!isRecord(result.plugins)) {
    return result;
  }
  const plugins = { ...result.plugins };

  // Guard: plugins.entries must be a non-null object
  if (!isRecord(plugins.entries)) {
    return result;
  }
  const entries = { ...plugins.entries };

  // Guard: principles-disciple entry must be a non-null object (or missing)
  const rawEntry = entries['principles-disciple'];
  const entry: Record<string, unknown> = isRecord(rawEntry)
    ? { ...rawEntry }
    : { enabled: true };

  // Guard: hooks must be a non-null object (or missing)
  const rawHooks = entry.hooks;
  const hooks = isRecord(rawHooks)
    ? { ...rawHooks }
    : {};

  // Set allowConversationAccess: true (idempotent)
  hooks[CONVERSATION_ACCESS_CONFIG_KEY] = true;
  entry.hooks = hooks;
  entries['principles-disciple'] = entry;
  plugins.entries = entries;
  result.plugins = plugins;

  return result;
}

// rc-3: a malformed PD_INSTALL_TIMEOUT_MS must fall back LOUD to the default —
// a NaN timeout would make every execNpm fail instantly (same NaN-timeout
// class as the console's PD_UPDATE_APPLY_FULL_TIMEOUT_MS, review 2026-09-17).
function resolveInstallTimeoutMs(): number {
  const raw = process.env.PD_INSTALL_TIMEOUT_MS;
  if (raw === undefined || raw.trim().length === 0) return 300000;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    logger.warn(`PD_INSTALL_TIMEOUT_MS=${JSON.stringify(raw)} is not a positive number — using the 300000ms default.`);
    return 300000;
  }
  return parsed;
}
const INSTALL_TIMEOUT_MS = resolveInstallTimeoutMs();

// 超时常量
const PD_CLI_VERIFICATION_TIMEOUT_MS = 30_000;
const STORY_A_VERIFICATION_TIMEOUT_MS = 30_000;
const CONSOLE_HEALTH_CHECK_TIMEOUT_MS = 8_000;
const CONSOLE_WARMUP_TIME_MS = 6_000;
// P0-2 (SPEC v1.2 §5 step 6): bounded exit-join windows for the verification
// child — SIGTERM wait, then SIGKILL wait. Bounded so a wedged child can never
// hang the install forever; the join RESULT (not a guess) decides whether
// destructive directory operations may proceed.
const CONSOLE_CHILD_GRACEFUL_EXIT_TIMEOUT_MS = 5_000;
const CONSOLE_CHILD_KILL_EXIT_TIMEOUT_MS = 5_000;

// 端口范围常量。PD_CONSOLE_PORT_BASE 允许在操作系统保留了大段端口
// (如 Windows excludedportrange) 的机器上整体平移探测窗口；未设置时
// 保持历史默认 3100–3199。resolveConsolePortBase() 是唯一 resolved
// base：安装验证窗口、console 健康检查、autolaunch 扫描、测试全部
// 消费它——任何新窗口不得再硬编码第二个 base。
export function resolveConsolePortBase(): number {
  const raw = process.env.PD_CONSOLE_PORT_BASE;
  if (raw === undefined) return 3100;
  // Number() (not parseInt) so '3300.5' is rejected instead of silently
  // truncating to 3300.
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1024 || parsed > 65000) {
    throw new Error(`PD_CONSOLE_PORT_BASE must be an integer in [1024, 65000], got: ${JSON.stringify(raw)}`);
  }
  return parsed;
}
const CONSOLE_PORT_RANGE_MIN = resolveConsolePortBase();
const CONSOLE_PORT_RANGE_MAX = CONSOLE_PORT_RANGE_MIN + 99;

// Task 8: auto-launch console via `pd console open` after successful install.
// Derived from the SAME resolved base as the verification window above.
const CONSOLE_AUTOLAUNCH_BASE_PORT = CONSOLE_PORT_RANGE_MIN;
const CONSOLE_AUTOLAUNCH_PORT_SCAN_LIMIT = 20; // base..base+19 (matches pd console open PORT_FALLBACK_LIMIT)
const CONSOLE_AUTOLAUNCH_READY_TIMEOUT_MS = 12_000;
const CONSOLE_AUTOLAUNCH_POLL_INTERVAL_MS = 500;

// 允许的原生模块白名单
const ALLOWED_NATIVE_MODULES = ['better-sqlite3'];

// Shared components use ~/.pd/runtime. The plugin package is host-neutral for
// Codex-only installs; OpenClaw/all still receive their adapter copy under
// ~/.openclaw/extensions for host discovery.
let activeHostTarget: HostTarget = 'openclaw';
function installsOpenClaw(host: HostTarget): boolean {
  return host === 'openclaw' || host === 'all';
}

function installsWorkbuddy(host: HostTarget): boolean {
  return host === 'workbuddy' || host === 'all';
}

function pluginInstallDirs(): string[] {
  return installsOpenClaw(activeHostTarget)
    ? [getInstalledPluginDir(), getPluginExtDir()]
    : [getInstalledPluginDir()];
}

export function mergeInstallManifestHosts(current: unknown, host: HostTarget): string[] {
  const hosts = new Set<string>();
  const parsed = parseInstallManifest(current);
  if (current !== undefined && !parsed.manifest) {
    throw new Error(parsed.error ?? 'install_manifest_malformed');
  }
  // Persisted hosts must carry forward registrations this reader does not
  // know (installManifestHostsForPersist) — rebuilding from manifest.hosts
  // alone would silently unregister a newer host on every re-install.
  for (const existingHost of installManifestHostsForPersist(parsed.manifest)) hosts.add(existingHost);
  if (host === 'all' || host === 'codex') hosts.add('codex');
  if (host === 'all' || host === 'openclaw') hosts.add('openclaw');
  // WorkBuddy is its own explicit target — 'all' must not attach a third host
  // the operator never asked for (SPEC workbuddy-host-adapter §6, OD-03).
  if (host === 'workbuddy') hosts.add('workbuddy');
  return [...hosts];
}

function resolveInstallManifestHosts(host: HostTarget): string[] {
  let current: unknown;
  try {
    current = JSON.parse(readFileSync(getInstallManifestPath(), 'utf8')) as unknown;
  } catch (error) {
    if (existsSync(getInstallManifestPath())) throw error;
  }
  return mergeInstallManifestHosts(current, host);
}

/** Hosts the install manifest already records BEFORE this run attaches its own. */
function readPersistedInstallHosts(): string[] {
  try {
    const parsed = parseInstallManifest(JSON.parse(readFileSync(getInstallManifestPath(), 'utf8')) as unknown);
    return parsed.manifest ? installManifestHostsForPersist(parsed.manifest) : [];
  } catch {
    // Malformed manifests are rejected later by resolveInstallManifestHosts;
    // an unreadable record must never be treated as "this host was installed".
    return [];
  }
}

/**
 * Hosts PD already serves whose artifacts this run does NOT touch.
 *
 * The runtime directory (`~/.pd/runtime`) is shared across hosts, but each
 * host's `mcp-binding.json` pins the MCP server version it launches. An
 * install/update scoped to ONE host (`--host openclaw` is the default) replaces
 * that shared runtime and silently leaves every other installed host bound to
 * the previous MCP server version — the host then fails closed at launch with
 * `binding_version_mismatch`. Those previously installed hosts must be
 * refreshed in the same run, otherwise a routine update breaks them until the
 * operator happens to re-run the installer for each one.
 *
 * WorkBuddy stays opt-in (OD-03): 'all' never attaches it here, but a manifest
 * that ALREADY records it must be refreshed like any other served host.
 */
export function resolveHostRefreshTargets(persistedHosts: readonly string[], host: HostTarget): HostTarget[] {
  const covered = new Set<string>(host === 'all' ? ['openclaw', 'codex'] : [host]);
  const targets: HostTarget[] = [];
  for (const persisted of persistedHosts) {
    if (persisted !== 'openclaw' && persisted !== 'codex' && persisted !== 'workbuddy') continue;
    if (covered.has(persisted) || targets.includes(persisted)) continue;
    targets.push(persisted);
  }
  return targets;
}

/** Union the detected (already-installed) hosts into the manifest host list. */
function withDetectedHosts(hosts: readonly string[], detected: readonly DetectedHost[]): string[] {
  const merged = [...hosts];
  for (const host of detected) {
    if (!merged.includes(host.hostId)) merged.push(host.hostId);
  }
  return merged;
}

export interface UpgradeHostPlan {
  /** Hosts refreshed in this upgrade (requested + already-installed others). */
  readonly refreshTargets: HostTarget[];
  /** Installed hosts PD had not recorded before — the silent-skip case. */
  readonly newlyCovered: DetectedHost[];
}

/**
 * One upgrade must cover every host that already carries PD (2026-11-11).
 * Pure so the coverage rule is testable without running a whole install.
 */
export function planUpgradeHosts(
  requested: HostTarget,
  persistedHosts: readonly string[],
  detected: readonly DetectedHost[],
): UpgradeHostPlan {
  return {
    refreshTargets: resolveHostRefreshTargets(
      [...persistedHosts, ...detected.map((host) => host.hostId)],
      requested,
    ),
    newlyCovered: detected.filter((host) => !persistedHosts.includes(host.hostId)),
  };
}

/**
 * PRI-624 Slice C: the install manifest records every Workspace this install
 * serves so the Companion can discover its per-Workspace workers (SPEC §13
 * "canonical install manifest"). Idempotent by canonical path.
 *
 * WorkBuddy (SPEC workbuddy-host-adapter §6): when the run targets workbuddy,
 * the OD-07 governance workspace (~/.workbuddy/pd-workspace) is registered the
 * same way — derived from install-layout, never hand-joined, never reused from
 * another host's state.
 */
function resolveInstallManifestWorkspaces(workspaceDir: string, host?: HostTarget): string[] {
  let current: unknown;
  try {
    current = JSON.parse(readFileSync(getInstallManifestPath(), 'utf8')) as unknown;
  } catch (error) {
    if (existsSync(getInstallManifestPath())) throw error;
  }
  const parsed = parseInstallManifest(current);
  if (current !== undefined && !parsed.manifest) {
    throw new Error(parsed.error ?? 'install_manifest_malformed');
  }
  let workspaces = mergeInstallManifestWorkspaces(parsed.manifest, path.resolve(workspaceDir));
  if (host === 'workbuddy') {
    // Set-union via the same authority helper — order of existing entries is
    // preserved, the governance dir is appended when absent (idempotent).
    workspaces = mergeInstallManifestWorkspaces(
      { layoutVersion: parsed.manifest?.layoutVersion ?? INSTALL_LAYOUT_VERSION, mode: parsed.manifest?.mode ?? 'canonical', hosts: parsed.manifest?.hosts ?? [], workspaces },
      getWorkbuddyWorkspaceDir(getHomeDir()),
    );
  }
  return workspaces;
}

function writeInstallManifest(hosts: string[], workspaces: string[]): void {
  mkdirSync(getPdDir(), { recursive: true });
  // PRI-709 P0-1: merge into the existing record. This file has more than one
  // writer (the update side owns `channel` / `autoCheck` / `releaseMetadataUrl`);
  // a wholesale replace silently deleted those fields.
  const existing = readInstallJsonRecord(getInstallManifestPath());
  const payload: Record<string, unknown> = {
    ...(existing ?? {}),
    layoutVersion: 1,
    mode: 'canonical',
    hosts,
    workspaces,
  };
  writeFileSync(getInstallManifestPath(), JSON.stringify(payload, null, 2) + '\n', 'utf8');
}

/**
 * PRI-709 P0-2 — active record commit point (ADR-0024 D-2).
 *
 * `~/.pd/active.json` is the deployment identity source: it records WHAT is
 * actually deployed, keyed to the transaction that deployed it. Before PRI-709
 * the installer never wrote it (the only writer was legacy-migration.ts), so
 * every real install and every ReleaseManager apply left active.json absent or
 * stale — the PRI-698 audit finding F-2.
 *
 * Identity is taken from the transaction, never recomputed here: the journal
 * was opened with the payload's own identity (`_release/manifest.json` digest
 * when the self-contained asset ships one), and active.json must agree with
 * the journal of the transaction that produced it. A divergent second
 * computation would break the audit trail.
 *
 * Ordering: journal-first. The caller appends `confirmed` and only then calls
 * this, so a crash between the two is recoverable from the journal (the
 * reverse order would leave an unjournaled active.json).
 *
 * Failure policy — Tier 2: this runs AFTER the backup was discarded, so the
 * install is already committed and must not be failed here. A write failure is
 * reported loud (rc-9) and returned to the caller; it never bricks the
 * installation.
 */
export interface ActiveRecordCommitResult {
  readonly written: boolean;
  readonly activeRecordPath: string;
  readonly generation: number;
  readonly previousReleaseId: string | null;
  /** Set when the record could not be written or the previous one was unreadable. */
  readonly reason?: string;
}

export function commitInstallerActiveRecord(journal: InstallerJournal): ActiveRecordCommitResult {
  const paths = resolvePdHomePaths(getPdDir());

  let previous: ActiveRecord | null = null;
  let previousWarning: string | null = null;
  try {
    previous = readActiveRecord(paths.activeRecordPath);
  } catch (error) {
    // A corrupt previous record must not block committing the new identity —
    // overwriting it with a valid record is strictly an improvement.
    previousWarning = error instanceof Error ? error.message : String(error);
    logger.warn(`active.json was unreadable and is being replaced (${paths.activeRecordPath}): ${previousWarning}`);
  }

  // Generation continuity: never move backwards. A standalone install already
  // carries generation 1, but re-installing over an existing deployment must
  // advance past it — otherwise the deployment identity source would regress.
  const generation = Math.max(journal.generation, previous === null ? 1 : previous.generation + 1);

  try {
    writeActiveRecord(paths.activeRecordPath, {
      generation,
      releaseId: journal.releaseId,
      releaseMetadataDigest: journal.releaseMetadataDigest,
      previousReleaseId: previous?.releaseId ?? null,
      transactionId: journal.transactionId,
      productVersion: journal.productVersion,
      // Embedded provenance only — absent (not faked) for legacy payloads.
      ...(journal.sourceCommit !== null ? { sourceCommit: journal.sourceCommit } : {}),
    });
    return {
      written: true,
      activeRecordPath: paths.activeRecordPath,
      generation,
      previousReleaseId: previous?.releaseId ?? null,
      ...(previousWarning !== null ? { reason: `previous_record_unreadable: ${previousWarning}` } : {}),
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    logger.error(
      `active.json could not be written after a committed install (${paths.activeRecordPath}): ${reason}. `
      + `Deployment identity is out of sync with the transaction ${journal.transactionId}; re-run the installer to repair it.`,
    );
    return {
      written: false,
      activeRecordPath: paths.activeRecordPath,
      generation,
      previousReleaseId: previous?.releaseId ?? null,
      reason,
    };
  }
}

/**
 * PRI-709 P0-1 — installer supply path for the release metadata source.
 *
 * The installer is the only component that legitimately knows the metadata
 * repository at install time, so it persists `PD_RELEASE_METADATA_URL` into
 * `~/.pd/install.json` (the durable `install_config` tier). Without this the
 * variable had to be exported in every shell that wanted a governed update
 * check (PRI-698 audit F-4).
 *
 * Absent env is a no-op — an install with no metadata source stays
 * unconfigured rather than persisting a guessed URL. A malformed env value is
 * reported and skipped: it must never be written into install.json, where the
 * strict reader would then fail loud and mark the install corrupt.
 */
export function persistReleaseMetadataSource(): void {
  // PRI-853 review fix (precedence): explicit env wins → an EXISTING persisted
  // source (e.g. the Owner's custom source) is preserved → the maintained
  // official default is written only when neither exists. The trust root
  // stays a separate anchor: a changed URL never changes who is trusted.
  const envValue = process.env[RELEASE_METADATA_URL_ENV];
  const existingPath = getInstallManifestPath();
  let existing: string | undefined;
  try {
    existing = readInstallConfig(resolvePdHomePaths(getPdDir())).releaseMetadataUrl;
  } catch {
    existing = undefined;
  }
  const candidate = envValue !== undefined && envValue.trim().length > 0
    ? envValue
    : existing !== undefined
      ? existing
      : DEFAULT_RELEASE_METADATA_URL;
  const normalized = normalizeReleaseMetadataUrl(candidate);
  if (normalized === null) {
    logger.warn(
      `Release metadata source candidate is not a valid http(s) URL and was not persisted to install.json: ${JSON.stringify(candidate)}. Release metadata source stays unconfigured.`,
    );
    return;
  }
  mergeIntoInstallJson(existingPath, { releaseMetadataUrl: normalized });
}

/**
 * PRI-850 (SPEC v0.3 §6.1, ADR-0024 §6): stage, probe, and register the
 * bootstrap update executor under `~/.pd/bootstrap/`.
 *
 * The executor is the installer's own compiled package (dist + package.json) —
 * self-contained ESM, no runtime dependency resolution on the Owner machine.
 * Delivery order: stage → probe the staged bytes through the strict JSON
 * protocol → activate by rename-swap → register in bootstrap.json with a
 * digest of the deployed tree. The previous executor is kept until the new
 * registration is written, then removed.
 */
export interface BootstrapDeliveryResult {
  readonly bootstrapVersion: string;
  readonly executorDigest: string;
  readonly executorDir: string;
}

/**
 * PRI-850: the staged executor must be SELF-CONTAINED — the Owner machine
 * performs no dependency resolution (SPEC §7). This walks the installer
 * package's declared dependency closure, resolves each package root the same
 * way Node would from the installer package, and copies the real files into
 * the staged tree's node_modules (dereferencing workspace symlinks).
 */
/** Walks node_modules directories upward from fromDir, mirroring Node module resolution. */
function resolvePackageDir(name: string, fromDir: string): string {
  const segments = name.split('/');
  let dir = fromDir;
  for (;;) {
    const candidate = path.join(dir, 'node_modules', ...segments);
    if (existsSync(path.join(candidate, 'package.json'))) {
      return candidate;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(`could not locate the package root of dependency "${name}" for the bootstrap executor bundle`);
}

function copyExecutorDependencyClosure(sourcePackageDir: string, stagingDir: string): void {
  const stagedModulesDir = path.join(stagingDir, 'node_modules');
  const manifest = JSON.parse(readFileSync(path.join(sourcePackageDir, 'package.json'), 'utf8')) as { dependencies?: Record<string, string> };
  const seen = new Set<string>();
  // Each queued dependency resolves from the package that DECLARES it —
  // nested/deduped layouts mean chownr resolves from tar, not from the
  // installer package root. The directory walk mirrors Node's own
  // node_modules resolution, so no exports-map cooperation is required.
  const queue: { name: string; fromDir: string }[] = Object.keys(manifest.dependencies ?? {}).map((name) => ({ name, fromDir: sourcePackageDir }));
  while (queue.length > 0) {
    const item = queue.shift() as { name: string; fromDir: string };
    if (seen.has(item.name)) continue;
    seen.add(item.name);
    const packageRoot = resolvePackageDir(item.name, item.fromDir);
    cpSync(packageRoot, path.join(stagedModulesDir, item.name), { recursive: true, dereference: true });
    const dependencyManifest = JSON.parse(readFileSync(path.join(packageRoot, 'package.json'), 'utf8')) as { dependencies?: Record<string, string> };
    for (const dependencyName of Object.keys(dependencyManifest.dependencies ?? {})) {
      if (!seen.has(dependencyName)) queue.push({ name: dependencyName, fromDir: packageRoot });
    }
  }
}

/**
 * Resolve which installer bytes the bootstrap executor should be deployed
 * from. The deployed executor is what RUNS an update, so delivering it from
 * "whichever installer is executing" pins that old code forever: the executor
 * re-delivers itself, its same-version fast path matches, and every later
 * update keeps running retired behavior. That is how the PRI-1021 legacy
 * `~/.openclaw/plugins/installs.json` writer came back on 2026-10-28 — a
 * 1.145.1 executor deployed 2026-10-15 applied release 2.4.0 using its own
 * pre-PRI-1021 host installer while the release shipped the fixed one.
 *
 * The payload's `release-manager` component is the installer this transaction
 * deploys, so it is the authority for the NEXT executor. Fall back to the
 * executing package only when the payload carries no installer component
 * (npm-distributed legacy shape).
 */
export function resolveBootstrapExecutorSourceDir(payloadRoot: string): string {
  const shipped = path.join(payloadRoot, 'release-manager');
  try {
    const manifest = JSON.parse(readFileSync(path.join(shipped, 'package.json'), 'utf8')) as { name?: unknown };
    if (manifest.name === 'create-principles-disciple' && existsSync(path.join(shipped, 'dist', 'update', 'bootstrap-executor.js'))) {
      return shipped;
    }
  } catch {
    // Absent or unreadable component — the executing package is the only source.
  }
  return path.resolve(fileURLToPath(import.meta.url), '../..');
}

export async function deliverBootstrapExecutor(input: {
  pdHome: string;
  /** The installer package's own root (contains dist/ and package.json). */
  sourcePackageDir: string;
}): Promise<BootstrapDeliveryResult> {
  const paths = resolvePdHomePaths(input.pdHome);
  const stagingDir = path.join(paths.bootstrapDir, 'executor.staging');
  const previousDir = path.join(paths.bootstrapDir, 'executor.previous');

  // Same-version fast path (PRI-850 review fix): skipping is only safe when
  // the deployed bytes RE-VERIFY against the registration AND still match
  // what the CURRENT installer would deploy — the source dist digest is
  // recomputed and compared against the deployed dist subtree. Version match
  // alone is not enough: changed bytes under the same version must
  // re-deliver. Corrupt or mismatched state falls through to full
  // re-delivery, which is how repair actually heals a broken executor.
  try {
    const existing = readBootstrapManifest(paths);
    const packageManifest = JSON.parse(readFileSync(path.join(input.sourcePackageDir, 'package.json'), 'utf8')) as { version?: unknown };
    const currentVersion = typeof packageManifest.version === 'string' && packageManifest.version.length > 0 ? packageManifest.version : '0.0.0';
    if (existing !== null && existing.bootstrapVersion === currentVersion && existing.executorDigest !== undefined && existsSync(paths.bootstrapExecutorDir)) {
      const actualDigest = digestDirectory(paths.bootstrapExecutorDir);
      if (actualDigest === existing.executorDigest) {
        const sourceDistDigest = digestDirectory(path.join(input.sourcePackageDir, 'dist'));
        const deployedDistDigest = digestDirectory(path.join(paths.bootstrapExecutorDir, 'dist'));
        if (sourceDistDigest === deployedDistDigest) {
          logger.info(`Bootstrap update executor already at ${currentVersion} — skipping re-delivery.`);
          return { bootstrapVersion: existing.bootstrapVersion, executorDigest: existing.executorDigest, executorDir: paths.bootstrapExecutorDir };
        }
        logger.warn('Bootstrap executor dist drifted from the current installer build — re-deploying.');
      } else {
        logger.warn(`Bootstrap executor digest mismatch (${actualDigest.slice(0, 12)} ≠ ${existing.executorDigest.slice(0, 12)}) — re-deploying.`);
      }
    }
  } catch {
    // Corrupt registration falls through to full re-delivery (which rewrites it).
  }

  rmSync(stagingDir, { recursive: true, force: true });
  mkdirSync(stagingDir, { recursive: true });
  cpSync(path.join(input.sourcePackageDir, 'dist'), path.join(stagingDir, 'dist'), { recursive: true });
  copyFileSync(path.join(input.sourcePackageDir, 'package.json'), path.join(stagingDir, 'package.json'));
  copyExecutorDependencyClosure(input.sourcePackageDir, stagingDir);

  const packageManifest = JSON.parse(readFileSync(path.join(input.sourcePackageDir, 'package.json'), 'utf8')) as { version?: unknown };
  const bootstrapVersion = typeof packageManifest.version === 'string' && packageManifest.version.length > 0 ? packageManifest.version : '0.0.0';

  // Probe: import the STAGED executor module and run one `inspect` round-trip
  // through the strict JSON protocol. This proves the staged bytes parse, the
  // module graph resolves from the staged layout, and the protocol answers —
  // before anything is activated. (The executor's detached process startup
  // happens on first use; a broken entry there fails loud with spawn detail.)
  try {
    const executorModuleUrl = pathToFileURL(path.join(stagingDir, 'dist', 'update', 'bootstrap-executor.js')).href;
    const staged = await import(executorModuleUrl) as {
      runBootstrapExecutor: (options: { rawRequest: string; resultFile?: string }) => Promise<{ response: { ok: boolean } }>;
    };
    const probeDir = mkdtempSync(path.join(tmpdir(), 'pd-bootstrap-probe-'));
    try {
      const resultFile = path.join(probeDir, 'result.json');
      // Ping, not inspect: the probe verifies the STAGED PROGRAM loads and
      // answers the protocol — it must stay independent of the installation
      // state being repaired (review P1-2).
      const probe = await staged.runBootstrapExecutor({ rawRequest: `${JSON.stringify({ op: 'ping' })}\n`, resultFile });
      if (!probe.response.ok) {
        throw new Error(`probe response not ok: ${readFileSync(resultFile, 'utf8').slice(0, 200)}`, { cause: new Error('bootstrap executor answered ok:false') });
      }
      if (!existsSync(resultFile)) {
        throw new Error('probe produced no result file');
      }
    } finally {
      rmSync(probeDir, { recursive: true, force: true });
    }
  } catch (probeError) {
    rmSync(stagingDir, { recursive: true, force: true });
    const detail = probeError instanceof Error ? probeError.message : String(probeError);
    throw new Error(`bootstrap executor probe failed: ${detail}`, { cause: probeError });
  }

  const executorDigest = digestDirectory(stagingDir);

  // Activate by rename-swap; the previous executor survives until the new
  // registration is on disk (a crash between the two steps leaves
  // executor.previous recoverable by the installer).
  rmSync(previousDir, { recursive: true, force: true });
  if (existsSync(paths.bootstrapExecutorDir)) {
    renameSync(paths.bootstrapExecutorDir, previousDir);
  }
  renameSync(stagingDir, paths.bootstrapExecutorDir);
  const registration = {
    schemaVersion: 1,
    bootstrapVersion,
    executorDigest,
    installedAt: new Date().toISOString(),
  };
  writeFileSync(paths.bootstrapManifestPath, `${JSON.stringify(registration, null, 2)}\n`, 'utf8');
  rmSync(previousDir, { recursive: true, force: true });
  logger.info(`Bootstrap update executor deployed: version=${bootstrapVersion} digest=${executorDigest.slice(0, 12)}`);
  return { bootstrapVersion, executorDigest, executorDir: paths.bootstrapExecutorDir };
}

/**
 * PRI-850: the official repair path for installations whose update chain is
 * broken or pre-bootstrap (ADR-0024 §6.5). It NEVER deploys a product release
 * and NEVER touches active.json — the installed product version is not this
 * command's authority. It repairs the update capability itself: bootstrap
 * delivery + update-source registration + install-state report.
 */
export interface RepairUpdateChainResult {
  readonly success: boolean;
  readonly installedProductVersion: string | null;
  readonly bootstrap: BootstrapDeliveryResult | null;
  readonly metadataSourceRegistered: boolean;
  readonly needsFullInstall: boolean;
  readonly notes: readonly string[];
  readonly error?: string;
}

/** Reads the persisted release metadata URL, tolerating absent/corrupt state. */
function readInstallConfigSafeReleaseMetadataUrl(pdHome: string): string | undefined {
  try {
    return readInstallConfig(resolvePdHomePaths(pdHome)).releaseMetadataUrl;
  } catch {
    return undefined;
  }
}

export async function repairUpdateChain(input: { sourcePackageDir: string }): Promise<RepairUpdateChainResult> {
  const notes: string[] = [];
  const pdHome = getPdDir();
  ensurePdHomeLayout(resolvePdHomePaths(pdHome));

  // Install identity report: never guessed. A corrupt/absent active.json marks
  // a historical install that needs the full installer (migration); the
  // product version stays whatever it verifiably was.
  let installedProductVersion: string | null = null;
  let needsFullInstall = false;
  const activePath = resolvePdHomePaths(pdHome).activeRecordPath;
  try {
    const active = readActiveRecord(activePath);
    if (active === null) {
      needsFullInstall = true;
      notes.push('No active release record found — treating this as a historical install that needs the full official installer for product deployment.');
    } else {
      installedProductVersion = active.productVersion;
      notes.push(`Verified active release record: productVersion=${active.productVersion} generation=${String(active.generation)}.`);
    }
  } catch (error) {
    needsFullInstall = true;
    notes.push(`Active release record unreadable (${error instanceof Error ? error.message : String(error)}) — needs the full official installer.`);
  }

  // Bootstrap delivery: the core of the repair.
  let bootstrap: BootstrapDeliveryResult;
  try {
    bootstrap = await deliverBootstrapExecutor({ pdHome, sourcePackageDir: input.sourcePackageDir });
  } catch (error) {
    return {
      success: false,
      installedProductVersion,
      bootstrap: null,
      metadataSourceRegistered: false,
      needsFullInstall,
      notes,
      error: `bootstrap delivery failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  // Update-source registration: the official default applies when the env is
  // absent (PRI-853); an explicit env value still wins; a malformed env value
  // is reported and left unconfigured (never persisted, PRI-709).
  const envValue = process.env[RELEASE_METADATA_URL_ENV];
  const metadataUrlBefore = readInstallConfigSafeReleaseMetadataUrl(pdHome);
  persistReleaseMetadataSource();
  const metadataSourceRegistered = readInstallConfigSafeReleaseMetadataUrl(pdHome) !== undefined;
  if (metadataSourceRegistered && metadataUrlBefore === undefined) {
    notes.push(envValue === undefined
      ? 'Official update source registered into install.json (maintained default).'
      : 'Update source registered into install.json from the environment.');
  } else if (!metadataSourceRegistered) {
    notes.push(`${RELEASE_METADATA_URL_ENV} is not a valid http(s) URL — the release metadata source stays unconfigured. Re-run with a valid URL.`);
  }

  // Trust root: report-only in repair mode. First provisioning happens with a
  // real payload transaction (the repair deploys no payload).
  const trustRootPath = path.join(pdHome, 'trust', 'root.json');
  notes.push(existsSync(trustRootPath)
    ? 'Release trust root already pinned.'
    : 'No release trust root pinned — the full official installer will provision it from the payload.');

  return {
    success: true,
    installedProductVersion,
    bootstrap,
    metadataSourceRegistered,
    needsFullInstall,
    notes,
  };
}

/**
 * PRI-1204 follow-up — repair historical `hosts` pollution.
 *
 * `ReleaseManager.apply()` used to deploy every update as `host: 'openclaw'`,
 * so a WorkBuddy-only (or Codex-only) installation ended up recording hosts it
 * does not serve. This routine removes such a host ONLY when absence is proven
 * by reading that host's own evidence surface; an unreadable surface is
 * `undecidable` and the host stays. Unknown host ids are never judged.
 *
 * The installer owns `~/.pd/install.json`, so the repair lives here and writes
 * through the same `writeInstallManifest` path as a normal install. Nothing is
 * written in dry-run mode, and every apply first copies the current file into
 * the existing backups directory so the original value is recoverable verbatim.
 */
export interface InstallManifestHostRepairEntry {
  readonly host: string;
  readonly verdict: 'installed' | 'absent' | 'undecidable' | 'not-judged';
  readonly detail: string;
}

export interface InstallManifestHostRepairResult {
  readonly success: boolean;
  readonly applied: boolean;
  readonly manifestPath: string;
  readonly before: readonly string[];
  readonly after: readonly string[];
  readonly removed: readonly string[];
  readonly entries: readonly InstallManifestHostRepairEntry[];
  readonly backupPath?: string;
  readonly restoreCommand?: string;
  readonly reason?: string;
  readonly nextAction: string;
}

export function repairInstallManifestHosts(options: { apply?: boolean } = {}): InstallManifestHostRepairResult {
  const manifestPath = getInstallManifestPath();
  const refuse = (reason: string, nextAction: string): InstallManifestHostRepairResult => ({
    success: false,
    applied: false,
    manifestPath,
    before: [],
    after: [],
    removed: [],
    entries: [],
    reason,
    nextAction,
  });

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return refuse(
      `install_manifest_unreadable: ${detail}`,
      `Inspect ${manifestPath} and re-run the official installer once it is valid JSON.`,
    );
  }
  const parsed = parseInstallManifest(raw);
  if (parsed.manifest === undefined) {
    return refuse(
      parsed.error ?? 'install_manifest_malformed',
      `Inspect ${manifestPath}; the host record cannot be judged safely.`,
    );
  }

  const before = installManifestHostsForPersist(parsed.manifest);
  const entries: InstallManifestHostRepairEntry[] = before.map((host) => {
    if (!isRecordedHost(host)) {
      return { host, verdict: 'not-judged', detail: 'unknown host id — never removed by this repair' };
    }
    const presence = evaluateRecordedHostPresence(host, getHomeDir());
    return presence.status === 'undecidable'
      ? { host, verdict: 'undecidable', detail: presence.reason }
      : { host, verdict: presence.status, detail: presence.evidence };
  });
  const removed = entries.filter((entry) => entry.verdict === 'absent').map((entry) => entry.host);
  const after = before.filter((host) => !removed.includes(host));

  if (removed.length === 0) {
    return {
      success: true,
      applied: false,
      manifestPath,
      before,
      after,
      removed,
      entries,
      nextAction: 'Nothing to repair: every recorded host is installed or cannot be judged safely.',
    };
  }
  if (after.length === 0) {
    return refuse(
      'manifest_would_be_empty: every recorded host is provably absent, so no host installer would serve this installation',
      `Re-run the official installer to register a host before repairing ${manifestPath}.`,
    );
  }
  if (options.apply !== true) {
    return {
      success: true,
      applied: false,
      manifestPath,
      before,
      after,
      removed,
      entries,
      nextAction: 'Dry run — re-run with --apply to write the repair (the current file is backed up first).',
    };
  }

  const backupPath = path.join(getPdRuntimeBackupsDir(), `install-manifest.backup.${Date.now()}.json`);
  mkdirSync(getPdRuntimeBackupsDir(), { recursive: true });
  writeFileSync(backupPath, readFileSync(manifestPath));
  writeInstallManifest([...after], [...(parsed.manifest.workspaces ?? [])]);

  return {
    success: true,
    applied: true,
    manifestPath,
    before,
    after,
    removed,
    entries,
    backupPath,
    restoreCommand: `cp "${backupPath}" "${manifestPath}"`,
    nextAction: `Removed ${removed.join(', ')} from the host record. Restore the previous value with: cp "${backupPath}" "${manifestPath}"`,
  };
}

function installBundledLayoutPackage(pluginDir: string): void {
  const source = path.join(pluginDir, 'install-layout');
  const destination = getInstalledLayoutPackageDir();
  if (!existsSync(path.join(source, 'package.json')) || !existsSync(path.join(source, 'dist'))) {
    throw new Error('Bundled @principles/install-layout is incomplete. Re-run the installer with a current package.');
  }
  rmSync(destination, { recursive: true, force: true });
  cpSync(source, destination, { recursive: true });
}

/**
 * Run npm with array-form argv, no shell (PRI-569 hardening).
 *
 * On Windows `npm` is an npm.cmd shim: Node cannot spawn .cmd without a
 * shell (EINVAL/ENOENT), so win32 routes through cmd.exe with CONSTANT argv
 * elements — args are compile-time literals at every call site; the one
 * external-derived value (registry version) is regex-guarded before use.
 * Returns captured stdout (encoding utf-8).
 */
function execNpm(args: string[], cwd?: string, timeoutOverride?: number): string {
  // encoding:'utf-8' resolves the string overload of execFileSync (TS-typed);
  // callers and tests must honor that contract (string output).
  return (process.platform === 'win32'
    ? execFileSync('cmd.exe', ['/c', 'npm', ...args], {
        cwd,
        encoding: 'utf-8',
        stdio: 'pipe',
        env: process.env,
        windowsHide: true,
        timeout: timeoutOverride ?? INSTALL_TIMEOUT_MS,
      })
    : execFileSync('npm', args, {
        cwd,
        encoding: 'utf-8',
        stdio: 'pipe',
        env: process.env,
        timeout: timeoutOverride ?? INSTALL_TIMEOUT_MS,
      })
  ).trim();
}

/**
 * 执行 npm install 并提供友好的错误提示
 */
async function runNpmInstall(cwd: string, componentName = 'npm'): Promise<void> {
  try {
    execNpm(['install', '--ignore-scripts', '--legacy-peer-deps'], cwd);
  } catch (e) {
    const errorMsg = e instanceof Error ? e.message : String(e);

    // `t` is the module-level i18n translator (imported at top of file).
    // i18n.ts has no imports, so there is no circular dependency.

    const hint = errorMsg.includes('ETIMEDOUT') || errorMsg.includes('network') || errorMsg.includes('timeout')
      ? t('npm_hint_network_timeout').replace('{path}', cwd)
      : errorMsg.includes('EACCES') || errorMsg.includes('permission') || errorMsg.includes('EPERM')
      ? t('npm_hint_permission_denied')
      : errorMsg.includes('ENOSPC')
      ? t('npm_hint_disk_space')
      : t('npm_hint_manual_fix').replace('{path}', cwd);

    throw new Error(`${componentName} npm install failed: ${errorMsg}\n\n${hint}`, { cause: e });
  }
}

/**
 * 验证原生模块：better-sqlite3 随发布资产携带 prebuilt 二进制
 * (prebuilds/*.node)，node-gyp-build 在 require 时解析——无需（也没有）
 * npm rebuild 步骤。本函数的 require 探针就是唯一验证（历史上存在一个
 * 名为 rebuildNativeModules 的空壳函数，已删除以避免误导维护者）。
 */
export function verifyNativeModules(cwd: string, componentName: string): void {
  for (const nativeMod of ALLOWED_NATIVE_MODULES) {
    const nativeModPath = path.join(cwd, 'node_modules', nativeMod);
    if (!existsSync(nativeModPath)) continue;

    try {
      execFileSync(process.execPath, ['-e', `require('${nativeMod}')`], { cwd, stdio: 'pipe' });
    } catch {
      throw new Error(`${componentName} native module ${nativeMod} failed its require probe: the prebuilt binary for this Node.js ABI is missing or incompatible (no rebuild step exists by design). Install the platform release asset matching this OS, architecture, and ABI.`);
    }
  }
}

const SELF_CONTAINED_DEPENDENCY_NEXT_ACTION = 'Install a complete platform release asset for this Node.js ABI and re-run the installer.';
const SELF_CONTAINED_NATIVE_NEXT_ACTION = 'Install the platform release asset matching this operating system, architecture, and Node.js ABI.';

export class SelfContainedDependencyError extends Error {
  public readonly reason: string;
  public readonly nextAction: string;
  public readonly component: string;
  public readonly dependency?: string;

  constructor(options: {
    reason: string;
    nextAction: string;
    message: string;
    component: string;
    dependency?: string;
    cause?: unknown;
  }) {
    super(options.message, { cause: options.cause });
    this.name = 'SelfContainedDependencyError';
    this.reason = options.reason;
    this.nextAction = options.nextAction;
    this.component = options.component;
    this.dependency = options.dependency;
  }
}

function legacyNpmInstallEnabled(): boolean {
  const value = process.env.PD_ALLOW_LEGACY_NPM_INSTALL;
  return value === '1' || value === 'true';
}

/**
 * Installer payload shape, decided once per install run (see
 * `decideInstallPayloadMode` below):
 * - `self-contained` — the package ships the immutable release asset
 *   (`_release/asset.json` + per-component node_modules); the default
 *   for the release-asset publication channel.
 * - `npm-distributed` — the npm registry package ships the bundled
 *   component trees WITHOUT node_modules/_release (the registry package
 *   is ~8MB vs ~792MB for the self-contained payload); dependencies
 *   resolve from the npm registry at install time (the
 *   PD_ALLOW_LEGACY_NPM_INSTALL recovery path).
 */
type InstallerPayloadMode = 'self-contained' | 'npm-distributed';

const NPM_DISTRIBUTED_COMPONENTS = [
  ['Core', 'core'],
  ['Host runtime', 'host-runtime'],
  ['Codex adapter', 'codex-adapter'],
  ['Plugin', 'plugin'],
  ['PD CLI', 'pd-cli'],
  ['Console', 'console'],
  ['Install layout', 'install-layout'],
  ['MCP server', 'pd-mcp-server'],
] as const;

// Components whose install step demands MORE than the generic
// package.json+dist shape check — the per-component extra files are
// preflighted here so the form-gate refusal is exact (a truncated package
// must fail BEFORE any mutation, matching the per-component install
// requirements instead of discovering them mid-deployment).
const NPM_DISTRIBUTED_REQUIRED_FILES: Record<string, string[]> = {
  // console-surface.js is the registered public seam the Console update
  // routes import at runtime (package.json exports["./update-console"]) —
  // a payload without it installs cleanly and only fails when the Owner
  // opens the update page, so it is required HERE (pre-mutation).
  'release-manager': [
    'package.json',
    path.join('dist', 'update', 'release-manager-authority.js'),
    path.join('dist', 'update', 'console-surface.js'),
  ],
  console: ['package.json', path.join('dist', 'server.js'), path.join('dist', 'web', 'index.html')],
};

function releaseAssetPresent(pluginDir: string): boolean {
  return existsSync(path.join(pluginDir, '_release', 'asset.json'));
}

/**
 * Form-gate for the npm-distributed package shape: every bundled component
 * directory must carry its required files. Returns the missing items
 * (empty = complete) so the refusal can name them (rc-3: fail loud with
 * specifics, not a generic "invalid asset"). release-manager and console
 * are checked against their ACTUAL install-time requirements — they are
 * consumed unconditionally during deployment, so a package missing them
 * must be refused before the backup step, not mid-copy (review blocker,
 * PR #1525).
 */
function missingNpmDistributedComponents(pluginDir: string): string[] {
  const missing: string[] = [];
  // Components with exact install-time file demands replace the generic
  // package.json+dist check (console appears in both lists — the exact list
  // subsumes the generic one, so dedupe to avoid reporting each miss twice).
  const exactShapeComponents = new Set(Object.keys(NPM_DISTRIBUTED_REQUIRED_FILES));
  const componentDirs = [
    ...NPM_DISTRIBUTED_COMPONENTS.map(([, directory]) => directory).filter((directory) => !exactShapeComponents.has(directory)),
    ...exactShapeComponents,
  ];
  for (const componentDirectory of componentDirs) {
    const componentDir = path.join(pluginDir, componentDirectory);
    const requiredFiles = NPM_DISTRIBUTED_REQUIRED_FILES[componentDirectory]
      ?? ['package.json', componentDirectory === 'plugin' ? '' : 'dist'];
    for (const requiredFile of requiredFiles) {
      if (!existsSync(path.join(componentDir, requiredFile))) {
        missing.push(`${componentDirectory}/${requiredFile}`);
      }
    }
  }
  return missing;
}

/**
 * Decide which payload shape this package instance carries and whether
 * registry dependency resolution (npm install) is required. Env override
 * first (explicit operator intent), then the physical shape: a present
 * `_release/asset.json` always takes the self-contained path (a present
 * but CORRUPT asset still fails hard inside the preflight — never
 * silently falling back to registry resolution); a package without the
 * release asset but with complete component trees is the npm-distributed
 * shape and resolves dependencies from the registry.
 */
export function decideInstallPayloadMode(pluginDir: string): InstallerPayloadMode {
  if (legacyNpmInstallEnabled()) return 'npm-distributed';
  if (releaseAssetPresent(pluginDir)) return 'self-contained';
  return 'npm-distributed';
}

// Per-run payload mode, set by install() alongside activeHostTarget (same
// module-level idiom) — prepareComponentDependencies' call sites are the
// per-component wrappers, which have no natural parameter path from install().
let activePayloadMode: InstallerPayloadMode = 'self-contained';

/**
 * Whether registry dependency resolution (npm install / global root
 * discovery) may run: true for the npm-distributed payload shape and the
 * PD_ALLOW_LEGACY_NPM_INSTALL recovery path. Host installers consume this
 * gate instead of re-reading the env (their concern is payload shape, not
 * the specific env var).
 */
export function isNpmDependencyResolutionEnabled(): boolean {
  return activePayloadMode === 'npm-distributed';
}

/**
 * Supported release assets are self-contained: installation validates the
 * copied component and never resolves dependencies or runs lifecycle scripts.
 * The old npm path remains opt-in for development/legacy recovery only.
 */
export async function prepareBundledComponentDependencies(
  cwd: string,
  componentName: string,
): Promise<void> {
  const packageJsonPath = path.join(cwd, 'package.json');
  let packageJsonRaw: unknown;
  try {
    packageJsonRaw = JSON.parse(readFileSync(packageJsonPath, 'utf-8'));
  } catch (error) {
    throw new SelfContainedDependencyError({
      reason: 'self_contained_package_manifest_invalid',
      nextAction: SELF_CONTAINED_DEPENDENCY_NEXT_ACTION,
      message: `${componentName} package.json is missing or malformed after copy.`,
      component: componentName,
      cause: error,
    });
  }
  if (!isRecord(packageJsonRaw)) {
    throw new SelfContainedDependencyError({
      reason: 'self_contained_package_manifest_invalid',
      nextAction: SELF_CONTAINED_DEPENDENCY_NEXT_ACTION,
      message: `${componentName} package.json must contain an object.`,
      component: componentName,
    });
  }

  const { dependencies } = packageJsonRaw;
  if (dependencies !== undefined && !isRecord(dependencies)) {
    throw new SelfContainedDependencyError({
      reason: 'self_contained_package_manifest_invalid',
      nextAction: SELF_CONTAINED_DEPENDENCY_NEXT_ACTION,
      message: `${componentName} package.json dependencies must contain an object.`,
      component: componentName,
    });
  }
  for (const dependency of Object.keys(dependencies ?? {})) {
    if (!existsSync(path.join(cwd, 'node_modules', dependency))) {
      throw new SelfContainedDependencyError({
        reason: 'self_contained_runtime_dependency_missing',
        nextAction: SELF_CONTAINED_DEPENDENCY_NEXT_ACTION,
        message: `${componentName} self-contained release asset is missing declared runtime dependency ${dependency}.`,
        component: componentName,
        dependency,
      });
    }
  }

  try {
    verifyNativeModules(cwd, componentName);
  } catch (error) {
    throw new SelfContainedDependencyError({
      reason: 'self_contained_native_module_unloadable',
      nextAction: SELF_CONTAINED_NATIVE_NEXT_ACTION,
      message: `${componentName} bundled better-sqlite3 cannot be loaded by this Node.js runtime.`,
      component: componentName,
      dependency: 'better-sqlite3',
      cause: error,
    });
  }
}

const SELF_CONTAINED_COMPONENTS = [
  ['Core', 'core'],
  ['Host runtime', 'host-runtime'],
  ['Plugin', 'plugin'],
  ['PD CLI', 'pd-cli'],
  ['Console', 'console'],
  ['Install layout', 'install-layout'],
  ['MCP server', 'pd-mcp-server'],
] as const;

export async function preflightSelfContainedReleaseAsset(assetDir: string): Promise<void> {
  const identityPath = path.join(assetDir, '_release', 'asset.json');
  let identityValue: unknown;
  try {
    identityValue = JSON.parse(readFileSync(identityPath, 'utf8')) as unknown;
    const identity = parseReleaseAssetIdentity(identityValue);
    verifyReleaseAssetTarget(identity, {
      platform: process.platform,
      arch: process.arch,
      nodeAbi: process.versions.modules,
    });
  } catch (error) {
    const targetMismatch = error instanceof ReleaseAssetManifestError && error.code === 'asset_target_mismatch';
    throw new SelfContainedDependencyError({
      reason: targetMismatch ? 'self_contained_asset_target_mismatch' : 'self_contained_asset_identity_invalid',
      nextAction: targetMismatch ? SELF_CONTAINED_NATIVE_NEXT_ACTION : SELF_CONTAINED_DEPENDENCY_NEXT_ACTION,
      message: error instanceof Error ? error.message : 'Release asset identity is missing or malformed.',
      component: 'Release asset',
      cause: error,
    });
  }

  try {
    const manifestValue: unknown = JSON.parse(readFileSync(path.join(assetDir, '_release', 'manifest.json'), 'utf8')) as unknown;
    await verifyReleaseAssetManifestAsync(assetDir, parseReleaseAssetManifest(manifestValue));
  } catch (error) {
    throw new SelfContainedDependencyError({
      reason: 'self_contained_asset_integrity_invalid',
      nextAction: SELF_CONTAINED_DEPENDENCY_NEXT_ACTION,
      message: error instanceof Error ? error.message : 'Release asset manifest is missing, malformed, or does not match its files.',
      component: 'Release asset',
      cause: error,
    });
  }

  for (const [componentName, componentDirectory] of SELF_CONTAINED_COMPONENTS) {
    await prepareBundledComponentDependencies(path.join(assetDir, componentDirectory), componentName);
  }
}

async function prepareComponentDependencies(cwd: string, componentName: string): Promise<void> {
  if (activePayloadMode === 'self-contained') {
    await prepareBundledComponentDependencies(cwd, componentName);
    return;
  }

  await runNpmInstall(cwd, componentName);
  verifyNativeModules(cwd, componentName);
}

/**
 * 验证路径是否在工作区目录内，防止路径遍历攻击
 */
export function validateWorkspacePath(targetPath: string, workspaceDir: string): void {
  const resolved = path.resolve(targetPath);
  const workspace = path.resolve(workspaceDir);

  if (!resolved.startsWith(workspace + path.sep) && resolved !== workspace) {
    throw new Error(`Security error: Path "${targetPath}" is outside workspace directory "${workspaceDir}"`);
  }
}

interface InstallStep {
  name: string;
  weight: number;
}

const INSTALL_STEPS: InstallStep[] = [
  { name: 'Checking built plugin', weight: 3 },
  { name: 'Checking workspace rule compatibility', weight: 1 },
  { name: 'Backing up existing install', weight: 3 },
  { name: 'Installing bundled @principles/core', weight: 8 },
  { name: 'Validating bundled core dependencies', weight: 5 },
  { name: 'Installing bundled @principles/host-runtime', weight: 3 },
  { name: 'Validating bundled host runtime dependencies', weight: 5 },
  { name: 'Installing bundled @principles/codex-adapter', weight: 3 },
  { name: 'Installing plugin', weight: 10 },
  { name: 'Preparing core library for plugin', weight: 3 },
  { name: 'Validating bundled plugin dependencies', weight: 10 },
  { name: 'Installing pd CLI', weight: 8 },
  { name: 'Preparing core library for pd-cli', weight: 3 },
  { name: 'Verifying pd CLI', weight: 3 },
  { name: 'Installing pd-console', weight: 8 },
  { name: 'Preparing core library for console', weight: 3 },
  { name: 'Validating bundled console dependencies', weight: 5 },
  { name: 'Reconciling canonical core junction', weight: 1 },
  { name: 'Verifying pd-console', weight: 3 },
  { name: 'Copying templates', weight: 3 },
  { name: 'Generating config.yaml', weight: 2 },
  { name: 'Creating config', weight: 2 },
  { name: 'Verifying demo', weight: 5 },
  { name: 'Updating host config', weight: 3 },
];

const TOTAL_WEIGHT = INSTALL_STEPS.reduce((sum, step) => sum + step.weight, 0);

function updateProgress(spinner: Ora | null, currentStep: number, message: string): void {
  if (!spinner) return;

  if (currentStep < 0 || currentStep >= INSTALL_STEPS.length) {
    spinner.text = message;
    return;
  }

  const completedWeight = INSTALL_STEPS.slice(0, currentStep + 1).reduce((sum, s) => sum + s.weight, 0);
  const percent = Math.round((completedWeight / TOTAL_WEIGHT) * 100);

  spinner.text = `${message} (${percent}%)`;
}

interface BackupResult {
  type: 'no_existing' | 'backed_up';
  backupDir: string | null;
  runtimeBackupDir?: string | null;
}

/**
 * Move legacy PD backup directories out of the extensions dir into the PD
 * backups root. Older versions created backups as siblings of the plugin
 * inside ~/.openclaw/extensions — OpenClaw plugin discovery scans every
 * extensions/ child directory, so those backups get discovered as duplicate
 * principles-disciple plugins ("duplicate plugin id detected" on every
 * gateway startup). Best-effort: failures are logged, never fatal (rc-9).
 *
 * Exported for real-filesystem tests (tests/backup-location.test.ts).
 */
export function migrateLegacyPdBackups(): void {
  const extensionsDir = path.join(getOpenClawDir(), 'extensions');
  let entries: Dirent[];
  try {
    entries = readdirSync(extensionsDir, { withFileTypes: true });
  } catch {
    return; // no extensions dir — nothing to migrate
  }
  const isLegacyName = (name: string): boolean =>
    name.startsWith('.pd-backup-') || /^principles-disciple\.backup\.\d+$/.test(name);
  const backupsDir = getPdBackupsDir();
  let moved = 0;
  for (const entry of entries) {
    if (!entry.isDirectory() || !isLegacyName(entry.name)) continue;
    let dest = path.join(backupsDir, entry.name);
    let suffix = 1;
    while (existsSync(dest)) {
      dest = path.join(backupsDir, `${entry.name}-${suffix}`);
      suffix += 1;
    }
    try {
      mkdirSync(backupsDir, { recursive: true });
      renameSync(path.join(extensionsDir, entry.name), dest);
      moved += 1;
    } catch (e) {
      logger.warn(`Could not migrate legacy PD backup ${entry.name} out of extensions/: ${e instanceof Error ? e.message : String(e)}. Move it out manually to silence the OpenClaw "duplicate plugin id" warning.`);
    }
  }
  if (moved > 0) {
    logger.info(`Migrated ${moved} legacy PD backup dir(s) out of the extensions dir to ${backupsDir}`);
  }
}

/**
 * P0-3 (SPEC v1.2 §17 / PRI-1070 comment §2): backup step failed midway and
 * the compensation (undo of the already-moved extension tree) ALSO failed —
 * the installer is holding the moved backup paths so the failure handler can
 * still restore them. Never silently dropped.
 */
export class BackupIntegrityError extends Error {
  readonly extensionBackupDir: string | null;
  readonly runtimeBackupDir: string | null;

  constructor(message: string, extensionBackupDir: string | null, runtimeBackupDir: string | null) {
    super(message);
    this.name = 'BackupIntegrityError';
    this.extensionBackupDir = extensionBackupDir;
    this.runtimeBackupDir = runtimeBackupDir;
  }
}

/**
 * Exported for real-filesystem tests (tests/backup-location.test.ts).
 */
export function backupExistingInstall(host: HostTarget = 'openclaw'): BackupResult {
  const extDir = getPluginExtDir();
  const runtimeDir = getPdRuntimeDir();
  const hasExt = installsOpenClaw(host) && existsSync(extDir);
  const hasRuntime = existsSync(runtimeDir);
  if (!hasExt && !hasRuntime) return { type: 'no_existing', backupDir: null };

  // The backup must live OUTSIDE the extensions dir (see getPdBackupsDir):
  // OpenClaw plugin discovery scans every extensions/ child directory and
  // would discover the backup as a second principles-disciple plugin.
  const backupsDir = hasExt ? getPdBackupsDir() : getPdRuntimeBackupsDir();
  const timestamp = Date.now();
  const backupDir = hasExt ? path.join(backupsDir, `principles-disciple.backup.${timestamp}`) : null;
  const runtimeBackupDir = hasRuntime ? path.join(getPdRuntimeBackupsDir(), `runtime.backup.${timestamp}`) : null;
  let extMoved = false;
  try {
    mkdirSync(backupsDir, { recursive: true });
    if (backupDir) {
      renameSync(extDir, backupDir);
      extMoved = true;
    }
    if (runtimeBackupDir) {
      mkdirSync(getPdRuntimeBackupsDir(), { recursive: true });
      renameSync(runtimeDir, runtimeBackupDir);
    }
    logger.info(`Backed up existing install to ${backupDir ?? runtimeBackupDir}`);
    return { type: 'backed_up', backupDir, runtimeBackupDir };
  } catch (e) {
    // P0-3 (PRI-1070 comment §2): a PARTIAL backup (extension moved, runtime
    // move failed) used to escape with no path information — the caller then
    // ran restoreBackup(null, null), a no-op that silently stranded the moved
    // extension tree. Compensate first: put the moved tree back. Only when
    // even the compensation fails does the BackupIntegrityError carry the
    // moved paths out for the failure handler.
    if (extMoved && backupDir && existsSync(backupDir) && !existsSync(extDir)) {
      try {
        renameSync(backupDir, extDir);
      } catch (undoError) {
        throw new BackupIntegrityError(
          `Could not backup existing install at ${extDir}: ${e instanceof Error ? e.message : String(e)}; compensation ALSO failed: ${undoError instanceof Error ? undoError.message : String(undoError)}. The moved extension backup is preserved at ${backupDir} — re-running the installer will restore it.`,
          backupDir,
          null,
        );
      }
    }
    throw new Error(`Could not backup existing install at ${extDir}: ${e instanceof Error ? e.message : String(e)}. Aborting to prevent data loss — resolve the lock or rename manually and re-run.`, { cause: e });
  }
}

/** P0-3 (SPEC v1.2 §17): per-tree restore outcome — never one fuzzy boolean. */
export interface TreeRestoreResult {
  readonly tree: 'extension' | 'runtime';
  readonly status: 'restored' | 'no_backup' | 'failed';
  readonly detail?: string;
  /** Directories that MUST be preserved for a later manual/automatic retry. */
  readonly preservedDirs: readonly string[];
}

export interface RestoreBackupResult {
  readonly restored: boolean;
  readonly partial: boolean;
  readonly extension?: TreeRestoreResult;
  readonly runtime?: TreeRestoreResult;
  readonly error?: string;
}

/**
 * Restore ONE tree rename-aside (P0-3, PRI-1070; SPEC v1.2 §17):
 *
 *   1. live target exists → rename it aside to `<target>.restore-quarantine.<ts>`
 *      (same-volume rename; NEVER a recursive delete — the R8 experiment
 *      proved a live process's mapped .node makes rmSync die with EPERM
 *      halfway through, while a directory rename succeeds).
 *   2. rename the backup onto the target.
 *   3. success → best-effort delete of the quarantine (residue is reported,
 *      never fatal).
 *   step 2 failure → try to rename the quarantine back (undo the aside);
 *   if even that fails, BOTH the backup and the quarantine are reported in
 *   `preservedDirs` and nothing was destroyed (I-2).
 *
 * Idempotent: once the backup has landed, a re-run sees `no_backup` and the
 * already-restored tree stays in place.
 */
function restoreTreeAside(tree: 'extension' | 'runtime', backupDir: string | null, targetDir: string): TreeRestoreResult {
  if (!backupDir || !existsSync(backupDir)) {
    return { tree, status: 'no_backup', preservedDirs: [] };
  }
  let quarantine: string | null = null;
  try {
    if (existsSync(targetDir)) {
      try {
        quarantine = `${targetDir}.restore-quarantine.${Date.now()}`;
        renameSync(targetDir, quarantine);
      } catch (asideError) {
        // TOCTOU guard: if the aside rename reports ENOENT the target is in
        // fact already gone (e.g. handled concurrently) — there is nothing to
        // set aside, and the restore itself below remains correct.
        if ((asideError as { code?: string }).code !== 'ENOENT') throw asideError;
        quarantine = null;
      }
    }
    renameSync(backupDir, targetDir);
    let residue = '';
    if (quarantine !== null) {
      try {
        rmSync(quarantine, { recursive: true, force: true });
      } catch (e) {
        residue = `; quarantine residue left at ${quarantine} (${e instanceof Error ? e.message : String(e)})`;
      }
    }
    return { tree, status: 'restored', detail: residue.length > 0 ? `restored${residue}` : undefined, preservedDirs: [] };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    let undo = false;
    if (quarantine !== null && existsSync(quarantine) && !existsSync(targetDir)) {
      try {
        renameSync(quarantine, targetDir);
        undo = true;
      } catch {
        undo = false;
      }
    }
    const preserved: string[] = [backupDir];
    if (quarantine !== null && !undo) preserved.push(quarantine);
    return {
      tree,
      status: 'failed',
      detail: `restore failed: ${msg}; aside-undo=${undo ? 'ok (live tree back in place)' : 'failed'}`,
      preservedDirs: preserved,
    };
  }
}

/**
 * P0-3/P0-4: restore both trees with per-tree outcomes. `restored: true` only
 * when every tree is genuinely back (or had no backup to apply). A partial
 * restore is reported as such — never as success, never as rolled_back.
 */
export function restoreBackup(backupDir: string | null, runtimeBackupDir: string | null): RestoreBackupResult {
  const extDir = getPluginExtDir();
  const runtimeDir = getPdRuntimeDir();
  const extension = backupDir !== null || runtimeBackupDir !== null
    ? restoreTreeAside('extension', backupDir, extDir)
    : { tree: 'extension' as const, status: 'no_backup' as const, preservedDirs: [] };
  const runtime = backupDir !== null || runtimeBackupDir !== null
    ? restoreTreeAside('runtime', runtimeBackupDir, runtimeDir)
    : { tree: 'runtime' as const, status: 'no_backup' as const, preservedDirs: [] };
  const restored = extension.status !== 'failed' && runtime.status !== 'failed';
  const partial = !restored;
  if (restored && (extension.status === 'restored' || runtime.status === 'restored')) {
    logger.info('Restored previous install from backup');
  } else if (partial) {
    logger.error(`Partial restore: extension=${extension.status} runtime=${runtime.status}`);
  }
  return {
    restored,
    partial,
    extension,
    runtime,
    ...(partial ? { error: `extension=${extension.status}${extension.detail ? ` (${extension.detail})` : ''}; runtime=${runtime.status}${runtime.detail ? ` (${runtime.detail})` : ''}; preserved=${[...extension.preservedDirs, ...runtime.preservedDirs].join(', ') || 'none'}` } : {}),
  };
}

/**
 * CP-6: remove the runtime trees a failed FRESH install deployed. Only called
 * when there is no pre-existing install (no backup) and a deployment step
 * already ran — every file under these roots was created by this run, so
 * removal cannot destroy anyone else's work. Best-effort: failures are
 * returned and surfaced in the operator message (rc-9), never thrown.
 */
function cleanUnactivatedFreshInstall(): { removed: string[]; failed: { dir: string; error: string }[] } {
  const targets: string[] = [getPdRuntimeDir()];
  if (installsOpenClaw(activeHostTarget)) targets.push(getPluginExtDir());
  const removed: string[] = [];
  const failed: { dir: string; error: string }[] = [];
  for (const dir of targets) {
    if (!existsSync(dir)) continue;
    try {
      rmSync(dir, { recursive: true, force: true });
      removed.push(dir);
    } catch (e) {
      failed.push({ dir, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return { removed, failed };
}

/**
 * PRI-853 (SPEC §5 retention: "current + one previous"): after a committed
 * install the just-superseded backup set BECOMES the retained previous
 * release — it is kept on disk, and only OLDER retained sets are pruned so
 * the retention policy never grows without bound. Best-effort pruning; a
 * failed prune is non-fatal residue, never a loss of the retained previous.
 */
function retainSupersededBackup(extensionBackupDir: string | null, runtimeBackupDir: string | null): void {
  const retainedSets: { root: string | null; prefix: string }[] = [
    { root: extensionBackupDir ? path.dirname(extensionBackupDir) : null, prefix: 'principles-disciple.backup.' },
    { root: runtimeBackupDir ? path.dirname(runtimeBackupDir) : null, prefix: 'runtime.backup.' },
  ];
  for (const set of retainedSets) {
    if (set.root === null || !existsSync(set.root)) continue;
    let entries: Dirent[];
    try {
      entries = readdirSync(set.root, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && entry.name.startsWith(set.prefix))
        .sort((a, b) => b.name.localeCompare(a.name));
    } catch {
      continue;
    }
    // entries[0] is the newest = the just-superseded previous release. Keep it.
    for (const stale of entries.slice(1)) {
      try {
        rmSync(path.join(set.root, stale.name), { recursive: true, force: true });
      } catch {
        // non-fatal residue; reported by the next doctor/audit pass
      }
    }
  }
}

/**
 * PRI-697 review P1: undo the global `pd` shim side effect when the
 * install transaction fails. Exactly the files THIS run created are
 * removed; PD-owned shims that already existed before the run (a
 * pre-existing install's global command) are left in place — rolling back
 * to the pre-run state, not to "no PD anywhere". Best-effort with every
 * residue named (rc-9); never throws.
 */
function rollbackGlobalPdShim(record: GlobalPdShimResult): { removed: string[]; failed: string[] } {
  const removed: string[] = [];
  const failed: string[] = [];
  for (const shimPath of record.createdPaths) {
    if (!existsSync(shimPath)) continue;
    try {
      rmSync(shimPath, { force: true });
      removed.push(shimPath);
    } catch (e) {
      failed.push(`${shimPath} (${e instanceof Error ? e.message : String(e)})`);
    }
  }
  if (failed.length > 0) {
    logger.warn(`Failed to remove global pd shim files created by this run: ${failed.join(', ')} — remove them manually.`);
  }
  return { removed, failed };
}

// --- OpenClaw gateway lock handling (EPERM prevention) ---------------------
// The gateway holds file handles on native .node modules inside the plugin ext
// dir. Renaming that dir for backup fails with EPERM on Windows while the
// gateway is running. These helpers decide + execute stop/start so install()
// never falls through into a known-likely EPERM.

type GatewayAction = 'stop' | 'proceed' | 'abort';

/**
 * Decide how to handle a running gateway.
 * - --stop-gateway flag → 'stop' (auto-stop, no prompt, even in interactive).
 * - non-interactive (quiet/--json/--yes) without the flag → 'abort' (refuse
 *   cleanly; rc-9: do NOT silently proceed into a known failure).
 * - interactive without the flag → warn + 3-way prompt (stop / proceed / abort).
 */
async function resolveGatewayAction(
  status: OpenClawGatewayStatus,
  opts: { stopGateway: boolean; interactive: boolean },
): Promise<GatewayAction> {
  if (opts.stopGateway) return 'stop';
  if (!opts.interactive) return 'abort';
  const portInfo = status.port ? ` (port ${status.port})` : '';
  const pidInfo = status.pid ? `, PID ${status.pid}` : '';
  logger.warn(`${t('gateway_running')}${portInfo}${pidInfo}.`);
  logger.warn(t('gateway_lock_warning'));
  const choice = await select<GatewayAction>({
    message: t('gateway_prompt_title'),
    choices: [
      { value: 'stop', name: t('gateway_choice_stop') },
      { value: 'proceed', name: t('gateway_choice_proceed') },
      { value: 'abort', name: t('gateway_choice_abort') },
    ],
  });
  return choice;
}

/**
 * Structured failure result for a gateway pre-flight refusal — either the run
 * aborted (gateway running, not stopped) or --stop-gateway was requested but
 * `openclaw gateway stop` failed. All components stay 'skipped': both refusal
 * paths return before any mutation (cli-5).
 */
function buildGatewayRefusalResult(
  options: InstallOptions,
  detail: { reason: string; nextAction: string; error?: string },
): InstallResult {
  return {
    success: false,
    workspaceDir: options.workspaceDir,
    configYamlPath: getConfigYamlPath(options.workspaceDir),
    templatesCount: 0,
    components: { plugin: 'skipped', cli: 'skipped', console: 'skipped' },
    verification: { features: 'skipped', storyA: 'skipped' },
    enabledChannels: options.channels,
    nextAction: detail.nextAction,
    reason: detail.reason,
    ...(detail.error !== undefined ? { error: detail.error } : {}),
  };
}

/**
 * Legacy rule contract preflight (2026-08-19).
 *
 * Before replacing the current installation, run the NEW pd-cli's
 * `runtime compatibility-scan` against the target workspace: if any ACTIVE
 * owner-approved RuleCode still references a RuleHost contract symbol this
 * version removed (recentThinking, planStatus, hasPlanFile, ...), upgrading
 * would silently change that rule's behavior. Refusing here keeps the old
 * installation untouched (cli-5) and tells the owner exactly which rules
 * block the upgrade.
 */
/**
 * Compatibility preflight status taxonomy (P1-3, 2026-08-20; `incomplete` 5B).
 *
 * The scanner's status is preserved end-to-end so a refusal names the real
 * cause instead of smearing every failure into "legacy RuleCode":
 *
 *   clean             → allow upgrade
 *   no_state_db       → allow (nothing persisted to be incompatible)
 *   incomplete        → allow + warn (nothing found, but some ACTIVE rows
 *                       could not be read — see summarizeCompatibilityVisibility)
 *   legacy_dependency → refuse → migrate/deactivate the listed rules
 *   scan_failed       → refuse → repair DB / permissions
 *   scan_unavailable  → refuse → repair/re-download the installer
 *
 * Any unrecognized status is treated as a refusal (fail closed).
 */
export type CompatibilityStatus =
  | 'clean'
  | 'incomplete'
  | 'no_state_db'
  | 'legacy_dependency'
  | 'scan_failed'
  | 'scan_unavailable';

/** One validated `skipped` bucket from the scanner payload (rc-1/rc-4). */
export interface CompatibilitySkippedBucket {
  reason: string;
  /** Always > 0 — the scanner only emits buckets it counted. */
  count: number;
  sampleActivationIds: string[];
}

export interface LegacyRulePreflightOutcome {
  ok: boolean;
  status?: CompatibilityStatus;
  /** rc-9: structured reason + remediation whenever ok=false. */
  reason?: string;
  remediation?: string;
  /**
   * 5B: ACTIVE rows the scanner could NOT read, straight from the payload.
   * Present on successful scans; empty = every ACTIVE row was scanned.
   * This is visibility, not a refusal signal (see the install preflight).
   */
  skipped?: CompatibilitySkippedBucket[];
  /**
   * 5B: how many ACTIVE rows the scanner actually inspected. `0` with a
   * non-empty `skipped` means this upgrade verified NO rule at all.
   */
  scannedActivations?: number;
}

/** Injected runner so tests can exercise refusal without a built pd-cli. */
export type LegacyRulePreflightRunner = (
  pdCliEntry: string,
  workspaceDir: string,
) => Promise<LegacyRulePreflightOutcome>;

/** Refusal statuses a scanner payload may legitimately carry (ok=false). */
type PreflightRefusalStatus = Extract<CompatibilityStatus, 'legacy_dependency' | 'scan_failed' | 'scan_unavailable'>;

/** Map a scanner refusal status into the preflight refusal contract (P1-3). */
function refuseForStatus(
  status: PreflightRefusalStatus,
  parsedReason: string | undefined,
  remediation: string | undefined,
): LegacyRulePreflightOutcome {
  switch (status) {
    case 'legacy_dependency':
      return {
        ok: false,
        status: 'legacy_dependency',
        reason: parsedReason ?? `legacy_rule_contract_dependency: ${status}`,
        ...(remediation !== undefined ? { remediation } : {}),
      };
    case 'scan_failed':
      return {
        ok: false,
        status: 'scan_failed',
        reason: parsedReason ?? 'compatibility_scan_failed: workspace state could not be scanned',
        ...(remediation !== undefined
          ? { remediation }
          : { remediation: 'Repair the workspace database or its permissions, then retry the upgrade. The current installation has not been replaced.' }),
      };
    case 'scan_unavailable':
      return {
        ok: false,
        status: 'scan_unavailable',
        reason: parsedReason ?? 'compatibility_scan_unavailable',
        ...(remediation !== undefined
          ? { remediation }
          : { remediation: 'Re-download/rebuild the installer before upgrading. The current installation has not been replaced.' }),
      };
  }
}

/** Fail closed with the strict protocol-violation reason (P2, 2026-08-20). */
function protocolInvalid(detail: string): LegacyRulePreflightOutcome {
  return {
    ok: false,
    status: 'scan_failed',
    reason: `compatibility_scan_protocol_invalid: ${detail}`,
    remediation: 'The compatibility scanner returned an unexpected result. Re-download/rebuild the installer before upgrading. The current installation has not been replaced.',
  };
}

const MAX_SKIP_BUCKETS = 50;
/** Sentinel so "absent scannedActivations" stays distinguishable from 0. */
const INVALID_COUNT = Symbol('invalid-count');
type ParsedCount = number | undefined | typeof INVALID_COUNT;

/** rc-4: validate every bucket field, not just "is an array". */
function parseSkippedBuckets(value: unknown): CompatibilitySkippedBucket[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_SKIP_BUCKETS) return null;
  const buckets: CompatibilitySkippedBucket[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) return null;
    const {reason} = entry;
    const {count} = entry;
    const samples = entry.sampleActivationIds;
    if (typeof reason !== 'string' || reason.length === 0) return null;
    if (typeof count !== 'number' || !Number.isInteger(count) || count <= 0) return null;
    if (!Array.isArray(samples) || !samples.every((id) => typeof id === 'string')) return null;
    buckets.push({ reason, count, sampleActivationIds: [...samples] });
  }
  return buckets;
}

function parseScannedActivations(value: unknown): ParsedCount {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) return INVALID_COUNT;
  return value;
}

/**
 * Strict (ok, status) protocol parse (P2, 2026-08-20).
 *
 * Boolean `ok` alone is NOT authoritative — the (ok, status) pair is the
 * contract. Only ok=true + (clean|no_state_db|incomplete) is a successful
 * scan. Every other combination fails closed:
 *   - ok=true + refusal status                    → protocol invalid
 *   - ok=true + clean/no_state_db + skipped rows  → protocol invalid (a
 *     consumer may never quietly downgrade `incomplete` to `clean`)
 *   - ok=true + incomplete + empty skipped        → protocol invalid
 *   - ok=false + clean|no_state_db|incomplete/unknown → protocol invalid
 *   - ok=false + legacy_dependency|scan_failed|scan_unavailable → refusal
 *   - non-boolean / missing ok                    → protocol invalid
 * The payload is never trusted to self-describe a pass.
 */
export function parseCompatibilityScanStdout(stdout: unknown): LegacyRulePreflightOutcome {
  if (typeof stdout !== 'string' || stdout.trim().length === 0) {
    return { ok: false, status: 'scan_failed', reason: 'compatibility_scan_unreadable: empty stdout' };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return { ok: false, status: 'scan_failed', reason: 'compatibility_scan_unreadable: stdout is not JSON' };
  }
  if (!isRecord(parsed)) {
    return { ok: false, status: 'scan_failed', reason: 'compatibility_scan_unreadable: stdout is not an object' };
  }
  const status = typeof parsed.status === 'string' ? parsed.status : 'unknown';
  const reason = typeof parsed.reason === 'string' ? parsed.reason : undefined;
  const remediation = typeof parsed.remediation === 'string' ? parsed.remediation : undefined;

  const skipped = parseSkippedBuckets(parsed.skipped);
  if (skipped === null) {
    return protocolInvalid('skipped is not a valid [{reason,count,sampleActivationIds}] array');
  }
  const scannedActivations = parseScannedActivations(parsed.scannedActivations);
  if (scannedActivations === INVALID_COUNT) {
    return protocolInvalid('scannedActivations is not a non-negative integer');
  }
  const skippedTotal = skipped.reduce((sum, bucket) => sum + bucket.count, 0);
  const visibility = {
    skipped,
    ...(scannedActivations !== undefined ? { scannedActivations } : {}),
  };

  if (parsed.ok === true) {
    if (status === 'clean' || status === 'no_state_db') {
      // Hard constraint (5B): `incomplete` must never be degraded to `clean`
      // by a consumer. A payload that admits it skipped rows while claiming
      // clean is self-contradictory, not a pass.
      if (skipped.length > 0) {
        return protocolInvalid(`ok=true with status=${status} but skipped=${skippedTotal}`);
      }
      return { ok: true, status, ...visibility };
    }
    if (status === 'incomplete') {
      if (skipped.length === 0) {
        return protocolInvalid('ok=true with status=incomplete but skipped is empty');
      }
      return { ok: true, status, ...visibility };
    }
    return protocolInvalid(`ok=true with status=${status}`);
  }

  if (parsed.ok === false) {
    if (status === 'legacy_dependency' || status === 'scan_failed' || status === 'scan_unavailable') {
      return refuseForStatus(status, reason, remediation);
    }
    return protocolInvalid(`ok=false with status=${status}`);
  }

  return protocolInvalid(`ok is not a boolean`);
}

export interface CompatibilityVisibility {
  /**
   * none     → every ACTIVE row was scanned;
   * warning  → some rows unreadable, at least one rule was still verified;
   * critical → NO ACTIVE row was verified this run.
   */
  level: 'none' | 'warning' | 'critical';
  lines: string[];
}

/**
 * 5B: turn the scan's `skipped` buckets into operator-facing lines.
 *
 * INTENTIONAL CHOICE — these are warnings, never a refusal. A non-interactive
 * install that hard-failed here would strand the user: the old installation is
 * untouched, but the upgrade is blocked with no in-product repair path (they
 * would have to hand-edit the workspace DB before the installer would run).
 * Escalate to a hard failure only if a real incident is attributed to an
 * upgrade that ran with unverified ACTIVE rules; the escalation condition is
 * then `level === 'critical'` (zero rules verified) and belongs here.
 */
export function summarizeCompatibilityVisibility(
  outcome: Pick<LegacyRulePreflightOutcome, 'skipped' | 'scannedActivations'>,
  workspaceDir: string,
): CompatibilityVisibility {
  const skipped = outcome.skipped ?? [];
  if (skipped.length === 0) return { level: 'none', lines: [] };

  const total = skipped.reduce((sum, bucket) => sum + bucket.count, 0);
  const rows = skipped.map((bucket) => {
    const sample = bucket.sampleActivationIds.length > 0 ? ` (sample: ${bucket.sampleActivationIds.join(', ')})` : '';
    return `${bucket.reason}=${bucket.count}${sample}`;
  });
  const nextCommand = `pd runtime compatibility-scan --workspace "${workspaceDir}" --json`;

  if (outcome.scannedActivations === 0) {
    const border = '!'.repeat(74);
    return {
      level: 'critical',
      lines: [
        border,
        '!! WARNING: THIS UPGRADE DID NOT VERIFY ANY RULE COMPATIBILITY',
        `!! ${total} ACTIVE rule(s) could not be read and 0 ACTIVE rule(s) were scanned,`,
        '!! so no ACTIVE rule was checked for retired-contract dependencies.',
        `!! ${rows.join(' | ')}`,
        '!! The upgrade proceeds; verify now:',
        `!!   ${nextCommand}`,
        border,
      ],
    };
  }

  return {
    level: 'warning',
    lines: [
      `warning: ${total} ACTIVE rule(s) could not be read during the compatibility check — their compatibility is NOT verified.`,
      ...rows.map((row) => `  ${row}`),
      `next: ${nextCommand}`,
    ],
  };
}

/**
 * PRI-693 / PRI-1060: materialize node_modules links for the BUNDLED (not yet
 * deployed) components so the pre-deployment compatibility scan can execute
 * the bundled pd-cli. Mirrors the links syncPdCli creates for the deployed
 * copy — targets are the sibling component directories of the npm package
 * (files whitelist: core/, host-runtime/, codex-adapter/, workbuddy-adapter/,
 * install-layout/, plugin/). Idempotent.
 *
 * Links are materialized at BOTH levels:
 *
 * 1. <root>/pd-cli/node_modules/* — pd-cli's OWN first-hop imports.
 * 2. <root>/node_modules/* — every OTHER bundled component's `file:../`
 *    sibling dependencies. Node resolves a component reached through a
 *    junction by its REAL path, so host-runtime/dist/index.js importing
 *    '@principles/core' never sees pd-cli's node_modules — it only resolves
 *    via the package root's node_modules (PRI-1060: this exact gap crashed
 *    the scan with ERR_MODULE_NOT_FOUND on every registry install). The
 *    third-party dependencies of the bundled graph (@sinclair/typebox,
 *    better-sqlite3, …) are declared as top-level installer dependencies so
 *    the surrounding npx/npm install places them one node_modules above the
 *    package, reachable by the same upward resolution.
 */
export function ensureBundledPdCliResolution(pdCliRoot: string): void {
  const packageRoot = path.resolve(pdCliRoot, '..');
  const componentLinks: { linkName: string; componentDir: string }[] = [
    { linkName: path.join('@principles', 'core'), componentDir: 'core' },
    { linkName: path.join('@principles', 'host-runtime'), componentDir: 'host-runtime' },
    { linkName: path.join('@principles', 'codex-adapter'), componentDir: 'codex-adapter' },
    { linkName: path.join('@principles', 'workbuddy-adapter'), componentDir: 'workbuddy-adapter' },
    { linkName: path.join('@principles', 'install-layout'), componentDir: 'install-layout' },
    { linkName: 'principles-disciple', componentDir: 'plugin' },
  ];
  // Unix relative targets are computed from EACH link's own directory — a
  // wrong level produces a DANGLING link (existsSync() false, second run hits
  // EEXIST). Windows junctions take absolute targets and ignore the depth.
  const linkBases: { nodeModulesDir: string; depth: number }[] = [
    // <root>/pd-cli/node_modules/@principles/<name> → three levels up to
    // <root>; <root>/pd-cli/node_modules/principles-disciple → two levels.
    { nodeModulesDir: path.join(pdCliRoot, 'node_modules'), depth: 3 },
    // <root>/node_modules/@principles/<name> → two levels up; principles-
    // disciple → one level.
    { nodeModulesDir: path.join(packageRoot, 'node_modules'), depth: 2 },
  ];
  for (const base of linkBases) {
    for (const spec of componentLinks) {
      const linkPath = path.join(base.nodeModulesDir, spec.linkName);
      if (existsSync(linkPath)) continue;
      const windowsTarget = path.join(packageRoot, spec.componentDir);
      if (!existsSync(windowsTarget)) continue; // component absent from this package layout — skip
      const depthUp = spec.linkName.includes(path.sep) ? base.depth : base.depth - 1;
      const unixTarget = `${'../'.repeat(depthUp)}${spec.componentDir}`;
      mkdirSync(path.dirname(linkPath), { recursive: true });
      if (isWindows()) {
        symlinkSync(windowsTarget, linkPath, 'junction');
      } else {
        symlinkSync(unixTarget, linkPath, 'dir');
      }
    }
  }
}

async function defaultLegacyRulePreflightRunner(pdCliEntry: string, workspaceDir: string): Promise<LegacyRulePreflightOutcome> {
  // The entry path is boundary-checked before it is used as a subprocess
  // target, and the subprocess is invoked with an argv array (no shell).
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const execFileAsync = promisify(execFile);
  try {
    const result = await execFileAsync(
      process.execPath,
      [pdCliEntry, 'runtime', 'compatibility-scan', '--json', '--workspace', workspaceDir],
      { timeout: 60_000 },
    );
    return parseCompatibilityScanStdout(result.stdout);
  } catch (err) {
    // The scan command exits 1 WITH valid JSON for any refusal (legacy
    // dependency, DB failure, ...). Preserve that structured result instead
    // of smearing scan_failed into legacy_dependency (P1-3).
    const { stdout } = (err as { stdout?: string });
    if (typeof stdout === 'string' && stdout.trim().length > 0) {
      const fromStdout = parseCompatibilityScanStdout(stdout);
      if (!fromStdout.ok) return fromStdout;
    }
    return {
      ok: false,
      status: 'scan_failed',
      reason: `compatibility_scan_failed: ${err instanceof Error ? err.message : String(err)}`,
      remediation: 'Repair the workspace database or its permissions, then retry the upgrade. The current installation has not been replaced.',
    };
  }
}

export async function runLegacyRuleContractPreflight(
  pluginDir: string,
  workspaceDir: string,
  runScan: LegacyRulePreflightRunner = defaultLegacyRulePreflightRunner,
): Promise<LegacyRulePreflightOutcome> {
  const resolvedWorkspace = path.resolve(workspaceDir);
  // Self-contained status decision (P0/P1-2): a workspace with no persisted
  // PD state has nothing a contract change could break, so the scan is
  // skipped cleanly. The function must NOT rely on the caller having
  // pre-checked for state.db — Console/installer callers differ.
  const stateDbPath = path.join(resolvedWorkspace, '.pd', 'state.db');
  if (!existsSync(stateDbPath)) {
    return {
      ok: true,
      status: 'no_state_db',
      reason: 'state.db not found — no persisted activations to scan',
    };
  }

  const pdCliRoot = path.resolve(pluginDir, 'pd-cli');
  const pdCliEntry = path.resolve(pdCliRoot, 'dist', 'index.js');
  if (pdCliEntry !== pdCliRoot && !pdCliEntry.startsWith(pdCliRoot + path.sep)) {
    return {
      ok: false,
      status: 'scan_unavailable',
      reason: `compatibility_scan_unavailable: pd-cli entry escapes package dir (${pdCliEntry})`,
      remediation: 'Re-download/rebuild the installer before upgrading. The current installation has not been replaced.',
    };
  }
  if (!existsSync(pdCliEntry) || !statSync(pdCliEntry).isFile()) {
    // A stateful workspace is about to be upgraded and we cannot prove its
    // active RuleCode is compatible with the new runtime. This is NOT a
    // "fresh layout, skip it" case — fresh workspaces were handled above by
    // the no_state_db early return. Fail closed (P0/P1-2).
    return {
      ok: false,
      status: 'scan_unavailable',
      reason: 'compatibility_scan_unavailable',
      remediation:
        'The bundled compatibility scanner is missing. The package may be incomplete or corrupted. ' +
        'Re-download/rebuild the installer before upgrading. The current installation has not been replaced.',
    };
  }
  // PRI-693: the bundled pd-cli dist statically imports @principles/core,
  // @principles/host-runtime and principles-disciple, but the npm package
  // ships those as SIBLING directories (core/, host-runtime/, plugin/) — not
  // as node_modules entries — and the scan runs BEFORE deployment, so the
  // runtime symlinks created by syncPdCli do not exist yet. Node resolves
  // ESM imports only through node_modules, hence ERR_MODULE_NOT_FOUND for
  // every workspace with persisted state (fresh workspaces skip the scan).
  // Materialize the same links syncPdCli creates at deploy time.
  ensureBundledPdCliResolution(pdCliRoot);
  try {
    return await runScan(pdCliEntry, resolvedWorkspace);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes('ERR_MODULE_NOT_FOUND')) {
      // PRI-693: distinguish the packaging defect from a workspace problem —
      // telling the user to "repair the workspace database" sent them on a
      // hopeless path (the database is fine; the bundled dependency graph is
      // what cannot resolve).
      return {
        ok: false,
        status: 'scan_failed',
        reason: `compatibility_scan_dependency_missing: ${message}`,
        remediation:
          'The bundled pd-cli could not resolve its own dependencies (packaging defect). ' +
          'Do NOT modify the workspace database. Re-download/rebuild the installer, or report this version.',
      };
    }
    return {
      ok: false,
      status: 'scan_failed',
      reason: `compatibility_scan_failed: ${message}`,
      remediation: 'Repair the workspace database or its permissions, then retry the upgrade. The current installation has not been replaced.',
    };
  }
}

/**
 * Structured refusal for the legacy-contract preflight: nothing has been
 * mutated yet (the old installation is untouched) and the message names the
 * affected rules via the scan's remediation text.
 */
function buildCompatibilityRefusalResult(
  options: InstallOptions,
  outcome: LegacyRulePreflightOutcome,
): InstallResult {
  const nextAction = outcome.remediation ?? 'Migrate or deactivate the listed rules, then re-run the installer.';
  return {
    success: false,
    workspaceDir: options.workspaceDir,
    configYamlPath: getConfigYamlPath(options.workspaceDir),
    templatesCount: 0,
    components: { plugin: 'skipped', cli: 'skipped', console: 'skipped' },
    verification: { features: 'skipped', storyA: 'skipped' },
    enabledChannels: options.channels,
    nextAction,
    reason: outcome.reason ?? 'legacy_rule_contract_dependency',
    ...(outcome.remediation !== undefined ? { error: outcome.remediation } : {}),
  };
}

export async function checkBuiltPlugin(pluginDir: string): Promise<void> {
  const distDir = path.join(pluginDir, 'plugin', 'dist');
  const pluginJson = path.join(pluginDir, 'plugin', 'openclaw.plugin.json');

  if (!existsSync(distDir) || !existsSync(pluginJson)) {
    throw new Error(`Built plugin files missing at ${distDir}. Package may be corrupted.`);
  }

  const manifestRaw: unknown = JSON.parse(readFileSync(pluginJson, 'utf-8'));
  if (typeof manifestRaw !== 'object' || manifestRaw === null || Array.isArray(manifestRaw)) {
    throw new Error('openclaw.plugin.json is not a valid object');
  }
  const manifest = manifestRaw as Record<string, unknown>;
  const { activation } = manifest;
  if (typeof activation !== 'object' || activation === null || Array.isArray(activation)) {
    throw new Error('openclaw.plugin.json is missing activation object — PD hooks will not execute via gateway');
  }
  const activationObj = activation as Record<string, unknown>;
  const { onCapabilities } = activationObj;
  if (!Array.isArray(onCapabilities) || !(onCapabilities as unknown[]).includes('hook')) {
    throw new Error('openclaw.plugin.json.activation.onCapabilities does not include "hook" — PD hooks will not execute via gateway. Re-bundle after PR #725 is merged.');
  }

  const pkgJsonPath = path.join(pluginDir, 'plugin', 'package.json');
  if (existsSync(pkgJsonPath)) {
    const pkgRaw: unknown = JSON.parse(readFileSync(pkgJsonPath, 'utf-8'));
    if (typeof pkgRaw === 'object' && pkgRaw !== null && !Array.isArray(pkgRaw)) {
      const pkg = pkgRaw as Record<string, unknown>;
      const { openclaw } = pkg;
      if (typeof openclaw === 'object' && openclaw !== null && !Array.isArray(openclaw)) {
        const openclawObj = openclaw as Record<string, unknown>;
        if (openclawObj.setupEntry !== './dist/bundle.js') {
          throw new Error(`plugin package.json openclaw.setupEntry is "${String(openclawObj.setupEntry)}" (expected "./dist/bundle.js") — gateway will not load PD hooks. Re-bundle after PR #725 is merged.`);
        }
      }
    }
  }
}

function filesystemErrorCode(error: unknown): unknown {
  if (typeof error !== 'object' || error === null || !Object.hasOwn(error, 'code')) return undefined;
  return (error as Record<string, unknown>).code;
}

/**
 * PRI-1102: a target that exists as a DANGLING link (an interrupted install
 * left a reparse point whose target is gone) is not a directory the installer
 * can copy into. `existsSync` follows the link and reports "missing", so the
 * backup step never moves it, and `ensureDir` then treats it as present —
 * the follow-up mkdir fails with ENOENT and aborts the whole install.
 *
 * Absent targets are created. A dangling link is removed (the link itself only,
 * never a target), and the caller recreates the real directory. Everything
 * else — a real directory, or a link that still resolves — is left untouched,
 * so an existing install is never destroyed by this step.
 */
export async function preparePluginInstallTarget(targetDir: string): Promise<void> {
  let stats: Stats | undefined;
  try {
    stats = lstatSync(targetDir, { throwIfNoEntry: false });
  } catch (error) {
    throw new Error(`Cannot inspect plugin install target ${targetDir}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
  if (stats !== undefined && stats.isSymbolicLink()) {
    let targetAbsent = false;
    try {
      realpathSync(targetDir);
    } catch (error) {
      const code = filesystemErrorCode(error);
      if (code !== 'ENOENT' && code !== 'ENOTDIR') {
        // EACCES/EPERM/... means the link target may still be a live install
        // this process cannot read. Removing the link would destroy it, so
        // fail closed and let the caller report the refusal.
        throw new Error(
          `Cannot resolve plugin install target ${targetDir}: ${error instanceof Error ? error.message : String(error)}`,
          { cause: error },
        );
      }
      // Confirmed absent target (ENOENT/ENOTDIR) — the link itself is the
      // residue of an interrupted install.
      targetAbsent = true;
    }
    if (targetAbsent) {
      // fs-extra's remove unlinks the reparse point instead of traversing it.
      await fse.remove(targetDir);
      logger.warn(`Removed dangling link at ${targetDir} (target missing) — rebuilding the plugin install directory.`);
    }
  }
  await fse.ensureDir(targetDir);
}

/**
 * PRI-1102: a rollback is only as good as the state it returns to. The
 * pre-run state can itself be incomplete (a component the previous run never
 * finished, a link whose target is gone), so "restored" must not be reported
 * as a healthy install without checking what the restored tree actually
 * contains.
 *
 * A directory merely existing is not enough: every executable entry the
 * Console/CLI/gateway consumes at runtime must resolve, and a directory that
 * is a link must still resolve. Only then is the restored state usable.
 */
interface RestoredTreeRequirement {
  readonly dir: string;
  readonly entries: readonly string[];
  /** OpenClaw-only tree: a Codex-only install legitimately has no copy. */
  readonly openClawOnly: boolean;
}

function restoredTreeRequirements(): RestoredTreeRequirement[] {
  return [
    // The runtime root itself (type + link resolution only).
    { dir: getPdRuntimeDir(), entries: [], openClawOnly: false },
    {
      dir: getInstalledConsoleDir(),
      entries: [path.join('dist', 'server.js'), path.join('dist', 'web', 'index.html')],
      openClawOnly: false,
    },
    { dir: getInstalledPdCliDir(), entries: [path.join('dist', 'index.js')], openClawOnly: false },
    { dir: getInstalledPluginDir(), entries: [path.join('dist', 'bundle.js'), 'openclaw.plugin.json'], openClawOnly: false },
    {
      dir: getPluginExtDir(),
      entries: [path.join('dist', 'bundle.js'), 'openclaw.plugin.json', 'package.json'],
      openClawOnly: true,
    },
  ];
}

function describeRestoredDirGap(dir: string, gaps: string[]): boolean {
  let stats: Stats | undefined;
  try {
    stats = lstatSync(dir, { throwIfNoEntry: false });
  } catch (error) {
    gaps.push(`${dir} (unreadable: ${error instanceof Error ? error.message : String(error)})`);
    return false;
  }
  if (stats === undefined) {
    gaps.push(`${dir} (missing)`);
    return false;
  }
  if (stats.isSymbolicLink()) {
    try {
      realpathSync(dir);
    } catch (error) {
      const code = filesystemErrorCode(error);
      gaps.push(`${dir} (${code === 'ENOENT' || code === 'ENOTDIR' ? 'dangling link' : 'unresolvable link'})`);
      return false;
    }
  } else if (!stats.isDirectory()) {
    gaps.push(`${dir} (not a directory)`);
    return false;
  }
  return true;
}

function describeRestoredEntryGap(entry: string, gaps: string[]): void {
  let stats: Stats | undefined;
  try {
    stats = lstatSync(entry, { throwIfNoEntry: false });
  } catch (error) {
    gaps.push(`${entry} (unreadable: ${error instanceof Error ? error.message : String(error)})`);
    return;
  }
  if (stats === undefined) {
    gaps.push(`${entry} (missing)`);
    return;
  }
  if (stats.isSymbolicLink()) {
    try {
      realpathSync(entry);
    } catch (error) {
      const code = filesystemErrorCode(error);
      gaps.push(`${entry} (${code === 'ENOENT' || code === 'ENOTDIR' ? 'dangling link' : 'unresolvable link'})`);
      return;
    }
    // realpath only proves the target EXISTS. The entry is consumed as a file
    // at runtime, so a link to a directory is just as unusable as a missing
    // file path. stat follows the link and reports the target type.
    let targetStats: Stats;
    try {
      targetStats = statSync(entry);
    } catch (error) {
      const code = filesystemErrorCode(error);
      gaps.push(`${entry} (${code === 'ENOENT' || code === 'ENOTDIR' ? 'dangling link' : 'unresolvable link'})`);
      return;
    }
    if (!targetStats.isFile()) {
      gaps.push(`${entry} (not a file)`);
    }
    return;
  }
  if (!stats.isFile()) {
    gaps.push(`${entry} (not a file)`);
  }
}

export function describeRestoredStateGaps(): string[] {
  const gaps: string[] = [];
  for (const requirement of restoredTreeRequirements()) {
    if (requirement.openClawOnly && !installsOpenClaw(activeHostTarget)) continue;
    if (!describeRestoredDirGap(requirement.dir, gaps)) continue;
    for (const entry of requirement.entries) {
      describeRestoredEntryGap(path.join(requirement.dir, entry), gaps);
    }
  }
  return gaps;
}

export async function installPluginToStaging(pluginDir: string, language: SkillLanguage): Promise<void> {
  const builtPluginDir = path.join(pluginDir, 'plugin');
  for (const targetDir of pluginInstallDirs()) {
    await preparePluginInstallTarget(targetDir);
    // PRI-1037 payload fix: npm-era payloads carried a ~16k-file node_modules
    // (the whole pi-ai/openai/anthropic tree, dragged in through the plugin's
    // historical file:./core dependency) plus a `core` junction, in BOTH plugin
    // install dirs. fse.copy(overwrite) never deletes extraneous entries, so
    // that payload survived every upgrade — and OpenClaw's workspace-plugin
    // capture copies plugin files package-by-package into each `agent exec`
    // state under a hard 120s publication budget, timing out every exec. The
    // shipped plugin now declares better-sqlite3 as its only runtime dependency
    // (dist/bundle.js imports it statically; everything else is inlined at
    // build time), so prune the stale trees before the copy and let the
    // installed payload converge to the lean shape.
    // Unconditional removes: fse.remove is a no-op on a missing path, and an
    // existsSync guard would skip dangling `core` links (existsSync follows the
    // link, so it reports false once the link target is gone) and leave the
    // retired surface behind.
    await fse.remove(path.join(targetDir, 'node_modules'));
    await fse.remove(path.join(targetDir, 'core'));
    await fse.copy(builtPluginDir, targetDir, { overwrite: true });

    // OpenClaw publishes skills by name with no locale mechanism. Applying the
    // same selected language to both copies also keeps the canonical package
    // ready if another host is attached later.
    const selection = applySkillLanguageSelection(targetDir, language);
    if (!selection.applied) {
      logger.warn(`Skill language "${language}" not applied at ${targetDir} (${selection.note ?? 'unknown'}) — published skills stay at the manifest default`);
    }
  }
}

// ADR-0020 §2.3: The OpenClaw config write logic previously lived here as
// `updateOpenClawConfig()`. It has been extracted to OpenClawHostInstaller
// (./installers/openclaw-host-installer.ts) and is invoked via
// `runHostInstallers()` below. This file no longer writes openclaw.json
// directly — the HostInstaller interface keeps install/uninstall host-agnostic.

async function installPluginDependencies(): Promise<void> {
  for (const extDir of pluginInstallDirs()) {
    await prepareComponentDependencies(extDir, 'Plugin');
  }
}

function getNpmGlobalBinDir(): string | null {
  try {
    const prefix = execNpm(['prefix', '-g']).trim();
    if (!prefix) return null;
    return process.platform === 'win32' ? prefix : path.join(prefix, 'bin');
  } catch {
    return null;
  }
}

/** Outcome of one global-shim discovery/install attempt (PRI-697 review P1). */
export interface GlobalPdShimResult {
  /** true when PD-owned shim files are in place in the npm global bin dir. */
  installed: boolean;
  /** Shim files this run CREATED (absent before) — the rollback set. */
  createdPaths: string[];
  /** PD-owned shim files that already existed and were overwritten in place. */
  replacedPaths: string[];
  /** Foreign-owned `pd` entries found — never written, never rolled back. */
  skippedForeignPaths: string[];
}

/** Fixed filename whitelist for global-shim targets (no caller input). */
// PRI-898 SP1: win32 also carries an extensionless `pd`. cmd.exe/PowerShell
// resolve bare `pd` via PATHEXT to pd.cmd / pd.ps1, but Git Bash (MSYS sh)
// does NOT append PATHEXT — it only finds an exact-named executable. Without
// the extensionless shim, a Git Bash host agent gets command-not-found even
// though the .cmd shim is on PATH (empirically probed: `zzpd.cmd` present,
// bare `zzpd` -> not found). The three files are the full coverage set:
// pd.cmd (cmd), pd.ps1 (PowerShell), pd (Git Bash / MSYS).
const GLOBAL_PD_SHIM_BASENAMES: readonly string[] = isWindows() ? ['pd.cmd', 'pd.ps1', 'pd'] : ['pd'];

/**
 * Render the POSIX-sh forwarding script that exposes a global `pd`.
 *
 * The target goes in SINGLE quotes. Inside `"…"` the shell still expands `$`
 * and backticks and treats `\` as an escape character — and a Windows path is
 * nothing but backslashes — so no complete escape set exists there short of
 * quoting per-character. Single quotes are literal except for `'` itself,
 * which is emitted as the close-escape-reopen idiom. Exported because the
 * win32 write branch is platform-gated while this escaping contract has to be
 * assertable on every runner.
 */
export function renderShForwardingShim(targetPath: string): string {
  return `#!/usr/bin/env sh\nexec '${targetPath.split("'").join("'\\''")}' "$@"\n`;
}

/** Resolve a whitelisted shim basename under the npm global bin dir. */
function globalShimPath(globalBin: string, basename: string): string {
  if (!GLOBAL_PD_SHIM_BASENAMES.includes(basename)) {
    throw new Error(`Refusing to touch non-whitelisted global shim name: ${basename}`);
  }
  const target = path.resolve(globalBin, basename);
  if (path.dirname(target) !== path.resolve(globalBin)) {
    throw new Error(`Global shim path escaped the npm global bin dir: ${target}`);
  }
  return target;
}

// A legacy path mentioned in a comment is not proof of ownership. Only
// complete known forwarding scripts may be migrated when their target is gone.
// The substitutions below REPLICATE the historical writers' exact byte output
// (format parity, not output escaping): none of the writers escape backslashes
// in Windows paths, so detection must not add escaping either — split/join is
// used instead of String.replace to keep that intent explicit.
function duplicateDoubleQuotes(value: string): string {
  return value.split('"').join('""');
}

function doubleBackticksThenBacktickQuotes(value: string): string {
  return value.split('`').join('``').split('"').join('`"');
}

function backslashQuote(value: string): string {
  return value.split('"').join('\\"');
}

function isLegacyPdShim(content: string): boolean {
  const scripts: string[] = [];
  const bin = path.join(getPluginExtDir(), 'bin');
  const cmd = duplicateDoubleQuotes(path.join(bin, 'pd.cmd'));
  const ps = doubleBackticksThenBacktickQuotes(path.join(bin, 'pd.ps1'));
  scripts.push(`@echo off\ncall "${cmd}" %*`);
  scripts.push(`$shim = "${ps}"\n& $shim @args\nexit $LASTEXITCODE`);
  scripts.push(`#!/usr/bin/env sh\nexec "${backslashQuote(path.join(bin, 'pd'))}" "$@"`);
  for (const root of [getPdRuntimeDir(), getPluginExtDir()]) {
    const entry = path.join(root, 'pd-cli', 'dist', 'index.js');
    scripts.push(`@echo off\nnode "${duplicateDoubleQuotes(entry)}" %*`);
    scripts.push(`$ErrorActionPreference = "Stop"\n$entry = "${doubleBackticksThenBacktickQuotes(entry)}"\n& node $entry @args\nexit $LASTEXITCODE`);
    scripts.push(`#!/usr/bin/env sh\nexec node "${backslashQuote(entry)}" "$@"`);
  }
  return scripts.includes(content.replace(/\r\n/g, '\n').trim());
}

function classifyGlobalPdShim(globalBin: string, installedBinDir: string): { foreignPaths: string[]; existingPdOwned: boolean } {
  const foreignPaths: string[] = [];
  let existingPdOwned = false;
  for (const shim of GLOBAL_PD_SHIM_BASENAMES) {
    const shimPath = globalShimPath(globalBin, shim);
    if (!existsSync(shimPath)) continue;
    let content: string;
    try {
      content = readFileSync(shimPath, 'utf-8');
    } catch {
      foreignPaths.push(shimPath); // unreadable → do not touch
      continue;
    }
    if (content.includes(installedBinDir) || isLegacyPdShim(content)) {
      existingPdOwned = true;
    } else {
      foreignPaths.push(shimPath);
    }
  }
  return { foreignPaths, existingPdOwned };
}

export function installGlobalPdShim(): GlobalPdShimResult | boolean {
  // PRI-898: global-`pd` exposure is decoupled from the payload/dependency
  // mode. The shim is a forwarding script written into the npm global bin —
  // a PATH-managed directory that exists independently of how PD resolves
  // its own dependencies — so it does not belong to the npm-distributed
  // shape only. Gating this on the payload mode skipped it for the
  // self-contained release asset, which is the recommended channel, leaving
  // every self-contained install without a `pd` command (verifyPdCliShim
  // only downgraded to verified_local_only + a stderr warn afterward). The
  // dependency-resolution gate stays where it
  // belongs: installReleaseManagerDependencies / codex-host-installer.
  //
  // Allow skipping global shim installation in smoke tests to avoid
  // polluting the host's npm global bin dir. The bundled pd-cli is
  // still installed locally (getInstalledBinDir); only the global
  // symlink/shim is skipped. Mirrors PD_SKIP_NPM_UPGRADE pattern.
  if (process.env.PD_SKIP_GLOBAL_SHIM === '1' || process.env.PD_SKIP_GLOBAL_SHIM === 'true') {
    logger.info('Skipping global pd shim installation (PD_SKIP_GLOBAL_SHIM set).');
    return false;
  }
  const globalBin = getNpmGlobalBinDir();
  if (!globalBin) return false;
  const installedBinDir = getInstalledBinDir();

  // Ownership gate before ANY write: foreign `pd` entries are never
  // overwritten (uninstaller's isPdOwnedShim discipline, write side).
  const { foreignPaths, existingPdOwned } = classifyGlobalPdShim(globalBin, installedBinDir);
  if (foreignPaths.length > 0) {
    const foreignList = foreignPaths.join(', ');
    logger.warn(`A non-PD "pd" command already exists in the npm global bin dir (${foreignList}) — not overwriting it.`);
    logger.warn(`The bundled PD CLI stays available at "${path.join(installedBinDir, isWindows() ? 'pd.cmd' : 'pd')}". Remove the foreign "pd" yourself if you want the global name.`);
    if (existingPdOwned) {
      logger.warn('PD-owned shim files in the same dir were left untouched to keep the existing installation consistent.');
    }
    return { installed: false, createdPaths: [], replacedPaths: [], skippedForeignPaths: foreignPaths };
  }

  // Rollback bookkeeping: which shim targets already existed (PD-owned)?
  // preExisting drives the replaced-list and the partial-failure residue
  // computation below.
  const preExisting = new Set<string>(
    GLOBAL_PD_SHIM_BASENAMES
      .map((shim) => globalShimPath(globalBin, shim))
      .filter((shimPath) => existsSync(shimPath)),
  );
  const createdPaths: string[] = [];
  const replacedPaths: string[] = [...preExisting];

  try {
    mkdirSync(globalBin, { recursive: true });

    if (isWindows()) {
      const pluginCmd = path.join(installedBinDir, 'pd.cmd');
      const globalCmdPath = globalShimPath(globalBin, 'pd.cmd');
      writeFileSync(globalCmdPath, `@echo off\r\ncall "${pluginCmd.replace(/"/g, '""')}" %*\r\n`, 'utf-8');
      const pluginPs = path.join(installedBinDir, 'pd.ps1');
      const globalPsPath = globalShimPath(globalBin, 'pd.ps1');
      writeFileSync(
        globalPsPath,
        `$shim = "${pluginPs.replace(/`/g, '``').replace(/"/g, '`"')}"\r\n& $shim @args\r\nexit $LASTEXITCODE\r\n`,
        'utf-8',
      );
      // PRI-898 SP1: extensionless POSIX-sh shim forwarding to pd.cmd — the
      // only form Git Bash resolves for a bare `pd`. LF newlines (an MSYS sh
      // rejects CRLF shebang lines), so it shares the POSIX branch's renderer.
      const globalSh = globalShimPath(globalBin, 'pd');
      writeFileSync(globalSh, renderShForwardingShim(pluginCmd), 'utf-8');
      chmodSync(globalSh, 0o755);
    } else {
      const pluginSh = path.join(installedBinDir, 'pd');
      const globalSh = globalShimPath(globalBin, 'pd');
      writeFileSync(globalSh, renderShForwardingShim(pluginSh), 'utf-8');
      chmodSync(globalSh, 0o755);
    }
    // PRI-697 review P1: the success path MUST record which targets are new
    // (created) vs pre-existing PD-owned (replaced) — rollbackGlobalPdShim
    // removes exactly createdPaths when a LATER install step fails. The
    // pre-fix success path left createdPaths empty, silently no-op'ing the
    // rollback while the failure message claimed a clean cleanup.
    for (const shim of GLOBAL_PD_SHIM_BASENAMES) {
      const shimPath = globalShimPath(globalBin, shim);
      if (!preExisting.has(shimPath)) createdPaths.push(shimPath);
    }
    return { installed: true, createdPaths, replacedPaths, skippedForeignPaths: [] };
  } catch (e) {
    logger.warn(`Global pd shim installation failed: ${e instanceof Error ? e.message : String(e)}`);
    // Partial writes may have landed before the failure — hand the raw
    // targets to the caller as createdPaths so the rollback can remove
    // exactly this run's residue.
    const landed = GLOBAL_PD_SHIM_BASENAMES
      .map((shim) => globalShimPath(globalBin, shim))
      .filter((shimPath) => existsSync(shimPath) && !preExisting.has(shimPath));
    return { installed: false, createdPaths: landed, replacedPaths: [], skippedForeignPaths: [] };
  }
}

export function tryUpgradePdCliFromNpm(installedPdCliDir: string): void {
  // The npm upgrade stays gated on the legacy env var (PRI-697 keeps the
  // behavior): a registry pd-cli version can import exports the bundled
  // core no longer has, so upgrading is only for the explicit recovery
  // path where the whole shape is registry-resolved anyway. The skip
  // message reports the ACTUAL payload mode — it used to claim
  // "self-contained release asset" even in npm-distributed installs.
  if (!legacyNpmInstallEnabled()) {
    if (activePayloadMode === 'npm-distributed') {
      logger.info('Skipping npm pd-cli upgrade (bundled pd-cli is authoritative; set PD_ALLOW_LEGACY_NPM_INSTALL to enable registry upgrades).');
    } else {
      logger.info('Skipping npm pd-cli upgrade for the self-contained release asset.');
    }
    return;
  }
  // Allow skipping the npm upgrade in smoke tests / offline environments.
  // The bundled pd-cli is built from the current repo state and is the
  // authoritative version for testing. Upgrading to an npm-published version
  // can introduce incompatibilities (e.g., when local core has removed
  // exports that the npm pd-cli still imports).
  if (process.env.PD_SKIP_NPM_UPGRADE === '1' || process.env.PD_SKIP_NPM_UPGRADE === 'true') {
    logger.info('Skipping pd-cli npm upgrade (PD_SKIP_NPM_UPGRADE set).');
    return;
  }
  try {
    const npmVersion = execNpm(['view', '@principles/pd-cli', 'version'], undefined, 15_000).trim();

    // Fully anchored semver: this value is interpolated into a cmd.exe
    // command line below, so a registry response carrying shell
    // metacharacters after a valid-looking prefix must be rejected outright.
    if (!npmVersion || !/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/.test(npmVersion)) return;

    const localPkgPath = path.join(installedPdCliDir, 'package.json');
    const localPkg = JSON.parse(readFileSync(localPkgPath, 'utf-8')) as { version: string };
    const localVersion = localPkg.version;

    if (npmVersion === localVersion) return;

    logger.info(`Upgrading pd-cli from bundled v${localVersion} to npm v${npmVersion}...`);

    const tmpDir = path.join(installedPdCliDir, '__npm_upgrade_tmp');
    try {
      mkdirSync(tmpDir, { recursive: true });
      // Platform dispatch (CodeRabbit review): cmd.exe does not exist on
      // POSIX, where npm is a real executable and can be spawned directly.
      // The only registry-derived value on this command line is npmVersion,
      // restricted to a metacharacter-free semver charset by the anchored
      // check above; tmpDir is the local install root (profile-derived, not
      // attacker-controlled). CodeQL's js/indirect-command-line-injection
      // cannot model the regex sanitizer — see the evidence-based dismissal
      // on alert 431.
      const packArgs = ['pack', `@principles/pd-cli@${npmVersion}`, '--pack-destination', tmpDir];
      if (process.platform === 'win32') {
        execFileSync('cmd.exe', ['/d', '/s', '/c', 'npm', ...packArgs], {
          encoding: 'utf-8',
          timeout: 30_000,
          stdio: ['pipe', 'pipe', 'pipe'],
        });
      } else {
        execFileSync('npm', packArgs, {
          encoding: 'utf-8',
          timeout: 30_000,
          stdio: ['pipe', 'pipe', 'pipe'],
        });
      }

      const tgzFiles = readdirSync(tmpDir).filter(f => f.endsWith('.tgz'));
      const [tgzFile] = tgzFiles;
      if (!tgzFile) {
        logger.info('No npm tarball found, keeping bundled version.');
        return;
      }

      const extractDir = path.join(tmpDir, 'extracted');
      mkdirSync(extractDir, { recursive: true });
      execFileSync('tar', ['-xzf', path.join(tmpDir, tgzFile), '-C', extractDir], {
        encoding: 'utf-8',
        timeout: 15_000,
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      const packageDir = path.join(extractDir, 'package');
      if (!existsSync(path.join(packageDir, 'dist', 'index.js'))) {
        logger.info('Npm package structure unexpected, keeping bundled version.');
        return;
      }

      rmSync(path.join(installedPdCliDir, 'dist'), { recursive: true, force: true });
      cpSync(path.join(packageDir, 'dist'), path.join(installedPdCliDir, 'dist'), { recursive: true });
      if (existsSync(path.join(packageDir, 'package.json'))) {
        copyFileSync(path.join(packageDir, 'package.json'), localPkgPath);
      }

      logger.success(`pd-cli upgraded to v${npmVersion}`);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    logger.info(`pd-cli npm upgrade skipped (${msg}). Bundled version is functional.`);
  }
}

/**
 * Deploy the bundled pd-cli into the runtime + local bin shims + (npm-
 * distributed payload only) the global `pd` shim. Returns the global-shim
 * transaction bookkeeping so install() can roll the global side effect back
 * on failure (PRI-697 review P1): globalShim is null when no global write
 * was attempted (skip gates / payload mode), otherwise it records which
 * shim files this run CREATED (rollback removes them) vs which PD-owned
 * files it replaced in place (rollback keeps them — a pre-existing PD
 * install keeps its global command).
 */
function syncPdCli(pluginDir: string): { ok: boolean; globalShim: GlobalPdShimResult | null } {
  const pdCliSourceDir = path.join(pluginDir, 'pd-cli');
  const distDir = path.join(pdCliSourceDir, 'dist');

  if (!existsSync(path.join(distDir, 'index.js'))) {
    throw new Error('PD CLI dist/index.js not found in package. Cannot install pd command.');
  }

  const installedPdCliDir = getInstalledPdCliDir();
  rmSync(installedPdCliDir, { recursive: true, force: true });
  mkdirSync(installedPdCliDir, { recursive: true });
  cpSync(distDir, path.join(installedPdCliDir, 'dist'), { recursive: true });
  copyFileSync(path.join(pdCliSourceDir, 'package.json'), path.join(installedPdCliDir, 'package.json'));
  const bundledNodeModules = path.join(pdCliSourceDir, 'node_modules');
  if (existsSync(bundledNodeModules)) {
    cpSync(bundledNodeModules, path.join(installedPdCliDir, 'node_modules'), { recursive: true });
  }

  // G3 §10.5: the pd-cli sibling links (core / host-runtime / codex-adapter /
  // workbuddy-adapter / install-layout / principles-disciple) are NO LONGER
  // hand-rolled here. install() materializes them via
  // ensurePdCliResolution() AFTER installPdCliDependencies(), so a physical
  // copy produced by the dependency stage can never be silently kept — this
  // block used to short-circuit on existsSync() and leave npm-materialized
  // copies in place.
  tryUpgradePdCliFromNpm(installedPdCliDir);

  const installedBinDir = getInstalledBinDir();
  mkdirSync(installedBinDir, { recursive: true });
  const installedEntry = path.join(installedPdCliDir, 'dist', 'index.js');

  if (isWindows()) {
    const cmdShim = [
      '@echo off',
      `node "${installedEntry.replace(/"/g, '""')}" %*`,
      '',
    ].join('\r\n');
    writeFileSync(path.join(installedBinDir, 'pd.cmd'), cmdShim, 'utf-8');
    const psShim = [
      '$ErrorActionPreference = "Stop"',
      `$entry = "${installedEntry.replace(/`/g, '``').replace(/"/g, '`"')}"`,
      '& node $entry @args',
      'exit $LASTEXITCODE',
      '',
    ].join('\r\n');
    writeFileSync(path.join(installedBinDir, 'pd.ps1'), psShim, 'utf-8');
  } else {
    const shShim = [
      '#!/usr/bin/env sh',
      `exec node "${installedEntry.replace(/"/g, '\\"')}" "$@"`,
      '',
    ].join('\n');
    const target = path.join(installedBinDir, 'pd');
    writeFileSync(target, shShim, 'utf-8');
    chmodSync(target, 0o755);
  }

  // PRI-697 review P1: propagate the structured global-shim outcome so the
  // install transaction can roll the global side effect back on failure.
  // Plain false (smoke-env skip gate, or an unresolvable npm global bin)
  // carries no residue.
  const shimResult = installGlobalPdShim();
  if (typeof shimResult === 'boolean') return { ok: shimResult, globalShim: null };
  return { ok: shimResult.installed, globalShim: shimResult };
}

function verifyPdCliShim(): { localOk: boolean; globalOk: boolean; localPath: string; localError?: string } {
  const localShim = path.join(getInstalledBinDir(), isWindows() ? 'pd.cmd' : 'pd');
  let localOk = false;
  let localError: string | undefined;
  try {
    const installedEntry = path.join(getInstalledPdCliDir(), 'dist', 'index.js');
    execFileSync(process.execPath, [installedEntry, '--version'], { stdio: 'pipe', timeout: PD_CLI_VERIFICATION_TIMEOUT_MS });
    localOk = true;
  } catch (e: unknown) {
    let detail = 'unknown error';
    if (typeof e === 'object' && e !== null) {
      const stderr = Object.hasOwn(e, 'stderr') ? Reflect.get(e, 'stderr') : undefined;
      const message = Object.hasOwn(e, 'message') ? Reflect.get(e, 'message') : undefined;
      const stderrText = Buffer.isBuffer(stderr) ? stderr.toString().trim().slice(0, 500) : '';
      if (stderrText.length > 0) detail = stderrText;
      else if (typeof message === 'string' && message.trim().length > 0) detail = message.trim().slice(0, 500);
    } else if (typeof e === 'string' && e.trim().length > 0) {
      detail = e.trim().slice(0, 500);
    }
    localError = detail;
    logger.warn(`PD CLI local verification failed: ${detail}`);
    // First-install sequencing (WorkBuddy remediation): on a fresh home the
    // ~/.pd active record is written only at commit (AFTER this verify), and
    // host targets that deploy no OpenClaw legacy overlay (--host workbuddy)
    // have no fallback branch in the version report — so the version probe
    // legitimately reports active_record_missing here. That exact shape
    // proves the deployed CLI EXECUTES (entry reachable, imports resolved);
    // activation arrives at commit. Strict behavior is preserved whenever an
    // active record already exists (upgrades).
    const activeRecordPath = path.join(getPdDir(), 'active.json');
    if (detail.includes('no active release record') && !existsSync(activeRecordPath)) {
      localOk = true;
      localError = undefined;
      logger.info('PD CLI executed without an activation record (first install); the record is written at commit.');
    }
  }

  const globalOk = (() => {
    try {
      if (isWindows()) {
        // 'pd' is an npm .cmd shim on Windows — resolve via cmd.exe with a
        // constant argv array (no shell string, no interpolation).
        execFileSync('cmd.exe', ['/c', 'pd', '--version'], { stdio: 'pipe', timeout: PD_CLI_VERIFICATION_TIMEOUT_MS, windowsHide: true });
      } else {
        execFileSync('pd', ['--version'], { stdio: 'pipe', timeout: PD_CLI_VERIFICATION_TIMEOUT_MS });
      }
      return true;
    } catch {
      return false;
    }
  })();

  return { localOk, globalOk, localPath: localShim, localError };
}

/**
 * PRI-672: the ReleaseManager authority module ships as the release-manager/
 * payload component (package name create-principles-disciple). Installed to
 * ~/.pd/runtime so the console's rewritten `create-principles-disciple`
 * dependency resolves; installConsole creates the resolution link.
 */
function getInstalledReleaseManagerDir(): string {
  return path.join(getPdRuntimeDir(), 'release-manager');
}

function installBundledReleaseManagerPackage(pluginDir: string): void {
  const source = path.join(pluginDir, 'release-manager');
  const destination = getInstalledReleaseManagerDir();
  if (!existsSync(path.join(source, 'package.json')) || !existsSync(path.join(source, 'dist', 'update', 'release-manager-authority.js'))) {
    throw new Error('Bundled release-manager component is incomplete (missing package.json or dist/update/release-manager-authority.js). Re-run the installer with a current package.');
  }
  rmSync(destination, { recursive: true, force: true });
  cpSync(source, destination, { recursive: true });
}

/**
 * PR #1525 review: the npm-distributed payload ships release-manager/ as
 * package.json + dist only — no node_modules. Without its own dependencies
 * (tuf-js / @tufjs/models) the authority module's static import chain
 * (release-manager → trust-metadata → tuf-js) cannot resolve, and the gap
 * would only surface later as `installer_missing` in the console. The
 * self-contained payload ships the bundle-time npm ci node_modules, so
 * registry resolution runs for the npm-distributed shape only.
 */
async function installReleaseManagerDependencies(): Promise<void> {
  if (!isNpmDependencyResolutionEnabled()) return;
  await runNpmInstall(getInstalledReleaseManagerDir(), 'ReleaseManager');
}

/**
 * PR #1525 review smoke: import the REAL authority module from the installed
 * tree so a dependency gap fails the install loudly here with a structured
 * message instead of surfacing as `installer_missing` at console runtime.
 * Mode-independent — the self-contained payload's shipped node_modules is
 * proven the same way.
 */
async function verifyReleaseManagerAuthorityImports(): Promise<void> {
  const installedDir = getInstalledReleaseManagerDir();
  // The Console reaches the authority through the registered public seam
  // (`create-principles-disciple/update-console` → dist/update/console-surface.js),
  // so that entry is what this probe loads when present: it proves the seam
  // file deployed AND that its sibling re-exports (authority / journal /
  // layout / manager) resolve with the installed dependencies. Self-contained
  // assets published BEFORE the seam shipped carry no console-surface.js and
  // are still installable — their co-installed Console imports the authority
  // entry, so that stays the fallback rather than turning an older asset into
  // an install failure.
  const seamPath = path.join(installedDir, 'dist', 'update', 'console-surface.js');
  const authorityPath = path.join(installedDir, 'dist', 'update', 'release-manager-authority.js');
  const entryPath = existsSync(seamPath) ? seamPath : authorityPath;
  if (!existsSync(entryPath)) {
    throw new Error('Installed release-manager authority module not found — installation is incomplete.');
  }
  try {
    await import(pathToFileURL(entryPath).href);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `ReleaseManager authority module failed to load — its runtime dependencies are incomplete. Re-run the installer to repair the installation. (${detail})`,
      { cause: error },
    );
  }
}

function installConsole(consoleDir: string): void {
  const consoleSrc = path.join(consoleDir, 'console');
  const consoleDest = getInstalledConsoleDir();

  if (!existsSync(consoleSrc)) {
    throw new Error('Console bundle not found in package. Cannot install pd-console.');
  }

  const serverJs = path.join(consoleSrc, 'dist', 'server.js');
  const webIndex = path.join(consoleSrc, 'dist', 'web', 'index.html');
  if (!existsSync(serverJs)) {
    throw new Error('Console dist/server.js not found in bundle. Package may be corrupted.');
  }
  if (!existsSync(webIndex)) {
    throw new Error('Console dist/web/index.html not found in bundle. Package may be corrupted.');
  }

  rmSync(consoleDest, { recursive: true, force: true });
  cpSync(consoleSrc, consoleDest, { recursive: true });

  // G3 §10.5: the console's sibling links (core / host-runtime / install-layout
  // / principles-disciple / create-principles-disciple) are materialized by
  // ensureConsoleResolution() AFTER installConsoleDependencies() — see
  // ensurePdCliResolution() for why the old existsSync() short-circuit was
  // removed instead of kept.
}

function getInstalledCoreDir(): string {
  return path.join(getPdRuntimeDir(), 'core');
}

function getInstalledHostRuntimeDir(): string {
  return path.join(getPdRuntimeDir(), 'host-runtime');
}

function getInstalledCodexAdapterDir(): string {
  return path.join(getPdRuntimeDir(), 'codex-adapter');
}

function getInstalledWorkbuddyAdapterDir(): string {
  return path.join(getPdRuntimeDir(), 'workbuddy-adapter');
}

/**
 * Gate 4 (PRI-1071): the shared MCP server installs as a runtime sibling so
 * the three host launchers can point their PD-owned bindings at one canonical
 * entry (~/.pd/runtime/pd-mcp-server/dist/index.js).
 */
function getInstalledMcpServerDir(): string {
  return resolveMcpServerDir(getInstallLayoutPaths(getHomeDir()));
}

/**
 * Gate 4 (PRI-1071): deploy the bundled @principles/pd-mcp-server the same
 * way as the codex/workbuddy adapters. Observable skip (not a failure) for
 * installer builds older than the component — the host launchers then fail
 * closed at launch with the honest "server entry missing" state (SPEC §3.5).
 * Link materialization happens via ensureComponentFileDependencyLinks AFTER
 * all siblings exist (same ordering contract as the codex adapter).
 */
function installBundledMcpServer(pluginDir: string): boolean {
  const mcpServerSrc = path.join(pluginDir, 'pd-mcp-server');
  const mcpServerDest = getInstalledMcpServerDir();

  if (!existsSync(mcpServerSrc)) {
    logger.warn(
      `Bundled @principles/pd-mcp-server not found in this installer package (${mcpServerSrc}) — the pd-recall MCP tool stays unavailable in this deployment. Hook/CLI/Console installation is unaffected.`,
    );
    return false;
  }

  const mcpServerPkgJson = path.join(mcpServerSrc, 'package.json');
  const mcpServerDistEntry = path.join(mcpServerSrc, 'dist', 'index.js');
  if (!existsSync(mcpServerPkgJson) || !existsSync(mcpServerDistEntry)) {
    throw new Error('Bundled @principles/pd-mcp-server is incomplete (missing package.json / dist/index.js). Package may be corrupted.');
  }

  rmSync(mcpServerDest, { recursive: true, force: true });
  cpSync(mcpServerSrc, mcpServerDest, { recursive: true });
  return true;
}

function installBundledCore(pluginDir: string): void {
  const coreSrc = path.join(pluginDir, 'core');
  const coreDest = getInstalledCoreDir();

  if (!existsSync(coreSrc)) {
    throw new Error('Bundled @principles/core not found in package. Cannot resolve runtime dependencies.');
  }

  const corePkgJson = path.join(coreSrc, 'package.json');
  const coreDist = path.join(coreSrc, 'dist');
  if (!existsSync(corePkgJson) || !existsSync(coreDist)) {
    throw new Error('Bundled @principles/core is incomplete (missing package.json or dist). Package may be corrupted.');
  }

  rmSync(coreDest, { recursive: true, force: true });
  cpSync(coreSrc, coreDest, { recursive: true });
}

function installBundledHostRuntime(pluginDir: string): void {
  const hostRuntimeSrc = path.join(pluginDir, 'host-runtime');
  const hostRuntimeDest = getInstalledHostRuntimeDir();

  if (!existsSync(hostRuntimeSrc)) {
    throw new Error('Bundled @principles/host-runtime not found in package. Cannot resolve runtime dependencies.');
  }

  const hostRuntimePkgJson = path.join(hostRuntimeSrc, 'package.json');
  const hostRuntimeDist = path.join(hostRuntimeSrc, 'dist');
  if (!existsSync(hostRuntimePkgJson) || !existsSync(hostRuntimeDist)) {
    throw new Error('Bundled @principles/host-runtime is incomplete (missing package.json or dist). Package may be corrupted.');
  }

  rmSync(hostRuntimeDest, { recursive: true, force: true });
  cpSync(hostRuntimeSrc, hostRuntimeDest, { recursive: true });
}

/**
 * PRI-624: pd-cli's `codex worker` / `codex ingest catch-up` commands import
 * the workspace worker cycle from @principles/codex-adapter, so the bundled
 * package is installed as a runtime sibling exactly like host-runtime.
 */
function installBundledCodexAdapter(pluginDir: string): void {
  const codexAdapterSrc = path.join(pluginDir, 'codex-adapter');
  const codexAdapterDest = getInstalledCodexAdapterDir();

  if (!existsSync(codexAdapterSrc)) {
    throw new Error('Bundled @principles/codex-adapter not found in package. Cannot resolve runtime dependencies.');
  }

  const codexAdapterPkgJson = path.join(codexAdapterSrc, 'package.json');
  const codexAdapterDist = path.join(codexAdapterSrc, 'dist');
  if (!existsSync(codexAdapterPkgJson) || !existsSync(codexAdapterDist)) {
    throw new Error('Bundled @principles/codex-adapter is incomplete (missing package.json or dist). Package may be corrupted.');
  }

  rmSync(codexAdapterDest, { recursive: true, force: true });
  cpSync(codexAdapterSrc, codexAdapterDest, { recursive: true });
}

/**
 * P1: structural package-name validation. Unscoped names have exactly one
 * segment; scoped names exactly `@scope/pkg`. This is deliberately NOT one
 * regex: "." / ".." pass a character-class test, yet path.join() normalizes
 * them onto node_modules / the scope parent / the component root.
 */
function isSafeNameSegment(segment: string): boolean {
  return segment.length > 0 && segment !== '.' && segment !== '..' && /^[A-Za-z0-9._-]+$/.test(segment);
}

function parseDependencyName(name: string): string[] | undefined {
  const scoped = name.startsWith('@');
  const raw = (scoped ? name.slice(1) : name).split('/');
  if (scoped ? raw.length !== 2 : raw.length !== 1) return undefined;
  if (!raw.every(isSafeNameSegment)) return undefined;
  if (!scoped) return raw;
  const [scope, packageName] = raw;
  return scope !== undefined && packageName !== undefined ? [`@${scope}`, packageName] : undefined;
}

/**
 * P1: `target` must be a STRICT descendant of `root` (never root itself, never
 * `..`, never an absolute escape). Applied to the lexical link path, the real
 * node_modules directory (which must stay inside the component) and any
 * symlinked ancestor we are about to create or delete through.
 */
function assertStrictlyInside(root: string, target: string, componentLabel: string): void {
  const relative = path.relative(root, target);
  if (relative === '' || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(
      `Installed ${componentLabel} dependency link path escapes the install tree (${target} is not strictly inside ${root}).`,
    );
  }
}

/** P1: an existing path used as a link parent must be a real directory, not a symlink. */
function assertRealParentDirectory(dir: string, componentLabel: string): void {
  let stat: Stats;
  try {
    stat = lstatSync(dir);
  } catch (error) {
    throw new Error(
      `Installed ${componentLabel} dependency link parent is missing (${dir}): ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  if (stat.isSymbolicLink()) {
    throw new Error(`Installed ${componentLabel} dependency link parent must not be a symbolic link (${dir}).`);
  }
  if (!stat.isDirectory()) {
    throw new Error(`Installed ${componentLabel} dependency link parent must be a directory (${dir}).`);
  }
}

interface ComponentFileDependencyLink {
  segments: string[];
  siblingReal: string;
  linkPath: string;
}

/**
 * P1 two-phase planning: resolve + validate every `file:../` dependency and
 * its final link path without mutating anything. Only a fully valid plan is
 * returned, so an invalid later entry cannot leave earlier links half-applied.
 */
function planComponentFileDependencyLinks(
  componentDir: string,
  componentLabel: string,
  dependencies: Record<string, unknown>,
): ComponentFileDependencyLink[] {
  const runtimeDir = getPdRuntimeDir();
  const runtimeDirReal = realpathSync(runtimeDir);
  const nodeModulesDir = path.join(componentDir, 'node_modules');
  const operations: ComponentFileDependencyLink[] = [];

  for (const [name, ref] of Object.entries(dependencies)) {
    if (typeof ref !== 'string' || !ref.startsWith('file:../')) continue;
    const siblingName = ref.slice('file:../'.length);
    // rc-1: only a single ordinary sibling segment; "." / ".." and separators
    // must not resolve the ref outside the runtime dir.
    if (!isSafeNameSegment(siblingName)) {
      throw new Error(`Installed ${componentLabel} declares an unsupported file dependency ref "${ref}" for ${name}.`);
    }
    const segments = parseDependencyName(name);
    if (segments === undefined) {
      throw new Error(`Installed ${componentLabel} declares an unsupported dependency name "${name}".`);
    }

    const siblingDir = path.join(runtimeDir, siblingName);
    if (!existsSync(siblingDir)) {
      throw new Error(`${componentLabel} depends on ${ref} but the sibling runtime component is missing: ${siblingDir}`);
    }
    const siblingReal = realpathSync(siblingDir);
    // The sibling must resolve to exactly <runtime>/<siblingName>: a symlink
    // that redirects the link target outside the runtime is not a sibling.
    if (path.relative(runtimeDirReal, siblingReal) !== siblingName) {
      throw new Error(`Installed ${componentLabel} declares a file dependency ref that resolves outside the runtime dir: "${ref}".`);
    }

    const linkPath = path.join(nodeModulesDir, ...segments);
    // Lexical boundary + segment-count: path.join() collapses "." / ".." and
    // repeated separators, so the normalized path must still have exactly the
    // declared number of segments and be a strict descendant of node_modules.
    const relative = path.relative(nodeModulesDir, linkPath);
    if (relative.split(path.sep).length !== segments.length) {
      throw new Error(`Installed ${componentLabel} declares an unsupported dependency name "${name}".`);
    }
    assertStrictlyInside(nodeModulesDir, linkPath, componentLabel);
    operations.push({ segments, siblingReal, linkPath });
  }
  return operations;
}

/**
 * PRI-711 (generalized for ADR-0020 host adapters): materialize node_modules
 * links for an INSTALLED runtime component so its declared `file:../<component>`
 * dependencies resolve under ESM realpath rules. Data-driven from the deployed
 * manifest: every dependency whose ref starts with `file:../` names a sibling
 * runtime component directory. An existing correct link is kept; a stale
 * physical copy or a wrong-target link is replaced with the canonical
 * junction/symlink. Idempotent. MUST run after the component AND all its
 * file:../ siblings are installed — a missing sibling means a corrupted
 * payload or a call-order regression, which fails the install loudly.
 */
function ensureComponentFileDependencyLinks(componentDir: string, componentLabel: string): void {
  const manifestPath = path.join(componentDir, 'package.json');
  let manifest: unknown;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
  } catch (error) {
    throw new Error(
      `Installed ${componentLabel} package.json is missing or malformed (${manifestPath}): ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  if (!isRecord(manifest)) {
    throw new Error(`Installed ${componentLabel} package.json must contain an object (${manifestPath}).`);
  }
  if (manifest.dependencies !== undefined && !isRecord(manifest.dependencies)) {
    throw new Error(`Installed ${componentLabel} package.json dependencies must be an object (${manifestPath}).`);
  }
  // P1: validate EVERYTHING before touching the filesystem. A manifest is
  // untrusted input, and a name that normalizes to node_modules / the scope
  // parent / the component root must never reach a recursive delete.
  const operations = planComponentFileDependencyLinks(componentDir, componentLabel, manifest.dependencies ?? {});
  if (operations.length === 0) return;

  const componentDirReal = realpathSync(componentDir);
  const nodeModulesDir = path.join(componentDir, 'node_modules');
  // P1: node_modules itself must be a real directory inside the component —
  // a symlinked parent would redirect every link/delete outside the install.
  mkdirSync(nodeModulesDir, { recursive: true });
  assertRealParentDirectory(nodeModulesDir, componentLabel);
  const nodeModulesReal = realpathSync(nodeModulesDir);
  assertStrictlyInside(componentDirReal, nodeModulesReal, componentLabel);

  for (const operation of operations) {
    const { segments, siblingReal, linkPath } = operation;
    if (segments.length === 2) {
      // scoped parent: create only when absent; never replace an existing
      // real directory (npm may legitimately share it) and never follow a
      // symlinked parent.
      const scopeSegment = segments[0] as string;
      const scopeDir = path.join(nodeModulesDir, scopeSegment);
      let scopeStat: Stats | undefined;
      try {
        scopeStat = lstatSync(scopeDir);
      } catch {
        scopeStat = undefined;
      }
      if (scopeStat === undefined) mkdirSync(scopeDir);
      assertRealParentDirectory(scopeDir, componentLabel);
      assertStrictlyInside(nodeModulesReal, realpathSync(scopeDir), componentLabel);
    }

    let stat: Stats | undefined;
    try {
      stat = lstatSync(linkPath);
    } catch {
      stat = undefined; // ENOENT — create below
    }
    if (stat !== undefined) {
      if (stat.isSymbolicLink()) {
        try {
          if (realpathSync(linkPath) === siblingReal) continue;
        } catch {
          // Unreadable link target — fall through to replace.
        }
      }
      // linkPath was proven to be a strict descendant of node_modules during
      // planning, and both parent levels were re-verified as real directories
      // above, so the only recursive delete stays inside the component tree.
      rmSync(linkPath, { recursive: stat.isDirectory() && !stat.isSymbolicLink(), force: true });
    }
    if (isWindows()) {
      symlinkSync(siblingReal, linkPath, 'junction');
    } else {
      symlinkSync(path.relative(path.dirname(linkPath), siblingReal), linkPath, 'dir');
    }
  }
}

/**
 * G3 §10.5: materialize the INSTALLED pd-cli's `file:../` sibling links
 * (core / host-runtime / codex-adapter / workbuddy-adapter / install-layout /
 * principles-disciple) through the shared helper. Replaces the hand-rolled
 * per-dependency blocks that used to live in syncPdCli(): those short-circuited
 * on existsSync(), so an npm-materialized physical copy silently won over the
 * intended runtime sibling.
 *
 * Ordering contract: MUST run after installPdCliDependencies() (the dependency
 * stage is what can (re)materialize node_modules) AND after every sibling is
 * deployed. A missing sibling fails the install loud (the helper).
 */
export function ensurePdCliResolution(): void {
  ensureComponentFileDependencyLinks(getInstalledPdCliDir(), '@principles/pd-cli');
}

/**
 * G3 §10.5: same contract for the INSTALLED pd-console (core / host-runtime /
 * install-layout / principles-disciple / create-principles-disciple). Runs
 * after installConsoleDependencies() so npm-materialized copies are corrected
 * instead of silently kept.
 */
export function ensureConsoleResolution(): void {
  ensureComponentFileDependencyLinks(getInstalledConsoleDir(), '@principles/pd-console');
}

/**
 * PRI-711: materialize node_modules links for the INSTALLED codex-adapter so
 * its declared `file:../<component>` dependencies resolve under ESM realpath
 * rules. The adapter's dist imports @principles/host-runtime and
 * @principles/core, and pd-cli's eager import graph (health-codex) statically
 * imports the adapter — without these links every pd command dies with
 * ERR_MODULE_NOT_FOUND at startup (observed 2026-09-09: the 1.231.2 full
 * update swapped in Slice-D pd-cli while the deployed adapter, laid down by
 * older installers, had no node_modules at all).
 */
export function ensureCodexAdapterResolution(): void {
  ensureComponentFileDependencyLinks(getInstalledCodexAdapterDir(), '@principles/codex-adapter');
}

/**
 * PRI-1145: the INSTALLED host-runtime declares the same `file:../<component>`
 * siblings as the other runtime components (core / install-layout), but it was
 * the only one with no `ensure*Resolution()` caller. `installBundledHostRuntime`
 * therefore left the npm-materialized `node_modules/@principles/core` physical
 * copy in place, so a second core byte lived on the machine outside the
 * "every component resolves the canonical runtime core" invariant. Reuses the
 * shared helper (Connection Before Creation) instead of a new mechanism.
 *
 * Ordering contract: MUST run after installBundledHostRuntime() AND after every
 * `file:../` sibling it declares is deployed (core, install-layout). A missing
 * sibling fails the install loud (the helper).
 */
export function ensureHostRuntimeResolution(): void {
  ensureComponentFileDependencyLinks(getInstalledHostRuntimeDir(), '@principles/host-runtime');
}

/**
 * PRI-1201: the INSTALLED release-manager component declares the same
 * `file:../<component>` sibling contract as every other runtime component
 * (@principles/install-layout), but — exactly like host-runtime before
 * PRI-1145 — it had no `ensure*Resolution()` caller. `installBundledReleaseManagerPackage`
 * + `installReleaseManagerDependencies` (and the self-contained payload's
 * build-time npm ci) therefore left a physical `node_modules/@principles/
 * install-layout` copy behind: a second install-layout byte that never
 * refreshes with the canonical sibling. Reuses the shared helper
 * (Connection Before Creation) instead of a new mechanism.
 *
 * Ordering contract: MUST run after installReleaseManagerDependencies() (that
 * stage is what can materialize node_modules) AND after installBundledLayoutPackage()
 * deployed the install-layout sibling. It also precedes
 * verifyReleaseManagerAuthorityImports() so the probe loads the module through
 * the canonical sibling. A missing sibling fails the install loud (the helper).
 */
export function ensureReleaseManagerResolution(): void {
  ensureComponentFileDependencyLinks(getInstalledReleaseManagerDir(), '@principles/release-manager');
}

/**
 * SPEC workbuddy-host-adapter §4.1/§5: the bundled @principles/workbuddy-adapter
 * payload installs as a runtime sibling exactly like codex-adapter, and its
 * `file:../<component>` dependency links are materialized the same way so the
 * plugin wrapper resolves core/host-runtime/install-layout under ESM realpath
 * rules.
 *
 * Unlike codex-adapter, the payload's ABSENCE is an observable skip, not a
 * failure: installer builds published before the adapter component landed (or
 * cut from a tree where it is not yet bundled) still deploy OpenClaw/Codex
 * untouched; the WorkBuddy host installer then reports
 * workbuddy_adapter_payload_missing for --host workbuddy (rc-9).
 */
export function installBundledWorkbuddyAdapter(pluginDir: string): boolean {
  const workbuddyAdapterSrc = path.join(pluginDir, 'workbuddy-adapter');
  const workbuddyAdapterDest = getInstalledWorkbuddyAdapterDir();

  if (!existsSync(workbuddyAdapterSrc)) {
    logger.warn(
      `Bundled @principles/workbuddy-adapter not found in this installer package (${workbuddyAdapterSrc}) — the WorkBuddy host stays unavailable in this deployment. OpenClaw/Codex installation is unaffected.`,
    );
    return false;
  }

  const workbuddyAdapterPkgJson = path.join(workbuddyAdapterSrc, 'package.json');
  const workbuddyAdapterDist = path.join(workbuddyAdapterSrc, 'dist');
  if (!existsSync(workbuddyAdapterPkgJson) || !existsSync(workbuddyAdapterDist)) {
    throw new Error('Bundled @principles/workbuddy-adapter is incomplete (missing package.json or dist). Package may be corrupted.');
  }

  rmSync(workbuddyAdapterDest, { recursive: true, force: true });
  cpSync(workbuddyAdapterSrc, workbuddyAdapterDest, { recursive: true });
  return true;
}

/**
 * Materialize the resolution links for the INSTALLED workbuddy-adapter.
 * Mirrors ensureCodexAdapterResolution; tolerates the component's absence
 * (observable skip — see installBundledWorkbuddyAdapter).
 */
export function ensureWorkbuddyAdapterResolution(): { installed: boolean; skipReason?: string } {
  const workbuddyAdapterDir = getInstalledWorkbuddyAdapterDir();
  if (!existsSync(workbuddyAdapterDir)) {
    return { installed: false, skipReason: 'workbuddy_adapter_not_installed' };
  }
  ensureComponentFileDependencyLinks(workbuddyAdapterDir, '@principles/workbuddy-adapter');
  return { installed: true };
}

/**
 * PRI-912 (SPEC-P1′-A): canonical junction reconciliation for the plugin's
 * bundled @principles/core copy. The self-contained release asset must ship
 * node_modules materialized (the asset builder refuses symlinks), so every
 * deployed plugin carries a full physical duplicate of the runtime root core
 * (~119MB / 17k files on a real install). This pass runs once ALL components
 * are deployed and BEFORE the journal 'staged' transition — a conversion that
 * breaks runtime resolution must surface through the EXISTING console-probe →
 * rollback channel, not a new one.
 *
 * The ONLY candidate is <pluginDir>/node_modules/@principles/core with the
 * runtime root core (<runtime>/core) as canonical source. A materialized copy
 * is converted to a junction (Windows) / relative symlink (Unix) only when
 * ALL three gates hold:
 *   1. package identity — the copy's and the source's package.json `name`
 *      agree (evidence-based; never name-matching alone),
 *   2. declared relationship — the plugin manifest declares
 *      `@principles/core` as a `file:` dependency whose declared path stays
 *      inside the plugin dir (rc-1) and RESOLVES to the canonical runtime
 *      core (the <plugin>/core slot installPluginToStaging creates),
 *   3. content digest — digestDirectory(copy) === digestDirectory(source).
 * Any gate failure (or an unreadable/partial state) SKIPS the copy with a
 * structured reason (rc-9) and never mutates it — dedup must never make an
 * install worse. Conversion is rename-swap with verification and restore:
 * a failed link creation/verification puts the materialized copy back; only
 * a restore failure (which WOULD break resolution) fails the install loud
 * into the existing fail → rollback channel. Idempotent: an existing link
 * that already resolves to the canonical core is a no-op. The canonical
 * target itself is never deleted: removing a converted tree unlinks the
 * junction, it does not follow it (rmSync/fse.remove symlink semantics).
 */
export interface CoreJunctionReconciliation {
  /** Materialized copies replaced by a verified canonical junction. */
  readonly converted: readonly string[];
  /** Existing links already resolving to the canonical core (idempotent no-op). */
  readonly alreadyCanonical: readonly string[];
  /** Structured skip records — every non-conversion carries a reason (rc-9). */
  readonly skipped: readonly { dir: string; reason: string }[];
}

const CORE_JUNCTION_PACKAGE = '@principles/core';

/** Reads a package.json `name` as untrusted input (rc-1); null when absent/malformed. */
function readPackageJsonName(manifestPath: string): string | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(manifestPath, 'utf8'));
    if (!isRecord(parsed)) return null;
    const {name} = parsed;
    return typeof name === 'string' && name.length > 0 ? name : null;
  } catch {
    return null;
  }
}

export function reconcilePluginCoreCanonicalJunction(): CoreJunctionReconciliation {
  const converted: string[] = [];
  const alreadyCanonical: string[] = [];
  const skipped: { dir: string; reason: string }[] = [];
  const runtimeCoreDir = getInstalledCoreDir();
  const runtimeCoreReal = (() => {
    try {
      return realpathSync(runtimeCoreDir);
    } catch {
      return null;
    }
  })();
  if (runtimeCoreReal === null) {
    // No canonical source → nothing safe to link to; the copies still work.
    for (const pluginDir of pluginInstallDirs()) {
      skipped.push({ dir: path.join(pluginDir, 'node_modules', CORE_JUNCTION_PACKAGE), reason: 'canonical_runtime_core_missing' });
    }
    return { converted, alreadyCanonical, skipped };
  }
  // Computed at most once, only when a materialized candidate reaches gate 3.
  let runtimeCoreDigest: string | null = null;

  for (const pluginDir of pluginInstallDirs()) {
    const coreSlot = path.join(pluginDir, 'node_modules', CORE_JUNCTION_PACKAGE);
    // lstat (never existsSync): a dangling link must be reported as a link
    // problem, not misread as an absent copy.
    let slotStat: Stats;
    try {
      slotStat = lstatSync(coreSlot);
    } catch {
      skipped.push({ dir: coreSlot, reason: 'copy_absent' });
      continue;
    }
    try {
      if (slotStat.isSymbolicLink()) {
        try {
          if (realpathSync(coreSlot) === runtimeCoreReal) {
            alreadyCanonical.push(coreSlot);
          } else {
            skipped.push({ dir: coreSlot, reason: 'existing_link_resolves_elsewhere' });
          }
        } catch {
          skipped.push({ dir: coreSlot, reason: 'existing_link_target_unreadable' });
        }
        continue;
      }
      if (!slotStat.isDirectory()) {
        skipped.push({ dir: coreSlot, reason: 'copy_not_a_directory' });
        continue;
      }
    } catch (error) {
      // An unreadable/partial slot state is never mutated and never fails
      // the install — dedup is an optimization over a working copy (rc-9).
      skipped.push({ dir: coreSlot, reason: `copy_unreadable: ${error instanceof Error ? error.message : String(error)}` });
      continue;
    }

    // Gate 1 — package identity from both manifests.
    const copyName = readPackageJsonName(path.join(coreSlot, 'package.json'));
    const sourceName = readPackageJsonName(path.join(runtimeCoreDir, 'package.json'));
    if (copyName === null || sourceName === null || copyName !== sourceName) {
      skipped.push({ dir: coreSlot, reason: `package_identity_mismatch: copy=${JSON.stringify(copyName)} source=${JSON.stringify(sourceName)}` });
      continue;
    }

    // Gate 2 — the declared file: dependency binds the copy slot to the
    // canonical core. The ref is untrusted (rc-1): only relative refs that
    // stay inside the plugin dir are considered.
    const pluginManifestPath = path.join(pluginDir, 'package.json');
    let declaredRef: unknown;
    try {
      const parsed: unknown = JSON.parse(readFileSync(pluginManifestPath, 'utf8'));
      if (!isRecord(parsed) || !isRecord(parsed.dependencies)) {
        skipped.push({ dir: coreSlot, reason: 'plugin_manifest_dependencies_unreadable' });
        continue;
      }
      declaredRef = parsed.dependencies[CORE_JUNCTION_PACKAGE];
    } catch (error) {
      skipped.push({ dir: coreSlot, reason: `plugin_manifest_unreadable: ${error instanceof Error ? error.message : String(error)}` });
      continue;
    }
    if (typeof declaredRef !== 'string' || !declaredRef.startsWith('file:')) {
      skipped.push({ dir: coreSlot, reason: `declared_dependency_not_file_ref: ${JSON.stringify(declaredRef ?? null)}` });
      continue;
    }
    const declaredDir = path.resolve(pluginDir, declaredRef.slice('file:'.length));
    if (declaredDir !== pluginDir && !declaredDir.startsWith(pluginDir + path.sep)) {
      skipped.push({ dir: coreSlot, reason: `declared_dependency_escapes_plugin_dir: ${declaredRef}` });
      continue;
    }
    let declaredResolvesToCore: boolean;
    try {
      declaredResolvesToCore = existsSync(declaredDir) && realpathSync(declaredDir) === runtimeCoreReal;
    } catch {
      // Unreadable declared slot — treat as not resolving to the canonical core.
      declaredResolvesToCore = false;
    }
    if (!declaredResolvesToCore) {
      skipped.push({ dir: coreSlot, reason: `declared_file_dep_does_not_resolve_to_runtime_core: ${declaredRef}` });
      continue;
    }

    // Gate 3 — content digest equality. Either side failing to digest is a
    // skip (rc-9), never an install failure.
    if (runtimeCoreDigest === null) {
      try {
        runtimeCoreDigest = digestDirectory(runtimeCoreDir);
      } catch (error) {
        skipped.push({ dir: coreSlot, reason: `canonical_core_unreadable: ${error instanceof Error ? error.message : String(error)}` });
        continue;
      }
    }
    let copyDigest: string;
    try {
      copyDigest = digestDirectory(coreSlot);
    } catch (error) {
      skipped.push({ dir: coreSlot, reason: `copy_unreadable: ${error instanceof Error ? error.message : String(error)}` });
      continue;
    }
    if (copyDigest !== runtimeCoreDigest) {
      skipped.push({ dir: coreSlot, reason: 'content_digest_mismatch' });
      continue;
    }

    // All gates hold: rename-swap the materialized copy for a canonical link.
    const backupPath = `${coreSlot}.pri912-materialized`;
    // The backup name is reserved by this pass; clear our own stale residue
    // so the swap below can never collide with it. If the residue cannot be
    // removed (e.g. Windows EBUSY from an AV scan holding the ~17k-file tree),
    // the swap would collide anyway — skip with the working copy intact
    // rather than throw out of the pass and fail a healthy install (rc-9).
    try {
      rmSync(backupPath, { recursive: true, force: true });
    } catch (error) {
      skipped.push({ dir: coreSlot, reason: `stale_backup_unremovable: ${error instanceof Error ? error.message : String(error)}` });
      continue;
    }
    try {
      renameSync(coreSlot, backupPath);
    } catch (error) {
      skipped.push({ dir: coreSlot, reason: `rename_aside_failed: ${error instanceof Error ? error.message : String(error)}` });
      continue;
    }
    try {
      if (isWindows()) {
        symlinkSync(runtimeCoreDir, coreSlot, 'junction');
      } else {
        symlinkSync(path.relative(path.dirname(coreSlot), runtimeCoreDir), coreSlot, 'dir');
      }
      if (realpathSync(coreSlot) !== runtimeCoreReal) {
        throw new Error('fresh link does not resolve to the canonical core');
      }
    } catch (error) {
      // Conversion failed — put the proven-identical copy back. The slot must
      // never be left empty or dangling; only a failed RESTORE breaks
      // resolution and deserves the fail → rollback channel. Remove the slot
      // unconditionally (force handles absent, lstat semantics unlinks a
      // dangling link without following it); guarding on existsSync would MISS
      // a dangling link — existsSync follows it to a missing target and returns
      // false — leaving it to make the restore renameSync fail.
      try {
        rmSync(coreSlot, { recursive: true, force: true });
        renameSync(backupPath, coreSlot);
      } catch (restoreError) {
        throw new Error(
          `PRI-912 core junction conversion failed at ${coreSlot} AND the materialized copy could not be restored: `
          + `${restoreError instanceof Error ? restoreError.message : String(restoreError)}`
          + ` (original conversion failure: ${error instanceof Error ? error.message : String(error)})`,
          { cause: restoreError },
        );
      }
      skipped.push({ dir: coreSlot, reason: `conversion_failed_restored: ${error instanceof Error ? error.message : String(error)}` });
      continue;
    }
    // The link is created and verified — the conversion is a success. Removing
    // the now-redundant materialized backup is only disk reclamation; if it
    // fails (Windows EBUSY/EPERM on ~17k files) we must NOT roll back a
    // working install. Leave the residue, warn, and keep the converted slot.
    try {
      rmSync(backupPath, { recursive: true, force: true });
    } catch (error) {
      logger.warn(
        `PRI-912: converted ${coreSlot} to a canonical junction but could not remove the redundant materialized backup at ${backupPath}: `
        + `${error instanceof Error ? error.message : String(error)} — reclamation deferred, install is healthy.`,
      );
    }
    converted.push(coreSlot);
  }

  if (converted.length > 0) {
    logger.info(`PRI-912: converted ${converted.length} materialized @principles/core plugin copy/copies to canonical junctions.`);
  }
  for (const skip of skipped) {
    logger.warn(`PRI-912: core dedup skipped at ${skip.dir}: ${skip.reason}`);
  }
  return { converted, alreadyCanonical, skipped };
}

function ensureCoreDependency(_targetDir: string): void {
  const coreDir = getInstalledCoreDir();
  if (!existsSync(coreDir)) {
    throw new Error('Installed @principles/core not found. Run installBundledCore first.');
  }
}

async function installCoreDependencies(): Promise<void> {
  const coreDir = getInstalledCoreDir();
  await prepareComponentDependencies(coreDir, 'Core');
}

async function installHostRuntimeDependencies(): Promise<void> {
  const hostRuntimeDir = getInstalledHostRuntimeDir();
  await prepareComponentDependencies(hostRuntimeDir, 'Host runtime');
}

async function installPdCliDependencies(): Promise<void> {
  const pdCliDir = getInstalledPdCliDir();
  await prepareComponentDependencies(pdCliDir, 'PD CLI');
}

async function installConsoleDependencies(): Promise<void> {
  const consoleDest = getInstalledConsoleDir();
  await prepareComponentDependencies(consoleDest, 'Console');
}

async function installMcpServerDependencies(): Promise<void> {
  await prepareComponentDependencies(getInstalledMcpServerDir(), 'MCP server');
}

const CONSOLE_PORT_MAX_RETRIES = 3;

// ─── PRI-1069 / PRI-1070 (G1, SPEC v1.2): child lifecycle + probe identity ───

export interface ChildJoinResult {
  readonly exited: boolean;
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly timedOut: boolean;
  readonly escalation: 'already_exited' | 'sigterm' | 'sigkill';
}

/**
 * P0-2 (SPEC v1.2 §5 step 6 / invariant I-4): terminate a child and WAIT for
 * its real exit event before anyone touches the directories it may hold.
 *
 * Discipline proven by the R8 Windows experiment (2026-11-02, real
 * better-sqlite3 .node): subscribing to 'exit' AFTER the kill signal loses
 * the event — the listener must be attached BEFORE the signal is sent.
 * Graceful SIGTERM first, bounded wait, then SIGKILL, then a second bounded
 * wait. If even that does not confirm exit, `exited: false` is returned and
 * the caller MUST NOT perform destructive directory operations (defer to a
 * recovery state instead).
 */
export async function terminateAndJoinChild(
  child: ChildProcess,
  options: { gracefulTimeoutMs?: number; killTimeoutMs?: number } = {},
): Promise<ChildJoinResult> {
  const gracefulTimeoutMs = options.gracefulTimeoutMs ?? CONSOLE_CHILD_GRACEFUL_EXIT_TIMEOUT_MS;
  const killTimeoutMs = options.killTimeoutMs ?? CONSOLE_CHILD_KILL_EXIT_TIMEOUT_MS;
  if (child.exitCode !== null || child.signalCode !== null) {
    return { exited: true, exitCode: child.exitCode, signal: child.signalCode, timedOut: false, escalation: 'already_exited' };
  }
  const joinExit = (ms: number): Promise<{ code: number | null; signal: string | null } | 'timeout'> =>
    new Promise((resolve) => {
      const timer = setTimeout(() => resolve('timeout'), ms);
      child.once('exit', (code, signal) => {
        clearTimeout(timer);
        resolve({ code, signal });
      });
    });
  try { child.kill('SIGTERM'); } catch { /* already gone — the join decides */ }
  let joined = await joinExit(gracefulTimeoutMs);
  if (joined !== 'timeout') {
    return { exited: true, exitCode: joined.code, signal: joined.signal, timedOut: false, escalation: 'sigterm' };
  }
  try { child.kill('SIGKILL'); } catch { /* already gone — the join decides */ }
  joined = await joinExit(killTimeoutMs);
  if (joined !== 'timeout') {
    return { exited: true, exitCode: joined.code, signal: joined.signal, timedOut: true, escalation: 'sigkill' };
  }
  return { exited: false, exitCode: null, signal: null, timedOut: true, escalation: 'sigkill' };
}

/** One probe attempt's diagnostics (SPEC v1.2 §14: attempt-level records;
 * the nonce VALUE itself is never recorded — only the match outcome). */
export interface ConsoleVerifyAttempt {
  readonly port: number;
  readonly pid: number | null;
  readonly outcome:
    | 'verified'
    | 'identity_mismatch'
    | 'http_error_status'
    | 'bad_body'
    | 'request_error'
    | 'child_exited_early'
    | 'join_failed';
  readonly httpStatus?: number;
  readonly exitCode?: number | null;
  readonly signal?: string | null;
  readonly stderrTail?: string;
  readonly detail?: string;
}

export class ConsoleVerifyError extends Error {
  readonly attempts: readonly ConsoleVerifyAttempt[];
  readonly hadJoinFailure: boolean;

  constructor(message: string, attempts: readonly ConsoleVerifyAttempt[]) {
    super(message);
    this.name = 'ConsoleVerifyError';
    this.attempts = attempts;
    this.hadJoinFailure = attempts.some((attempt) => attempt.outcome === 'join_failed');
  }
}

/**
 * PD Console health shape (rc-5: Object.hasOwn for untrusted keys).
 *
 * P1-B: `data.overall` is the PD-specific discriminative field — the generic
 * { success: true } envelope alone matches any service.
 *
 * (Hoisted above the G1 P0-1 identity verifier — its first caller in file
 * order — for no-use-before-define discipline; the autolaunch probe below
 * shares this same shape contract.)
 */
function isLaunchedConsoleHealth(payload: unknown): boolean {
  if (typeof payload !== 'object' || payload === null) return false;
  if (!Object.hasOwn(payload, 'success') || Reflect.get(payload, 'success') !== true) return false;
  if (!Object.hasOwn(payload, 'data')) return false;
  const data = Reflect.get(payload, 'data');
  if (typeof data !== 'object' || data === null) return false;
  if (!Object.hasOwn(data, 'overall')) return false;
  const overall = Reflect.get(data, 'overall');
  return overall === 'healthy' || overall === 'degraded' || overall === 'error';
}

/** P0-1 (SPEC v1.2 §7 / invariant I-3): the response must prove it came from
 * THIS child — a one-shot nonce injected through the child env and echoed by
 * /api/health. An old console, another local service, or a proxy returning
 * 200+JSON cannot know the value, so they all fail closed here. The nonce
 * value never enters logs or diagnostics. */
function isVerifiedConsoleIdentity(payload: unknown, expectedNonce: string): boolean {
  if (!isLaunchedConsoleHealth(payload)) return false;
  const data = Reflect.get(payload as object, 'data');
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return false;
  if (!Object.hasOwn(data, 'verifyNonce')) return false;
  return Reflect.get(data, 'verifyNonce') === expectedNonce;
}

/** Exported for real-subprocess tests (tests/console-verify-identity.test.ts). */
export async function verifyConsole(workspaceDir: string): Promise<{ ok: boolean; url: string; process: ChildProcess | null; attempts: readonly ConsoleVerifyAttempt[]; unconfirmedChildren: readonly ChildProcess[] }> {
  const consoleDest = getInstalledConsoleDir();
  const serverEntry = path.join(consoleDest, 'dist', 'server.js');

  if (!existsSync(serverEntry)) {
    return { ok: false, url: '', process: null, attempts: [{ port: 0, pid: null, outcome: 'child_exited_early', detail: 'Console server entry not found' }], unconfirmedChildren: [] };
  }

  // EP-06 regression guard (PR #1169): verify the web UI bundle exists BEFORE
  // spawning the server. Without dist/web/index.html the server returns 404
  // "Run npm run build:ui first" on every route — a fatal first-impression bug
  // for new users. npm install --ignore-scripts can remove dist/ in edge cases.
  const webIndex = path.join(consoleDest, 'dist', 'web', 'index.html');
  if (!existsSync(webIndex)) {
    return { ok: false, url: '', process: null, attempts: [{ port: 0, pid: null, outcome: 'child_exited_early', detail: 'Console web UI (dist/web/index.html) not found — bundle may be corrupted or npm install removed dist/.' }], unconfirmedChildren: [] };
  }

  // Build a shuffled port list to avoid retrying the same port
  const portRange: number[] = [];
  for (let p = CONSOLE_PORT_RANGE_MIN; p <= CONSOLE_PORT_RANGE_MAX; p++) portRange.push(p);
  for (let i = portRange.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    const a = portRange[i];
    const b = portRange[j];
    if (a === undefined || b === undefined) continue;
    portRange[i] = b;
    portRange[j] = a;
  }
  const portsToTry = portRange.slice(0, CONSOLE_PORT_MAX_RETRIES);

  const attempts: ConsoleVerifyAttempt[] = [];
  // Probe children whose exit could NOT be confirmed (join_failed). They stay
  // owned by the caller even when a later port attempt verifies — an orphan
  // probe child holding runtime-tree handles must never be dropped on the
  // floor (review 2026-11-02, Major: verifyConsole success path).
  const unconfirmedChildren: ChildProcess[] = [];

  for (const port of portsToTry) {
    // P0-1: fresh one-shot nonce per attempt (SPEC v1.2 §14), injected via
    // the parent env so the spawn below (env: { ...process.env }) passes it
    // to the child. Never argv (visible in process listings), never logged.
    // Cleared at every attempt exit below; attempts are strictly serial.
    const nonce = randomUUID();
    process.env.PD_CONSOLE_VERIFY_NONCE = nonce;
    const child = spawn(process.execPath, [serverEntry, '--workspace', workspaceDir, '--port', String(port), '--host', '127.0.0.1'], {
      stdio: 'pipe',
      env: { ...process.env },
      detached: false,
    });

    let childExited = false;
    let childExitCode: number | null = null;
    let childExitSignal: string | null = null;
    let childStderr = '';
    child.on('exit', (code, signal) => {
      childExited = true;
      childExitCode = code;
      childExitSignal = signal;
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      if (childStderr.length < 4000) childStderr += chunk.toString();
    });

    await new Promise<void>((resolve) => { setTimeout(resolve, CONSOLE_WARMUP_TIME_MS); });

    if (childExited) {
      delete process.env.PD_CONSOLE_VERIFY_NONCE;
      attempts.push({ port, pid: child.pid ?? null, outcome: 'child_exited_early', exitCode: childExitCode, signal: childExitSignal, stderrTail: childStderr.slice(-300) });
      continue; // Try next port
    }

    const healthUrl = new URL('/api/health', `http://127.0.0.1:${port}`);
    let ok = false;
    let reason = '';
    let reasonKind: 'http_error_status' | 'bad_body' | 'request_error' | 'identity_mismatch' = 'bad_body';
    let httpStatus: number | undefined;
    try {
      const result = await new Promise<{ statusCode: number; body: string }>((resolve, reject) => {
        const req = http.get(healthUrl, (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk: Buffer) => chunks.push(chunk));
          res.on('end', () => {
            resolve({ statusCode: res.statusCode ?? 0, body: Buffer.concat(chunks).toString() });
          });
        });
        req.on('error', reject);
        req.setTimeout(CONSOLE_HEALTH_CHECK_TIMEOUT_MS, () => { req.destroy(); reject(new Error('health check timeout')); });
      });
      httpStatus = result.statusCode;

      if (result.statusCode !== 200) {
        // SPEC v1.2 §14: a 502 (or any non-200) is recorded as an observed
        // fact with UNKNOWN attribution — we do NOT guess whether the
        // responder was PD, a proxy, or another local service (PRI-1069).
        reason = `Console /api/health returned HTTP ${result.statusCode} (expected 200); responder identity unknown`;
        reasonKind = 'http_error_status';
      } else if (!result.body || result.body.trim().length === 0) {
        reason = 'Console /api/health returned empty body';
        reasonKind = 'bad_body';
      } else {
        try {
          const parsed: unknown = JSON.parse(result.body);
          if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
            reason = 'Console /api/health returned non-object JSON';
            reasonKind = 'bad_body';
          } else if (!isVerifiedConsoleIdentity(parsed, nonce)) {
            // P0-1 fail-closed: a 200 JSON object that cannot echo THIS
            // attempt's nonce is some other responder (old console, foreign
            // local service, proxy) — never "verified".
            reason = 'Health responder did not prove this launch instance (nonce/shape mismatch) — rejected';
            reasonKind = 'identity_mismatch';
          } else {
            ok = true;
          }
        } catch {
          reason = 'Console /api/health returned malformed JSON';
          reasonKind = 'bad_body';
        }
      }
    } catch (e) {
      reason = `Console health check failed on port ${port}: ${e instanceof Error ? e.message : String(e)}. Stderr: ${childStderr.slice(-300)}`;
      reasonKind = 'request_error';
    }

    if (!ok) {
      // P0-2: bounded terminate + REAL exit join before moving on; the child
      // may hold native-module handles inside the runtime tree a later
      // restore would rename/delete (R8: a mapped .node kills rmSync with
      // EPERM, while a same-volume directory rename survives).
      const join = await terminateAndJoinChild(child);
      delete process.env.PD_CONSOLE_VERIFY_NONCE;
      const outcome: ConsoleVerifyAttempt['outcome'] = join.exited ? reasonKind : 'join_failed';
      if (!join.exited) unconfirmedChildren.push(child);
      attempts.push({
        port,
        pid: child.pid ?? null,
        outcome,
        httpStatus,
        exitCode: join.exitCode,
        signal: join.signal,
        stderrTail: childStderr.slice(-300),
        ...(join.exited
          ? (reason.length > 0 ? { detail: reason } : {})
          : { detail: `${reason}; child NOT confirmed exited after SIGKILL — destructive operations must be deferred` }),
      });
      // A join_failed attempt does NOT fail the whole probe — the next port
      // may still verify — but the unconfirmed child must stay owned: it is
      // carried out in `unconfirmedChildren` so the caller terminates (and
      // waits on) every probe child before any destructive directory op.
      continue; // Try next port
    }

    delete process.env.PD_CONSOLE_VERIFY_NONCE;
    attempts.push({ port, pid: child.pid ?? null, outcome: 'verified', httpStatus: 200 });
    return { ok: true, url: healthUrl.toString(), process: child, attempts, unconfirmedChildren };
  }

  return { ok: false, url: '', process: null, attempts, unconfirmedChildren };
}

// ─── Task 8: auto-launch console at end of successful install ────────────────

/**
 * Task 8: Open the system browser to a URL. Minimal platform dispatch — NOT a
 * launcher subsystem. The console launcher (port detection, reuse, health) is
 * `pd console open` (handleConsoleOpen), reused via spawn in autoLaunchConsole.
 *
 * Best-effort: failures are reported but do not crash the installer.
 */
function openBrowserForOnboarding(url: string): { opened: boolean; reason?: string } {
  let cmd: string;
  let args: string[];
  if (process.platform === 'win32') {
    cmd = process.env.ComSpec || 'cmd.exe';
    args = ['/c', 'start', '""', url];
  } else if (process.platform === 'darwin') {
    cmd = 'open';
    args = [url];
  } else {
    cmd = 'xdg-open';
    args = [url];
  }
  try {
    const child = spawn(cmd, args, { detached: true, stdio: 'ignore' });
    // P2-E: handle async spawn errors (ENOENT, EACCES) — without this,
    // the process emits an unhandled 'error' event that crashes Node.
    child.on('error', (err) => {
      logger.warn(`Browser launch failed asynchronously: ${err.message}`);
    });
    child.unref();
    return { opened: true };
  } catch (err) {
    return { opened: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

interface HealthProbeResponse {
  readonly status: number;
  readonly payload: unknown;
}

function requestConsoleHealth(
  port: number,
  timeoutMs: number,
): Promise<HealthProbeResponse | null> {
  return new Promise((resolve) => {
    const req = http.get(
      `http://127.0.0.1:${port}/api/health`,
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          let payload: unknown;
          try { payload = JSON.parse(Buffer.concat(chunks).toString()); } catch { payload = undefined; }
          resolve({ status: res.statusCode ?? 0, payload });
        });
      },
    );
    req.on('error', () => resolve(null));
    req.setTimeout(timeoutMs, () => { req.destroy(); resolve(null); });
  });
}

/**
 * Is the console READY on this port? A single bare GET is enough now: the
 * Console has no credential, so a 200 with a healthy envelope (and the
 * launcher's one-shot nonce where required) is the whole proof.
 */
async function probeAutolaunchHealth(
  port: number,
  timeoutMs = 1500,
): Promise<boolean> {
  const response = await requestConsoleHealth(port, timeoutMs);
  return response !== null && response.status === 200 && isLaunchedConsoleHealth(response.payload);
}

/**
 * Task 8: Auto-launch the PD Console at the end of a successful install by
 * reusing `pd console open` (handleConsoleOpen). Spawns it detached so the
 * console survives installer exit, then opens the browser to /welcome.
 *
 * EP-03: on failure, returns consoleUrl=undefined + fallbackAction so the user
 *        is never left without a way to reach the console.
 * EP-04: detached + unref keeps the console running after the installer exits.
 * EP-06: reuses pd-cli's handleConsoleOpen via the CLI entry — no new launcher.
 */
/**
 * WorkBuddy remediation (review 2026-10-13 §4 P1): the auto-launched Console,
 * canary and manual-open instructions must manage the directory the host's
 * hook/worker actually read. For the WorkBuddy host that is the dedicated
 * governance workspace (SPEC §4.1) — NOT the project directory, which is only
 * the task project path. Other hosts keep the project workspace.
 */
export function resolveConsoleWorkspaceDir(
  host: HostTarget | undefined,
  projectWorkspaceDir: string,
  homeDir: string,
): string {
  return host === 'workbuddy' ? getWorkbuddyWorkspaceDir(homeDir) : projectWorkspaceDir;
}

async function autoLaunchConsole(workspaceDir: string): Promise<{ consoleUrl?: string; fallbackAction?: string; manualOpenCommand: string }> {
  const manualOpenCommand = `pd console open --workspace "${workspaceDir}"`;
  // Test/smoke seam (mirrors PD_SKIP_GLOBAL_SHIM): isolated installs (release
  // smoke, upgrade gate) must not spawn a detached console that holds the
  // installed files open or pops a browser.
  if (process.env.PD_SKIP_CONSOLE_AUTOLAUNCH === '1' || process.env.PD_SKIP_CONSOLE_AUTOLAUNCH === 'true') {
    logger.info('Skipping console auto-launch (PD_SKIP_CONSOLE_AUTOLAUNCH set).');
    return { manualOpenCommand };
  }
  const pdCliEntry = path.join(getInstalledPdCliDir(), 'dist', 'index.js');
  if (!existsSync(pdCliEntry)) {
    return { manualOpenCommand, fallbackAction: `${manualOpenCommand} (auto-launch skipped: pd CLI entry not found)` };
  }

  // Spawn `pd console open` detached — reuses handleConsoleOpen (port detection,
  // reuse, health). --no-browser because we open /welcome ourselves.
  const launchArgs = [pdCliEntry, 'console', 'open', '--workspace', workspaceDir, '--no-browser'];
  const child = spawn(
    process.execPath,
    launchArgs,
    { detached: true, stdio: 'ignore', shell: false },
  );
  child.unref();

  // Wait for the console to become ready (bounded poll on
  // CONSOLE_AUTOLAUNCH_BASE_PORT..+CONSOLE_AUTOLAUNCH_PORT_SCAN_LIMIT-1).
  const deadline = Date.now() + CONSOLE_AUTOLAUNCH_READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    for (let i = 0; i < CONSOLE_AUTOLAUNCH_PORT_SCAN_LIMIT; i++) {
      const port = CONSOLE_AUTOLAUNCH_BASE_PORT + i;

      if (await probeAutolaunchHealth(port)) {
        // HashRouter: client-side routes live under /#/ — server only serves /,
        // anything else (incl. /welcome) is treated as an API path and returns
        // 404 not_found. Must open /#/welcome so the browser loads index.html
        // first, then React Router handles the hash segment client-side.
        const consoleUrl = `http://127.0.0.1:${port}/#/welcome`;
        const browserResult = openBrowserForOnboarding(consoleUrl);
        if (!browserResult.opened) {
          // EP-03: browser failed but console is up — surface the URL + reason.
          return { consoleUrl, manualOpenCommand, fallbackAction: `Console ready at ${consoleUrl} (browser auto-open failed: ${browserResult.reason ?? 'unknown'} — open the URL manually)` };
        }
        return { consoleUrl, manualOpenCommand };
      }
    }
     
    await new Promise((r) => setTimeout(r, CONSOLE_AUTOLAUNCH_POLL_INTERVAL_MS));
  }

  // EP-03: console did not become ready — provide manual launch instruction.
  return { manualOpenCommand, fallbackAction: `${manualOpenCommand} (auto-launch did not become ready in time; run manually)` };
}

interface CopyOptions {
  pluginDir: string;
  language: string;
  workspaceDir: string;
  mode: 'smart' | 'force';
}

async function copyCoreTemplates(opts: CopyOptions): Promise<number> {
  let count = 0;
  const coreSrc = path.join(opts.pluginDir, 'templates', 'langs', opts.language, 'core');
  const fallbackSrc = path.join(opts.pluginDir, 'templates', 'langs', 'en', 'core');
  const actualSrc = existsSync(coreSrc) ? coreSrc : (existsSync(fallbackSrc) ? fallbackSrc : null);

  if (!actualSrc) return 0;

  const files = readdirSync(actualSrc).filter(f => f.endsWith('.md'));
  for (const file of files) {
    const srcPath = path.join(actualSrc, file);
    const destPath = path.join(opts.workspaceDir, file);

    // 验证目标路径安全
    validateWorkspacePath(destPath, opts.workspaceDir);

    if (existsSync(destPath) && opts.mode === 'smart') {
      await fse.copy(srcPath, `${destPath}.update`, { overwrite: true });
    } else {
      await fse.ensureDir(opts.workspaceDir);
      await fse.copy(srcPath, destPath, { overwrite: true });
    }
    count++;
  }
  return count;
}

async function copyPrinciplesLayer(opts: CopyOptions): Promise<number> {
  let count = 0;

  // 根据语言选择源目录
  const langPrinciplesSrc = path.join(opts.pluginDir, 'templates', 'langs', opts.language, 'principles');
  const defaultPrinciplesSrc = path.join(opts.pluginDir, 'templates', 'workspace', '.principles');
  const actualPrinciplesSrc = existsSync(langPrinciplesSrc) ? langPrinciplesSrc : defaultPrinciplesSrc;

  const principlesDest = path.join(opts.workspaceDir, '.principles');

  if (!existsSync(actualPrinciplesSrc)) return 0;

  const files = readdirSync(actualPrinciplesSrc);

  for (const file of files) {
    const srcPath = path.join(actualPrinciplesSrc, file);
    const destPath = path.join(principlesDest, file);
    if (statSync(srcPath).isDirectory()) continue;

    // 验证目标路径安全
    validateWorkspacePath(destPath, opts.workspaceDir);

    if (existsSync(destPath) && opts.mode === 'smart') {
      await fse.copy(srcPath, `${destPath}.update`, { overwrite: true });
    } else {
      await fse.ensureDir(principlesDest);
      await fse.copy(srcPath, destPath, { overwrite: true });
    }
    count++;
  }

  const modelsSrc = path.join(actualPrinciplesSrc, 'models');
  const modelsDest = path.join(principlesDest, 'models');
  if (existsSync(modelsSrc)) {
    await fse.ensureDir(modelsDest);
    await fse.copy(modelsSrc, modelsDest, { overwrite: true });
    count += readdirSync(modelsDest).length;
  }
  return count;
}

async function generateConfigYamlConfig(
  workspaceDir: string,
  runtimeProfile?: RuntimeProfileInput,
): Promise<string> {
  const configPath = getConfigYamlPath(workspaceDir);
  const configDir = path.dirname(configPath);
  await fse.ensureDir(configDir);
  // Fix-4 (P0-BUG-4): pass through the runtime profile so the generated
  // config.yaml's pd.default profile is pre-filled (avoids silent LLM
  // failures on first run).
  // CodeQL TOCTOU fix: use 'wx' (exclusive create) instead of existsSync
  // + default write. The 'wx' flag atomically creates the file and fails
  // with EEXIST if it already exists — eliminating the race between a
  // separate check and the write. If the file exists (pre-existing or
  // created concurrently), EEXIST is caught below and we preserve the
  // existing config (PRI-308).
  try {
    writeFileSync(
      configPath,
      generateConfigYamlContent(runtimeProfile),
      { encoding: 'utf8', flag: 'wx' },
    );
    return configPath;
  } catch (err) {
    // rc-2: instanceof Error is the runtime guard; the cast extends the type
    // with the optional `code` property present on Node.js fs errors.
    if (!(err instanceof Error) || (err as Error & { code?: string }).code !== 'EEXIST') throw err;
  }

  // PRI-308: preserve existing valid config.yaml (file exists — either
  // pre-existing or created concurrently between ensureDir and writeFileSync).
  // PRI-645: the config is preserved verbatim — the PRI-523 host-flag
  // migration that wrote registry-default entries here is retired (defaults
  // belong to the registry; effective values are unchanged).
  try {
    validateExistingConfigYamlForPreserve(workspaceDir);
    // Existing config is structurally valid — preserve it
    logger.info(`Existing .pd/config.yaml is valid, preserving it`);
    // rc-9-no-silent-fallback: when the user supplied a runtimeProfile via
    // --provider/--api-key-env but an existing valid config.yaml was found,
    // the profile is NOT written. Emit a clear warning so the user knows
    // their --provider/--api-key-env flags were ignored and how to update
    // the profile manually.
    if (runtimeProfile) {
      logger.warn(
        `--provider/--api-key-env were provided but an existing valid .pd/config.yaml was found. ` +
        `The runtime profile was not written. To update it, edit .pd/config.yaml or run: pd console open --workspace "${workspaceDir}"`,
      );
    }
    return configPath;
  } catch (e) {
    if (e instanceof ExistingConfigVerifyInfraError) {
      // Read failure (EPERM/EBUSY/...) while verifying the existing config:
      // the config file is NOT necessarily malformed. Do NOT advise deleting
      // it — that would destroy a valid Owner config.
      const reason = e instanceof Error ? e.message : String(e);
      throw new Error(
        `Failed to verify existing .pd/config.yaml: ${reason}. ` +
        'The existing config was left unchanged. Close other tools holding the file, check disk permissions and free space, then re-run the installer.',
        { cause: e },
      );
    }
    // Existing config is malformed — fail loud, do not overwrite
    const reason = e instanceof Error ? e.message : String(e);
    throw new Error(`Existing .pd/config.yaml is malformed: ${reason}. Delete the file and re-run the installer, or fix it manually.`, { cause: e });
  }
}

/**
 * Does this workspace pointer name one fixed directory in every process?
 *
 * Mirrors `isDriveQualifiedWorkspacePath` in the plugin's workspace-dir
 * validation (openclaw-plugin/src/core/workspace-dir-validation.ts), which is
 * the reading side. It is duplicated rather than imported because the installer
 * is the bootstrap package: it must not depend on the runtime it installs.
 * Keep the two in step.
 *
 * `path.isAbsolute` alone is not enough on Windows — it accepts root-relative
 * values like `\workspace`, which resolve against whatever drive the calling
 * process is on.
 */
function isUsableWorkspacePointer(workspaceDir: string): boolean {
  if (typeof workspaceDir !== 'string' || !workspaceDir.trim()) return false;
  if (!path.isAbsolute(workspaceDir)) return false;
  if (process.platform !== 'win32') return true;
  return /^[A-Za-z]:[\\/]/.test(workspaceDir) || /^\\\\[^\\/]/.test(workspaceDir);
}

/**
 * Fail loud on a workspace pointer that would make the installed config point
 * at a different directory depending on which process reads it. The message is
 * structured for an operator or agent: what is wrong, what was received, what
 * is expected, and what to re-run.
 */
function assertUsableWorkspaceDir(workspaceDir: string): void {
  if (isUsableWorkspacePointer(workspaceDir)) return;
  throw new Error(
    'Workspace path must be an absolute path that names one fixed directory.\n' +
    `  Received: ${JSON.stringify(workspaceDir)}\n` +
    '  Expected: a drive-qualified path such as "D:\\.openclaw\\workspace",\n' +
    '            a UNC path such as "\\\\server\\share\\workspace",\n' +
    `            or on other platforms "/home/me/workspace"\n` +
    '  Rejected: relative paths, drive-relative paths ("D:workspace") and\n' +
    '            root-relative paths ("\\workspace") — each of these names a\n' +
    '            different directory depending on the calling process.\n' +
    '\n' +
    'Re-run with the path quoted, so the shell cannot strip its separators:\n' +
    '  --workspace "D:\\.openclaw\\workspace"',
  );
}

/**
 * Where the OpenClaw plugin (and therefore the MCP launcher) reads the
 * Owner-declared governance workspace. The gateway process, hook processes and
 * MCP children all run with different environments, and the MCP child has its
 * environment sanitized by the host (PD_WORKSPACE_DIR / HOME are stripped), so
 * this FILE is the only signal every one of them can see.
 */
const OPENCLAW_PD_CONFIG_FILENAME = 'principles-disciple.json';

export interface OpenClawWorkspaceDeclarationInspection {
  readonly configPath: string;
  /**
   * absent      — no declaration yet (first install writes it)
   * compatible  — the existing declaration names this workspace (no write)
   * conflict    — the existing declaration names a DIFFERENT workspace
   * invalid     — the file exists but cannot be trusted as a declaration
   * unreadable  — the file exists but could not be read
   */
  readonly state: 'absent' | 'compatible' | 'conflict' | 'invalid' | 'unreadable';
  readonly declaredWorkspace?: string;
  readonly reason?: string;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Same-directory identity for a workspace pointer (Windows is case-insensitive). */
function sameWorkspaceTarget(left: string, right: string): boolean {
  const normalize = (value: string): string => {
    const resolved = path.resolve(value);
    const trimmed = resolved.length > 1 ? resolved.replace(/[\\/]+$/, '') : resolved;
    return process.platform === 'win32' ? trimmed.toLowerCase() : trimmed;
  };
  return normalize(left) === normalize(right);
}

/**
 * Read the existing declaration as UNTRUSTED input (it is a plain file on disk)
 * and classify it. Never overwrites and never silently repairs anything.
 */
export function inspectOpenClawWorkspaceDeclaration(workspaceDir: string): OpenClawWorkspaceDeclarationInspection {
  const configPath = path.join(getOpenClawDir(), OPENCLAW_PD_CONFIG_FILENAME);
  if (!existsSync(configPath)) return { configPath, state: 'absent' };

  let raw: string;
  try {
    raw = readFileSync(configPath, 'utf-8');
  } catch (e) {
    return { configPath, state: 'unreadable', reason: describeError(e) };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return { configPath, state: 'invalid', reason: `it is not valid JSON (${describeError(e)})` };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { configPath, state: 'invalid', reason: 'the root value is not a JSON object' };
  }
  const declaredRaw = Object.hasOwn(parsed, 'workspace') ? Reflect.get(parsed, 'workspace') : undefined;
  if (typeof declaredRaw !== 'string' || declaredRaw.trim().length === 0) {
    return { configPath, state: 'invalid', reason: 'it has no non-empty string "workspace" field' };
  }
  const declared = declaredRaw.trim();
  if (!isUsableWorkspacePointer(declared)) {
    return {
      configPath,
      state: 'invalid',
      declaredWorkspace: declared,
      reason: 'the "workspace" value does not name one fixed absolute directory',
    };
  }
  if (!sameWorkspaceTarget(declared, workspaceDir)) {
    return { configPath, state: 'conflict', declaredWorkspace: declared };
  }
  return { configPath, state: 'compatible', declaredWorkspace: declared };
}

function throwOnIncompatibleDeclaration(inspection: OpenClawWorkspaceDeclarationInspection, workspaceDir: string): void {
  if (inspection.state === 'absent' || inspection.state === 'compatible') return;
  if (inspection.state === 'conflict') {
    throw new Error(
      'An existing OpenClaw PD config declares a DIFFERENT workspace; it was left unchanged.\n' +
      `  Config:    ${inspection.configPath}\n` +
      `  Declared:  ${JSON.stringify(inspection.declaredWorkspace)}\n` +
      `  Requested: ${JSON.stringify(path.resolve(workspaceDir))}\n` +
      'The pd-recall MCP server can only serve the workspace declared in this file, so the installer\n' +
      'never overwrites it. Otherwise the host would report a successful install while recall served\n' +
      'another workspace.\n' +
      `  To keep the existing workspace, re-run with --workspace ${JSON.stringify(inspection.declaredWorkspace)}.\n` +
      `  To switch deliberately, back up ${inspection.configPath}, remove it, then re-run for the new workspace.`,
    );
  }
  throw new Error(
    `The existing OpenClaw PD config cannot be verified and was left unchanged (${inspection.reason}).\n` +
    `  Config: ${inspection.configPath}\n` +
    'Expected a JSON object with an absolute "workspace" string.\n' +
    '  Fix it manually, or back it up and remove it, then re-run the installer.',
  );
}

/**
 * Read-only preflight: refuse BEFORE any runtime mutation when the existing
 * declaration points somewhere else (or cannot be trusted). This is the check
 * that keeps an install from "succeeding" while pd-recall serves a different
 * workspace.
 */
export function assertOpenClawWorkspaceDeclarationCompatible(workspaceDir: string): void {
  throwOnIncompatibleDeclaration(inspectOpenClawWorkspaceDeclaration(workspaceDir), workspaceDir);
}

export interface OpenClawWorkspaceDeclarationWriteResult {
  readonly configPath: string;
  readonly action: 'created' | 'unchanged';
}

/**
 * Ensure the OpenClaw plugin can locate the governance workspace through the
 * file declaration. Idempotent: a compatible existing declaration is left
 * byte-identical (no rewrite, no installedAt churn). A conflicting/invalid one
 * fails loud and is never overwritten.
 */
export async function ensureOpenClawWorkspaceDeclaration(
  workspaceDir: string,
  channels: string[],
): Promise<OpenClawWorkspaceDeclarationWriteResult> {
  // Defense in depth: the same refusal the install entry makes, kept here
  // because this is the only writer of the pointer the plugin reads on every
  // hook, and other callers reach it without passing through install().
  assertUsableWorkspaceDir(workspaceDir);

  const inspection = inspectOpenClawWorkspaceDeclaration(workspaceDir);
  throwOnIncompatibleDeclaration(inspection, workspaceDir);
  if (inspection.state === 'compatible') {
    return { configPath: inspection.configPath, action: 'unchanged' };
  }

  const resolvedWorkspace = path.resolve(workspaceDir);
  const config: Record<string, unknown> = {
    workspace: resolvedWorkspace,
    state: path.join(resolvedWorkspace, '.state'),
    channels,
    installedAt: new Date().toISOString(),
    mvpFirst: true,
  };

  await fse.ensureDir(path.dirname(inspection.configPath));
  await fse.writeJson(inspection.configPath, config, { spaces: 2 });
  return { configPath: inspection.configPath, action: 'created' };
}

export interface InstallResult {
  success: boolean;
  workspaceDir: string;
  configYamlPath: string;
  templatesCount: number;
  components: ComponentStatus;
  verification: VerificationResult;
  enabledChannels: string[];
  nextAction: string;
  reason?: string;
  component?: string;
  dependency?: string;
  error?: string;
  /** Task 8: URL the browser was opened to when the installer auto-launched the
   * console via `pd console open`. Undefined when auto-launch was skipped or failed. */
  consoleUrl?: string;
  /** ADR-0020 §2.3: Host-side install results (one per HostInstaller). */
  hostResults?: HostInstallResult[];
  /** UPDATE CHAIN (2026-11-11): one line per host this run actually touched,
   *  naming the runtime it now resolves. Derived, never persisted. */
  hostSummary?: string[];
  /**
   * Marketplace contract (2026-11-07): host results that ended in a manual
   * operator step (e.g. the Codex Marketplace install) — present ONLY when
   * non-empty. The aggregate result is then NOT success (explicit partial
   * completion, non-zero exit); the runtime itself stays installed and usable.
   */
  manualActions?: HostInstallResult[];
  /** ADR-0024 D-2 (PRI-664): transaction journal record for this install.
   * Undefined when the mutation never began (pre-mutation refusal/throw). */
  journal?: InstallJournalRecord;
  /** PRI-726: degraded-success notice — the payload committed but the OpenClaw
   * gateway did not come back up. Present ONLY on success results (a failed
   * install reports its own error/nextAction); ReleaseManager.apply propagates
   * it verbatim to the Console `gatewayNotice` contract (PRI-723 legacy path
   * parity). */
  gatewayNotice?: string;
  /**
   * 5B: ACTIVE rules the upgrade compatibility check could not read. Present
   * ONLY when non-empty. `success` is NOT affected — the install completed,
   * but those rules' compatibility is unverified (see the printed block).
   * Carried here so `--json`/quiet mode is not the only blind path.
   */
  compatibilityWarnings?: string[];
}

/** Observability record for one installer transaction (ADR-0024 D-2). */
export interface InstallJournalRecord {
  readonly transactionId: string;
  /** Journal file: `~/.pd/transactions/<transactionId>.jsonl` (D-6, runtime scope). */
  readonly journalPath: string;
  /** True when a mid-flight journal append failed (Tier-2 degradation) and
   * later transitions were skipped — the backup/restore safety net remained
   * authoritative for this transaction. */
  readonly degraded: boolean;
}

/**
 * Marketplace contract (2026-11-07): partition host installer results into
 * REAL failures and pending MANUAL actions (e.g. the Codex Marketplace
 * install). A real failure aborts the install transaction (atomic rollback);
 * a manual action is an explicit partial completion — it must NOT trigger the
 * other hosts' rollback (the OpenClaw `--host all` defect), but it does make
 * the aggregate result non-successful with a non-zero exit code so automation
 * cannot mistake partial for complete. Pure: unit-testable without I/O.
 */
export function partitionHostInstallResults(
  results: readonly HostInstallResult[],
): { failures: HostInstallResult[]; manualActions: HostInstallResult[] } {
  const failures: HostInstallResult[] = [];
  const manualActions: HostInstallResult[] = [];
  for (const result of results) {
    if (result.success) continue;
    if (result.manualActionRequired === true) manualActions.push(result);
    else failures.push(result);
  }
  return { failures, manualActions };
}

/**
 * UPDATE CHAIN (2026-11-11): the Owner-visible install summary. Every host
 * this run actually touched gets one line naming the runtime it now resolves,
 * so covering an already-installed host can never happen silently.
 *
 * The two runtime layouts are different authorities, not interchangeable
 * views: the shared canonical runtime is `<dir>/<component>/package.json`,
 * while Codex's PLUGIN_DATA copy is `<dir>/node_modules/<pkg>/package.json`.
 * Reading the canonical dir with the PLUGIN_DATA reader made every
 * OpenClaw/WorkBuddy line print "runtime not verified".
 *
 * Derived from the existing host results plus the installed runtime dirs —
 * never persisted, never a second install-state authority.
 */
export function summarizeTouchedHosts(
  results: readonly HostInstallResult[],
  deps: { canonicalRuntimeDir?: string; codexRuntimeDir?: string; codexRuntimeReadable?: boolean } = {},
): string[] {
  const canonical = readCanonicalRuntimeCohort(deps.canonicalRuntimeDir ?? getPdRuntimeDir());
  const codexHome = process.env.CODEX_HOME ?? path.join(getHomeDir(), '.codex');
  // `resolvePluginDataRoot` returns the PLUGIN DATA ROOT; the installed cohort
  // lives one level below it in `runtime/`. Appending `node_modules` to the
  // root read a directory that never exists, so an install that had just
  // refreshed Codex to the payload pin still printed "runtime not verified".
  const pluginDataRoot = resolvePluginDataRoot(codexHome, 'principles');
  const codexRuntimeDir = deps.codexRuntimeDir
    ?? (pluginDataRoot === undefined ? undefined : path.join(pluginDataRoot, 'runtime'));
  const codex = deps.codexRuntimeReadable === false || codexRuntimeDir === undefined
    ? undefined
    : readInstalledRuntimeCohort(codexRuntimeDir);
  return results.map((host) => {
    if (!host.success) {
      return `Host "${host.hostId}" — not updated: ${host.reason ?? 'unknown failure'}`;
    }
    const cohort = host.hostId === 'codex' ? codex : canonical;
    const version = cohort
      ? `core@${cohort.core}, codex-adapter@${cohort.codexAdapter}, host-runtime@${cohort.hostRuntime}, mcp@${cohort.mcpServer}`
      : 'runtime not verified';
    return `Host "${host.hostId}" — ${version} (${host.configAction ?? 'updated'})`;
  });
}

/**
 * ADR-0020 §2.3: Run host installers for the selected HostTarget.
 *
 * Iterates the concrete HostInstaller instances returned by getHostInstallers()
 * and calls install() on each. Returns an array of results — one per host.
 *
 * rc-9: failures in one host do NOT abort the other (e.g. if Codex adapter
 * is missing, OpenClaw install still succeeds). Each result includes a
 * structured reason + nextAction.
 */
async function runHostInstallers(
  host: HostTarget,
  ctx: HostInstallContext,
): Promise<HostInstallResult[]> {
  const installers = getHostInstallers(host);
  const results: HostInstallResult[] = [];
  for (const installer of installers) {
    try {
      const result = await installer.install(ctx);
      results.push(result);
    } catch (err) {
      // rc-9: never silently swallow — record as failure with reason.
      results.push({
        success: false,
        hostId: installer.hostId,
        configAction: 'skipped',
        reason: `Installer threw: ${err instanceof Error ? err.message : String(err)}`,
        nextAction: `Check ${installer.hostId} host configuration and re-run: npx create-principles-disciple install --host ${installer.hostId}`,
      });
    }
  }
  return results;
}

export interface InstallRunMode {
  /** Suppress human output (spinner / progress). True under --json. */
  quiet?: boolean;
  /** No interactive prompts. True under --yes / --non-interactive / --json. */
  nonInteractive?: boolean;
}

// ---------------------------------------------------------------------------
// ADR-0024 D-2 (PRI-664): transaction journal integration.
//
// The installer already owned digest verification, backup/rename-swap and
// failure recovery; what it lacked was an auditable transaction lifecycle.
// This glue reuses the EXISTING transaction journal (update/transaction-
// journal.ts — one JSONL file per transaction under ~/.pd/transactions/,
// journal-first append+fsync ordering). No new journal system, no history
// duplication (D-7 convergence stays with the console-side task).
//
// Journal failure policy (documented in
// docs/architecture/installer-journal-integration-analysis.md §3.2):
// - Tier 1 — the FIRST ('planned') append fails before any mutation:
//   the caller REFUSES to install (fail loud, zero side effects).
// - Tier 2 — a later append fails mid-mutation: degrade (log + mark +
//   skip further appends) and continue under the backup/restore safety
//   net, which does not depend on the journal. Journal failure must not
//   brick the installation.
// ---------------------------------------------------------------------------

export interface InstallerJournal {
  readonly transactionId: string;
  readonly journalPath: string;
  readonly releaseId: string;
  readonly productVersion: string;
  /**
   * PRI-926: the version the update started FROM. ReleaseManager apply only —
   * the active record's productVersion at plan time, journaled once on the
   * planned transition. Absent for installer-initiated (install-*)
   * transactions, which are not Owner-facing update history.
   */
  readonly preUpdateProductVersion?: string;
  /**
   * Embedded product identity (SPEC §12): the payload's stamped source commit.
   * Null = the payload carries no embedded identity (legacy shape) — provenance
   * is then visibly unavailable in journal/active.json, never faked.
   */
  readonly sourceCommit: string | null;
  /**
   * Provenance of `productVersion`: `embedded` (installer read the payload's
   * stamp) or `signed_channel` (ReleaseManager adopted a signed release).
   * These are the only two producible values — see `InstallerProductVersionSource`.
   */
  readonly productVersionSource: InstallerProductVersionSource;
  readonly releaseMetadataDigest: string;
  /** PRI-664 review: provenance of releaseMetadataDigest ('manifest' | 'package_manifest' | 'fallback' | 'signed_channel'). */
  readonly releaseMetadataDigestSource: ReleaseMetadataDigestSource;
  /**
   * PRI-698 Phase 1: dual-slot generation continuity. Standalone installs keep
   * the historical `1`; an externally adopted transaction (ReleaseManager
   * apply orchestration) supplies activeRecord.generation + 1.
   */
  readonly generation: number;
  degraded: boolean;
  /** Last successfully journaled state — the `from` for failure-path transitions. */
  lastState: TransactionState | null;
}

function sha256File(filePath: string): string {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex');
}

/**
 * Identity of the payload being installed (SPEC §12). The PRODUCT VERSION comes
 * only from the EMBEDDED identity stamp (`_release/product-identity.json`,
 * written by the asset build BEFORE the artifact bytes were hashed) — there is
 * no manifest fallback for it any more, and a payload without a stamp is
 * refused rather than guessed (contract below).
 *
 * `releaseMetadataDigest` keeps its own, unrelated provenance ladder
 * (`manifest` → `package_manifest` → `fallback`): that digest is an integrity
 * marker whose source is a REAL fact, so the journal never stores a placeholder
 * where a verifiable value is available (same discipline as
 * legacy-migration.ts), and the last-resort `fallback` hashes the literal
 * reason string only to satisfy the journal's 64-hex format requirement.
 * Nothing in that ladder may be promoted to the product version.
 *
 * PRI-709 P0-2 (PRI-698 audit F-1): without an embedded stamp the installer
 * once derived `productVersion` from a component package manifest — the
 * exact promotion of a diagnostic to product authority that stamped every
 * legacy-installer machine with `bundled-1.74.1-*` (PRI-874).
 *
 * Embedded-stamp contract (fail-closed, rc-2/rc-3): the payload MUST carry
 * `_release/product-identity.json`. A PRESENT but malformed stamp throws
 * BEFORE any install mutation (the caller journals `planned` before the
 * first filesystem mutation, so a throw here leaves the runtime untouched).
 * A MISSING stamp now throws too — component manifest versions are
 * diagnostics and are never promoted to the product version. Only
 * train/asset builds stamp their payloads (PRI-874 publish guards); a tree
 * without a stamp is not an installable release.
 */
/**
 * The ONLY producible product-version provenances:
 * - `embedded`       — the installer read the payload's `_release/product-identity.json`;
 * - `signed_channel` — ReleaseManager adopted a signed release document.
 *
 * PRI-874 review: `package_manifest` and `unavailable` were dropped. Once the
 * component-manifest fallback was deleted, no production seam could return
 * either value, so advertising them described a branch no seam can reach (the
 * ERR-099 class this repository's error index forbids). This is a compile-time
 * narrowing only: the value lives in the in-memory installer transaction and is
 * NOT part of the persisted journal/active.json schema, so no stored row is
 * reinterpreted.
 */
export type InstallerProductVersionSource = 'embedded' | 'signed_channel';

export interface InstallerPayloadIdentity {
  readonly productVersion: string;
  readonly sourceCommit: string | null;
  readonly productVersionSource: InstallerProductVersionSource;
  readonly releaseMetadataDigest: string;
  readonly releaseMetadataDigestSource: ReleaseMetadataDigestSource;
}

function resolveInstallerPayloadIdentity(pluginDir: string): InstallerPayloadIdentity {
  const pdCliPkgPath = path.join(pluginDir, 'pd-cli', 'package.json');
  const assetManifestPath = path.join(pluginDir, '_release', 'manifest.json');
  const embeddedIdentityPath = path.join(pluginDir, '_release', 'product-identity.json');
  let releaseMetadataDigest: string;
  let releaseMetadataDigestSource: ReleaseMetadataDigestSource;
  if (existsSync(assetManifestPath)) {
    releaseMetadataDigest = sha256File(assetManifestPath);
    releaseMetadataDigestSource = 'manifest';
  } else if (existsSync(pdCliPkgPath)) {
    releaseMetadataDigest = sha256File(pdCliPkgPath);
    releaseMetadataDigestSource = 'package_manifest';
  } else {
    releaseMetadataDigest = createHash('sha256').update('installer-payload-missing-identity').digest('hex');
    releaseMetadataDigestSource = 'fallback';
  }
  if (existsSync(embeddedIdentityPath)) {
    // Present stamp: strict validation, no fallback. A malformed identity must
    // stop the install before it mutates anything rather than journal a guess.
    let embeddedValue: unknown;
    try {
      embeddedValue = JSON.parse(readFileSync(embeddedIdentityPath, 'utf8')) as unknown;
    } catch (error) {
      throw new ProductIdentityError(
        'productIdentity',
        `The release payload's embedded product identity is not valid JSON (${embeddedIdentityPath}): `
        + `${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const embedded = parseEmbeddedProductIdentity(embeddedValue);
    return {
      productVersion: embedded.productVersion,
      sourceCommit: embedded.sourceCommit,
      productVersionSource: 'embedded',
      releaseMetadataDigest,
      releaseMetadataDigestSource,
    };
  }
  // PRI-874: no embedded identity → refuse the install. A component manifest
  // version is a diagnostic and is never promoted to the product version
  // (rc-3 fail-loud; this legacy fallback is what produced the
  // `bundled-1.74.1-*` downgrades). The digest computed above keeps its
  // provenance label for journals of refused attempts.
  throw new ProductIdentityError(
    'productIdentity',
    `The release payload has no embedded product identity (missing: ${embeddedIdentityPath}). `
    + 'Component manifest versions are diagnostics and are never the product version, so the install is refused. '
    + 'Next action: install a payload produced by the release train or build-release-asset (both stamp _release/product-identity.json).',
  );
}

/** Opens one installer transaction: `~/.pd/transactions/<transactionId>.jsonl`. */
export function beginInstallerJournal(pluginDir: string, preResolvedIdentity?: InstallerPayloadIdentity): InstallerJournal {
  // PRI-874 review: `install()` resolves the identity as a PRE-FLIGHT (before
  // the gateway is stopped or the workspace is created) and hands the result
  // here, so the identity is computed exactly once and the journal cannot
  // disagree with what the pre-flight validated. Callers that open a journal
  // directly (tests, ReleaseManager adoption) keep the old single-argument
  // behavior and resolve inside this function.
  const { productVersion, sourceCommit, productVersionSource, releaseMetadataDigest, releaseMetadataDigestSource } = preResolvedIdentity ?? resolveInstallerPayloadIdentity(pluginDir);
  const transactionId = `install-${Date.now()}-${randomUUID().slice(0, 8)}`;
  const journalPath = path.join(getPdDir(), 'transactions', `${transactionId}.jsonl`);
  const releaseId = `bundled-${productVersion}-${releaseMetadataDigest.slice(0, 12)}`;
  return { transactionId, journalPath, releaseId, productVersion, sourceCommit, productVersionSource, releaseMetadataDigest, releaseMetadataDigestSource, generation: 1, degraded: false, lastState: null };
}

/**
 * Append one transition durably (append + fsync) BEFORE the side effect it
 * describes. Throws on failure — the caller decides Tier-1 (refuse before
 * mutation) vs Tier-2 (degrade and continue).
 */
// eslint-disable-next-line @typescript-eslint/max-params -- (from, to, detail) mirrors the JournalTransition shape it appends
export function journalInstallerTransition(
  journal: InstallerJournal,
  from: TransactionState | null,
  to: TransactionState,
  detail: string,
): void {
  appendJournalTransition(journal.journalPath, {
    at: new Date().toISOString(),
    from,
    to,
    transactionId: journal.transactionId,
    releaseId: journal.releaseId,
    productVersion: journal.productVersion,
    // Embedded provenance only: legacy payloads without a stamp journal no
    // sourceCommit at all (the field's absence IS the visible unavailable
    // marker), so a strict reader never mistakes a fallback for a fact.
    ...(journal.sourceCommit !== null ? { sourceCommit: journal.sourceCommit } : {}),
    releaseMetadataDigest: journal.releaseMetadataDigest,
    releaseMetadataDigestSource: journal.releaseMetadataDigestSource,
    // PRI-698 Phase 1: standalone installs keep generation 1; an externally
    // adopted transaction (ReleaseManager apply) carries the dual-slot
    // generation chain forward (activeRecord.generation + 1).
    generation: journal.generation,
    detail,
  });
  journal.lastState = to;
}

/** Tier-2 wrapper: on append failure, degrade (mark + warn) instead of throwing. */
// eslint-disable-next-line @typescript-eslint/max-params -- (from, to, detail) mirrors the JournalTransition shape it appends
export function journalInstallerTransitionDegrading(
  journal: InstallerJournal,
  from: TransactionState | null,
  to: TransactionState,
  detail: string,
): void {
  if (journal.degraded) return;
  try {
    journalInstallerTransition(journal, from, to, detail);
  } catch (error) {
    journal.degraded = true;
    logger.error(
      `Transaction journal append failed at '${to}' — continuing under the backup/restore safety net; `
      + `this transaction is partially journaled (ADR-0024 D-2 Tier-2 degradation): `
      + `${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function installerJournalRecord(journal: InstallerJournal): InstallJournalRecord {
  return { transactionId: journal.transactionId, journalPath: journal.journalPath, degraded: journal.degraded };
}


// eslint-disable-next-line @typescript-eslint/max-params -- (options, payloadDir, runMode, adoptedTransaction) mirrors the four independent concerns of an install run; the 4th is optional and only supplied by the PRI-698 orchestrator
export async function install(
  options: InstallOptions,
  pluginDir: string,
  mode: InstallRunMode = {},
  // PRI-698 Phase 1: optional externally-opened transaction (ReleaseManager
  // apply orchestration). When provided, its identity and journal file are
  // adopted verbatim and the 'planned' append is skipped (the orchestrator
  // already journaled planned → downloaded → verified; Tier-1 applied there).
  // Undefined keeps the historical standalone behavior byte-for-byte.
  transaction?: InstallerJournal,
): Promise<InstallResult> {
  // `quiet` (= jsonMode) suppresses human output / spinner. `nonInteractive`
  // (--yes/--non-interactive/--json) gates PROMPTING. They differ for `--yes`
  // (human output on, but must NOT prompt). nonInteractive defaults to quiet
  // because jsonMode always implies non-interactive.
  const quiet = mode.quiet === true;
  const nonInteractive = mode.nonInteractive ?? quiet;
  activeHostTarget = options.host;

  // Refuse an unusable workspace pointer before ANY side effect — the gateway
  // may already have been stopped and the workspace already templated by the
  // time the config writer runs, and the rollback path does not undo workspace
  // files. Validated here, the failure costs nothing.
  assertUsableWorkspaceDir(options.workspaceDir);

  // Decide the payload shape once: self-contained (release asset) or
  // npm-distributed (registry-resolved dependencies). A present `_release`
  // asset keeps the hard preflight; the npm-distributed shape must pass
  // the component form-gate or fail loud naming what is missing.
  activePayloadMode = decideInstallPayloadMode(pluginDir);
  if (activePayloadMode === 'self-contained') {
    try {
      await preflightSelfContainedReleaseAsset(pluginDir);
    } catch (error) {
      const preflightError = error instanceof SelfContainedDependencyError
        ? error
        : new SelfContainedDependencyError({
          reason: 'self_contained_asset_preflight_failed',
          nextAction: SELF_CONTAINED_DEPENDENCY_NEXT_ACTION,
          message: error instanceof Error ? error.message : String(error),
          component: 'Release asset',
          cause: error,
        });
      return {
        success: false,
        workspaceDir: options.workspaceDir,
        configYamlPath: getConfigYamlPath(options.workspaceDir),
        templatesCount: 0,
        components: { plugin: 'skipped', cli: 'skipped', console: 'skipped' },
        verification: { features: 'skipped', storyA: 'skipped' },
        enabledChannels: options.channels,
        nextAction: preflightError.nextAction,
        reason: preflightError.reason,
        component: preflightError.component,
        dependency: preflightError.dependency,
        error: `${preflightError.message} — ${t('rollback_no_changes')}`,
      };
    }
  } else {
    if (!quiet) logger.warn('npm-distributed package detected — resolving component dependencies from the npm registry.');
    const missing = missingNpmDistributedComponents(pluginDir);
    if (missing.length > 0) {
      return {
        success: false,
        workspaceDir: options.workspaceDir,
        configYamlPath: getConfigYamlPath(options.workspaceDir),
        templatesCount: 0,
        components: { plugin: 'skipped', cli: 'skipped', console: 'skipped' },
        verification: { features: 'skipped', storyA: 'skipped' },
        enabledChannels: options.channels,
        nextAction: 'The package is incomplete — reinstall it: npm cache clear --force && npx create-principles-disciple@latest. No changes were made.',
        reason: `npm_bundle_incomplete: missing ${missing.join(', ')}`,
        component: 'Release asset',
        error: `Bundled components incomplete (missing ${missing.join(', ')}) — the npm package is corrupted or truncated. No changes were made.`,
      };
    }
  }
  // PRI-874 review: fail-closed has to mean "does not ENTER the install flow",
  // not merely "does not install". Resolving the payload identity only inside
  // beginInstallerJournal() (below) refused an unstamped payload AFTER the
  // gateway had been stopped and the workspace directory created — a failed
  // install that still left the Owner with a downed gateway and a stray
  // directory, i.e. a recovery problem. Resolve and validate it HERE, before
  // any side effect, and hand the same value to beginInstallerJournal() so the
  // identity is computed exactly once.
  //
  // Only when this run opens its own transaction: an externally adopted
  // transaction (ReleaseManager apply orchestration) supplies its identity
  // verbatim and was never resolved from the payload, so the pre-flight must
  // not invent a stricter rule for it.
  let preResolvedIdentity: InstallerPayloadIdentity | undefined;
  if (transaction === undefined) {
    try {
      preResolvedIdentity = resolveInstallerPayloadIdentity(pluginDir);
    } catch (error) {
      // EVERY resolution failure refuses here — not only the identity-contract
      // class. Resolving the identity READS the payload (`_release/manifest.json`,
      // `pd-cli/package.json`, `_release/product-identity.json`), so an
      // EACCES/EPERM/EBUSY read is a real defect in the payload being installed.
      // Letting it continue would have the installer stop the gateway and create
      // the workspace FIRST and only then fail at beginInstallerJournal() — a
      // refused install that still left the Owner with a downed gateway and a
      // stray directory. "Fail closed" has to mean "does not enter the install
      // flow", so the same structured refusal the post-mutation catch would have
      // produced is returned here instead, one step earlier and with zero side
      // effects (no backup yet, nothing to clean up).
      const message = error instanceof Error ? error.message : String(error);
      return {
        success: false,
        workspaceDir: options.workspaceDir,
        configYamlPath: getConfigYamlPath(options.workspaceDir),
        templatesCount: 0,
        components: { plugin: 'skipped', cli: 'skipped', console: 'skipped' },
        verification: { features: 'skipped', storyA: 'skipped' },
        enabledChannels: options.channels,
        nextAction: t('next_no_changes_other'),
        reason: `install_failed_before_mutation: ${message}`,
        error: `${message} — ${t('rollback_no_changes')}`,
      };
    }
  }
  // PRI-1062: WorkBuddy hard preflights run BEFORE any side effect — including
  // the gateway stop below. A running WorkBuddy holds settings.json with
  // exclusive sharing (the commit-stage rename fails with EPERM after minutes
  // of npm work) and hooks never launch without Git Bash. Both are knowable up
  // front; failing here costs one bash probe + two file opens instead of a
  // full install + rollback.
  //
  // Ordering is load-bearing: this must precede the gateway pre-flight. On
  // `--host all` the gateway block below may STOP the Owner's OpenClaw
  // gateway, and a refusal that returns from here would leave it stopped —
  // `restartedGateway` is only honoured at the end of the install flow.
  if (installsWorkbuddy(options.host)) {
    const workbuddyPreflight = runWorkbuddyEarlyPreflight();
    if (!workbuddyPreflight.ok) {
      logger.error(workbuddyPreflight.reason);
      return buildGatewayRefusalResult(options, {
        reason: `workbuddy_preflight_failed: ${workbuddyPreflight.reason}`,
        nextAction: workbuddyPreflight.nextAction,
      });
    }
  }

  // Gateway lock pre-flight: a running gateway holds native-module file handles
  // that make the backup rename fail with EPERM. Decide stop/abort/proceed
  // BEFORE mutating anything (cli-5: abort/stop-failed paths must not mutate).
  let restartedGateway = false;
  const gatewayStatus = installsOpenClaw(options.host)
    ? await checkOpenClawGateway()
    : { isRunning: false };
  if (gatewayStatus.isRunning) {
    const action = await resolveGatewayAction(gatewayStatus, {
      stopGateway: options.stopGateway,
      interactive: !nonInteractive,
    });
    if (action === 'abort') {
      logger.warn(t('gateway_aborted_reason'));
      return buildGatewayRefusalResult(options, {
        reason: `gateway_running_aborted: ${t('gateway_aborted_reason')}`,
        nextAction: t('gateway_aborted_next'),
      });
    }
    if (action === 'stop') {
      if (!quiet) logger.info(t('gateway_stopping'));
      const stopRes = await stopOpenClawGateway(gatewayStatus);
      if (!stopRes.ok) {
        logger.error(`${t('gateway_stop_failed')} ${stopRes.error ?? ''}`);
        return buildGatewayRefusalResult(options, {
          reason: `gateway_stop_failed: ${t('gateway_stop_failed_reason')}${stopRes.error ? ` — ${stopRes.error}` : ''}`,
          // PRI-944: the instruction must match what was actually measured.
          // A port that cleared while the process lingered is a slow exit, and
          // telling the Owner to fight a process that is already leaving is a
          // false instruction. Everything else — verified still running, or an
          // effect we could not measure at all — keeps the manual-stop advice.
          nextAction: stopRes.reason === 'stop_confirmation_timeout'
            ? t('gateway_stop_unconfirmed_next')
            : t('gateway_stop_failed_next'),
          error: stopRes.error,
        });
      }
      if (!quiet) logger.success(t('gateway_stopped'));
      restartedGateway = true; // restart after install, even on failure
    } else {
      // action === 'proceed': user accepted the risk of EPERM.
      logger.warn(t('gateway_proceed_warn'));
    }
  }

  const spinner = quiet ? null : ora('Installing...').start();
  let backupDir: string | null = null;
  let runtimeBackupDir: string | null = null;
  // ADR-0024 D-2: non-null once the transaction is planned (first mutation is imminent).
  let journal: InstallerJournal | null = null;
  let installManifestHosts: string[];
  const components: ComponentStatus = { plugin: 'skipped', cli: 'skipped', console: 'skipped' };
  const verification: VerificationResult = { features: 'skipped', storyA: 'skipped' };
  let consoleProcess: ChildProcess | null = null;
  // P0-2 (review 2026-11-02 Major): probe children from earlier port attempts
  // whose exit could not be confirmed. They ride along until the terminal
  // join below — a later verified port never orphans them.
  let unconfirmedProbeChildren: ChildProcess[] = [];
  let stepIndex = 0;
  // CP-6: true once the run has started deploying runtime components (after
  // the backup step). With no pre-existing install (no backup), a failure
  // after this point must clean up instead of claiming "not modified".
  let mutationStarted = false;
  // PRI-697 review P1: global pd shim side effect, recorded when the
  // npm-distributed payload wrote PD-owned shims into the npm global bin
  // dir. Null until syncPdCli runs (or when no global write was attempted).
  let globalShimRecord: GlobalPdShimResult | null = null;
  // PRI-726: the result object the try/catch is about to return, held so the
  // finally block can attach the gateway restart notice to the SAME object
  // the caller receives (a finally block cannot rewrite an inline return).
  let pendingResult: InstallResult | undefined;

  // P0-2: bounded terminate + exit join over EVERY probe child we still own
  // (the verified child plus any earlier unconfirmed ones). The aggregated
  // join result decides whether destructive directory operations may proceed
  // — an unconfirmed child may hold native-module handles inside the runtime
  // tree (R8 experiment).
  const killConsoleChild = async (): Promise<ChildJoinResult | null> => {
    const targets: ChildProcess[] = [...unconfirmedProbeChildren];
    unconfirmedProbeChildren = [];
    if (consoleProcess) {
      targets.push(consoleProcess);
      consoleProcess = null;
    }
    if (targets.length === 0) return null;
    let aggregated: ChildJoinResult | null = null;
    for (const child of targets) {
      const join = await terminateAndJoinChild(child);
      if (!join.exited) {
        logger.error(`Console child (pid=${child.pid ?? '?'}) could not be confirmed exited after SIGKILL (graceful ${CONSOLE_CHILD_GRACEFUL_EXIT_TIMEOUT_MS}ms + kill ${CONSOLE_CHILD_KILL_EXIT_TIMEOUT_MS}ms)`);
      }
      // Worst result wins: one unconfirmed child must gate destructive
      // operations even when every other child exited cleanly.
      if (aggregated === null || !join.exited) aggregated = join;
    }
    return aggregated;
  };

  try {
    // CP-9 (2026-09-05 investigation): the workspace must exist before any
    // step touches it — console verification spawns the server with
    // --workspace and `pd-cli runtime init` writes under it, while workspace
    // creation used to happen only as a side effect of the LATE template
    // copy step. An explicit --workspace pointing at a new directory
    // therefore failed the install halfway through (leaving the CP-6
    // residue). First statement INSIDE the try: an ensureDir failure
    // (permissions / invalid path) flows into the unified failure result
    // below instead of rejecting the install() promise (P1 review finding).
    await fse.ensureDir(path.resolve(options.workspaceDir));

    // OpenClaw only: the MCP launcher re-derives the governance workspace from
    // this PD-owned file, because the host strips PD_WORKSPACE_DIR / HOME from
    // MCP children. An existing declaration for a DIFFERENT workspace must
    // refuse the install BEFORE any runtime mutation — otherwise the install
    // would report success while pd-recall served another workspace.
    if (installsOpenClaw(options.host)) {
      assertOpenClawWorkspaceDeclarationCompatible(options.workspaceDir);
    }

    if (spinner) updateProgress(spinner, stepIndex, 'Checking built plugin...');
    await checkBuiltPlugin(pluginDir);
    verification.manifestActivation = 'verified';
    stepIndex++;

    // Legacy rule contract preflight — run BEFORE the backup/rename step so
    // a refusal leaves the existing installation completely untouched. Only
    // meaningful when the target workspace already has PD state; fresh
    // workspaces scan clean (no state.db → nothing persisted to conflict).
    //
    // 5B: rows the scan could not read are surfaced as warnings, never as a
    // refusal — see summarizeCompatibilityVisibility for why, and for the
    // condition under which that choice should be revisited.
    let compatibilityVisibility: CompatibilityVisibility = { level: 'none', lines: [] };
    if (existsSync(path.join(path.resolve(options.workspaceDir), '.pd', 'state.db'))) {
      if (spinner) updateProgress(spinner, stepIndex, 'Checking workspace rule compatibility...');
      const compat = await runLegacyRuleContractPreflight(pluginDir, options.workspaceDir);
      if (!compat.ok) {
        if (!quiet) logger.error(compat.reason ?? 'legacy_rule_contract_dependency');
        return buildCompatibilityRefusalResult(options, compat);
      }
      compatibilityVisibility = summarizeCompatibilityVisibility(compat, options.workspaceDir);
      if (!quiet) {
        for (const line of compatibilityVisibility.lines) logger.warn(line);
      }
    }
    stepIndex++;

    if (spinner) updateProgress(spinner, stepIndex, 'Backing up existing install...');
    // ADR-0024 D-2 (PRI-664): journal-first — record 'planned' BEFORE the
    // first runtime mutation (the backup rename). Tier-1 policy: if the
    // journal cannot be written at all, refuse before mutating (fail loud,
    // zero side effects) rather than performing an unjournaled mutation
    // (refusal over silent degradation, ADR-0024 §2.4 rule 4).
    journal = transaction ?? beginInstallerJournal(pluginDir, preResolvedIdentity);
    if (transaction === undefined) {
      try {
        journalInstallerTransition(journal, null, 'planned', `host=${options.host} mode=${options.mode}`);
      } catch (journalError) {
        if (spinner) spinner.fail('Install failed');
        const journalDetail = journalError instanceof Error ? journalError.message : String(journalError);
        logger.error(`Transaction journal unavailable — refusing to mutate the runtime unjournaled (ADR-0024 D-2): ${journalDetail}`);
      return {
        success: false,
        workspaceDir: options.workspaceDir,
        configYamlPath: getConfigYamlPath(options.workspaceDir),
        templatesCount: 0,
        components,
        verification,
        enabledChannels: options.channels,
        nextAction: 'Resolve write access to ~/.pd/transactions (disk space / permissions), then re-run the installer. No changes were made.',
        reason: `transaction_journal_unavailable: ${journalDetail}`,
        error: `Could not write the transaction journal — refusing to mutate the runtime unjournaled (ADR-0024 D-2). No changes were made.`,
        journal: { transactionId: journal.transactionId, journalPath: journal.journalPath, degraded: true },
      };
      }
    }
    // Validate the existing host-ownership record before mutating runtime or
    // host config. A malformed manifest must not be discovered only after the
    // old installation has already been replaced (rc-3/rc-9).
    const persistedHostsBeforeRun = readPersistedInstallHosts();
    // UPDATE CHAIN (2026-11-11): a host installed outside the manifest (e.g. a
    // Codex Marketplace plugin added by hand) used to stay on the old release
    // while the upgrade reported success. Detect every host that already
    // carries PD and include it in BOTH the manifest record and the refresh
    // set, so one upgrade brings all hosts forward without uninstall/reinstall.
    const detectedHostsBeforeRun = detectInstalledHosts();
    const hostPlan = planUpgradeHosts(options.host, persistedHostsBeforeRun, detectedHostsBeforeRun);
    installManifestHosts = withDetectedHosts(resolveInstallManifestHosts(options.host), detectedHostsBeforeRun);
    for (const detectedHost of hostPlan.newlyCovered) {
      logger.info(`Detected installed host "${detectedHost.hostId}" (${detectedHost.evidence}) — included in this upgrade.`);
    }
    if (installsOpenClaw(options.host)) migrateLegacyPdBackups();
    const { backupDir: backupDirFromResult, runtimeBackupDir: runtimeBackupDirFromResult } = backupExistingInstall(options.host);
    backupDir = backupDirFromResult;
    runtimeBackupDir = runtimeBackupDirFromResult ?? null;
    stepIndex++;

    // CP-6: from here on the run deploys runtime components. When there is no
    // pre-existing install (no backup), a later failure must clean them up —
    // the old code claimed "No changes were made" while ~/.pd/runtime was
    // already on disk (install-upgrade investigation 2026-09-05, E-003).
    mutationStarted = true;

    if (spinner) updateProgress(spinner, stepIndex, 'Installing bundled @principles/core...');
    installBundledCore(pluginDir);
    stepIndex++;

    if (spinner) updateProgress(spinner, stepIndex, 'Validating bundled core dependencies...');
    await installCoreDependencies();
    stepIndex++;

    if (spinner) updateProgress(spinner, stepIndex, 'Installing bundled @principles/host-runtime...');
    installBundledHostRuntime(pluginDir);
    stepIndex++;

    if (spinner) updateProgress(spinner, stepIndex, 'Validating bundled host runtime dependencies...');
    await installHostRuntimeDependencies();
    stepIndex++;

    if (spinner) updateProgress(spinner, stepIndex, 'Installing bundled @principles/codex-adapter...');
    installBundledCodexAdapter(pluginDir);
    stepIndex++;

    installBundledLayoutPackage(pluginDir);
    // PRI-1145: host-runtime declares file:../core + file:../install-layout.
    // Both siblings are deployed above, so its physical nested copies are
    // corrected here — same contract as the adapters below.
    ensureHostRuntimeResolution();
    // PRI-711: the adapter's own file: deps must resolve or pd-cli's eager
    // import graph crashes on every command. Runs only once ALL adapter
    // siblings exist — the manifest declares file:../core, file:../host-runtime
    // AND file:../install-layout, and install-layout lands just above.
    ensureCodexAdapterResolution();

    // WorkBuddy third host (SPEC workbuddy-host-adapter §5 build/delivery
    // face): the adapter payload refreshes on every runtime deployment like
    // its codex sibling — updates rewrite the dir and its resolution links,
    // while WorkBuddy plugin registration and governance data are owned by
    // the host installer and preserved. Absence of the payload in older
    // installer builds is an observable skip, not a failure.
    installBundledWorkbuddyAdapter(pluginDir);
    ensureWorkbuddyAdapterResolution();

    // Gate 4 (PRI-1071): the shared MCP server refreshes with the runtime so
    // the host launchers' bindings always point at the current canonical
    // entry. Older installer payloads skip observably (the launchers fail
    // closed at start with the honest missing-entry state).
    const mcpServerInstalled = installBundledMcpServer(pluginDir);
    if (mcpServerInstalled) {
      ensureComponentFileDependencyLinks(getInstalledMcpServerDir(), 'pd-mcp-server');
      // The npm-distributed payload ships only dist/ + package.json, and the
      // MCP server keeps @modelcontextprotocol/server + zod as registry deps
      // (unlike the file:-linked siblings). Without this pass the launcher
      // starts an entry whose imports cannot resolve.
      await installMcpServerDependencies();
    }

    if (spinner) updateProgress(spinner, stepIndex, 'Installing release-manager authority module...');
    installBundledReleaseManagerPackage(pluginDir);
    await installReleaseManagerDependencies();
    // PRI-1201: install-layout is already deployed (installBundledLayoutPackage
    // above), so the dependency stage's physical copy is corrected before the
    // import probe loads the authority through its canonical sibling.
    ensureReleaseManagerResolution();
    await verifyReleaseManagerAuthorityImports();
    stepIndex++;

    if (spinner) updateProgress(spinner, stepIndex, 'Installing plugin...');
    await installPluginToStaging(pluginDir, options.language);
    stepIndex++;

    if (spinner) updateProgress(spinner, stepIndex, 'Preparing core library for plugin...');
    ensureCoreDependency(getPluginExtDir());
    stepIndex++;

    if (spinner) updateProgress(spinner, stepIndex, 'Validating bundled plugin dependencies...');
    await installPluginDependencies();
    components.plugin = 'verified';
    stepIndex++;

    if (spinner) updateProgress(spinner, stepIndex, 'Installing pd CLI...');
    // PRI-697 review P1: keep the global-shim bookkeeping — a LATER failure
    // must undo exactly the global side effect this run caused.
    const pdCliSync = syncPdCli(pluginDir);
    if (pdCliSync.globalShim !== null) globalShimRecord = pdCliSync.globalShim;
    await installPdCliDependencies();
    // G3 §10.5: materialize the sibling links AFTER the dependency stage — every
    // sibling component is already deployed at this point, and a physical copy
    // the dependency stage produced is now corrected rather than silently kept.
    ensurePdCliResolution();
    stepIndex++;

    if (spinner) updateProgress(spinner, stepIndex, 'Preparing core library for pd-cli...');
    ensureCoreDependency(getInstalledPdCliDir());
    stepIndex++;

    if (spinner) updateProgress(spinner, stepIndex, 'Verifying pd CLI...');
    const cliVerify = verifyPdCliShim();
    if (!cliVerify.localOk) {
      throw new Error(`PD CLI verification failed — local shim is not executable after install: ${cliVerify.localError ?? 'unknown error'}. Check Node.js and PATH configuration.`);
    }
    if (cliVerify.globalOk) {
      components.cli = 'verified';
    } else {
      components.cli = 'verified_local_only';
      components.cliLocalPath = cliVerify.localPath;
      logger.warn(`Global pd command not on PATH. Use local entry: "${cliVerify.localPath}" (always-available form: node "${path.join(getPdRuntimeDir(), 'pd-cli', 'dist', 'index.js')}"), or add ${getInstalledBinDir()} to PATH.`);
    }
    stepIndex++;

    if (spinner) updateProgress(spinner, stepIndex, 'Installing pd-console...');
    installConsole(pluginDir);
    stepIndex++;

    if (spinner) updateProgress(spinner, stepIndex, 'Preparing core library for console...');
    ensureCoreDependency(getInstalledConsoleDir());
    stepIndex++;

    if (spinner) updateProgress(spinner, stepIndex, 'Validating bundled console dependencies...');
    await installConsoleDependencies();
    // G3 §10.5: same ordering contract as pd-cli — links after the dependency
    // stage, with every console sibling (plugin / release-manager / core /
    // host-runtime / install-layout) already deployed.
    ensureConsoleResolution();
    stepIndex++;

    // PRI-912 (SPEC-P1′-A): dedup the plugin's bundled @principles/core copy
    // into a canonical junction only after EVERY component is deployed, so a
    // conversion that breaks runtime resolution fails the console probe below
    // and lands in the EXISTING fail → restoreBackup channel (no new
    // rollback mechanism). Runs before the journal 'staged' transition: an
    // install that failed here is still fully covered by the backups.
    if (spinner) updateProgress(spinner, stepIndex, 'Reconciling canonical core junction...');
    reconcilePluginCoreCanonicalJunction();
    stepIndex++;
    // ADR-0024 D-2: all runtime content is laid down — the new installation
    // is staged (nothing has been discarded yet; backups still hold the old one).
    journalInstallerTransitionDegrading(journal, journal.lastState, 'staged', 'runtime components installed');

    if (spinner) updateProgress(spinner, stepIndex, 'Verifying pd-console...');
    const consoleVerify = await verifyConsole(options.workspaceDir);
    unconfirmedProbeChildren.push(...consoleVerify.unconfirmedChildren);
    if (consoleVerify.ok) {
      components.console = 'configured';
      components.consoleEntrypoint = consoleVerify.url;
      consoleProcess = consoleVerify.process;
    } else {
      // SPEC v1.2 §14: attempt-level diagnostics travel with the failure so
      // the journal records every port/PID/status/identity outcome. The
      // message states ONLY the probe fact — whether anything was rolled back
      // is decided by the actual restore below and reported there (review
      // 2026-11-02: never claim "rolled back" before the restore ran).
      const attemptsSummary = consoleVerify.attempts
        .map((a) => `port=${a.port} pid=${a.pid ?? '?'} outcome=${a.outcome}${a.httpStatus !== undefined ? ` http=${a.httpStatus}` : ''}${a.stderrTail ? ` stderr="${a.stderrTail.slice(-160)}"` : ''}`)
        .join(' | ');
      throw new ConsoleVerifyError(
        `Console verification failed: all ${CONSOLE_PORT_MAX_RETRIES} port attempts failed (${attemptsSummary}). Installation was not activated.`,
        consoleVerify.attempts,
      );
    }
    stepIndex++;
    // ADR-0024 D-2: the console probe passed — the staged installation is live.
    journalInstallerTransitionDegrading(journal, journal.lastState, 'probed', `console verified at ${consoleVerify.url}`);

    if (spinner) updateProgress(spinner, stepIndex, 'Copying templates...');
    const templatesCount = await copyCoreTemplates({
      pluginDir,
      language: options.language,
      workspaceDir: options.workspaceDir,
      mode: options.mode,
    });
    const principlesCount = await copyPrinciplesLayer({
      pluginDir,
      language: options.language,
      workspaceDir: options.workspaceDir,
      mode: options.mode,
    });
    stepIndex++;

    if (spinner) updateProgress(spinner, stepIndex, 'Generating config.yaml...');
    // Round-3 remediation P1: for the WorkBuddy host the LLM runtime profile
    // is GOVERNANCE state — WorkBuddyHostInstaller applies it to the
    // governance workspace config (the file its worker/console/hook chain
    // reads). Writing it here too would create a second truth. Other hosts
    // keep the historical project-dir profile (Fix-4 behavior, unchanged).
    const configYamlPath = await generateConfigYamlConfig(
      options.workspaceDir,
      options.host === 'workbuddy' ? undefined : options.runtimeProfile,
    );
    verification.features = 'passed';
    stepIndex++;

    if (spinner) updateProgress(spinner, stepIndex, 'Creating config...');
    if (installsOpenClaw(options.host)) {
      await ensureOpenClawWorkspaceDeclaration(options.workspaceDir, options.channels);
    }
    stepIndex++;

    // PRI-686 Fix C: after pinning PD canonical, check OpenClaw's resolved
    // main-agent workspace against it. Read-only; a divergence means PD
    // commands and hooks would write to two different state trees.
    try {
      const divergence = detectOpenClawMainWorkspaceDivergence(options.workspaceDir);
      if (divergence.divergent) {
        logger.warn(
          `Workspace divergence detected: ${divergence.detail}. ` +
          `${divergence.nextAction} ` +
          `Until fixed, OpenClaw sessions in "${divergence.openclawMainWorkspace}" may be unable to record pain signals (needs_evidence).`,
        );
      }
    } catch (e) {
      logger.warn(`OpenClaw workspace divergence check failed (non-fatal): ${e instanceof Error ? e.message : String(e)}`);
    }

    if (spinner) updateProgress(spinner, stepIndex, 'Initializing PD databases...');
    try {
      const pdCliEntry = path.join(getInstalledPdCliDir(), 'dist', 'index.js');
      execFileSync(process.execPath, [pdCliEntry, 'runtime', 'init', '--confirm', '--workspace', options.workspaceDir], {
        stdio: ['ignore', 'ignore', 'pipe'],
        timeout: 30000,
      });
    } catch (err) {
      // rc-9: surface failure — do not silently swallow.
      // Non-fatal: demo story-a and runtime hooks will surface DB issues.
      const initWarn = err instanceof Error ? err.message : String(err);
      logger.warn(`pd runtime init failed (non-fatal): ${initWarn}`);
    }
    stepIndex++;

    if (spinner) updateProgress(spinner, stepIndex, 'Verifying demo...');
    try {
      // Demo isolation (2026-08-19): the install target already holds
      // initialized PD state at this point (.pd/state.db, .principles/
      // PROFILE.json), so the CLI's demo guard refuses to write demo data
      // into it. Run WITHOUT --workspace — pd-cli provisions and cleans up
      // its own throwaway temp workspace, exercising the same installed
      // pd-cli + core chain without polluting the user's workspace.
      // The entry path is boundary-checked before it is used as a
      // subprocess target (canonical-path containment + existence).
      const pdCliRoot = path.resolve(getInstalledPdCliDir());
      const pdCliEntry = path.resolve(pdCliRoot, 'dist', 'index.js');
      if (pdCliEntry !== pdCliRoot && !pdCliEntry.startsWith(pdCliRoot + path.sep)) {
        throw new Error(`pd-cli entry escapes install dir: ${pdCliEntry}`);
      }
      if (!existsSync(pdCliEntry) || !statSync(pdCliEntry).isFile()) {
        throw new Error(`pd-cli entry missing: ${pdCliEntry}`);
      }
      const { execFile } = await import('node:child_process');
      const { promisify } = await import('node:util');
      const execFileAsync = promisify(execFile);
      await execFileAsync(process.execPath, [pdCliEntry, 'demo', 'story-a', '--json'], {
        timeout: STORY_A_VERIFICATION_TIMEOUT_MS,
      });
      verification.storyA = 'passed';
    } catch (e) {
      // Same discipline as ConsoleVerifyError (review 2026-11-02): state the
      // probe fact only — the actual rollback outcome is journaled and
      // reported by the failure handler below, never pre-claimed here.
      throw new Error(`Demo verification failed: ${e instanceof Error ? e.message : String(e)}. Installation was not activated.`, { cause: e });
    }
    stepIndex++;

    if (spinner) updateProgress(spinner, stepIndex, 'Updating host config...');
    const hostInstallCtx: HostInstallContext = {
      workspaceDir: options.workspaceDir,
      pluginDir,
      language: options.language,
      mode: options.mode,
      runtimeProfile: options.runtimeProfile
        ? {
            provider: options.runtimeProfile.provider,
            model: options.runtimeProfile.model,
            apiKeyEnv: options.runtimeProfile.apiKeyEnv,
            baseUrl: options.runtimeProfile.baseUrl,
          }
        : undefined,
    };
    const hostResults = await runHostInstallers(options.host, hostInstallCtx);

    // Report host install results (rc-9: surface failures, don't silently swallow).
    // rc-9 propagation: if ANY host installer FAILED, the aggregate install
    // result is NOT successful — callers (CLI, tests) must see the failure.
    // Previously failures were only logged, leaving `success: true` even when
    // a host adapter failed to install (silent failure).
    //
    // Marketplace contract (2026-11-07): a host result carrying
    // manualActionRequired (Codex Marketplace install pending) is NOT a
    // failure of the install transaction. It must not throw — throwing here
    // used to roll back the SHARED runtime and left the already-successful
    // OpenClaw install pointing at a restored-away runtime (the --host all
    // defect). Manual actions are surfaced as an explicit partial completion:
    // the runtime stays installed and usable, the manifest claims only hosts
    // that actually installed, and the exit code is non-zero so automation
    // cannot mistake partial for complete.
    const { failures: hostFailures, manualActions: hostManualActions } = partitionHostInstallResults(hostResults);
    const hostFailureMessages = hostFailures.map((hr) => `Host "${hr.hostId}": ${hr.reason ?? 'unknown failure'}. Next: ${hr.nextAction}`);
    for (const msg of hostFailureMessages) {
      logger.warn(msg);
    }
    for (const hr of hostResults) {
      if (hr.success && hr.configAction === 'skipped') {
        logger.info(`Host "${hr.hostId}" install: ${hr.reason ?? 'skipped'}. Next: ${hr.nextAction}`);
      }
    }

    if (hostFailures.length > 0) {
      throw new Error(`Host installation failed: ${hostFailureMessages.join(' | ')}`);
    }

    // Shared-runtime consistency: this run replaced `~/.pd/runtime`, so every
    // OTHER host already recorded in the manifest still pins the previous MCP
    // server version in its own mcp-binding.json and would fail closed at the
    // next launch (binding_version_mismatch). Refresh them through their real
    // host installers here — best effort only: the requested host succeeded,
    // and a sibling refresh failure must not roll back the working runtime.
    const { refreshTargets } = hostPlan;
    const refreshedResults: HostInstallResult[] = [];
    for (const refreshTarget of refreshTargets) {
      if (spinner) updateProgress(spinner, stepIndex, `Refreshing ${refreshTarget} host binding...`);
      const refreshResults = await runHostInstallers(refreshTarget, hostInstallCtx);
      refreshedResults.push(...refreshResults);
      for (const hr of refreshResults) {
        if (hr.success) {
          logger.info(`Host "${hr.hostId}" refresh: ${hr.configAction === 'updated' ? 'updated' : 'no change needed'}${hr.reason ? ` — ${hr.reason}` : ''}.`);
        } else {
          // rc-9: never silent — state the reason and the exact recovery step.
          logger.warn(`Host "${hr.hostId}" refresh failed: ${hr.reason ?? 'unknown failure'}. Next: ${hr.nextAction ?? `npx create-principles-disciple install --host ${hr.hostId}`}`);
        }
      }
    }
    // UPDATE CHAIN (2026-11-11): one visible line per host this run touched.
    // First installs and upgrades share it, so an already-installed host being
    // brought forward can never be silent (Owner report).
    const hostSummary = summarizeTouchedHosts([...hostResults, ...refreshedResults]);
    if (hostSummary.length > 0) {
      logger.info('Install summary:');
      for (const line of hostSummary) logger.info(`  ${line}`);
    }
    // Manual-action hosts (e.g. Codex awaiting the Marketplace step) STAY in
    // the install manifest: the manifest records the hosts PD serves on this
    // machine (uninstall reads it to decide shared-runtime removal), not a
    // per-run success ledger. Dropping a pending host here could let a later
    // sibling-host uninstall remove the shared runtime while the pending
    // host's registration still points at it — the exact A3 hazard class
    // this fix exists to close. Real install state remains file-based truth
    // (checkInstallStatus / host detect()).
    writeInstallManifest(installManifestHosts, resolveInstallManifestWorkspaces(options.workspaceDir, options.host));
    // PRI-709 P0-1: persist the metadata source after the manifest write, so
    // the durable tier cannot be clobbered by the same install.
    persistReleaseMetadataSource();
    // PRI-732: provision the pinned TUF trust anchor in the SAME transaction
    // position as the metadata source — the official installer transaction is
    // the only production writer of the trust root. An invalid pinned root
    // fails the install loudly (the transaction below rolls back to the
    // previous runtime); a differing existing anchor is kept and reported
    // (rotation is separate governance work, never a silent overwrite).
    try {
      const trustOutcome = provisionBootstrapTrustRoot({ pdHome: getPdDir(), payloadRoot: pluginDir });
      if (trustOutcome.outcome === 'provisioned') {
        logger.info(`Pinned release trust root installed (key ${trustOutcome.keyIds.join(', ')}), expires ${trustOutcome.expires}.`);
      } else if (trustOutcome.outcome === 'retained-existing') {
        logger.warn(`${trustOutcome.note} Anchor kept at ${trustOutcome.trustRootPath}; payload carried ${trustOutcome.sourcePath}.`);
      }
      // already-pinned (idempotent) and skipped-no-source (pre-PRI-732
      // payloads stay unconfigured) are expected quiet states.
    } catch (error) {
      if (error instanceof TrustRootValidationError) {
        throw new Error(`Release trust root provisioning refused the install (${error.reason}): ${error.message} ${error.nextAction}`, { cause: error });
      }
      throw error;
    }
    // PRI-850 (SPEC v0.3 §6.1, ADR-0024 §6): deliver the bootstrap update
    // executor in the same installer transaction — stage from this package,
    // probe the staged bytes through the strict JSON protocol, activate by
    // rename-swap, and register with a re-verifiable digest. Delivery failure
    // is a DEGRADED install (the product payload itself is unaffected): it is
    // logged, journaled, and later surfaces observably as
    // `bootstrap_not_registered` on update checks, with repair-update-chain
    // as the recovery path — it never bricks the product install.
    try {
      await deliverBootstrapExecutor({
        pdHome: getPdDir(),
        // The installer shipped in THIS payload — never the executing package:
        // during an update the executor is the executing package, and sourcing
        // from it would re-pin the executor to its own stale code forever.
        sourcePackageDir: resolveBootstrapExecutorSourceDir(pluginDir),
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      logger.warn(`Bootstrap update executor delivery failed — updates will refuse with bootstrap_not_registered until repaired: ${detail}`);
      if (journal.lastState !== null) {
        journalInstallerTransitionDegrading(journal, journal.lastState, journal.lastState, `bootstrap executor delivery failed: ${detail}`);
      }
    }

    // ADR-0024 D-2: host installers completed and the install manifest is
    // written — the new installation is fully activated (backups not yet
    // discarded, so a crash here still recovers via the backup).
    journalInstallerTransitionDegrading(journal, journal.lastState, 'activated', 'host installers completed; install manifest written');

    // PRI-853 (SPEC §5 retention, §8 cleanup ordering): the just-superseded
    // runtime set is RETAINED as the supported previous release (rollback /
    // data-compat window material); only OLDER retained sets beyond the newest
    // are pruned. Deletion of the freshest backup would strand code rollback.
    // Review 2026-11-02 (Major: data integrity): while a PRIOR failed
    // transaction is still recovery-pending (restore_incomplete/deferred/
    // install_residue marker, no resolution record), pruning OLDER backup
    // sets could destroy the last good version's backup — the newest set here
    // is this run's just-superseded (possibly half-deployed) tree, and the
    // old "current + one previous" window cannot protect the original. Skip
    // pruning for this run; it resumes once the pending set is resolved
    // (written below, at confirm time) on a subsequent install.
    const { transactionsDir } = resolvePdHomePaths(getPdDir());
    const recoveryPendingBeforePrune = findRecoveryPendingTransactionIds(transactionsDir);
    if (recoveryPendingBeforePrune.length > 0) {
      logger.warn(`Recovery pending for ${recoveryPendingBeforePrune.length} prior failed transaction(s) (${recoveryPendingBeforePrune.join(', ')}) — keeping ALL backup sets this run (no pruning); normal retention resumes on the next install after this one confirms.`);
    } else {
      retainSupersededBackup(backupDir, runtimeBackupDir);
    }
    // ADR-0024 D-2: retention/pruning of OLDER sets is the commit point of the
    // transaction.
    journalInstallerTransitionDegrading(journal, journal.lastState, 'confirmed', 'previous release retained; older sets pruned; install complete');
    // PRI-709 P0-2: active.json is the deployment identity source, written
    // journal-first — after `confirmed`, never before it.
    commitInstallerActiveRecord(journal);
    // G1 (review 2026-11-02 Minor: recovery alarm never clears): now that this
    // install physically completed (confirmed), any prior recovery-pending
    // failed transaction it just superseded IS resolved — record that fact so
    // recovery surfaces stop alarming about it. Fail-safe: resolution writing
    // is best-effort; an unwritable record keeps the alarm (conservative).
    for (const pendingId of recoveryPendingBeforePrune) {
      try {
        writeRecoveryResolution(transactionsDir, {
          resolvedTransactionId: pendingId,
          resolvedByTransactionId: journal.transactionId,
        });
        logger.info(`Recorded recovery resolution: failed transaction ${pendingId} superseded by ${journal.transactionId}`);
      } catch (resolutionError) {
        logger.warn(`Could not record recovery resolution for ${pendingId} (alarm stays): ${resolutionError instanceof Error ? resolutionError.message : String(resolutionError)}`);
      }
    }
    if (spinner) {
      // rc-9: the runtime transaction IS committed here, but a pending host
      // manual action (e.g. the Codex Marketplace install) makes the run a
      // partial completion — "Install complete!" would be the exact
      // misleading-success texture this contract exists to remove.
      if (hostManualActions.length === 0) {
        spinner.succeed('Install complete!');
      } else {
        spinner.warn(`Install partially complete — ${hostManualActions.length} manual step(s) pending (details below)`);
      }
    }

    // 5B: the preflight warning scrolls away during a multi-minute install, so
    // the end summary repeats the zero-visibility block verbatim. This is
    // still a warning: the install completed and success is unchanged.
    if (!quiet && compatibilityVisibility.level === 'critical') {
      for (const line of compatibilityVisibility.lines) logger.warn(line);
    }

    // P0-2: terminate + join the verified child before any later step that
    // may touch the runtime tree (here: none destructive, but a wedged child
    // must not leak past the install either).
    await killConsoleChild();

    // Task 8: auto-launch console via `pd console open` (reuses PRI-300
    // handleConsoleOpen — no new launcher subsystem). Opens the browser to
    // /welcome for onboarding. Detached so the console survives installer exit.
    // WorkBuddy remediation: the console manages the GOVERNANCE workspace for
    // this host — the directory hook/worker read — never the project dir.
    const consoleWorkspaceDir = resolveConsoleWorkspaceDir(activeHostTarget, options.workspaceDir, getHomeDir());
    const launchResult = await autoLaunchConsole(consoleWorkspaceDir);

    // PRI-645: report the ACTUAL effective channels (registry default +
    // sparse override). Never mask an explicit Owner disable with the
    // requested channels — that would re-create ERR-042 (reporting the
    // requested config instead of the actual state).
    const actualEnabledChannels = readEnabledChannelsFromConfigYaml(options.workspaceDir);
    const cliWorking = components.cli === 'verified' || components.cli === 'verified_local_only';
    // Marketplace contract (2026-11-07): a pending manual action (e.g. the
    // Codex Marketplace install) makes the run an explicit PARTIAL completion —
    // never a full success (no fake "Install complete!"), never a runtime
    // rollback either. The runtime component itself is verified; the pending
    // step is host-side and must be surfaced with a non-zero exit code.
    const isComplete = components.plugin === 'verified' && cliWorking && components.console === 'configured' && hostManualActions.length === 0;
    const manualActionReason = hostManualActions.length > 0
      ? `Partial completion: ${hostManualActions.map((hr) => `host "${hr.hostId}" requires a manual step (${hr.reason ?? 'manual action required'})`).join('; ')}`
      : undefined;
    const manualActionNext = hostManualActions.length > 0
      ? hostManualActions.map((hr) => `Host "${hr.hostId}": ${hr.nextAction}`).join(' | ')
      : undefined;
    // A host installer failure means the install is not fully successful,
    // even if all component verifications passed. The operator should see
    // success=false and be guided to fix the failed host.
    const nextActions: string[] = [];
    if (components.cli === 'verified') {
      nextActions.push(`pd runtime canary --workspace "${consoleWorkspaceDir}" --json`);
    } else if (components.cli === 'verified_local_only' && components.cliLocalPath) {
      nextActions.push(`"${components.cliLocalPath}" runtime canary --workspace "${consoleWorkspaceDir}" --json`);
    }
    if (components.console === 'configured') {
      if (launchResult.consoleUrl) {
        // Console auto-launched — point user at the live URL.
        nextActions.push(`Console ready at ${launchResult.consoleUrl} (browser opened automatically)`);
      } else {
        // EP-03: auto-launch did not succeed — keep manual start instruction.
        nextActions.push(`${launchResult.manualOpenCommand} (listens on 127.0.0.1 only)`);
      }
    }
    if (launchResult.fallbackAction) {
      nextActions.push(launchResult.fallbackAction);
    }
    if (manualActionNext !== undefined) {
      nextActions.push(manualActionNext);
    }
    pendingResult = {
      success: isComplete,
      workspaceDir: options.workspaceDir,
      configYamlPath,
      templatesCount: templatesCount + principlesCount,
      components,
      verification,
      enabledChannels: actualEnabledChannels,
      nextAction: nextActions.join(' | '),
      consoleUrl: launchResult.consoleUrl,
      hostResults,
      hostSummary,
      ...(compatibilityVisibility.lines.length > 0 ? { compatibilityWarnings: compatibilityVisibility.lines } : {}),
      ...(manualActionReason !== undefined ? { reason: manualActionReason, manualActions: hostManualActions } : {}),
      journal: installerJournalRecord(journal),
    };
    return pendingResult;
  } catch (error) {
    if (spinner) spinner.fail('Install failed');

    // P0-2: terminate + join the child BEFORE any restore attempt. An
    // unconfirmed child may hold native-module handles inside the runtime
    // tree; restoring under it is exactly the PRI-1069 failure mode (EPERM
    // mid-delete, half-restored runtime).
    const childJoin = await killConsoleChild();

    // ADR-0024 D-2: record the outcome (journal may be null when the throw
    // happened before the transaction was planned — zero side effects then).
    // `failed` and `rolled_back` are BOTH terminal states and one journal
    // file must end at exactly one terminal state (the strict reader rejects
    // any transition after a terminal one), so the outcome is either-or:
    // - backup restored (a real rollback happened) → `rolled_back`
    // - no backup existed (mutation never started), restore failed, or
    //   restore deferred (child unconfirmed) → `failed`
    const errorMsgRaw = error instanceof Error ? error.message : String(error);
    const childUnconfirmed = childJoin !== null && !childJoin.exited;
    const probeHadJoinFailure = error instanceof ConsoleVerifyError && error.hadJoinFailure;
    let restoreResult: RestoreBackupResult;
    let restoreDeferred = false;
    if (childUnconfirmed || probeHadJoinFailure) {
      // I-4 (SPEC v1.2 §17): an unconfirmed probe child forbids destructive
      // directory operations. Keep everything on disk; surface a machine-
      // readable marker the recovery scan (P0-4) will NOT skip.
      restoreDeferred = true;
      restoreResult = {
        restored: false,
        partial: true,
        error: `child (pid=${childJoin && !childJoin.exited ? 'unconfirmed' : 'probe-child'}) not confirmed exited; destructive restore deferred`,
      };
    } else if (error instanceof BackupIntegrityError) {
      // P0-3: the backup step itself failed midway and its compensation also
      // failed — restore from the paths the error carries.
      restoreResult = restoreBackup(error.extensionBackupDir ?? backupDir, error.runtimeBackupDir ?? runtimeBackupDir);
    } else {
      restoreResult = restoreBackup(backupDir, runtimeBackupDir);
    }

    const errorMsg = errorMsgRaw;
    // ERR-046 / rc-9: never claim a restore that didn't happen. When backupDir
    // is null, the backup step never completed (it threw — e.g. EPERM — or
    // there was no existing install), so the existing install was never moved
    // and nothing was restored. The old code printed "Previous install has been
    // restored." here, which was misleading (success-shaped, no restore).
    const isLockError = /EPERM|EBUSY|EACCES|operation not permitted/i.test(errorMsg);
    const extDir = getPluginExtDir();
    // EP-11: all operator-visible failure/rollback text goes through t().
    // P0-3: a BackupIntegrityError means a tree IS displaced into a backup
    // location even though the local variables are still null — count it.
    const hasBackup = Boolean(backupDir || runtimeBackupDir) || error instanceof BackupIntegrityError;
    // CP-6 (2026-09-05 investigation, E-003/E-014): a FRESH install (no
    // pre-existing install → no backup) that failed mid-deployment used to
    // leave ~/.pd/runtime and the extension copy fully populated while the
    // message claimed "No changes were made" — silent half-install residue
    // that OpenClaw could load as an orphan plugin. Remove what this run
    // deployed and report the truth instead.
    // PR #1526 review fix: the earlier `!isLockError` exclusion assumed lock
    // errors can only fire before any mutation. They cannot — EPERM/EACCES/
    // EBUSY raised by a cpSync/config write AFTER core already landed on disk
    // is still a lock-shaped error, and skipping cleanup then left residue
    // behind a "No changes were made" report. Cleanup now keys on the actual
    // write state (mutationStarted) alone; if the cleanup itself is
    // permission-restricted, freshCleanup.failed names the residue (rc-9).
    // hasBackup=true keeps its restore path, and a lock error before
    // mutationStarted=true correctly keeps the no-changes messages below.
    // Review 2026-11-02 (Major/Minor): the cleanup is computed BEFORE the
    // journal write so PARTIAL-clean residue can be journaled with a machine-
    // readable marker (`install_residue:`) instead of vanishing behind a
    // terminal `failed`; and restore_deferred FORBIDS it — the probe child may
    // still hold runtime-tree handles, and rmSync under it is the exact
    // PRI-1069 failure mode.
    const freshCleanup = !hasBackup && mutationStarted && !restoreDeferred
      ? cleanUnactivatedFreshInstall()
      : undefined;

    if (journal) {
      const restoreFailed = hasBackup && !restoreResult.restored;
      const freshResidue = !hasBackup && freshCleanup !== undefined && freshCleanup.failed.length > 0;
      // SPEC v1.2 §14: attempt-level diagnostics ride along in the recovery
      // markers too — the recovery list reads journal details, not thrown
      // error objects (review 2026-11-02 Minor).
      const attemptsNote = error instanceof ConsoleVerifyError && error.attempts.length > 0
        ? ` attempts=[${error.attempts.map((a) => `port=${a.port} pid=${a.pid ?? '?'} outcome=${a.outcome}${a.httpStatus !== undefined ? ` http=${a.httpStatus}` : ''}${a.exitCode !== undefined ? ` exit=${a.exitCode}` : ''}`).join(', ')}];`
        : '';
      let detail: string;
      if (restoreDeferred) {
        detail = `restore_deferred:${attemptsNote} ${restoreResult.error ?? 'child not confirmed exited'}; backups and live trees preserved at extension=${backupDir ?? '-'} runtime=${runtimeBackupDir ?? '-'}; close the reported processes and re-run the installer to retry recovery`;
      } else if (restoreFailed) {
        // P0-4: machine-readable marker prefix — the recovery list (Console
        // recoveryStatus) must surface terminal-failed transactions whose
        // PHYSICAL install was left inconsistent instead of skipping them.
        const preserved = [...(restoreResult.extension?.preservedDirs ?? []), ...(restoreResult.runtime?.preservedDirs ?? [])];
        detail = `restore_incomplete:${attemptsNote} ${restoreResult.error ?? 'unknown'}; preserved=[${preserved.join(', ')}]; extension=${restoreResult.extension?.status ?? 'n/a'} runtime=${restoreResult.runtime?.status ?? 'n/a'}; re-run the installer to retry recovery`;
      } else if (freshResidue && freshCleanup !== undefined) {
        detail = `install_residue: fresh-install cleanup left residue: ${freshCleanup.failed.map((f) => `${f.dir} (${f.error})`).join(', ')}; ${errorMsgRaw}`;
      } else if (hasBackup && restoreResult.restored) {
        // A successful rollback that still left quarantine residue must name
        // it in the journal (review 2026-11-02 Minor: residue invisible in
        // the rolled_back path).
        const residueNotes = [restoreResult.extension?.detail, restoreResult.runtime?.detail]
          .filter((note): note is string => typeof note === 'string' && note.length > 0 && note.includes('residue'));
        detail = residueNotes.length > 0 ? `${errorMsgRaw}; restore notes: ${residueNotes.join('; ')}` : errorMsgRaw;
      } else {
        detail = errorMsgRaw;
      }
      if (!restoreDeferred && !restoreFailed && hasBackup && restoreResult.restored) {
        journalInstallerTransitionDegrading(journal, journal.lastState, 'rolled_back', detail);
      } else {
        journalInstallerTransitionDegrading(journal, journal.lastState, 'failed', detail);
      }
    }

    // PRI-697 review P1: the global pd shim is a side effect OUTSIDE the
    // runtime/extension trees both cleanup paths above address. Whatever
    // the backup state, files THIS run created in the npm global bin dir
    // are this run's residue — remove them (rollbackGlobalPdShim keeps
    // PD-owned shims that pre-dated the run, so a rolled-back upgrade of a
    // previously-shimmed install keeps its old global command; the shim
    // content targets the stable installed bin dir, which the restored
    // backup re-populates).
    const globalShimRollback = globalShimRecord !== null
      ? rollbackGlobalPdShim(globalShimRecord)
      : undefined;
    // R2 (review): after template/config steps have run (console verified →
    // templates copied → config generated), the WORKSPACE also holds this
    // run's files — but the workspace is the operator's own directory and may
    // pre-date this run, so it is NOT wholesale-removed. Report its retention
    // honestly instead of claiming "nothing else was modified".
    const workspaceTouched = !hasBackup && mutationStarted && journal?.lastState !== 'planned';
    // PRI-1102: `restored` describes the rollback operation, not the health of
    // the state it returned to. Name the gaps so "restored" is never read as
    // "usable install".
    const restoredGaps = hasBackup && restoreResult.restored ? describeRestoredStateGaps() : [];
    const rollbackSuffix = !hasBackup
      ? freshCleanup
        ? freshCleanup.failed.length === 0
          ? t('rollback_fresh_cleaned')
          : t('rollback_fresh_clean_failed').replace('{dirs}', freshCleanup.failed.map((f) => f.dir).join(', '))
        : t('rollback_no_changes')
      : restoreResult.restored
        ? restoredGaps.length === 0
          ? t('rollback_restored')
          : t('rollback_restored_incomplete').replace('{paths}', restoredGaps.join(', '))
        : t('rollback_failed')
          .replace('{restoreError}', restoreResult.error ?? '')
          .replace('{extDir}', extDir)
          .replace('{backupDir}', backupDir ?? runtimeBackupDir ?? '');
    const rollbackSuffixFinal = rollbackSuffix
      + (workspaceTouched && freshCleanup && freshCleanup.failed.length === 0 ? ` ${t('rollback_fresh_workspace_kept')}` : '')
      + (globalShimRollback !== undefined && globalShimRollback.failed.length > 0
        ? ` ${t('rollback_global_shim_residue').replace('{files}', globalShimRollback.failed.join(', '))}`
        : '');
    const rollbackNextAction = !hasBackup
      ? freshCleanup
        ? (freshCleanup.failed.length === 0 ? t('next_fresh_cleaned') : t('next_fresh_clean_failed'))
        : (isLockError
          ? t('next_no_changes_lock')
          : t('next_no_changes_other'))
      : restoreResult.restored
        ? restoredGaps.length === 0
          ? t('next_restored')
          : t('next_restored_incomplete').replace('{paths}', restoredGaps.join(', '))
        : t('next_restore_failed')
          .replace('{extDir}', extDir)
          .replace('{backupDir}', backupDir ?? runtimeBackupDir ?? '')
          .replace('{errorMsg}', errorMsg);
    const rollbackReason = !hasBackup
      ? freshCleanup
        ? (freshCleanup.failed.length === 0 && (globalShimRollback === undefined || globalShimRollback.failed.length === 0)
          ? `install_failed_unactivated_cleaned: ${errorMsg}`
          : `install_failed_unactivated_residue: ${errorMsg}`)
        : (isLockError ? `install_aborted_lock: ${errorMsg}` : `install_failed_before_mutation: ${errorMsg}`)
      : restoreResult.restored
        ? errorMsg
        : `install_failed_rollback_failed: ${errorMsg}`;
    const nextAction = error instanceof SelfContainedDependencyError
      ? restoreResult.restored || !hasBackup
        ? error.nextAction
        : `${error.nextAction} ${rollbackNextAction}`
      : rollbackNextAction;
    const reason = error instanceof SelfContainedDependencyError ? error.reason : rollbackReason;

    pendingResult = {
      success: false,
      workspaceDir: options.workspaceDir,
      configYamlPath: getConfigYamlPath(options.workspaceDir),
      templatesCount: 0,
      components,
      verification,
      enabledChannels: options.channels,
      nextAction,
      reason,
      component: error instanceof SelfContainedDependencyError ? error.component : undefined,
      dependency: error instanceof SelfContainedDependencyError ? error.dependency : undefined,
      error: `${errorMsg} — ${rollbackSuffixFinal}`,
      journal: journal ? installerJournalRecord(journal) : undefined,
    };
    return pendingResult;
  } finally {
    // If we stopped the gateway at the pre-flight, restart it regardless of
    // install outcome (success or failure) — never leave the gateway down.
    // rc-9: a restart failure is reported but does not override the install
    // result already computed above.
    if (restartedGateway) {
      if (!quiet) logger.info(t('gateway_restarting'));
      const restartRes = await restartOpenClawGateway();
      if (restartRes.ok) {
        if (!quiet) logger.success(t('gateway_restarted'));
      } else {
        logger.error(`${t('gateway_restart_failed')} ${restartRes.error ?? ''}`);
        // PRI-726 (rc-9): the failure must reach the Owner, not only this log.
        // The pending result is still mutable here — finally runs before the
        // caller sees the return value — so the degraded-success notice rides
        // the SAME object out; ReleaseManager/Console propagate it verbatim
        // as `gatewayNotice`. A FAILED install is never wrapped in a
        // success-shaped notice: the payload did not commit, so "degraded
        // success" would be a lie (failure isolation).
        if (pendingResult?.success) {
          pendingResult.gatewayNotice = restartRes.error
            ? `${t('gateway_restart_failed')} (${restartRes.error})`
            : t('gateway_restart_failed');
        }
      }
    }
  }
}
