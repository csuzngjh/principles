import { existsSync, readdirSync, statSync, readFileSync, writeFileSync, mkdirSync, rmSync, copyFileSync, cpSync, renameSync, chmodSync, symlinkSync } from 'fs';
import fse from 'fs-extra';
import * as path from 'path';
import * as http from 'http';
import { execSync, execFileSync, spawn, type ChildProcess } from 'child_process';
import type { ExecSyncOptions } from 'child_process';
import ora, { type Ora } from 'ora';
import { logger } from './utils/logger.js';
import { checkOpenClawGateway } from './utils/env.js';
import type { InstallOptions } from './prompts.js';
import {
  generateConfigYamlContent,
  getConfigYamlPath,
  validateConfigYamlFull,
  readEnabledChannelsFromConfigYaml,
  getOpenClawDir,
  getPluginExtDir,
  getInstalledPdCliDir,
  getInstalledBinDir,
  getInstalledConsoleDir,
  isWindows,
  validateOpenClawConfig,
  type ComponentStatus,
  type VerificationResult,
  type RuntimeProfileInput,
} from './mvp-config.js';

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
const PD_CLI_VERIFICATION_TIMEOUT_MS = 10_000;
const STORY_A_VERIFICATION_TIMEOUT_MS = 30_000;
const CONSOLE_HEALTH_CHECK_TIMEOUT_MS = 8_000;
const CONSOLE_WARMUP_TIME_MS = 6_000;

// 端口范围常量
const CONSOLE_PORT_RANGE_MIN = 3100;
const CONSOLE_PORT_RANGE_MAX = 3199;

// Task 8: auto-launch console via `pd console open` after successful install
const CONSOLE_AUTOLAUNCH_BASE_PORT = 3100;
const CONSOLE_AUTOLAUNCH_PORT_SCAN_LIMIT = 20; // 3100..3119 (matches pd console open PORT_FALLBACK_LIMIT)
const CONSOLE_AUTOLAUNCH_READY_TIMEOUT_MS = 12_000;
const CONSOLE_AUTOLAUNCH_POLL_INTERVAL_MS = 500;

// 允许的原生模块白名单
const ALLOWED_NATIVE_MODULES = ['better-sqlite3'];

function getCapturingExecOptions(cwd: string, timeoutOverride?: number): ExecSyncOptions {
  return {
    cwd,
    stdio: 'pipe' as const,
    env: process.env,
    timeout: timeoutOverride ?? INSTALL_TIMEOUT_MS,
  };
}

/**
 * 执行 npm install 并提供友好的错误提示
 */
