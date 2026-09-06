import { existsSync, readdirSync, statSync, readFileSync, writeFileSync, mkdirSync, rmSync, copyFileSync, cpSync, renameSync, chmodSync, symlinkSync, type Dirent } from 'fs';
import { createHash, randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
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
  isWindows,
  type ComponentStatus,
  type VerificationResult,
  type RuntimeProfileInput,
} from './mvp-config.js';
import { getHostInstallers, type HostTarget } from './installers/index.js';
import type { HostInstallContext, HostInstallResult } from '@principles/core/host';
import { mergeInstallManifestWorkspaces, parseInstallManifest } from '@principles/install-layout';
import { detectOpenClawMainWorkspaceDivergence } from './utils/workspace-divergence.js';
import { applySkillLanguageSelection, type SkillLanguage } from './skill-language.js';
import {
  parseReleaseAssetIdentity,
  parseReleaseAssetManifest,
  ReleaseAssetManifestError,
  verifyReleaseAssetManifestAsync,
  verifyReleaseAssetTarget,
} from './update/release-asset-manifest.js';
import { appendJournalTransition, type ReleaseMetadataDigestSource, type TransactionState } from './update/transaction-journal.js';

/** PRI-343: Keep in sync with @principles/core CONVERSATION_ACCESS_CONFIG_KEY */
export const CONVERSATION_ACCESS_CONFIG_KEY = 'allowConversationAccess' as const;

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

const INSTALL_TIMEOUT_MS = parseInt(process.env.PD_INSTALL_TIMEOUT_MS || '300000', 10);

// 超时常量
const PD_CLI_VERIFICATION_TIMEOUT_MS = 30_000;
const STORY_A_VERIFICATION_TIMEOUT_MS = 30_000;
const CONSOLE_HEALTH_CHECK_TIMEOUT_MS = 8_000;
const CONSOLE_WARMUP_TIME_MS = 6_000;

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

function installedPluginDir(): string {
  return getInstalledPluginDir();
}

function pluginInstallDirs(): string[] {
  return installsOpenClaw(activeHostTarget)
    ? [getInstalledPluginDir(), getPluginExtDir()]
    : [getInstalledPluginDir()];
}

export function mergeInstallManifestHosts(current: unknown, host: HostTarget): ('codex' | 'openclaw')[] {
  const hosts = new Set<'codex' | 'openclaw'>();
  const parsed = parseInstallManifest(current);
  if (current !== undefined && !parsed.manifest) {
    throw new Error(parsed.error ?? 'install_manifest_malformed');
  }
  for (const existingHost of parsed.manifest?.hosts ?? []) hosts.add(existingHost);
  if (host === 'all' || host === 'codex') hosts.add('codex');
  if (host === 'all' || host === 'openclaw') hosts.add('openclaw');
  return [...hosts];
}

function resolveInstallManifestHosts(host: HostTarget): ('codex' | 'openclaw')[] {
  let current: unknown;
  try {
    current = JSON.parse(readFileSync(getInstallManifestPath(), 'utf8')) as unknown;
  } catch (error) {
    if (existsSync(getInstallManifestPath())) throw error;
  }
  return mergeInstallManifestHosts(current, host);
}

/**
 * PRI-624 Slice C: the install manifest records every Workspace this install
 * serves so the Companion can discover its per-Workspace workers (SPEC §13
 * "canonical install manifest"). Idempotent by canonical path.
 */
function resolveInstallManifestWorkspaces(workspaceDir: string): string[] {
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
  return mergeInstallManifestWorkspaces(parsed.manifest, path.resolve(workspaceDir));
}

function writeInstallManifest(hosts: ('codex' | 'openclaw')[], workspaces: string[]): void {
  mkdirSync(getPdDir(), { recursive: true });
  writeFileSync(getInstallManifestPath(), JSON.stringify({ layoutVersion: 1, mode: 'canonical', hosts, workspaces }, null, 2) + '\n', 'utf8');
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
] as const;

// Components whose install step demands MORE than the generic
// package.json+dist shape check — the per-component extra files are
// preflighted here so the form-gate refusal is exact (a truncated package
// must fail BEFORE any mutation, matching the per-component install
// requirements instead of discovering them mid-deployment).
const NPM_DISTRIBUTED_REQUIRED_FILES: Record<string, string[]> = {
  'release-manager': ['package.json', path.join('dist', 'update', 'release-manager-authority.js')],
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
  try {
    mkdirSync(backupsDir, { recursive: true });
    if (backupDir) renameSync(extDir, backupDir);
    if (runtimeBackupDir) {
      mkdirSync(getPdRuntimeBackupsDir(), { recursive: true });
      renameSync(runtimeDir, runtimeBackupDir);
    }
    logger.info(`Backed up existing install to ${backupDir ?? runtimeBackupDir}`);
    return { type: 'backed_up', backupDir, runtimeBackupDir };
  } catch (e) {
    throw new Error(`Could not backup existing install at ${extDir}: ${e instanceof Error ? e.message : String(e)}. Aborting to prevent data loss — resolve the lock or rename manually and re-run.`, { cause: e });
  }
}

