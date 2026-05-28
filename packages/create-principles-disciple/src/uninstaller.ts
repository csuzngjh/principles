/**
 * Uninstaller module
 *
 * ⚠️ Safety principles:
 * 1. Only delete plugin system files (~/.openclaw/extensions/principles-disciple)
 * 2. Only delete plugin config files (~/.openclaw/principles-disciple.json)
 * 3. Never delete any files from user workspace:
 *    - MD files (AGENTS.md, SOUL.md, etc.)
 *    - Memory files (.principles/ directory)
 *    - State files (.state/ directory)
 *    - Any user data
 */
import { existsSync, readFileSync, writeFileSync } from 'fs';
import fse from 'fs-extra';
import * as path from 'path';
import { confirm } from '@inquirer/prompts';
import { logger } from './utils/logger.js';
import { getOpenClawConfigDir, getPluginExtDir } from './utils/env.js';
import { getGlobalShimPaths, getInstalledBinDir, isWindows } from './mvp-config.js';
import { setLanguage, t, getLanguage } from './i18n.js';

export interface UninstallResult {
  success: boolean;
  removedDirs: string[];
  removedFiles: string[];
  removedGlobalShims: string[];
  skippedGlobalShims: string[];
  preservedPaths: string[];  // Preserved paths (for user confirmation)
  error?: string;
}

async function detectAndSetLanguage(): Promise<void> {
  // Simple implementation - default to Chinese, can be improved later
  setLanguage('zh');
}

/**
 * Check install status
 */
export function checkInstallStatus(): {
  isInstalled: boolean;
  paths: {
    exists: boolean;
    path: string;
    name: string;
    type: 'dir' | 'file';
  }[];
} {
  const configDir = getOpenClawConfigDir();

  const lang = getLanguage();
  const paths = [
    { path: getPluginExtDir(), name: lang === 'zh' ? '插件扩展目录' : 'Plugin extension directory', type: 'dir' as const },
    { path: path.join(configDir, 'principles-disciple.json'), name: lang === 'zh' ? '配置文件' : 'Config file', type: 'file' as const },
  ];

  const checkedPaths = paths.map(p => ({
    exists: existsSync(p.path),
    path: p.path,
    name: p.name,
    type: p.type,
  }));

  const isInstalled = checkedPaths.some(p => p.exists);

  return { isInstalled, paths: checkedPaths };
}

/**
 * 检查 shim 文件是否由 Principles Disciple 创建
 * 通过读取文件内容，确认其目标指向 PD 安装目录
 */
export function isPdOwnedShim(shimPath: string): boolean {
  try {
    const content = readFileSync(shimPath, 'utf-8');
    const pdBinDir = getInstalledBinDir();
    const pdBinPath = isWindows()
      ? path.join(pdBinDir, 'pd.cmd')
      : path.join(pdBinDir, 'pd');

    if (isWindows()) {
      // Windows cmd/ps1 shim 应包含 PD 安装路径
      return content.includes(pdBinDir) || content.includes(pdBinPath);
    } else {
      // Unix shim 通常是符号链接或脚本，检查是否指向 PD 安装目录
      return content.includes(pdBinDir) || content.includes(pdBinPath);
    }
  } catch {
    return false;
  }
}

/**
 * Clean up global pd shim files
 * Only deletes shims that were created by Principles Disciple
 */
async function removeGlobalPdShim(): Promise<{ removed: string[]; skipped: string[] }> {
  const removed: string[] = [];
  const skipped: string[] = [];

  const shimPaths = getGlobalShimPaths();

  if (shimPaths.length === 0) {
    logger.info(t('cannot_detect_npm_global'));
    return { removed, skipped };
  }

  for (const shimPath of shimPaths) {
    if (!existsSync(shimPath)) {
      skipped.push(shimPath);
      continue;
    }

    if (!isPdOwnedShim(shimPath)) {
      logger.warn(`${t('global_command_skip_not_owned')}: ${shimPath}`);
      skipped.push(shimPath);
      continue;
    }

    try {
      await fse.remove(shimPath);
      removed.push(shimPath);
      logger.success(`${t('global_command_deleted')}: ${shimPath}`);
    } catch (error) {
      logger.warn(`${t('global_command_delete_failed')}: ${shimPath} - ${error instanceof Error ? error.message : String(error)}`);
      skipped.push(shimPath);
    }
  }

  return { removed, skipped };
}

/**
 * Get user workspace path (for showing preservation notice)
 */
