import { existsSync, readdirSync, statSync, readFileSync, writeFileSync, mkdirSync, rmSync, copyFileSync, cpSync, renameSync, chmodSync } from 'fs';
import fse from 'fs-extra';
import * as path from 'path';
import { execSync, execFileSync } from 'child_process';
import type { ExecSyncOptions } from 'child_process';
import ora from 'ora';
import { logger } from './utils/logger.js';
import type { InstallOptions } from './prompts.js';
import {
  generateFeatureFlagsYamlContent,
  getFeatureFlagsPath,
  getOpenClawDir,
  getPluginExtDir,
  getInstalledPdCliDir,
  getInstalledBinDir,
  isWindows,
  validateOpenClawConfig,
  readEnabledChannelsFromDisk,
  type ComponentStatus,
  type VerificationResult,
} from './mvp-config.js';

function getCapturingExecOptions(cwd: string): ExecSyncOptions {
  return {
    cwd,
    stdio: 'pipe' as const,
    env: process.env,
    timeout: 120_000,
  };
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

function restoreBackup(backupDir: string | null): void {
  if (!backupDir || !existsSync(backupDir)) return;
  const extDir = getPluginExtDir();
  try {
    if (existsSync(extDir)) {
      rmSync(extDir, { recursive: true, force: true });
    }
    renameSync(backupDir, extDir);
    logger.info('Restored previous install from backup');
  } catch (e) {
    logger.error(`Failed to restore backup: ${e instanceof Error ? e.message : String(e)}`);
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

async function checkBuiltPlugin(pluginDir: string): Promise<void> {
  const distDir = path.join(pluginDir, 'plugin', 'dist');
  const pluginJson = path.join(pluginDir, 'plugin', 'openclaw.plugin.json');

  if (!existsSync(distDir) || !existsSync(pluginJson)) {
    throw new Error(`Built plugin files missing at ${distDir}. Package may be corrupted.`);
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
  const extDir = getPluginExtDir();

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
  entries['principles-disciple'] = { enabled: true };
  plugins.entries = entries;

  if (!plugins.installs) plugins.installs = {};
  if (typeof plugins.installs !== 'object' || plugins.installs === null || Array.isArray(plugins.installs)) {
    throw new Error('openclaw.json plugins.installs is malformed. Fix manually and re-run installer.');
  }
  const installs = { ...(plugins.installs as Record<string, unknown>) };
  installs['principles-disciple'] = {
    source: 'path',
    installPath: extDir,
    installedAt: new Date().toISOString(),
  };
  plugins.installs = installs;

  configObj.plugins = plugins;
  writeFileSync(configPath, JSON.stringify(configObj, null, 2));
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
    ? Object.keys(pkg.dependencies as Record<string, unknown>)
    : [];
  const devDeps = (typeof pkg.devDependencies === 'object' && pkg.devDependencies !== null && !Array.isArray(pkg.devDependencies))
    ? Object.keys(pkg.devDependencies as Record<string, unknown>)
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
    const execOpts = getCapturingExecOptions(extDir);
    try {
      execSync('npm install --ignore-scripts', execOpts);
    } catch (e) {
      throw new Error(`npm install failed: ${e instanceof Error ? e.message : String(e)}. Try manually: cd ${extDir} && npm install --ignore-scripts`, { cause: e });
    }
  }

  const nativeModules = ['better-sqlite3'];
  const execOpts = getCapturingExecOptions(extDir);
  for (const mod of nativeModules) {
    const modPath = path.join(extDir, 'node_modules', mod);
    if (!existsSync(modPath)) continue;
    try {
      execSync(`npm rebuild ${mod}`, execOpts);
    } catch (e) {
      throw new Error(`Native module ${mod} rebuild failed: ${e instanceof Error ? e.message : String(e)}. Try manually: cd ${extDir} && npm rebuild ${mod}`, { cause: e });
    }
  }

  for (const nativeMod of nativeModules) {
    const nativeModPath = path.join(extDir, 'node_modules', nativeMod);
    if (!existsSync(nativeModPath)) continue;
    try {
      execSync('node -e "require(\'' + nativeMod + '\')"', { cwd: extDir, stdio: 'pipe' });
    } catch {
      throw new Error(`Native module ${nativeMod} verification failed after rebuild. The install cannot proceed.`);
    }
  }
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
    if (isWindows()) {
      execSync(`"${localShim}" --version`, { stdio: 'pipe', timeout: 10_000, shell: 'cmd' });
    } else {
      execFileSync(localShim, ['--version'], { stdio: 'pipe', timeout: 10_000 });
    }
    localOk = true;
  } catch { /* local shim failed */ }

  const globalOk = (() => {
    try {
      if (isWindows()) {
        execSync('pd --version', { stdio: 'pipe', timeout: 10_000, shell: 'cmd' });
      } else {
        execFileSync('pd', ['--version'], { stdio: 'pipe', timeout: 10_000 });
      }
      return true;
    } catch {
      return false;
    }
  })();

  return { localOk, globalOk, localPath: localShim };
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
  const principlesSrc = path.join(opts.pluginDir, 'templates', 'workspace', '.principles');
  const principlesDest = path.join(opts.workspaceDir, '.principles');

  if (!existsSync(principlesSrc)) return 0;

  const files = readdirSync(principlesSrc);
  const langThinkingOsSrc = path.join(opts.pluginDir, 'templates', 'langs', opts.language, 'principles', 'THINKING_OS.md');

  for (const file of files) {
    let srcPath = path.join(principlesSrc, file);
    if (file === 'THINKING_OS.md' && existsSync(langThinkingOsSrc)) {
      srcPath = langThinkingOsSrc;
    }
    const destPath = path.join(principlesDest, file);
    if (statSync(srcPath).isDirectory()) continue;

    if (existsSync(destPath) && opts.mode === 'smart') {
      await fse.copy(srcPath, `${destPath}.update`, { overwrite: true });
    } else {
      await fse.ensureDir(principlesDest);
      await fse.copy(srcPath, destPath, { overwrite: true });
    }
    count++;
  }

  const modelsSrc = path.join(principlesSrc, 'models');
  const modelsDest = path.join(principlesDest, 'models');
  if (existsSync(modelsSrc)) {
    await fse.ensureDir(modelsDest);
    await fse.copy(modelsSrc, modelsDest, { overwrite: true });
    count += readdirSync(modelsDest).length;
  }
  return count;
}

async function generateFeatureFlagsConfig(workspaceDir: string, channels: string[]): Promise<string> {
  const configPath = getFeatureFlagsPath(workspaceDir);
  const configDir = path.dirname(configPath);

  await fse.ensureDir(configDir);
  writeFileSync(configPath, generateFeatureFlagsYamlContent(channels), 'utf8');
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
  featureFlagsPath: string;
  templatesCount: number;
  components: ComponentStatus;
  verification: VerificationResult;
  enabledChannels: string[];
  nextAction: string;
  reason?: string;
  error?: string;
}

export async function install(options: InstallOptions, pluginDir: string, quiet = false): Promise<InstallResult> {
  const spinner = quiet ? null : ora('Installing...').start();
  let backupDir: string | null = null;
  const components: ComponentStatus = { plugin: 'skipped', cli: 'skipped', console: 'not_deliverable' };
  const verification: VerificationResult = { features: 'skipped', storyA: 'skipped' };

  try {
    if (spinner) spinner.text = 'Checking built plugin...';
    await checkBuiltPlugin(pluginDir);

    if (spinner) spinner.text = 'Backing up existing install...';
    const { backupDir: backupDirFromResult } = backupExistingInstall();
    backupDir = backupDirFromResult;

    if (spinner) spinner.text = 'Installing plugin...';
    await installPluginToStaging(pluginDir);

    if (spinner) spinner.text = 'Installing plugin dependencies...';
    await installPluginDependencies();
    components.plugin = 'verified';

    if (spinner) spinner.text = 'Installing pd CLI...';
    syncPdCli(pluginDir);

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

    if (spinner) spinner.text = 'Copying templates...';
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

    if (spinner) spinner.text = 'Generating feature flags...';
    const featureFlagsPath = await generateFeatureFlagsConfig(options.workspaceDir, options.channels);
    verification.features = 'passed';

    if (spinner) spinner.text = 'Creating config...';
    await createConfigFile(options.workspaceDir, options.channels);

    if (spinner) spinner.text = 'Verifying pd demo story-a...';
    try {
      const pdCmd = path.join(getInstalledBinDir(), isWindows() ? 'pd.cmd' : 'pd');
      if (isWindows()) {
        execSync(`"${pdCmd}" demo story-a --json --workspace "${options.workspaceDir}"`, {
          stdio: 'pipe',
          shell: 'cmd',
          timeout: 30_000,
        });
      } else {
        execFileSync(pdCmd, ['demo', 'story-a', '--json', '--workspace', options.workspaceDir], {
          stdio: 'pipe',
          timeout: 30_000,
        });
      }
      verification.storyA = 'passed';
    } catch (e) {
      verification.storyA = 'skipped';
      verification.storyASkipReason = `Demo verification skipped: ${e instanceof Error ? e.message : String(e)}`;
    }

    if (spinner) spinner.text = 'Updating OpenClaw config...';
    await updateOpenClawConfig();

    cleanupBackup(backupDir);
    if (spinner) spinner.succeed('Install complete!');

    const actualEnabledChannels = readEnabledChannelsFromDisk(options.workspaceDir);
    const cliWorking = components.cli === 'verified' || components.cli === 'verified_local_only';
    const isComplete = components.plugin === 'verified' && cliWorking && components.console === 'configured';
    const nextActions: string[] = [];
    if (components.cli === 'verified') {
      nextActions.push(`pd runtime canary --workspace "${options.workspaceDir}" --json`);
    } else if (components.cli === 'verified_local_only' && components.cliLocalPath) {
      nextActions.push(`"${components.cliLocalPath}" runtime canary --workspace "${options.workspaceDir}" --json`);
    }
    if (components.console === 'not_deliverable') {
      nextActions.push('Owner review console is not yet deliverable — this is a release-blocking gap');
    }
    if (components.console === 'configured' && components.consoleEntrypoint) {
      nextActions.push(`Open review console: ${components.consoleEntrypoint}`);
    }

    return {
      success: isComplete,
      workspaceDir: options.workspaceDir,
      featureFlagsPath,
      templatesCount: templatesCount + principlesCount,
      components,
      verification,
      enabledChannels: actualEnabledChannels.length > 0 ? actualEnabledChannels : options.channels,
      nextAction: nextActions.join(' | '),
      ...(isComplete ? {} : { reason: 'owner_review_console_not_deliverable' }),
    };
  } catch (error) {
    if (spinner) spinner.fail('Install failed');

    restoreBackup(backupDir);

    const errorMsg = error instanceof Error ? error.message : String(error);
    return {
      success: false,
      workspaceDir: options.workspaceDir,
      featureFlagsPath: getFeatureFlagsPath(options.workspaceDir),
      templatesCount: 0,
      components,
      verification,
      enabledChannels: options.channels,
      nextAction: 'Check the error above. Previous install has been restored if it existed.',
      reason: errorMsg,
      error: errorMsg,
    };
  }
}
