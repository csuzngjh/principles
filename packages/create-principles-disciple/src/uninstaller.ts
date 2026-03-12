/**
 * 卸载器模块
 */
import { existsSync } from 'fs';
import * as fse from 'fs-extra';
import * as path from 'path';
import * as os from 'os';
import { confirm } from '@inquirer/prompts';
import { logger } from './utils/logger.js';
import { getOpenClawConfigDir, getPluginExtDir } from './utils/env.js';

export interface UninstallResult {
  success: boolean;
  removedDirs: string[];
  removedFiles: string[];
  error?: string;
}

/**
 * 获取所有相关路径
 */
function getRelatedPaths(workspaceDir?: string): {
  dirs: { path: string; name: string }[];
  files: { path: string; name: string }[];
} {
  const configDir = getOpenClawConfigDir();
  const homeDir = os.homedir();
  
  const dirs: { path: string; name: string }[] = [
    { path: getPluginExtDir(), name: '插件扩展目录' },
  ];
  
  const files: { path: string; name: string }[] = [
    { path: path.join(configDir, 'principles-disciple.json'), name: '配置文件' },
  ];
  
  // 如果提供了工作区，添加工作区相关路径
  if (workspaceDir) {
    // 检查工作区是否存在
    if (existsSync(workspaceDir)) {
      dirs.push({ 
        path: path.join(workspaceDir, '.state'), 
        name: '状态目录' 
      });
    }
  }
  
  return { dirs, files };
}

/**
 * 检查安装状态
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
  
  const paths = [
    { path: getPluginExtDir(), name: '插件扩展目录', type: 'dir' as const },
    { path: path.join(configDir, 'principles-disciple.json'), name: '配置文件', type: 'file' as const },
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
 * 执行卸载
 */
export async function uninstall(
  options: {
    workspaceDir?: string;
    keepWorkspace?: boolean;
    force?: boolean;
  } = {}
): Promise<UninstallResult> {
  const result: UninstallResult = {
    success: false,
    removedDirs: [],
    removedFiles: [],
  };
  
  try {
    // 1. 检查安装状态
    const status = checkInstallStatus();
    
    if (!status.isInstalled) {
      logger.warn('未检测到已安装的 Principles Disciple');
      result.success = true;
      return result;
    }
    
    // 2. 显示将要删除的内容
    logger.info('以下内容将被删除：');
    for (const p of status.paths) {
      if (p.exists) {
        const icon = p.type === 'dir' ? '📁' : '📄';
        console.log(`  ${icon} ${p.name}: ${p.path}`);
      }
    }
    
    // 3. 确认卸载（除非 --force）
    if (!options.force) {
      const confirmed = await confirm({
        message: '确认卸载？',
        default: false,
      });
      
      if (!confirmed) {
        logger.info('卸载已取消');
        result.success = true;
        return result;
      }
    }
    
    // 4. 执行删除
    for (const p of status.paths) {
      if (!p.exists) continue;
      
      try {
        if (p.type === 'dir') {
          await fse.remove(p.path);
          result.removedDirs.push(p.path);
          logger.success(`已删除: ${p.name}`);
        } else {
          await fse.remove(p.path);
          result.removedFiles.push(p.path);
          logger.success(`已删除: ${p.name}`);
        }
      } catch (error) {
        logger.error(`删除失败: ${p.name} - ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    
    // 5. 工作区文件处理
    if (options.workspaceDir && !options.keepWorkspace) {
      const workspaceStateDir = path.join(options.workspaceDir, '.state');
      if (existsSync(workspaceStateDir)) {
        try {
          await fse.remove(workspaceStateDir);
          result.removedDirs.push(workspaceStateDir);
          logger.success('已删除: 工作区状态目录');
        } catch (error) {
          logger.warn(`状态目录删除失败: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }
    
    result.success = true;
    logger.success('卸载完成！');
    
    return result;
  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error);
    logger.error(`卸载失败: ${result.error}`);
    return result;
  }
}