function restoreBackup(backupDir: string | null, runtimeBackupDir: string | null): { restored: boolean; error?: string } {
  if ((!backupDir || !existsSync(backupDir)) && (!runtimeBackupDir || !existsSync(runtimeBackupDir))) return { restored: true };
  const extDir = getPluginExtDir();
  const runtimeDir = getPdRuntimeDir();
  try {
    if (backupDir && existsSync(extDir)) {
      rmSync(extDir, { recursive: true, force: true });
    }
    if (backupDir && existsSync(backupDir)) renameSync(backupDir, extDir);
    if (runtimeBackupDir && existsSync(runtimeBackupDir)) {
      if (existsSync(runtimeDir)) rmSync(runtimeDir, { recursive: true, force: true });
      renameSync(runtimeBackupDir, runtimeDir);
    }
    logger.info('Restored previous install from backup');
    return { restored: true };
  } catch (e) {
    const msg = `Failed to restore backup: ${e instanceof Error ? e.message : String(e)}`;
    logger.error(msg);
    return { restored: false, error: msg };
  }
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

function cleanupBackup(backupDir: string | null, runtimeBackupDir: string | null): void {
  for (const backup of [backupDir, runtimeBackupDir]) {
    if (!backup || !existsSync(backup)) continue;
    try {
      rmSync(backup, { recursive: true, force: true });
    } catch {
      // non-fatal
    }
  }
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
 * Compatibility preflight status taxonomy (P1-3, 2026-08-20).
 *
 * The scanner's status is preserved end-to-end so a refusal names the real
 * cause instead of smearing every failure into "legacy RuleCode":
 *
 *   clean             → allow upgrade
 *   no_state_db       → allow (nothing persisted to be incompatible)
 *   legacy_dependency → refuse → migrate/deactivate the listed rules
 *   scan_failed       → refuse → repair DB / permissions
 *   scan_unavailable  → refuse → repair/re-download the installer
 *
 * Any unrecognized status is treated as a refusal (fail closed).
 */
export type CompatibilityStatus =
  | 'clean'
  | 'no_state_db'
  | 'legacy_dependency'
  | 'scan_failed'
  | 'scan_unavailable';

export interface LegacyRulePreflightOutcome {
  ok: boolean;
  status?: CompatibilityStatus;
  /** rc-9: structured reason + remediation whenever ok=false. */
  reason?: string;
  remediation?: string;
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

/**
 * Strict (ok, status) protocol parse (P2, 2026-08-20).
 *
 * Boolean `ok` alone is NOT authoritative — the (ok, status) pair is the
 * contract. Only ok=true + (clean|no_state_db) is a successful scan. Every
 * other combination fails closed:
 *   - ok=true + refusal/success-impossible status → protocol invalid
 *   - ok=false + clean|no_state_db/unknown   → protocol invalid
 *   - ok=false + legacy_dependency|scan_failed|scan_unavailable → refusal
 *   - non-boolean / missing ok               → protocol invalid
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

  if (parsed.ok === true) {
    if (status === 'clean' || status === 'no_state_db') {
      return { ok: true, status };
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
  try {
    return await runScan(pdCliEntry, resolvedWorkspace);
  } catch (err) {
    return {
      ok: false,
      status: 'scan_failed',
      reason: `compatibility_scan_failed: ${err instanceof Error ? err.message : String(err)}`,
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

export async function installPluginToStaging(pluginDir: string, language: SkillLanguage): Promise<void> {
  const builtPluginDir = path.join(pluginDir, 'plugin');
  for (const targetDir of pluginInstallDirs()) {
    await fse.ensureDir(targetDir);
    await fse.copy(builtPluginDir, targetDir, { overwrite: true });

    // The published plugin declares its bundled core as file:./core. Keep that
    // package-local contract while storing the actual core once in the shared
    // host-neutral runtime directory.
    const pluginCoreLink = path.join(targetDir, 'core');
    if (!existsSync(pluginCoreLink)) {
      const coreDir = path.join(getPdRuntimeDir(), 'core');
      if (isWindows()) symlinkSync(coreDir, pluginCoreLink, 'junction');
      else symlinkSync(path.relative(targetDir, coreDir), pluginCoreLink, 'dir');
    }

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

function installGlobalPdShim(): boolean {
  if (!legacyNpmInstallEnabled()) {
    logger.info('Skipping npm global shim discovery for the self-contained release asset.');
    return false;
  }
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

  try {
    mkdirSync(globalBin, { recursive: true });
    const installedBinDir = getInstalledBinDir();

    if (isWindows()) {
      const pluginCmd = path.join(installedBinDir, 'pd.cmd');
      writeFileSync(path.join(globalBin, 'pd.cmd'), `@echo off\r\ncall "${pluginCmd.replace(/"/g, '""')}" %*\r\n`, 'utf-8');
      const pluginPs = path.join(installedBinDir, 'pd.ps1');
      writeFileSync(
        path.join(globalBin, 'pd.ps1'),
        `$shim = "${pluginPs.replace(/`/g, '``').replace(/"/g, '`"')}"\r\n& $shim @args\r\nexit $LASTEXITCODE\r\n`,
        'utf-8',
      );
    } else {
      const pluginSh = path.join(installedBinDir, 'pd');
      const globalSh = path.join(globalBin, 'pd');
      writeFileSync(globalSh, `#!/usr/bin/env sh\nexec "${pluginSh.replace(/"/g, '\\"')}" "$@"\n`, 'utf-8');
      chmodSync(globalSh, 0o755);
    }
    return true;
  } catch (e) {
    logger.warn(`Global pd shim installation failed: ${e instanceof Error ? e.message : String(e)}`);
    return false;
  }
}

function tryUpgradePdCliFromNpm(installedPdCliDir: string): void {
  if (!legacyNpmInstallEnabled()) {
    logger.info('Skipping npm pd-cli upgrade for the self-contained release asset.');
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

function syncPdCli(pluginDir: string): boolean {
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

  // Create node_modules/@principles/core symlink so pd-cli can resolve
  // its @principles/core dependency (rewritten to "file:../core" by bundle-plugin.mjs).
  // Without this, `node dist/index.js --version` fails because static imports
  // from @principles/core/runtime-v2 cannot be resolved.
  const coreLinkDir = path.join(installedPdCliDir, 'node_modules', '@principles');
  const coreLinkTarget = path.join(getPdRuntimeDir(), 'core');
  mkdirSync(coreLinkDir, { recursive: true });
  const coreLinkPath = path.join(coreLinkDir, 'core');
  if (!existsSync(coreLinkPath)) {
    if (isWindows()) {
      // On Windows, use a junction (directory symlink) which doesn't require elevated privileges
      symlinkSync(coreLinkTarget, coreLinkPath, 'junction');
    } else {
      // On Unix, use a relative symlink for portability
      symlinkSync('../../../core', coreLinkPath, 'dir');
    }
  }

  // Create node_modules/@principles/host-runtime symlink so pd-cli can resolve
  // its @principles/host-runtime dependency (rewritten to "file:../host-runtime"
  // by bundle-plugin.mjs). Without this, `pd --version` crashes with
  // ERR_MODULE_NOT_FOUND because pd-cli statically imports createProductionHostRuntime.
  // host-runtime's own better-sqlite3 / js-yaml / @principles/core dependencies
  // resolve through the plugin's <ext>/node_modules/ (shared via Node's upward
  // module resolution), so no separate npm install is needed.
  const hostRuntimeLinkTarget = path.join(getPdRuntimeDir(), 'host-runtime');
  const hostRuntimeLinkPath = path.join(coreLinkDir, 'host-runtime');
  if (!existsSync(hostRuntimeLinkPath)) {
    if (isWindows()) {
      symlinkSync(hostRuntimeLinkTarget, hostRuntimeLinkPath, 'junction');
    } else {
      symlinkSync('../../../host-runtime', hostRuntimeLinkPath, 'dir');
    }
  }

  // Create node_modules/@principles/codex-adapter symlink so pd-cli can resolve
  // its @principles/codex-adapter dependency (rewritten to
  // "file:../codex-adapter" by bundle-plugin.mjs). Without this, `pd codex
  // worker` crashes with ERR_MODULE_NOT_FOUND (PRI-624).
  const codexAdapterLinkTarget = path.join(getPdRuntimeDir(), 'codex-adapter');
  const codexAdapterLinkPath = path.join(coreLinkDir, 'codex-adapter');
  if (!existsSync(codexAdapterLinkPath)) {
    if (isWindows()) {
      symlinkSync(codexAdapterLinkTarget, codexAdapterLinkPath, 'junction');
    } else {
      symlinkSync('../../../codex-adapter', codexAdapterLinkPath, 'dir');
    }
  }

  // Create node_modules/principles-disciple symlink so pd-cli can resolve
  // its principles-disciple dependency (the plugin package, rewritten to
  // "file:../plugin" by bundle-plugin.mjs). The plugin is installed at the
  // extension dir root (getPluginExtDir()), so the symlink target is the
  // ext dir itself — Node resolves `import 'principles-disciple'` via the
  // plugin's package.json exports field.
  // Without this, `pd runtime init` crashes with ERR_MODULE_NOT_FOUND
  // because runtime-init.ts statically imports initTrajectorySchema/initWorkflowSchema.
  const pdLinkDir = path.join(installedPdCliDir, 'node_modules');
  const pdLinkTarget = installedPluginDir();
  mkdirSync(pdLinkDir, { recursive: true });
  const pdLinkPath = path.join(pdLinkDir, 'principles-disciple');
  if (!existsSync(pdLinkPath)) {
    if (isWindows()) {
      symlinkSync(pdLinkTarget, pdLinkPath, 'junction');
    } else {
      // Relative from <ext>/pd-cli/node_modules/ to <ext>/: go up twice
      // (node_modules → pd-cli → ext)
      symlinkSync('../../', pdLinkPath, 'dir');
    }
  }

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

  return installGlobalPdShim();
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
  const authorityPath = path.join(getInstalledReleaseManagerDir(), 'dist', 'update', 'release-manager-authority.js');
  if (!existsSync(authorityPath)) {
    throw new Error('Installed release-manager authority module not found — installation is incomplete.');
  }
  try {
    await import(pathToFileURL(authorityPath).href);
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

  const pluginLinkPath = path.join(consoleDest, 'node_modules', 'principles-disciple');
  mkdirSync(path.dirname(pluginLinkPath), { recursive: true });
  if (!existsSync(pluginLinkPath)) {
    if (isWindows()) {
      symlinkSync(installedPluginDir(), pluginLinkPath, 'junction');
    } else {
      symlinkSync(path.relative(path.dirname(pluginLinkPath), installedPluginDir()), pluginLinkPath, 'dir');
    }
  }

  // PRI-672: console resolves its create-principles-disciple dependency (the
  // ReleaseManager authority module, rewritten to file:../release-manager by
  // bundle-plugin.mjs) through this link into ~/.pd/runtime.
  const releaseManagerLinkPath = path.join(consoleDest, 'node_modules', 'create-principles-disciple');
  if (!existsSync(releaseManagerLinkPath)) {
    mkdirSync(path.dirname(releaseManagerLinkPath), { recursive: true });
    if (isWindows()) {
      symlinkSync(getInstalledReleaseManagerDir(), releaseManagerLinkPath, 'junction');
    } else {
      symlinkSync(path.relative(path.dirname(releaseManagerLinkPath), getInstalledReleaseManagerDir()), releaseManagerLinkPath, 'dir');
    }
  }
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

const CONSOLE_PORT_MAX_RETRIES = 3;

async function verifyConsole(workspaceDir: string): Promise<{ ok: boolean; url: string; process: ChildProcess | null; reason?: string }> {
  const consoleDest = getInstalledConsoleDir();
  const serverEntry = path.join(consoleDest, 'dist', 'server.js');

  if (!existsSync(serverEntry)) {
    return { ok: false, url: '', process: null, reason: 'Console server entry not found' };
  }

  // EP-06 regression guard (PR #1169): verify the web UI bundle exists BEFORE
  // spawning the server. Without dist/web/index.html the server returns 404
  // "Run npm run build:ui first" on every route — a fatal first-impression bug
  // for new users. npm install --ignore-scripts can remove dist/ in edge cases.
  const webIndex = path.join(consoleDest, 'dist', 'web', 'index.html');
  if (!existsSync(webIndex)) {
    return { ok: false, url: '', process: null, reason: 'Console web UI (dist/web/index.html) not found — bundle may be corrupted or npm install removed dist/. Re-run: npx create-principles-disciple' };
  }

  // Build a shuffled port list to avoid retrying the same port
  const portRange: number[] = [];
  for (let p = CONSOLE_PORT_RANGE_MIN; p <= CONSOLE_PORT_RANGE_MAX; p++) portRange.push(p);
  for (let i = portRange.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const a = portRange[i];
    const b = portRange[j];
    if (a === undefined || b === undefined) continue;
    portRange[i] = b;
    portRange[j] = a;
  }
  const portsToTry = portRange.slice(0, CONSOLE_PORT_MAX_RETRIES);

  let lastReason = '';

  for (const port of portsToTry) {
    const child = spawn(process.execPath, [serverEntry, '--workspace', workspaceDir, '--port', String(port), '--no-auth', '--host', '127.0.0.1'], {
      stdio: 'pipe',
      env: { ...process.env },
      detached: false,
    });

    let childExited = false;
    let childExitCode: number | null = null;
    let childStderr = '';
    let childStdout = '';
    child.on('exit', (code) => {
      childExited = true;
      childExitCode = code;
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      childStderr += chunk.toString();
    });
    child.stdout?.on('data', (chunk: Buffer) => {
      childStdout += chunk.toString();
    });

    await new Promise<void>((resolve) => { setTimeout(resolve, CONSOLE_WARMUP_TIME_MS); });

    if (childExited) {
      lastReason = `Console process exited prematurely with code ${childExitCode} on port ${port}. Stderr: ${childStderr.slice(0, 500)}`;
      continue; // Try next port
    }

    const url = `http://127.0.0.1:${port}`;
    let ok = false;
    let reason = '';
    try {
      const result = await new Promise<{ statusCode: number; body: string }>((resolve, reject) => {
        const req = http.get(`${url}/api/health`, (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk: Buffer) => chunks.push(chunk));
          res.on('end', () => {
            resolve({ statusCode: res.statusCode ?? 0, body: Buffer.concat(chunks).toString() });
          });
        });
        req.on('error', reject);
        req.setTimeout(CONSOLE_HEALTH_CHECK_TIMEOUT_MS, () => { req.destroy(); reject(new Error('health check timeout')); });
      });

      if (result.statusCode !== 200) {
        reason = `Console /api/health returned HTTP ${result.statusCode} (expected 200)`;
      } else if (!result.body || result.body.trim().length === 0) {
        reason = 'Console /api/health returned empty body';
      } else {
        try {
          const parsed: unknown = JSON.parse(result.body);
          if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
            reason = 'Console /api/health returned non-object JSON';
          } else {
            ok = true;
          }
        } catch {
          reason = 'Console /api/health returned malformed JSON';
        }
      }
    } catch (e) {
      reason = `Console health check failed on port ${port}: ${e instanceof Error ? e.message : String(e)}. Stderr: ${childStderr.slice(0, 300)}. Stdout: ${childStdout.slice(0, 300)}`;
    }

    if (!ok) {
      try { child.kill('SIGTERM'); } catch { /* ignore */ }
      try {
        if (!childExited) {
          child.kill('SIGKILL');
        }
      } catch { /* ignore */ }
      lastReason = reason;
      continue; // Try next port
    }

    return { ok: true, url, process: child };
  }

  return { ok: false, url: '', process: null, reason: `All ${CONSOLE_PORT_MAX_RETRIES} port attempts failed. Last: ${lastReason}` };
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

