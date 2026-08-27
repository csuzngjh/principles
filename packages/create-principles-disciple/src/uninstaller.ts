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
 *
 * ADR-0020 §2.3: Multi-host uninstall. Host-side config cleanup (openclaw.json
 * entries, ~/.codex/hooks.json entries, wrapper scripts) is delegated to
 * HostInstaller.uninstall() implementations. Workspace user data is always
 * preserved regardless of host target.
 */
import { existsSync, readFileSync, writeFileSync } from 'fs';
import fse from 'fs-extra';
import * as path from 'path';
import * as os from 'os';
import { confirm } from '@inquirer/prompts';
import { logger } from './utils/logger.js';
import { getOpenClawConfigDir, getPluginExtDir, checkOpenClawGateway } from './utils/env.js';
import { getGlobalShimPaths, getInstalledBinDir, getPdRuntimeDir, getInstallManifestPath, isWindows } from './mvp-config.js';
import { parseInstallManifest } from '@principles/install-layout';
import { setLanguage, t, getLanguage } from './i18n.js';
import { getHostInstallers, type HostTarget } from './installers/index.js';
import type { HostUninstallContext, HostUninstallResult } from '@principles/core/host';

export interface UninstallResult {
  success: boolean;
  removedDirs: string[];
  removedFiles: string[];
  removedGlobalShims: string[];
  skippedGlobalShims: string[];
  preservedPaths: string[];  // Preserved paths (for user confirmation)
  error?: string;
}

interface SharedRuntimeUninstallPlan {
  removeSharedRuntime: boolean;
  remainingHosts: ('codex' | 'openclaw')[];
  manifestHasTarget: boolean;
  warning?: string;
}

export function planSharedRuntimeUninstall(host: HostTarget): SharedRuntimeUninstallPlan {
  if (host === 'all') {
    return { removeSharedRuntime: true, remainingHosts: [], manifestHasTarget: true };
  }
  try {
    const raw: unknown = JSON.parse(readFileSync(getInstallManifestPath(), 'utf8'));
    const parsed = parseInstallManifest(raw);
    if (!parsed.manifest) {
      return {
        removeSharedRuntime: false,
        remainingHosts: [],
        manifestHasTarget: false,
        warning: `${parsed.error ?? 'install_manifest_malformed'}; shared runtime preserved. Re-run uninstall --host all after repairing ~/.pd/install.json.`,
      };
    }
    const manifestHasTarget = parsed.manifest.hosts.includes(host);
    const remainingHosts = parsed.manifest.hosts.filter(candidate => candidate !== host);
    return { removeSharedRuntime: remainingHosts.length === 0, remainingHosts, manifestHasTarget };
  } catch (error) {
    return {
      removeSharedRuntime: false,
      remainingHosts: [],
      manifestHasTarget: false,
      warning: `install_manifest_unreadable: ${error instanceof Error ? error.message : String(error)}; shared runtime preserved. Re-run uninstall --host all after repairing ~/.pd/install.json.`,
    };
  }
}

async function detectAndSetLanguage(lang?: string): Promise<void> {
  setLanguage(lang === 'en' ? 'en' : 'zh');
}

/**
 * Check install status across all hosts (OpenClaw + Codex).
 *
 * ADR-0020 §2.3: Detects PD install markers for each registered host.
 * Returns aggregated status so `pd status` / `npx create-principles-disciple
 * status` shows the full picture regardless of which host was selected
 * during install.
 */
