/**
 * 安装器模块
 */
import * as fs from 'fs-extra';
import * as path from 'path';
import * as os from 'os';
import { execSync } from 'child_process';
import ora from 'ora';
import pc from 'picocolors';
import { logger } from './utils/logger.js';
import { getOpenClawConfigDir, getPluginExtDir } from './utils/env.js';
import type { InstallOptions } from './prompts.js';

export interface InstallResult {
  success: boolean;
  pluginDir: string;
  workspaceDir: string;
  skillsCount: number;
  templatesCount: number;
  error?: string;
}

/**
 * 获取模板目录
 */
function getTemplatesDir(pluginDir: string, language: string): string {
  return path.join(pluginDir, 'templates', 'langs', language);
}

/**
 * 清理旧版本
 */
async function cleanOldVersion(): Promise<void> {
  const extDir = getPluginExtDir();
  if (fs.existsSync(extDir)) {
    await fs.remove(extDir);
    logger.info(`已删除旧版本: ${extDir}`);
  }
}

/**
 * 构建插件
 */
async function buildPlugin(pluginDir: string): Promise<void> {
  logger.step('构建插件');
  
  // 安装依赖
  execSync('npm install --silent', { cwd: pluginDir, stdio: 'inherit' });
  
  // 构建
  execSync('npm run build', { cwd: pluginDir, stdio: 'inherit' });
  
  logger.success('插件构建完成');
}

/**
 * 安装插件到 OpenClaw
 */
async function installPlugin(pluginDir: string): Promise<void> {
  logger.step('安装插件到 OpenClaw');
  
  const extDir = getPluginExtDir();
  
  // 使用 openclaw plugins install
  try {
    execSync(`openclaw plugins uninstall principles-disciple 2>/dev/null || true`, { stdio: 'inherit' });
    execSync(`openclaw plugins install "${pluginDir}"`, { stdio: 'inherit' });
    logger.success('插件安装成功');
  } catch (error) {
    // 备用方案：直接复制
    logger.warn('openclaw 命令不可用，使用备用安装方式...');
    await fs.ensureDir(extDir);
    await fs.copy(pluginDir, extDir, { overwrite: true });
    logger.success('插件复制完成');
  }
}

/**
 * 安装插件依赖
 */
async function installPluginDependencies(): Promise<void> {
  const extDir = getPluginExtDir();
  const nodeModulesPath = path.join(extDir, 'node_modules');
  
  if (!fs.existsSync(nodeModulesPath)) {
    logger.step('安装插件运行时依赖');
    execSync('npm install --silent micromatch@^4.0.8 @sinclair/typebox@^0.34.48', {
      cwd: extDir,
      stdio: 'inherit',
    });
    logger.success('插件依赖安装完成');
  }
}

/**
 * 复制 Skills
 */
async function copySkills(pluginDir: string, language: string): Promise<number> {
  logger.step('复制 Skills');
  
  const skillsSrc = path.join(getTemplatesDir(pluginDir, language), 'skills');
  const skillsDest = path.join(getPluginExtDir(), 'skills');
  
  if (!fs.existsSync(skillsSrc)) {
    // 回退到中文
    const fallbackSrc = path.join(getTemplatesDir(pluginDir, 'zh'), 'skills');
    if (fs.existsSync(fallbackSrc)) {
      await fs.ensureDir(skillsDest);
      await fs.copy(fallbackSrc, skillsDest, { overwrite: true });
    }
  } else {
    await fs.ensureDir(skillsDest);
    await fs.copy(skillsSrc, skillsDest, { overwrite: true });
  }
  
  const count = fs.existsSync(skillsDest) ? fs.readdirSync(skillsDest).length : 0;
  logger.success(`已复制 ${count} 个 Skills`);
  return count;
}

/**
 * 复制核心模板到工作区
 */
async function copyCoreTemplates(
  pluginDir: string,
  language: string,
  workspaceDir: string,
  mode: 'smart' | 'force'
): Promise<number> {
  logger.step('复制核心模板...');
  
  let count = 0;
  const coreSrc = path.join(getTemplatesDir(pluginDir, language), 'core');
  
  if (!fs.existsSync(coreSrc)) {
    logger.warn('核心模板目录不存在');
    return 0;
  }
  
  const files = fs.readdirSync(coreSrc).filter(f => f.endsWith('.md'));
  
  for (const file of files) {
    const srcPath = path.join(coreSrc, file);
    const destPath = path.join(workspaceDir, file);
    
    if (fs.existsSync(destPath) && mode === 'smart') {
      // 智能模式：生成 .update 文件
      const updatePath = `${destPath}.update`;
      await fs.copy(srcPath, updatePath, { overwrite: true });
      logger.info(`${file} -> ${file}.update (智能模式)`);
    } else {
      await fs.ensureDir(workspaceDir);
      await fs.copy(srcPath, destPath, { overwrite: true });
      logger.info(`${file} (已复制)`);
    }
    count++;
  }
  
  logger.success(`已复制 ${count} 个核心模板`);
  return count;
}