function getWorkspacePath(): string | null {
  const configDir = getOpenClawConfigDir();
  const configPath = path.join(configDir, 'principles-disciple.json');

  if (existsSync(configPath)) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires, @typescript-eslint/no-require-imports -- Reason: CommonJS require for synchronous JSON loading - ESM import() would require async refactoring throughout the module
      const config = require(configPath);
      return config.workspace || null;
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Remove principles-disciple entries from openclaw.json
 * Cleans plugins.allow, plugins.entries, and plugins.installs
 */
function cleanupOpenClawConfig(): { cleaned: boolean; error?: string } {
  const configDir = getOpenClawConfigDir();
  const configPath = path.join(configDir, 'openclaw.json');

  if (!existsSync(configPath)) {
    return { cleaned: false };
  }

  try {
    const raw = readFileSync(configPath, 'utf-8');
    const config: unknown = JSON.parse(raw);

    if (config === null || typeof config !== 'object' || Array.isArray(config)) {
      return { cleaned: false, error: 'openclaw.json is not an object' };
    }

    const configObj = config as Record<string, unknown>;
    let modified = false;

    // Clean plugins.allow
    if (Array.isArray(configObj.plugins) || typeof configObj.plugins !== 'object' || configObj.plugins === null) {
      // plugins is not an object, skip
    } else {
      const plugins = configObj.plugins as Record<string, unknown>;

      // Remove from plugins.allow
      if (Array.isArray(plugins.allow)) {
        const before = plugins.allow.length;
        const filtered = (plugins.allow as unknown[]).filter(
          (a): a is string => typeof a === 'string' && a !== 'principles-disciple'
        );
        plugins.allow = filtered;
        if (filtered.length !== before) modified = true;
      }

      // Remove from plugins.entries
      if (typeof plugins.entries === 'object' && plugins.entries !== null && !Array.isArray(plugins.entries)) {
        const entries = plugins.entries as Record<string, unknown>;
        if ('principles-disciple' in entries) {
          delete entries['principles-disciple'];
          modified = true;
        }
      }

      // Remove from plugins.installs (legacy field, but clean it up anyway)
      if (typeof plugins.installs === 'object' && plugins.installs !== null && !Array.isArray(plugins.installs)) {
        const installs = plugins.installs as Record<string, unknown>;
        if ('principles-disciple' in installs) {
          delete installs['principles-disciple'];
          modified = true;
        }
      }
    }

    if (modified) {
      writeFileSync(configPath, JSON.stringify(configObj, null, 2) + '\n');
      return { cleaned: true };
    }

    return { cleaned: false };
  } catch (err) {
    return { cleaned: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Execute uninstall
 *
 * @param options.force Skip confirmation prompt (dangerous, for scripts only)
 */
export async function uninstall(
  options: {
    force?: boolean;
  } = {}
): Promise<UninstallResult> {
  await detectAndSetLanguage();

  const result: UninstallResult = {
    success: false,
    removedDirs: [],
    removedFiles: [],
    removedGlobalShims: [],
    skippedGlobalShims: [],
    preservedPaths: [],
  };

  try {
    // 1. Check install status
    const status = checkInstallStatus();

    if (!status.isInstalled) {
      logger.warn(t('no_install_detected'));
      result.success = true;
      return result;
    }

    // 2. Get workspace path and show preservation notice
    const workspaceDir = getWorkspacePath();

    console.log('\n');
    logger.warn(t('uninstall_warning_title'));
    console.log(`   ${t('uninstall_warning_msg')}`);
    console.log('\n');

    if (workspaceDir && existsSync(workspaceDir)) {
      logger.info(t('workspace_files_preserved'));
      console.log(`   📁 ${t('workspace_dir_label')}: ${workspaceDir}`);
      console.log(`   📄 ${t('md_files_preserved')}`);
      console.log(`   📁 ${t('principles_dir_preserved')}`);
      console.log(`   📁 ${t('state_dir_preserved')}`);
      console.log('\n');
    }

    // 3. Show what will be deleted
    logger.info(t('plugin_files_will_delete'));
    for (const p of status.paths) {
      if (p.exists) {
        const icon = p.type === 'dir' ? '📁' : '📄';
        console.log(`  ${icon} ${p.name}: ${p.path}`);
      }
    }
    console.log('\n');

    // 4. Confirm uninstall (unless --force)
    if (!options.force) {
      const confirmed = await confirm({
        message: t('confirm_uninstall'),
        default: false,
      });

      if (!confirmed) {
        logger.info(t('uninstall_cancelled'));
        result.success = true;
        return result;
      }
    }

    // 5. Execute deletion (only plugin system files)
    for (const p of status.paths) {
      if (!p.exists) continue;

      try {
        if (p.type === 'dir') {
          await fse.remove(p.path);
          result.removedDirs.push(p.path);
          logger.success(`${t('deleted')}: ${p.name}`);
        } else {
          await fse.remove(p.path);
          result.removedFiles.push(p.path);
          logger.success(`${t('deleted')}: ${p.name}`);
        }
      } catch (error) {
        logger.error(`${t('delete_failed')}: ${p.name} - ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    // 6. Clean up global pd shim
    console.log('\n');
    logger.info(t('cleaning_global_commands'));
    const { removed, skipped } = await removeGlobalPdShim();
    result.removedGlobalShims = removed;
    result.skippedGlobalShims = skipped;

    // 6.5. Clean up openclaw.json entries
    const configCleanup = cleanupOpenClawConfig();
    if (configCleanup.cleaned) {
      logger.success(t('openclaw_config_cleaned') || 'openclaw.json: removed principles-disciple entries');
    } else if (configCleanup.error) {
      logger.warn(`${t('openclaw_config_cleanup_failed') || 'openclaw.json cleanup failed'}: ${configCleanup.error}`);
    }

    // 7. Record preserved paths
    if (workspaceDir) {
      result.preservedPaths.push(workspaceDir);
      if (existsSync(path.join(workspaceDir, '.principles'))) {
        result.preservedPaths.push(path.join(workspaceDir, '.principles'));
      }
      if (existsSync(path.join(workspaceDir, '.state'))) {
        result.preservedPaths.push(path.join(workspaceDir, '.state'));
      }
    }

    result.success = true;

    console.log('\n');
    logger.success(t('uninstall_complete'));
    console.log('\n');

    if (result.preservedPaths.length > 0) {
      logger.info(t('personal_data_preserved'));
      result.preservedPaths.forEach(p => console.log(`   ${p}`));
      console.log('\n');
      logger.info(t('manual_cleanup_hint'));
    }

    return result;
  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error);
    logger.error(`${t('uninstall_failed')}: ${result.error}`);
    return result;
  }
}