export function checkInstallStatus(host: HostTarget = 'all'): {
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

  // OpenClaw paths
  const openclawPaths = [
    { path: getPluginExtDir(), name: lang === 'zh' ? '插件扩展目录' : 'Plugin extension directory', type: 'dir' as const },
    { path: path.join(configDir, 'principles-disciple.json'), name: lang === 'zh' ? 'OpenClaw 配置文件' : 'OpenClaw config file', type: 'file' as const },
  ];

  // Codex paths (ADR-0020).
  // NOTE: ~/.codex/hooks.json is intentionally NOT in this deletion set.
  // It is a shared host config file — CodexHostInstaller.uninstall() removes
  // only PD-owned entries (matched by __pd_marker) from it. If it were listed
  // here, the generic delete loop below would delete the entire file,
  // destroying the user's non-PD Codex hooks. Also, including it would make
  // isInstalled=true for any user who merely has a hooks.json, even if PD
  // was never installed.
  const pdCodexDir = path.join(os.homedir(), '.pd', 'codex');
  const codexPaths = [
    { path: path.join(pdCodexDir, 'pd-hooks.marker'), name: lang === 'zh' ? 'Codex 安装标记' : 'Codex install marker', type: 'file' as const },
    { path: path.join(pdCodexDir, 'pd-hook-entry.cjs'), name: lang === 'zh' ? 'Codex 钩子入口' : 'Codex hook entry script', type: 'file' as const },
  ];

  const allPaths = host === 'openclaw'
    ? openclawPaths
    : host === 'codex'
      ? codexPaths
      : [...openclawPaths, ...codexPaths];

  const checkedPaths = allPaths.map(p => ({
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

  if (!existsSync(configPath)) return null;
  // Read and parse JSON directly — require() would execute the file if its
  // extension ever changed, and the path must stay inside the config dir.
  const resolved = path.resolve(configPath);
  if (resolved !== configPath && !resolved.startsWith(configDir + path.sep)) {
    return null;
  }
  try {
    const config: unknown = JSON.parse(readFileSync(configPath, 'utf-8'));
    if (config && typeof config === 'object' && !Array.isArray(config)) {
      const workspace: unknown = Reflect.get(config, 'workspace');
      return typeof workspace === 'string' && workspace.length > 0 ? workspace : null;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Execute uninstall
 *
 * @param options.force Skip confirmation prompt (dangerous, for scripts only)
 * @param options.host   ADR-0020: 'openclaw' | 'codex' | 'all' (default 'all')
 */
const REMOVE_RETRY_ATTEMPTS = 3;
const REMOVE_RETRY_DELAY_MS = 1000;

async function removeWithRetry(targetPath: string, _type: 'dir' | 'file'): Promise<void> {
  for (let attempt = 1; attempt <= REMOVE_RETRY_ATTEMPTS; attempt++) {
    try {
      await fse.remove(targetPath);
      return;
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      const isLockError = errMsg.includes('EPERM') || errMsg.includes('EBUSY') || errMsg.includes('permission');
      if (!isLockError || attempt === REMOVE_RETRY_ATTEMPTS) throw error;
      await new Promise(r => setTimeout(r, REMOVE_RETRY_DELAY_MS * attempt));
    }
  }
}

export async function uninstall(
  options: {
    force?: boolean;
    lang?: string;
    /**
     * ADR-0020 §2.3: Host target for uninstall.
     * - 'openclaw' — clean up OpenClaw config only.
     * - 'codex'    — clean up Codex hooks only.
     * - 'all' (default) — clean up both hosts.
     *
     * Default is 'all' for thorough cleanup (unlike install where default
     * is 'openclaw' for backward compatibility).
     */
    host?: HostTarget;
  } = {}
): Promise<UninstallResult> {
  await detectAndSetLanguage(options.lang);
  const hostTarget: HostTarget = options.host ?? 'all';

  const result: UninstallResult = {
    success: false,
    removedDirs: [],
    removedFiles: [],
    removedGlobalShims: [],
    skippedGlobalShims: [],
    preservedPaths: [],
  };

  try {
    const gatewayStatus = hostTarget === 'codex'
      ? { isRunning: false, port: undefined, pid: undefined }
      : await checkOpenClawGateway();
    if (gatewayStatus.isRunning) {
      const portInfo = gatewayStatus.port ? ` (port ${gatewayStatus.port})` : '';
      const pidInfo = gatewayStatus.pid ? `, PID ${gatewayStatus.pid}` : '';
      logger.warn(`OpenClaw gateway is running${portInfo}${pidInfo}.`);
      logger.warn(isWindows()
        ? '文件可能被占用导致删除失败。建议先关闭 OpenClaw（openclaw gateway stop），然后重新运行卸载。'
        : 'Files may be locked. Stop OpenClaw first (openclaw gateway stop), then re-run uninstall.');
      console.log('');
    }

    // 1. Check install status
    const status = checkInstallStatus(hostTarget);
    const runtimePlan = planSharedRuntimeUninstall(hostTarget);
    if (runtimePlan.warning) logger.warn(runtimePlan.warning);

    if (!status.isInstalled && !runtimePlan.manifestHasTarget) {
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
    const deleteErrors: { name: string; error: string }[] = [];
    for (const p of status.paths) {
      if (!p.exists) continue;

      try {
        await removeWithRetry(p.path, p.type);
        if (p.type === 'dir') {
          result.removedDirs.push(p.path);
        } else {
          result.removedFiles.push(p.path);
        }
        logger.success(`${t('deleted')}: ${p.name}`);
      } catch (error) {
        const errMsg = error instanceof Error ? error.message : String(error);
        const isPermError = errMsg.includes('EPERM') || errMsg.includes('permission') || errMsg.includes('access denied') || errMsg.includes('EBUSY');
        if (isPermError) {
          logger.error(`${t('delete_failed')}: ${p.name} - ${errMsg}`);
          logger.warn(isWindows()
            ? '文件被占用，请先关闭 OpenClaw（openclaw gateway stop），然后手动删除目录或重新运行卸载。'
            : 'File is locked. Stop OpenClaw first (openclaw gateway stop), then re-run uninstall or delete manually.');
        } else {
          logger.error(`${t('delete_failed')}: ${p.name} - ${errMsg}`);
        }
        deleteErrors.push({ name: p.name, error: errMsg });
      }
    }

    // 6. The pd shim belongs to the shared runtime. Keep it while another host
    // remains attached; otherwise a host-scoped uninstall breaks that host.
    if (runtimePlan.removeSharedRuntime) {
      console.log('\n');
      logger.info(t('cleaning_global_commands'));
      const { removed, skipped } = await removeGlobalPdShim();
      result.removedGlobalShims = removed;
      result.skippedGlobalShims = skipped;
    } else {
      logger.info('Keeping the shared pd command because another host still uses the runtime.');
    }

    // 6.5. ADR-0020 §2.3: Clean up host-side configs via HostInstallers.
    // Replaces the old cleanupOpenClawConfig() with multi-host delegation.
    const hostInstallers = getHostInstallers(hostTarget);
    for (const installer of hostInstallers) {
      try {
        const ctx: HostUninstallContext = {
          language: getLanguage(),
          force: options.force === true,
        };
        const hostResult: HostUninstallResult = await installer.uninstall(ctx);
        if (hostResult.success) {
          if (hostResult.removedPaths.length > 0) {
            logger.success(`Host "${installer.hostId}": cleaned ${hostResult.removedPaths.length} path(s)`);
          }
        } else {
          logger.warn(`Host "${installer.hostId}" cleanup: ${hostResult.reason ?? 'partial failure'}. Next: ${hostResult.nextAction}`);
        }
      } catch (err) {
        // rc-9: never silently swallow — surface the failure.
        logger.warn(`Host "${installer.hostId}" cleanup threw: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // Shared runtime is removed only after the final host is uninstalled.
    let sharedRuntimeRemovalFailed = false;
    if (runtimePlan.removeSharedRuntime && existsSync(getPdRuntimeDir())) {
      try {
        await removeWithRetry(getPdRuntimeDir(), 'dir');
        result.removedDirs.push(getPdRuntimeDir());
      } catch (err) {
        sharedRuntimeRemovalFailed = true;
        deleteErrors.push({ name: 'PD shared runtime', error: err instanceof Error ? err.message : String(err) });
      }
    }
    if (runtimePlan.removeSharedRuntime && !sharedRuntimeRemovalFailed && existsSync(getInstallManifestPath())) {
      try {
        await removeWithRetry(getInstallManifestPath(), 'file');
        result.removedFiles.push(getInstallManifestPath());
      } catch (err) {
        deleteErrors.push({ name: 'PD install manifest', error: err instanceof Error ? err.message : String(err) });
      }
    } else if (!runtimePlan.removeSharedRuntime && runtimePlan.remainingHosts.length > 0) {
      writeFileSync(getInstallManifestPath(), JSON.stringify({
        layoutVersion: 1,
        mode: 'canonical',
        hosts: runtimePlan.remainingHosts,
      }, null, 2) + '\n', 'utf8');
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

    result.success = deleteErrors.length === 0;
    if (deleteErrors.length > 0) {
      result.error = deleteErrors.map(e => `${e.name}: ${e.error}`).join('; ');
    }

    console.log('\n');
    if (deleteErrors.length > 0) {
      logger.warn(t('uninstall_partial') || '卸载部分完成 — 部分文件未能删除，请按上方提示处理。');
    } else {
      logger.success(t('uninstall_complete'));
    }
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