/**
 * 复制身份层文件到工作区
 */
async function copyPrinciplesLayer(
  pluginDir: string,
  workspaceDir: string,
  mode: 'smart' | 'force'
): Promise<number> {
  logger.step('复制身份层文件...');
  
  let count = 0;
  const principlesSrc = path.join(pluginDir, 'templates', 'workspace', '.principles');
  const principlesDest = path.join(workspaceDir, '.principles');
  
  if (!fs.existsSync(principlesSrc)) {
    logger.warn('身份层模板目录不存在');
    return 0;
  }
  
  // 复制所有文件
  const files = fs.readdirSync(principlesSrc);
  
  for (const file of files) {
    const srcPath = path.join(principlesSrc, file);
    const destPath = path.join(principlesDest, file);
    
    // 跳过目录（models 目录单独处理）
    if (fs.statSync(srcPath).isDirectory()) {
      continue;
    }
    
    if (fs.existsSync(destPath) && mode === 'smart') {
      const updatePath = `${destPath}.update`;
      await fs.copy(srcPath, updatePath, { overwrite: true });
      logger.info(`.principles/${file} -> .update (智能模式)`);
    } else {
      await fs.ensureDir(principlesDest);
      await fs.copy(srcPath, destPath, { overwrite: true });
      logger.info(`.principles/${file} (已复制)`);
    }
    count++;
  }
  
  // 复制 models 目录
  const modelsSrc = path.join(principlesSrc, 'models');
  const modelsDest = path.join(principlesDest, 'models');
  
  if (fs.existsSync(modelsSrc)) {
    await fs.ensureDir(modelsDest);
    await fs.copy(modelsSrc, modelsDest, { overwrite: true });
    const modelCount = fs.readdirSync(modelsDest).length;
    logger.info(`.principles/models/ (${modelCount} 个思维模型)`);
    count += modelCount;
  }
  
  logger.success(`身份层文件已复制`);
  return count;
}

/**
 * 创建配置文件
 */
async function createConfigFile(workspaceDir: string): Promise<void> {
  const configDir = getOpenClawConfigDir();
  const configPath = path.join(configDir, 'principles-disciple.json');
  
  const config = {
    workspace: workspaceDir,
    state: path.join(workspaceDir, '.state'),
    debug: false,
    installedAt: new Date().toISOString(),
  };
  
  await fs.ensureDir(configDir);
  await fs.writeJson(configPath, config, { spaces: 2 });
  
  logger.success(`配置文件已创建: ${configPath}`);
}

/**
 * 主安装流程
 */
export async function install(options: InstallOptions, pluginDir: string): Promise<InstallResult> {
  const spinner = ora('正在安装...').start();
  
  try {
    // 1. 清理旧版本
    spinner.text = '清理旧版本...';
    await cleanOldVersion();
    
    // 2. 构建插件
    spinner.text = '构建插件...';
    await buildPlugin(pluginDir);
    
    // 3. 安装插件
    spinner.text = '安装插件...';
    await installPlugin(pluginDir);
    
    // 4. 安装插件依赖
    spinner.text = '安装插件依赖...';
    await installPluginDependencies();
    
    // 5. 复制 Skills
    spinner.text = '复制 Skills...';
    const skillsCount = await copySkills(pluginDir, options.language);
    
    // 6. 复制核心模板
    spinner.text = '复制核心模板...';
    const templatesCount = await copyCoreTemplates(
      pluginDir,
      options.language,
      options.workspaceDir,
      options.mode
    );
    
    // 7. 复制身份层
    spinner.text = '复制身份层...';
    const principlesCount = await copyPrinciplesLayer(
      pluginDir,
      options.workspaceDir,
      options.mode
    );
    
    // 8. 创建配置文件
    spinner.text = '创建配置文件...';
    await createConfigFile(options.workspaceDir);
    
    spinner.succeed('安装完成！');
    
    return {
      success: true,
      pluginDir: getPluginExtDir(),
      workspaceDir: options.workspaceDir,
      skillsCount,
      templatesCount: templatesCount + principlesCount,
    };
  } catch (error) {
    spinner.fail('安装失败');
    return {
      success: false,
      pluginDir: getPluginExtDir(),
      workspaceDir: options.workspaceDir,
      skillsCount: 0,
      templatesCount: 0,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