/**
 * Probe /api/health on a single port. Reuses the http module already imported.
 */
function probeAutolaunchHealth(port: number, timeoutMs = 1500): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.get(`http://127.0.0.1:${port}/api/health`, (res) => {
      if (res.statusCode !== 200) { resolve(false); return; }
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        try {
          const body = JSON.parse(Buffer.concat(chunks).toString()) as unknown;
          // P1-B: verify a PD-specific field inside body.data, not just the generic
          // { success: true } envelope that ANY service could return. PD Console's
          // /api/health responds via sendSuccess -> { success: true, data: {...} } where
          // data.overall is one of 'healthy' | 'degraded' | 'error' (HealthCheckModel).
          // The previous top-level `body.healthy` branch was dead code (PD Console never
          // returns it) and `body.success === true` alone matched any generic service.
          // rc-5-object-hasown-not-in: use Object.hasOwn, not `in`, for untrusted keys.
          const isPdConsole = (() => {
            if (typeof body !== 'object' || body === null) return false;
            if (!Object.hasOwn(body, 'success') || Reflect.get(body, 'success') !== true) return false;
            if (!Object.hasOwn(body, 'data')) return false;
            const data = Reflect.get(body, 'data');
            if (typeof data !== 'object' || data === null) return false;
            // data.overall is the PD-specific discriminative field.
            if (!Object.hasOwn(data, 'overall')) return false;
            const overall = Reflect.get(data, 'overall');
            return overall === 'healthy' || overall === 'degraded' || overall === 'error';
          })();
          resolve(isPdConsole);
        } catch { resolve(false); }
      });
    });
    req.on('error', () => resolve(false));
    req.setTimeout(timeoutMs, () => { req.destroy(); resolve(false); });
  });
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
async function autoLaunchConsole(workspaceDir: string): Promise<{ consoleUrl?: string; fallbackAction?: string }> {
  const pdCliEntry = path.join(getInstalledPdCliDir(), 'dist', 'index.js');
  if (!existsSync(pdCliEntry)) {
    return { fallbackAction: `pd console open --workspace "${workspaceDir}" --no-auth (auto-launch skipped: pd CLI entry not found)` };
  }

  // Spawn `pd console open` detached — reuses handleConsoleOpen (port detection,
  // reuse, health). --no-browser because we open /welcome ourselves.
  const child = spawn(
    process.execPath,
    [pdCliEntry, 'console', 'open', '--workspace', workspaceDir, '--no-auth', '--no-browser'],
    { detached: true, stdio: 'ignore', shell: false },
  );
  child.unref();

  // Wait for the console to become ready (bounded poll on 3100..3105).
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
          return { consoleUrl, fallbackAction: `Console ready at ${consoleUrl} (browser auto-open failed: ${browserResult.reason ?? 'unknown'} — open the URL manually)` };
        }
        return { consoleUrl };
      }
    }
     
    await new Promise((r) => setTimeout(r, CONSOLE_AUTOLAUNCH_POLL_INTERVAL_MS));
  }

  // EP-03: console did not become ready — provide manual launch instruction.
  return { fallbackAction: `pd console open --workspace "${workspaceDir}" --no-auth (auto-launch did not become ready in time; run manually)` };
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

