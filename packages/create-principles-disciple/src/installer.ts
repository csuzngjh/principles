import { existsSync, readdirSync, statSync, readFileSync, writeFileSync } from 'fs';
import fse from 'fs-extra';
import * as path from 'path';
import { execSync } from 'child_process';
import type { ExecSyncOptions } from 'child_process';
import ora from 'ora';
import { logger } from './utils/logger.js';
import { getOpenClawConfigDir, getPluginExtDir } from './utils/env.js';
import type { InstallOptions } from './prompts.js';
import {
  generateFeatureFlagsYamlContent,
  getFeatureFlagsPath,
  buildNextAction,
  buildFailureReason,
  buildFailureNextAction,
} from './mvp-config.js';

const getExecOptions = (cwd: string): ExecSyncOptions => {
  const options: ExecSyncOptions = {
    cwd,
    stdio: 'inherit' as const,
    env: process.env,
  };
  if (process.platform === 'win32') {
    options.shell = process.env.ComSpec || 'cmd.exe';
  }
  return options;
};

async function cleanOldVersion(): Promise<void> {
  const extDir = getPluginExtDir();
  if (existsSync(extDir)) {
    await fse.remove(extDir);
    logger.info(`Removed old version: ${extDir}`);
  }
}

async function checkBuiltPlugin(pluginDir: string): Promise<void> {
  logger.step('Checking built plugin');

  const distDir = path.join(pluginDir, 'plugin', 'dist');
  const pluginJson = path.join(pluginDir, 'plugin', 'openclaw.plugin.json');

  if (!existsSync(distDir) || !existsSync(pluginJson)) {
    throw new Error(`Built plugin files missing. Expected at: ${distDir}. This may be a corrupted package. Reinstall or contact the developer.`);
  }

  logger.success('Built plugin check passed');
}

async function installPlugin(pluginDir: string): Promise<void> {
  logger.step('Installing plugin to OpenClaw');

  const extDir = getPluginExtDir();
  const configDir = getOpenClawConfigDir();
  const configPath = path.join(configDir, 'openclaw.json');
  const builtPluginDir = path.join(pluginDir, 'plugin');

  await fse.ensureDir(extDir);
  await fse.copy(builtPluginDir, extDir, { overwrite: true });
  logger.info('Plugin files copied');

  if (existsSync(configPath)) {
    const rawConfig = readFileSync(configPath, 'utf-8');
    const config: unknown = JSON.parse(rawConfig);

    if (config !== null && typeof config === 'object' && !Array.isArray(config)) {
      const configObj = config as Record<string, unknown>;
      if (!configObj.plugins) configObj.plugins = {};
      const plugins = configObj.plugins as Record<string, unknown>;
      if (!plugins.allow) plugins.allow = [];
      const allow = plugins.allow as string[];
      if (!allow.includes('principles-disciple')) {
        allow.push('principles-disciple');
      }

      if (!plugins.entries) plugins.entries = {};
      const entries = plugins.entries as Record<string, unknown>;
      entries['principles-disciple'] = { enabled: true };

      if (!plugins.installs) plugins.installs = {};
      const installs = plugins.installs as Record<string, unknown>;
      installs['principles-disciple'] = {
        source: 'path',
        installPath: extDir,
        installedAt: new Date().toISOString(),
      };

      writeFileSync(configPath, JSON.stringify(configObj, null, 2));
    }
  }

  logger.success('Plugin installed');
}

function verifyNativeModule(modulePath: string): boolean {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require(modulePath);
    return true;
  } catch {
    return false;
  }
}