async function runNpmInstall(cwd: string, componentName = 'npm'): Promise<void> {
  const execOpts = getCapturingExecOptions(cwd);
  try {
    execSync('npm install --ignore-scripts --legacy-peer-deps', execOpts);
  } catch (e) {
    const errorMsg = e instanceof Error ? e.message : String(e);

    // 动态导入 i18n 以避免循环依赖
    const { t } = await import('./i18n.js');

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
 * 重建原生模块
 */
export async function rebuildNativeModules(cwd: string, componentName: string): Promise<void> {
  for (const mod of ALLOWED_NATIVE_MODULES) {
    const modPath = path.join(cwd, 'node_modules', mod);
    if (!existsSync(modPath)) continue;

    try {
      execSync(`npm rebuild ${mod}`, getCapturingExecOptions(cwd));
    } catch (e) {
      throw new Error(`${componentName} native module ${mod} rebuild failed: ${e instanceof Error ? e.message : String(e)}. Try manually: cd ${cwd} && npm rebuild ${mod}`, { cause: e });
    }
  }
}

/**
 * 验证原生模块
 */
export function verifyNativeModules(cwd: string, componentName: string): void {
  for (const nativeMod of ALLOWED_NATIVE_MODULES) {
    const nativeModPath = path.join(cwd, 'node_modules', nativeMod);
    if (!existsSync(nativeModPath)) continue;

    try {
      execFileSync(process.execPath, ['-e', `require('${nativeMod}')`], { cwd, stdio: 'pipe' });
    } catch {
      throw new Error(`${componentName} native module ${nativeMod} verification failed after rebuild. The install cannot proceed.`);
    }
  }
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
  { name: 'Backing up existing install', weight: 3 },
  { name: 'Installing bundled @principles/core', weight: 8 },
  { name: 'Installing core dependencies', weight: 10 },
  { name: 'Installing plugin', weight: 10 },
  { name: 'Pre-filling @principles/core for plugin', weight: 3 },
  { name: 'Installing plugin dependencies', weight: 20 },
  { name: 'Installing pd CLI', weight: 8 },
  { name: 'Pre-filling @principles/core for pd-cli', weight: 3 },
  { name: 'Verifying pd CLI', weight: 3 },
  { name: 'Installing pd-console', weight: 8 },
  { name: 'Pre-filling @principles/core for console', weight: 3 },
  { name: 'Installing console dependencies', weight: 10 },
  { name: 'Verifying pd-console', weight: 3 },
  { name: 'Copying templates', weight: 3 },
  { name: 'Generating config.yaml', weight: 2 },
  { name: 'Creating config', weight: 2 },
  { name: 'Verifying pd demo story-a', weight: 5 },
  { name: 'Updating OpenClaw config', weight: 3 },
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
}

function backupExistingInstall(): BackupResult {
  const extDir = getPluginExtDir();
  if (!existsSync(extDir)) return { type: 'no_existing', backupDir: null };

  const backupDir = extDir + '.backup.' + Date.now();
  try {
    renameSync(extDir, backupDir);
    logger.info(`Backed up existing install to ${backupDir}`);
    return { type: 'backed_up', backupDir };
  } catch (e) {
    throw new Error(`Could not backup existing install at ${extDir}: ${e instanceof Error ? e.message : String(e)}. Aborting to prevent data loss — resolve the lock or rename manually and re-run.`, { cause: e });
  }
}

function restoreBackup(backupDir: string | null): { restored: boolean; error?: string } {
  if (!backupDir || !existsSync(backupDir)) return { restored: true };
  const extDir = getPluginExtDir();
  try {
    if (existsSync(extDir)) {
      rmSync(extDir, { recursive: true, force: true });
    }
    renameSync(backupDir, extDir);
    logger.info('Restored previous install from backup');
    return { restored: true };
  } catch (e) {
    const msg = `Failed to restore backup: ${e instanceof Error ? e.message : String(e)}`;
    logger.error(msg);
    return { restored: false, error: msg };
  }
}

function cleanupBackup(backupDir: string | null): void {
  if (!backupDir || !existsSync(backupDir)) return;
  try {
    rmSync(backupDir, { recursive: true, force: true });
  } catch {
    // non-fatal
  }
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

async function installPluginToStaging(pluginDir: string): Promise<void> {
  const extDir = getPluginExtDir();
  const builtPluginDir = path.join(pluginDir, 'plugin');

  await fse.ensureDir(extDir);
  await fse.copy(builtPluginDir, extDir, { overwrite: true });
}

async function updateOpenClawConfig(): Promise<void> {
  const configDir = getOpenClawDir();
  const configPath = path.join(configDir, 'openclaw.json');

  if (!existsSync(configPath)) return;

  const rawConfig = readFileSync(configPath, 'utf-8');
  const config: unknown = JSON.parse(rawConfig);

  const validation = validateOpenClawConfig(config);
  if (!validation.valid) {
    throw new Error(`Malformed openclaw.json: ${validation.error}. Fix manually and re-run installer.`);
  }

  if (config === null || typeof config !== 'object' || Array.isArray(config)) return;

  const configObj = { ...(config as Record<string, unknown>) };

  if (!configObj.plugins) configObj.plugins = {};
  if (typeof configObj.plugins !== 'object' || configObj.plugins === null || Array.isArray(configObj.plugins)) {
    throw new Error('openclaw.json plugins field is malformed. Fix manually and re-run installer.');
  }
  const plugins = { ...(configObj.plugins as Record<string, unknown>) };

  if (!plugins.allow) plugins.allow = [];
  if (!Array.isArray(plugins.allow)) {
    throw new Error('openclaw.json plugins.allow is not an array. Fix manually and re-run installer.');
  }
  const allow = (plugins.allow as unknown[]).filter((a): a is string => typeof a === 'string');
  if (!allow.includes('principles-disciple')) {
    allow.push('principles-disciple');
  }
  plugins.allow = allow;

  if (!plugins.entries) plugins.entries = {};
  if (typeof plugins.entries !== 'object' || plugins.entries === null || Array.isArray(plugins.entries)) {
    throw new Error('openclaw.json plugins.entries is malformed. Fix manually and re-run installer.');
  }
  const entries = { ...(plugins.entries as Record<string, unknown>) };
  // Merge with existing config — preserve hooks, config, and other user settings
  const existingEntry = (typeof entries['principles-disciple'] === 'object' && entries['principles-disciple'] !== null && !Array.isArray(entries['principles-disciple']))
    ? { ...(entries['principles-disciple'] as Record<string, unknown>) }
    : {};
  entries['principles-disciple'] = { ...existingEntry, enabled: true };
  plugins.entries = entries;

  // Do NOT write plugins.installs — OpenClaw manages install records in
  // ~/.openclaw/plugins/installs.json and strips plugins.installs from
  // openclaw.json on every write. Writing it here causes duplicate
  // registration and config corruption loops.

  // PRI-343: Deep-merge allowConversationAccess: true into the config
  // This ensures the field survives openclaw doctor --fix backup restores
  const mergedConfigObj = ensureConversationAccess(configObj);
  writeFileSync(configPath, JSON.stringify(mergedConfigObj, null, 2));

  // Write install record to installs.json (the canonical store)
  const installsDir = path.join(configDir, 'plugins');
  const installsPath = path.join(installsDir, 'installs.json');
  try {
    if (!existsSync(installsDir)) {
      mkdirSync(installsDir, { recursive: true });
    }
    let installs: Record<string, unknown> = { version: 1, installRecords: {} };
    if (existsSync(installsPath)) {
      const raw = readFileSync(installsPath, 'utf-8');
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        installs = parsed as Record<string, unknown>;
      }
    }
    if (!installs.installRecords || typeof installs.installRecords !== 'object') {
      installs.installRecords = {};
    }
    const extDir = getPluginExtDir();
    const pkgPath = path.join(extDir, 'package.json');
    let version: string | undefined = undefined;
    if (existsSync(pkgPath)) {
      try {
        const pkg: unknown = JSON.parse(readFileSync(pkgPath, 'utf-8'));
        if (typeof pkg === 'object' && pkg !== null && Object.hasOwn(pkg, 'version')) {
          version = (pkg as Record<string, unknown>).version as string;
        }
      } catch { /* ignore */ }
    }
    (installs.installRecords as Record<string, unknown>)['principles-disciple'] = {
      source: 'path',
      installPath: extDir,
      ...(version ? { version } : {}),
      installedAt: new Date().toISOString(),
    };
    writeFileSync(installsPath, JSON.stringify(installs, null, 2));
  } catch {
    // Non-fatal — installs.json is managed by OpenClaw and will self-heal
  }
}

async function installPluginDependencies(): Promise<void> {
  const extDir = getPluginExtDir();
  const packageJsonPath = path.join(extDir, 'package.json');
  const nodeModulesPath = path.join(extDir, 'node_modules');

  if (!existsSync(packageJsonPath)) {
    throw new Error('Plugin package.json not found after copy — install is corrupted');
  }

  const packageJsonRaw: unknown = JSON.parse(readFileSync(packageJsonPath, 'utf-8'));
  if (typeof packageJsonRaw !== 'object' || packageJsonRaw === null || Array.isArray(packageJsonRaw)) {
    throw new Error('Plugin package.json is malformed');
  }
  const pkg = packageJsonRaw as Record<string, unknown>;
  const deps = (typeof pkg.dependencies === 'object' && pkg.dependencies !== null && !Array.isArray(pkg.dependencies))
    ? Object.keys(pkg.dependencies)
    : [];
  const devDeps = (typeof pkg.devDependencies === 'object' && pkg.devDependencies !== null && !Array.isArray(pkg.devDependencies))
    ? Object.keys(pkg.devDependencies)
    : [];
  const allDeps = [...deps, ...devDeps];

  let needsInstall = !existsSync(nodeModulesPath);
  if (!needsInstall) {
    for (const dep of allDeps) {
      if (!existsSync(path.join(extDir, 'node_modules', dep))) {
        needsInstall = true;
        break;
      }
    }
  }

  if (needsInstall) {
    await runNpmInstall(extDir, 'Plugin');
  }

  await rebuildNativeModules(extDir, 'Plugin');
  verifyNativeModules(extDir, 'Plugin');
}

function getNpmGlobalBinDir(): string | null {
  try {
    const prefix = execSync('npm prefix -g', { encoding: 'utf-8', stdio: 'pipe' }).trim();
    if (!prefix) return null;
    return process.platform === 'win32' ? prefix : path.join(prefix, 'bin');
  } catch {
    return null;
  }
}

function installGlobalPdShim(): boolean {
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
    const npmVersion = execSync('npm view @principles/pd-cli version', {
      encoding: 'utf-8',
      timeout: 15_000,
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();

    if (!npmVersion || !/^\d+\.\d+\.\d+/.test(npmVersion)) return;

    const localPkgPath = path.join(installedPdCliDir, 'package.json');
    const localPkg = JSON.parse(readFileSync(localPkgPath, 'utf-8')) as { version: string };
    const localVersion = localPkg.version;

    if (npmVersion === localVersion) return;

    logger.info(`Upgrading pd-cli from bundled v${localVersion} to npm v${npmVersion}...`);

    const tmpDir = path.join(installedPdCliDir, '__npm_upgrade_tmp');
    try {
      mkdirSync(tmpDir, { recursive: true });
      execSync(`npm pack @principles/pd-cli@${npmVersion} --pack-destination "${tmpDir}"`, {
        encoding: 'utf-8',
        timeout: 30_000,
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      const tgzFiles = readdirSync(tmpDir).filter(f => f.endsWith('.tgz'));
      const [tgzFile] = tgzFiles;
      if (!tgzFile) {
        logger.info('No npm tarball found, keeping bundled version.');
        return;
      }

      const extractDir = path.join(tmpDir, 'extracted');
      mkdirSync(extractDir, { recursive: true });
      execSync(`tar -xzf "${path.join(tmpDir, tgzFile)}" -C "${extractDir}"`, {
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

  // Create node_modules/@principles/core symlink so pd-cli can resolve
  // its @principles/core dependency (rewritten to "file:../core" by bundle-plugin.mjs).
  // Without this, `node dist/index.js --version` fails because static imports
  // from @principles/core/runtime-v2 cannot be resolved.
  const coreLinkDir = path.join(installedPdCliDir, 'node_modules', '@principles');
  const coreLinkTarget = path.join(getPluginExtDir(), 'core');
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

  // Create node_modules/principles-disciple symlink so pd-cli can resolve
  // its principles-disciple dependency (the plugin package, rewritten to
  // "file:../plugin" by bundle-plugin.mjs). The plugin is installed at the
  // extension dir root (getPluginExtDir()), so the symlink target is the
  // ext dir itself — Node resolves `import 'principles-disciple'` via the
  // plugin's package.json exports field.
  // Without this, `pd runtime init` crashes with ERR_MODULE_NOT_FOUND
  // because runtime-init.ts statically imports initTrajectorySchema/initWorkflowSchema.
  const pdLinkDir = path.join(installedPdCliDir, 'node_modules');
  const pdLinkTarget = getPluginExtDir();
  mkdirSync(pdLinkDir, { recursive: true });
  const pdLinkPath = path.join(pdLinkDir, 'principles-disciple');
  if (!existsSync(pdLinkPath)) {
    if (isWindows()) {
      symlinkSync(pdLinkTarget, pdLinkPath, 'junction');
    } else {
      // Relative from <ext>/pd-cli/node_modules/ to <ext>/: go up twice (node_modules → pd-cli → ext)
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

function verifyPdCliShim(): { localOk: boolean; globalOk: boolean; localPath: string } {
  const localShim = path.join(getInstalledBinDir(), isWindows() ? 'pd.cmd' : 'pd');
  let localOk = false;
  try {
    const installedEntry = path.join(getInstalledPdCliDir(), 'dist', 'index.js');
    execFileSync(process.execPath, [installedEntry, '--version'], { stdio: 'pipe', timeout: PD_CLI_VERIFICATION_TIMEOUT_MS });
    localOk = true;
  } catch (e: unknown) {
    const err = e as { stderr?: Buffer; message?: string };
    const detail = err.stderr?.toString().slice(0, 500) ?? err.message ?? 'unknown error';
    logger.warn(`PD CLI local verification failed: ${detail}`);
  }

  const globalOk = (() => {
    try {
      if (isWindows()) {
        execSync('pd --version', { stdio: 'pipe', timeout: PD_CLI_VERIFICATION_TIMEOUT_MS, shell: 'cmd' });
      } else {
        execFileSync('pd', ['--version'], { stdio: 'pipe', timeout: PD_CLI_VERIFICATION_TIMEOUT_MS });
      }
      return true;
    } catch {
      return false;
    }
  })();

  return { localOk, globalOk, localPath: localShim };
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
}

function getInstalledCoreDir(): string {
  return path.join(getPluginExtDir(), 'core');
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

function ensureCoreDependency(_targetDir: string): void {
  const coreDir = getInstalledCoreDir();
  if (!existsSync(coreDir)) {
    throw new Error('Installed @principles/core not found. Run installBundledCore first.');
  }
}

async function installCoreDependencies(): Promise<void> {
  const coreDir = getInstalledCoreDir();
  const packageJsonPath = path.join(coreDir, 'package.json');

  if (!existsSync(packageJsonPath)) {
    throw new Error('Core package.json not found after copy — install is corrupted');
  }

  await runNpmInstall(coreDir, 'Core');
  await rebuildNativeModules(coreDir, 'Core');
  verifyNativeModules(coreDir, 'Core');
}

async function installConsoleDependencies(): Promise<void> {
  const consoleDest = getInstalledConsoleDir();
  const packageJsonPath = path.join(consoleDest, 'package.json');

  if (!existsSync(packageJsonPath)) {
    throw new Error('Console package.json not found after copy — install is corrupted');
  }

  await runNpmInstall(consoleDest, 'Console');
  await rebuildNativeModules(consoleDest, 'Console');
}

const CONSOLE_PORT_MAX_RETRIES = 3;

async function verifyConsole(workspaceDir: string): Promise<{ ok: boolean; url: string; process: ChildProcess | null; reason?: string }> {
  const consoleDest = getInstalledConsoleDir();
  const serverEntry = path.join(consoleDest, 'dist', 'server.js');

  if (!existsSync(serverEntry)) {
    return { ok: false, url: '', process: null, reason: 'Console server entry not found' };
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

  // PRI-308: preserve existing valid config.yaml
  if (existsSync(configPath)) {
    try {
      validateConfigYamlFull(workspaceDir);
      // Existing config is structurally valid — preserve it
      logger.info(`Existing .pd/config.yaml is valid, preserving it`);
      return configPath;
    } catch (e) {
      // Existing config is malformed — fail loud, do not overwrite
      const reason = e instanceof Error ? e.message : String(e);
      throw new Error(`Existing .pd/config.yaml is malformed: ${reason}. Delete the file and re-run the installer, or fix it manually.`, { cause: e });
    }
  }

  await fse.ensureDir(configDir);
  // Fix-4 (P0-BUG-4): pass through the runtime profile collected by the
  // prompt flow so the generated config.yaml's pd.default profile is
  // pre-filled instead of empty (avoids silent LLM failures on first run).
  writeFileSync(configPath, generateConfigYamlContent(runtimeProfile), 'utf8');
  return configPath;
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
  error?: string;
  /** Task 8: URL the browser was opened to when the installer auto-launched the
   * console via `pd console open`. Undefined when auto-launch was skipped or failed. */
  consoleUrl?: string;
}

export async function install(options: InstallOptions, pluginDir: string, quiet = false): Promise<InstallResult> {
  const gatewayStatus = await checkOpenClawGateway();
  if (gatewayStatus.isRunning) {
    const portInfo = gatewayStatus.port ? ` (port ${gatewayStatus.port})` : '';
    const pidInfo = gatewayStatus.pid ? `, PID ${gatewayStatus.pid}` : '';
    logger.warn(`OpenClaw gateway is running${portInfo}${pidInfo}.`);
    logger.warn('This may cause file lock issues during installation (EPERM on native modules).');
    logger.warn('Recommendation: stop OpenClaw first with "openclaw gateway stop", then re-run the installer.');
    logger.warn('Proceeding anyway — if installation fails, stop OpenClaw and retry.\n');
  }

  const spinner = quiet ? null : ora('Installing...').start();
  let backupDir: string | null = null;
  const components: ComponentStatus = { plugin: 'skipped', cli: 'skipped', console: 'skipped' };
  const verification: VerificationResult = { features: 'skipped', storyA: 'skipped' };
  let consoleProcess: ChildProcess | null = null;
  let stepIndex = 0;

  const killConsoleChild = () => {
    if (consoleProcess) {
      try { consoleProcess.kill('SIGTERM'); } catch { /* ignore */ }
      try { consoleProcess.kill('SIGKILL'); } catch { /* ignore */ }
      consoleProcess = null;
    }
  };

  try {
    if (spinner) updateProgress(spinner, stepIndex, 'Checking built plugin...');
    await checkBuiltPlugin(pluginDir);
    verification.manifestActivation = 'verified';
    stepIndex++;

    if (spinner) updateProgress(spinner, stepIndex, 'Backing up existing install...');
    const { backupDir: backupDirFromResult } = backupExistingInstall();
    backupDir = backupDirFromResult;
    stepIndex++;

    if (spinner) updateProgress(spinner, stepIndex, 'Installing bundled @principles/core...');
    installBundledCore(pluginDir);
    stepIndex++;

    if (spinner) updateProgress(spinner, stepIndex, 'Installing core dependencies...');
    await installCoreDependencies();
    stepIndex++;

    if (spinner) updateProgress(spinner, stepIndex, 'Installing plugin...');
    await installPluginToStaging(pluginDir);
    stepIndex++;

    if (spinner) updateProgress(spinner, stepIndex, 'Pre-filling @principles/core for plugin...');
    ensureCoreDependency(getPluginExtDir());
    stepIndex++;

    if (spinner) updateProgress(spinner, stepIndex, 'Installing plugin dependencies...');
    await installPluginDependencies();
    components.plugin = 'verified';
    stepIndex++;

    if (spinner) updateProgress(spinner, stepIndex, 'Installing pd CLI...');
    syncPdCli(pluginDir);
    stepIndex++;

    if (spinner) updateProgress(spinner, stepIndex, 'Pre-filling @principles/core for pd-cli...');
    ensureCoreDependency(getInstalledPdCliDir());
    stepIndex++;

    if (spinner) updateProgress(spinner, stepIndex, 'Verifying pd CLI...');
    const cliVerify = verifyPdCliShim();
    if (!cliVerify.localOk) {
      throw new Error('PD CLI verification failed — local shim is not executable after install. Check Node.js and PATH configuration.');
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

    if (spinner) updateProgress(spinner, stepIndex, 'Pre-filling @principles/core for console...');
    ensureCoreDependency(getInstalledConsoleDir());
    stepIndex++;

    if (spinner) updateProgress(spinner, stepIndex, 'Installing console dependencies...');
    await installConsoleDependencies();
    stepIndex++;

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

    if (spinner) updateProgress(spinner, stepIndex, 'Verifying pd demo story-a...');
    try {
      const installedPdCliEntry = path.join(getInstalledPdCliDir(), 'dist', 'index.js');
      execFileSync(process.execPath, [installedPdCliEntry, 'demo', 'story-a', '--json', '--workspace', options.workspaceDir], {
        stdio: 'pipe',
        timeout: STORY_A_VERIFICATION_TIMEOUT_MS,
      });
      verification.storyA = 'passed';
    } catch (e) {
      throw new Error(`Story A demo verification failed: ${e instanceof Error ? e.message : String(e)}. Installation rolled back — plugin and CLI are not activated.`, { cause: e });
    }
    stepIndex++;

    if (spinner) updateProgress(spinner, stepIndex, 'Updating OpenClaw config...');
    await updateOpenClawConfig();

    cleanupBackup(backupDir);
    if (spinner) spinner.succeed('Install complete!');

    killConsoleChild();

    // Task 8: auto-launch console via `pd console open` (reuses PRI-300
    // handleConsoleOpen — no new launcher subsystem). Opens the browser to
    // /welcome for onboarding. Detached so the console survives installer exit.
    const launchResult = await autoLaunchConsole(options.workspaceDir);

    const actualEnabledChannels = readEnabledChannelsFromConfigYaml(options.workspaceDir);
    const cliWorking = components.cli === 'verified' || components.cli === 'verified_local_only';
    const isComplete = components.plugin === 'verified' && cliWorking && components.console === 'configured';
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
      enabledChannels: actualEnabledChannels.length > 0 ? actualEnabledChannels : options.channels,
      nextAction: nextActions.join(' | '),
      consoleUrl: launchResult.consoleUrl,
    };
  } catch (error) {
    if (spinner) spinner.fail('Install failed');

    killConsoleChild();

    const restoreResult = restoreBackup(backupDir);

    const errorMsg = error instanceof Error ? error.message : String(error);
    const rollbackSuffix = restoreResult.restored
      ? 'Previous install has been restored.'
      : `CRITICAL: Rollback also failed — installation state is uncertain. ${restoreResult.error ?? ''} Resolve manually: check ${getPluginExtDir()} and ${backupDir}`;
    const nextAction = restoreResult.restored
      ? 'Check the error above. Previous install has been restored. Fix the issue and re-run the installer.'
      : `Installation and rollback both failed. Check ${getPluginExtDir()} and ${backupDir} manually. Error: ${errorMsg}`;
    const reason = restoreResult.restored
      ? errorMsg
      : `install_failed_rollback_failed: ${errorMsg}`;

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
      error: `${errorMsg} — ${rollbackSuffix}`,
    };
  }
}