async function createConfigFile(workspaceDir: string, channels: string[]): Promise<void> {
  const configDir = getOpenClawDir();
  const configPath = path.join(configDir, 'principles-disciple.json');

  let existingChannels: string[] | null = null;
  let existingFeatures: string[] | null = null;

  if (existsSync(configPath)) {
    const existingRaw = readFileSync(configPath, 'utf-8');
    const existing: unknown = JSON.parse(existingRaw);
    if (existing !== null && typeof existing === 'object' && !Array.isArray(existing)) {
      const existingObj = existing as Record<string, unknown>;
      if (Object.hasOwn(existingObj, 'channels') && Array.isArray(existingObj.channels)) {
        existingChannels = (existingObj.channels as unknown[]).filter((c): c is string => typeof c === 'string');
      }
      if (Object.hasOwn(existingObj, 'features') && Array.isArray(existingObj.features)) {
        existingFeatures = (existingObj.features as unknown[]).filter((f): f is string => typeof f === 'string');
      }
    }
  }

  const config: Record<string, unknown> = {
    workspace: workspaceDir,
    state: path.join(workspaceDir, '.state'),
    channels: existingChannels ?? channels,
    installedAt: new Date().toISOString(),
    mvpFirst: true,
  };

  if (existingFeatures) {
    config.features = existingFeatures;
  }

  await fse.ensureDir(configDir);
  await fse.writeJson(configPath, config, { spaces: 2 });
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
  /** ADR-0024 D-2 (PRI-664): transaction journal record for this install.
   * Undefined when the mutation never began (pre-mutation refusal/throw). */
  journal?: InstallJournalRecord;
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
 * Identity of the payload being installed. Prefers the self-contained asset
 * manifest (covers the whole payload); falls back to the bundled pd-cli
 * package manifest. Both are REAL digests — the journal never stores a
 * placeholder where a verifiable value is available (same discipline as
 * legacy-migration.ts). The last-resort fallback hashes the literal reason
 * string only to satisfy the journal's 64-hex format requirement; it is not
 * part of any release-metadata identity chain.
 */
function resolveInstallerPayloadIdentity(pluginDir: string): { productVersion: string; releaseMetadataDigest: string; releaseMetadataDigestSource: ReleaseMetadataDigestSource } {
  let productVersion = 'unknown';
  const pdCliPkgPath = path.join(pluginDir, 'pd-cli', 'package.json');
  if (existsSync(pdCliPkgPath)) {
    try {
      const parsed = JSON.parse(readFileSync(pdCliPkgPath, 'utf8')) as { version?: unknown };
      if (typeof parsed.version === 'string' && parsed.version.length > 0) productVersion = parsed.version;
    } catch {
      // Identity falls back to 'unknown'; journaling must not brick install.
    }
  }
  const assetManifestPath = path.join(pluginDir, '_release', 'manifest.json');
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
  return { productVersion, releaseMetadataDigest, releaseMetadataDigestSource };
}

/** Opens one installer transaction: `~/.pd/transactions/<transactionId>.jsonl`. */
export function beginInstallerJournal(pluginDir: string): InstallerJournal {
  const { productVersion, releaseMetadataDigest, releaseMetadataDigestSource } = resolveInstallerPayloadIdentity(pluginDir);
  const transactionId = `install-${Date.now()}-${randomUUID().slice(0, 8)}`;
  const journalPath = path.join(getPdDir(), 'transactions', `${transactionId}.jsonl`);
  const releaseId = `bundled-${productVersion}-${releaseMetadataDigest.slice(0, 12)}`;
  return { transactionId, journalPath, releaseId, productVersion, releaseMetadataDigest, releaseMetadataDigestSource, generation: 1, degraded: false, lastState: null };
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
      const stopRes = await stopOpenClawGateway();
      if (!stopRes.ok) {
        logger.error(`${t('gateway_stop_failed')} ${stopRes.error ?? ''}`);
        return buildGatewayRefusalResult(options, {
          reason: `gateway_stop_failed: ${t('gateway_stop_failed_reason')}${stopRes.error ? ` — ${stopRes.error}` : ''}`,
          nextAction: t('gateway_stop_failed_next'),
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
  let installManifestHosts: ('codex' | 'openclaw')[];
  const components: ComponentStatus = { plugin: 'skipped', cli: 'skipped', console: 'skipped' };
  const verification: VerificationResult = { features: 'skipped', storyA: 'skipped' };
  let consoleProcess: ChildProcess | null = null;
  let stepIndex = 0;
  // CP-6: true once the run has started deploying runtime components (after
  // the backup step). With no pre-existing install (no backup), a failure
  // after this point must clean up instead of claiming "not modified".
  let mutationStarted = false;

  const killConsoleChild = () => {
    if (consoleProcess) {
      try { consoleProcess.kill('SIGTERM'); } catch { /* ignore */ }
      try { consoleProcess.kill('SIGKILL'); } catch { /* ignore */ }
      consoleProcess = null;
    }
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

    if (spinner) updateProgress(spinner, stepIndex, 'Checking built plugin...');
    await checkBuiltPlugin(pluginDir);
    verification.manifestActivation = 'verified';
    stepIndex++;

    // Legacy rule contract preflight — run BEFORE the backup/rename step so
    // a refusal leaves the existing installation completely untouched. Only
    // meaningful when the target workspace already has PD state; fresh
    // workspaces scan clean (no state.db → nothing persisted to conflict).
    if (existsSync(path.join(path.resolve(options.workspaceDir), '.pd', 'state.db'))) {
      if (spinner) updateProgress(spinner, stepIndex, 'Checking workspace rule compatibility...');
      const compat = await runLegacyRuleContractPreflight(pluginDir, options.workspaceDir);
      if (!compat.ok) {
        if (!quiet) logger.error(compat.reason ?? 'legacy_rule_contract_dependency');
        return buildCompatibilityRefusalResult(options, compat);
      }
    }
    stepIndex++;

    if (spinner) updateProgress(spinner, stepIndex, 'Backing up existing install...');
    // ADR-0024 D-2 (PRI-664): journal-first — record 'planned' BEFORE the
    // first runtime mutation (the backup rename). Tier-1 policy: if the
    // journal cannot be written at all, refuse before mutating (fail loud,
    // zero side effects) rather than performing an unjournaled mutation
    // (refusal over silent degradation, ADR-0024 §2.4 rule 4).
    journal = transaction ?? beginInstallerJournal(pluginDir);
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
    installManifestHosts = resolveInstallManifestHosts(options.host);
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

    if (spinner) updateProgress(spinner, stepIndex, 'Installing release-manager authority module...');
    installBundledReleaseManagerPackage(pluginDir);
    await installReleaseManagerDependencies();
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
    syncPdCli(pluginDir);
    await installPdCliDependencies();
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
      logger.warn(`Global pd command not on PATH. Use local entry: "${cliVerify.localPath}" or add ${getInstalledBinDir()} to PATH.`);
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
    stepIndex++;
    // ADR-0024 D-2: all runtime content is laid down — the new installation
    // is staged (nothing has been discarded yet; backups still hold the old one).
    journalInstallerTransitionDegrading(journal, journal.lastState, 'staged', 'runtime components installed');

    if (spinner) updateProgress(spinner, stepIndex, 'Verifying pd-console...');
    const consoleVerify = await verifyConsole(options.workspaceDir);
    if (consoleVerify.ok) {
      components.console = 'configured';
      components.consoleEntrypoint = consoleVerify.url;
      consoleProcess = consoleVerify.process;
    } else {
      throw new Error(`Console verification failed: ${consoleVerify.reason ?? 'unknown'}. Installation rolled back — plugin and CLI are not activated.`);
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
    const configYamlPath = await generateConfigYamlConfig(options.workspaceDir, options.runtimeProfile);
    verification.features = 'passed';
    stepIndex++;

    if (spinner) updateProgress(spinner, stepIndex, 'Creating config...');
    await createConfigFile(options.workspaceDir, options.channels);
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
      throw new Error(`Demo verification failed: ${e instanceof Error ? e.message : String(e)}. Installation rolled back — plugin and CLI are not activated.`, { cause: e });
    }
    stepIndex++;

    if (spinner) updateProgress(spinner, stepIndex, 'Updating host config...');
    const hostResults = await runHostInstallers(options.host, {
      workspaceDir: options.workspaceDir,
      pluginDir,
      language: options.language,
      mode: options.mode,
      runtimeProfile: options.runtimeProfile
        ? {
            provider: options.runtimeProfile.provider,
            model: options.runtimeProfile.model,
            apiKeyEnv: options.runtimeProfile.apiKeyEnv,
          }
        : undefined,
    });

    // Report host install results (rc-9: surface failures, don't silently swallow).
    // rc-9 propagation: if ANY host installer failed, the aggregate install
    // result is NOT successful — callers (CLI, tests) must see the failure.
    // Previously failures were only logged, leaving `success: true` even when
    // a host adapter failed to install (silent failure).
    const hostFailures: string[] = [];
    for (const hr of hostResults) {
      if (!hr.success) {
        const msg = `Host "${hr.hostId}": ${hr.reason ?? 'unknown failure'}. Next: ${hr.nextAction}`;
        hostFailures.push(msg);
        logger.warn(msg);
      } else if (hr.configAction === 'skipped') {
        logger.info(`Host "${hr.hostId}" install: ${hr.reason ?? 'skipped'}. Next: ${hr.nextAction}`);
      }
    }

    if (hostFailures.length > 0) {
      throw new Error(`Host installation failed: ${hostFailures.join(' | ')}`);
    }
    writeInstallManifest(installManifestHosts, resolveInstallManifestWorkspaces(options.workspaceDir));
    // ADR-0024 D-2: host installers completed and the install manifest is
    // written — the new installation is fully activated (backups not yet
    // discarded, so a crash here still recovers via the backup).
    journalInstallerTransitionDegrading(journal, journal.lastState, 'activated', 'host installers completed; install manifest written');

    cleanupBackup(backupDir, runtimeBackupDir);
    // ADR-0024 D-2: backup cleanup is the commit point of the transaction.
    journalInstallerTransitionDegrading(journal, journal.lastState, 'confirmed', 'backup cleaned up; install complete');
    if (spinner) {
      spinner.succeed('Install complete!');
    }

    killConsoleChild();

    // Task 8: auto-launch console via `pd console open` (reuses PRI-300
    // handleConsoleOpen — no new launcher subsystem). Opens the browser to
    // /welcome for onboarding. Detached so the console survives installer exit.
    const launchResult = await autoLaunchConsole(options.workspaceDir);

    // PRI-645: report the ACTUAL effective channels (registry default +
    // sparse override). Never mask an explicit Owner disable with the
    // requested channels — that would re-create ERR-042 (reporting the
    // requested config instead of the actual state).
    const actualEnabledChannels = readEnabledChannelsFromConfigYaml(options.workspaceDir);
    const cliWorking = components.cli === 'verified' || components.cli === 'verified_local_only';
    const isComplete = components.plugin === 'verified' && cliWorking && components.console === 'configured';
    // A host installer failure means the install is not fully successful,
    // even if all component verifications passed. The operator should see
    // success=false and be guided to fix the failed host.
    const nextActions: string[] = [];
    if (components.cli === 'verified') {
      nextActions.push(`pd runtime canary --workspace "${options.workspaceDir}" --json`);
    } else if (components.cli === 'verified_local_only' && components.cliLocalPath) {
      nextActions.push(`"${components.cliLocalPath}" runtime canary --workspace "${options.workspaceDir}" --json`);
    }
    if (components.console === 'configured') {
      if (launchResult.consoleUrl) {
        // Console auto-launched — point user at the live URL.
        nextActions.push(`Console ready at ${launchResult.consoleUrl} (browser opened automatically)`);
      } else {
        // EP-03: auto-launch did not succeed — keep manual start instruction.
        nextActions.push(`pd console --workspace "${options.workspaceDir}" --no-auth (listens on 127.0.0.1 only)`);
      }
    }
    if (launchResult.fallbackAction) {
      nextActions.push(launchResult.fallbackAction);
    }
    return {
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
      journal: installerJournalRecord(journal),
    };
  } catch (error) {
    if (spinner) spinner.fail('Install failed');

    killConsoleChild();

    // ADR-0024 D-2: record the outcome (journal may be null when the throw
    // happened before the transaction was planned — zero side effects then).
    // `failed` and `rolled_back` are BOTH terminal states and one journal
    // file must end at exactly one terminal state (the strict reader rejects
    // any transition after a terminal one), so the outcome is either-or:
    // - backup restored (a real rollback happened) → `rolled_back`
    // - no backup existed (mutation never started) or restore failed → `failed`
    const errorMsgRaw = error instanceof Error ? error.message : String(error);
    const restoreResult = restoreBackup(backupDir, runtimeBackupDir);
    if (journal) {
      const restoreFailed = Boolean(backupDir || runtimeBackupDir) && !restoreResult.restored;
      const detail = restoreFailed
        ? `${errorMsgRaw}; backup restore FAILED: ${restoreResult.error ?? 'unknown'}`
        : errorMsgRaw;
      if ((backupDir || runtimeBackupDir) && restoreResult.restored) {
        journalInstallerTransitionDegrading(journal, journal.lastState, 'rolled_back', detail);
      } else {
        journalInstallerTransitionDegrading(journal, journal.lastState, 'failed', detail);
      }
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
    const hasBackup = Boolean(backupDir || runtimeBackupDir);
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
    const freshCleanup = !hasBackup && mutationStarted
      ? cleanUnactivatedFreshInstall()
      : undefined;
    // R2 (review): after template/config steps have run (console verified →
    // templates copied → config generated), the WORKSPACE also holds this
    // run's files — but the workspace is the operator's own directory and may
    // pre-date this run, so it is NOT wholesale-removed. Report its retention
    // honestly instead of claiming "nothing else was modified".
    const workspaceTouched = !hasBackup && mutationStarted && journal?.lastState !== 'planned';
    const rollbackSuffix = !hasBackup
      ? freshCleanup
        ? freshCleanup.failed.length === 0
          ? t('rollback_fresh_cleaned')
          : t('rollback_fresh_clean_failed').replace('{dirs}', freshCleanup.failed.map((f) => f.dir).join(', '))
        : t('rollback_no_changes')
      : restoreResult.restored
        ? t('rollback_restored')
        : t('rollback_failed')
          .replace('{restoreError}', restoreResult.error ?? '')
          .replace('{extDir}', extDir)
          .replace('{backupDir}', backupDir ?? runtimeBackupDir ?? '');
    const rollbackSuffixFinal = rollbackSuffix + (workspaceTouched && freshCleanup && freshCleanup.failed.length === 0 ? ` ${t('rollback_fresh_workspace_kept')}` : '');
    const rollbackNextAction = !hasBackup
      ? freshCleanup
        ? (freshCleanup.failed.length === 0 ? t('next_fresh_cleaned') : t('next_fresh_clean_failed'))
        : (isLockError
          ? t('next_no_changes_lock')
          : t('next_no_changes_other'))
      : restoreResult.restored
        ? t('next_restored')
        : t('next_restore_failed')
          .replace('{extDir}', extDir)
          .replace('{backupDir}', backupDir ?? runtimeBackupDir ?? '')
          .replace('{errorMsg}', errorMsg);
    const rollbackReason = !hasBackup
      ? freshCleanup
        ? (freshCleanup.failed.length === 0
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

    return {
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
      }
    }
  }
}