async function installPluginDependencies(): Promise<void> {
  const extDir = getPluginExtDir();
  const packageJsonPath = path.join(extDir, 'package.json');
  const nodeModulesPath = path.join(extDir, 'node_modules');
  const nativeModules = ['better-sqlite3'];

  if (!existsSync(packageJsonPath)) {
    logger.warn('Plugin package.json not found, skipping dependency install');
    return;
  }

  const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf-8'));
  const allDeps = Object.keys({ ...packageJson.dependencies, ...packageJson.devDependencies });

  let needsInstall = !existsSync(nodeModulesPath);

  if (!needsInstall) {
    for (const dep of allDeps) {
      if (!existsSync(path.join(extDir, 'node_modules', dep))) {
        needsInstall = true;
        break;
      }
    }
    if (!needsInstall) {
      for (const mod of nativeModules) {
        const modPath = path.join(extDir, 'node_modules', mod);
        if (existsSync(modPath) && !verifyNativeModule(mod)) {
          logger.warn(`Native module ${mod} verification failed, needs rebuild`);
          needsInstall = true;
          break;
        }
      }
    }
  }

  if (!needsInstall) {
    logger.success('Plugin dependencies already installed');
    return;
  }

  logger.step('Installing plugin runtime dependencies');
  try {
    const execOpts = getExecOptions(extDir);
    logger.info('Downloading and installing npm dependencies...');
    execSync('npm install --ignore-scripts', execOpts);

    for (const mod of nativeModules) {
      const modPath = path.join(extDir, 'node_modules', mod);
      if (existsSync(modPath)) {
        logger.info(`Compiling native module ${mod}...`);
        try {
          execSync(`npm rebuild ${mod}`, execOpts);
        } catch (e) {
          logger.warn(`Native module ${mod} compile failed: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
    }

    let nativeModulesOk = true;
    for (const nativeMod of nativeModules) {
      const nativeModPath = path.join(extDir, 'node_modules', nativeMod);
      if (existsSync(nativeModPath)) {
        if (verifyNativeModule(nativeMod)) {
          logger.success(`Native module ${nativeMod} verified`);
        } else {
          logger.warn(`Native module ${nativeMod} verification failed`);
          nativeModulesOk = false;
        }
      }
    }

    if (nativeModulesOk) {
      logger.success('Plugin dependencies installed');
    } else {
      logger.warn('Some native modules may not work correctly');
      logger.info('If issues occur, run: cd ~/.openclaw/extensions/principles-disciple && npm rebuild');
    }
  } catch (error) {
    logger.error('Dependency install failed');
    logger.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
    logger.info('');
    logger.info('Manual fix steps:');
    logger.info(`  cd ${extDir}`);
    logger.info('  npm install --ignore-scripts');
    logger.info('  npm rebuild better-sqlite3');
  }
}

interface CopyOptions {
  pluginDir: string;
  language: string;
  workspaceDir: string;
  mode: 'smart' | 'force';
}

async function copyCoreTemplates(opts: CopyOptions): Promise<number> {
  logger.step('Copying core templates');

  let count = 0;
  const coreSrc = path.join(opts.pluginDir, 'templates', 'langs', opts.language, 'core');

  if (!existsSync(coreSrc)) {
    const fallbackSrc = path.join(opts.pluginDir, 'templates', 'langs', 'en', 'core');
    if (!existsSync(fallbackSrc)) {
      logger.warn('Core templates directory not found');
      return 0;
    }
  }

  const actualSrc = existsSync(coreSrc) ? coreSrc : path.join(opts.pluginDir, 'templates', 'langs', 'en', 'core');
  const files = readdirSync(actualSrc).filter(f => f.endsWith('.md'));

  for (const file of files) {
    const srcPath = path.join(actualSrc, file);
    const destPath = path.join(opts.workspaceDir, file);

    if (existsSync(destPath) && opts.mode === 'smart') {
      const updatePath = `${destPath}.update`;
      await fse.copy(srcPath, updatePath, { overwrite: true });
      logger.info(`${file} -> ${file}.update (smart mode)`);
    } else {
      await fse.ensureDir(opts.workspaceDir);
      await fse.copy(srcPath, destPath, { overwrite: true });
      logger.info(`${file} (copied)`);
    }
    count++;
  }

  logger.success(`Copied ${count} core templates`);
  return count;
}

async function copyPrinciplesLayer(opts: CopyOptions): Promise<number> {
  logger.step('Copying principles layer');

  let count = 0;
  const principlesSrc = path.join(opts.pluginDir, 'templates', 'workspace', '.principles');
  const principlesDest = path.join(opts.workspaceDir, '.principles');

  if (!existsSync(principlesSrc)) {
    logger.warn('Principles layer templates directory not found');
    return 0;
  }

  const files = readdirSync(principlesSrc);

  const langThinkingOsSrc = path.join(opts.pluginDir, 'templates', 'langs', opts.language, 'principles', 'THINKING_OS.md');

  for (const file of files) {
    let srcPath = path.join(principlesSrc, file);
    if (file === 'THINKING_OS.md' && existsSync(langThinkingOsSrc)) {
      srcPath = langThinkingOsSrc;
    }
    const destPath = path.join(principlesDest, file);
    if (statSync(srcPath).isDirectory()) {
      continue;
    }

    if (existsSync(destPath) && opts.mode === 'smart') {
      const updatePath = `${destPath}.update`;
      await fse.copy(srcPath, updatePath, { overwrite: true });
      logger.info(`.principles/${file} -> .update (smart mode)`);
    } else {
      await fse.ensureDir(principlesDest);
      await fse.copy(srcPath, destPath, { overwrite: true });
      logger.info(`.principles/${file} (copied)`);
    }
    count++;
  }

  const modelsSrc = path.join(principlesSrc, 'models');
  const modelsDest = path.join(principlesDest, 'models');

  if (existsSync(modelsSrc)) {
    await fse.ensureDir(modelsDest);
    await fse.copy(modelsSrc, modelsDest, { overwrite: true });
    const modelCount = readdirSync(modelsDest).length;
    logger.info(`.principles/models/ (${modelCount} thinking models)`);
    count += modelCount;
  }

  logger.success('Principles layer files copied');
  return count;
}

async function generateFeatureFlagsConfig(workspaceDir: string): Promise<string> {
  logger.step('Generating feature-flags.yaml');

  const configPath = getFeatureFlagsPath(workspaceDir);
  const configDir = path.dirname(configPath);

  if (existsSync(configPath)) {
    logger.info('feature-flags.yaml already exists — preserving user config');
    return configPath;
  }

  await fse.ensureDir(configDir);
  const yamlContent = generateFeatureFlagsYamlContent();
  writeFileSync(configPath, yamlContent, 'utf8');

  logger.success(`Feature flags config created: ${configPath}`);
  return configPath;
}

async function createConfigFile(workspaceDir: string, channels: string[]): Promise<void> {
  const configDir = getOpenClawConfigDir();
  const configPath = path.join(configDir, 'principles-disciple.json');

  if (existsSync(configPath)) {
    const existingRaw = readFileSync(configPath, 'utf-8');
    const existing: unknown = JSON.parse(existingRaw);
    if (existing !== null && typeof existing === 'object' && !Array.isArray(existing)) {
      const existingObj = existing as Record<string, unknown>;
      if (Object.hasOwn(existingObj, 'channels') || Object.hasOwn(existingObj, 'features')) {
        logger.info('Existing config preserved — not overwriting channel/feature settings');
        return;
      }
    }
  }

  const config = {
    workspace: workspaceDir,
    state: path.join(workspaceDir, '.state'),
    channels,
    installedAt: new Date().toISOString(),
    mvpFirst: true,
  };

  await fse.ensureDir(configDir);
  await fse.writeJson(configPath, config, { spaces: 2 });

  logger.success(`Config file created: ${configPath}`);
}

async function generateUpdateSummary(
  workspaceDir: string,
  mode: 'smart' | 'force',
): Promise<number> {
  if (mode !== 'smart') return 0;

  const updateFiles: string[] = [];

  const findUpdateFiles = (dir: string): void => {
    if (!existsSync(dir)) return;
    const entries = readdirSync(dir);
    for (const entry of entries) {
      const fullPath = path.join(dir, entry);
      if (statSync(fullPath).isDirectory()) {
        if (entry.startsWith('.') || entry === 'node_modules') continue;
        findUpdateFiles(fullPath);
      } else if (entry.endsWith('.update')) {
        updateFiles.push(fullPath);
      }
    }
  };

  findUpdateFiles(workspaceDir);

  if (updateFiles.length === 0) return 0;

  const summaryPath = path.join(workspaceDir, '.principles', 'UPDATE_SUMMARY.md');
  const [timestamp] = new Date().toISOString().split('T');

  let content = `# Update Summary (${timestamp})\n\n## Pending merge files\n\n`;
  content += `| File | Status |\n|------|--------|\n`;

  for (const file of updateFiles) {
    const relativePath = path.relative(workspaceDir, file);
    content += `| \`${relativePath}\` | pending merge |\n`;
  }

  content += `\n## Merge steps\n\n1. Open each .update file\n2. Compare with original\n3. Merge valuable changes\n4. Delete .update file\n`;

  await fse.ensureDir(path.dirname(summaryPath));
  await fse.writeFile(summaryPath, content);

  logger.info(`Update summary generated: ${summaryPath}`);
  logger.warn(`${updateFiles.length} update file(s) need manual merge`);

  return updateFiles.length;
}

export interface InstallResult {
  success: boolean;
  pluginDir: string;
  workspaceDir: string;
  featureFlagsPath: string;
  templatesCount: number;
  updateFilesCount?: number;
  reason?: string;
  nextAction?: string;
  error?: string;
}

export async function install(options: InstallOptions, pluginDir: string, quiet = false): Promise<InstallResult> {
  const spinner = quiet ? null : ora('Installing...').start();

  try {
    if (spinner) spinner.text = 'Cleaning old version...';
    await cleanOldVersion();

    if (spinner) spinner.text = 'Checking built plugin...';
    await checkBuiltPlugin(pluginDir);

    if (spinner) spinner.text = 'Installing plugin...';
    await installPlugin(pluginDir);

    if (spinner) spinner.text = 'Installing plugin dependencies...';
    await installPluginDependencies();

    if (spinner) spinner.text = 'Copying core templates...';
    const templatesCount = await copyCoreTemplates({
      pluginDir,
      language: options.language,
      workspaceDir: options.workspaceDir,
      mode: options.mode,
    });

    if (spinner) spinner.text = 'Copying principles layer...';
    const principlesCount = await copyPrinciplesLayer({
      pluginDir,
      language: options.language,
      workspaceDir: options.workspaceDir,
      mode: options.mode,
    });

    if (spinner) spinner.text = 'Generating feature flags config...';
    const featureFlagsPath = await generateFeatureFlagsConfig(options.workspaceDir);

    if (spinner) spinner.text = 'Creating config file...';
    await createConfigFile(options.workspaceDir, options.channels);

    if (spinner) spinner.text = 'Generating update summary...';
    const updateFilesCount = await generateUpdateSummary(options.workspaceDir, options.mode);

    if (spinner) spinner.succeed('Install complete!');

    const mvpNextAction = buildNextAction();

    return {
      success: true,
      pluginDir: getPluginExtDir(),
      workspaceDir: options.workspaceDir,
      featureFlagsPath,
      templatesCount: templatesCount + principlesCount,
      updateFilesCount,
      nextAction: mvpNextAction,
    };
  } catch (error) {
    if (spinner) spinner.fail('Install failed');
    const errorMsg = error instanceof Error ? error.message : String(error);

    return {
      success: false,
      pluginDir: getPluginExtDir(),
      workspaceDir: options.workspaceDir,
      featureFlagsPath: getFeatureFlagsPath(options.workspaceDir),
      templatesCount: 0,
      reason: buildFailureReason(errorMsg),
      nextAction: buildFailureNextAction(),
      error: errorMsg,
    };
  }
}
