/**
 * 卸载器模块
 * 
 * ⚠️ 安全原则：
 * 1. 只删除插件系统文件（~/.openclaw/extensions/principles-disciple）
 * 2. 只删除插件配置文件（~/.openclaw/principles-disciple.json）
 * 3. 绝对不删除用户工作区的任何文件：
 *    - MD 文件（AGENTS.md, SOUL.md 等）
 *    - 记忆文件（.principles/ 目录）
 *    - 状态文件（.state/ 目录）
 *    - 任何用户数据
 */
import { existsSync } from 'fs';
import fse from 'fs-extra';
import * as path from 'path';
import { confirm } from '@inquirer/prompts';
import { logger } from './utils/logger.js';
import { getOpenClawConfigDir, getPluginExtDir } from './utils/env.js';

export interface UninstallResult {
  success: boolean;
  removedDirs: string[];
  removedFiles: string[];
  preservedPaths: string[];  // 保留的路径（供用户确认）
  error?: string;
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
 * 获取用户工作区路径（用于显示保护提醒）
 */
function getWorkspacePath(): string | null {
  const configDir = getOpenClawConfigDir();
  const configPath = path.join(configDir, 'principles-disciple.json');
  
  if (existsSync(configPath)) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports -- Reason: CommonJS require for synchronous JSON loading - ESM import() would require async refactoring
      const config = require(configPath);
      return config.workspace || null;
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * 执行卸载
 * 
 * @param options.force 跳过确认提示（危险，仅用于脚本）
 */
export async function uninstall(
  options: {
    force?: boolean;
  } = {}
): Promise<UninstallResult> {
  const result: UninstallResult = {
    success: false,
    removedDirs: [],
    removedFiles: [],
    preservedPaths: [],
  };
  
  try {
    // 1. 检查安装状态
    const status = checkInstallStatus();
    
    if (!status.isInstalled) {
      logger.warn('未检测到已安装的 Principles Disciple');
      result.success = true;
      return result;
    }
    
    // 2. 获取工作区路径并显示保护提醒
    const workspaceDir = getWorkspacePath();
    
    console.log('');
    logger.warn('⚠️  重要提醒：');
    console.log('   卸载操作仅移除插件系统文件，不会删除您的个人数据。');
    console.log('');
    
    if (workspaceDir && existsSync(workspaceDir)) {
      logger.info('以下工作区文件将被保留：');
      console.log(`   📁 工作区目录: ${workspaceDir}`);
      console.log('   📄 MD 文件 (AGENTS.md, SOUL.md, PRINCIPLES.md 等)');
      console.log('   📁 .principles/ 目录（身份层配置）');
      console.log('   📁 .state/ 目录（进化状态和记忆）');
      console.log('');
    }
    
    // 3. 显示将要删除的内容
    logger.info('以下插件文件将被删除：');
    for (const p of status.paths) {
      if (p.exists) {
        const icon = p.type === 'dir' ? '📁' : '📄';
        console.log(`  ${icon} ${p.name}: ${p.path}`);
      }
    }
    console.log('');
    
    // 4. 确认卸载（除非 --force）
    if (!options.force) {
      const confirmed = await confirm({
        message: '确认卸载插件？（您的个人数据将保留）',
        default: false,
      });
      
      if (!confirmed) {
        logger.info('卸载已取消');
        result.success = true;
        return result;
      }
    }
    
    // 5. 执行删除（仅限插件系统文件）
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
    
    // 6. 记录保留的路径
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
    
    console.log('');
    logger.success('✅ 卸载完成！');
    console.log('');
    
    if (result.preservedPaths.length > 0) {
      logger.info('💡 您的个人数据已保留在以下位置：');
      result.preservedPaths.forEach(p => console.log(`   ${p}`));
      console.log('');
      logger.info('如需彻底清理，请手动删除上述目录。');
    }
    
    return result;
  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error);
    logger.error(`卸载失败: ${result.error}`);
    return result;
  }
}