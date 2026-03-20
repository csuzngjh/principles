/**
 * 安装器模块
 */
import { existsSync, readdirSync, statSync, readFileSync, writeFileSync } from 'fs';
import fse from 'fs-extra';
import * as path from 'path';
import * as os from 'os';
import { execSync, ExecSyncOptions } from 'child_process';
import ora from 'ora';
import pc from 'picocolors';
import { logger } from './utils/logger.js';
import { getOpenClawConfigDir, getPluginExtDir } from './utils/env.js';
import type { InstallOptions } from './prompts.js';

// 跨平台 execSync 选项：Windows 需要 shell，Unix 可以直接执行
const getExecOptions = (cwd: string): ExecSyncOptions => {
  const options: ExecSyncOptions = {
    cwd,
    stdio: 'inherit' as const,
    env: process.env,
  };
  // Windows 需要 shell 来正确执行 npm 命令
  if (process.platform === 'win32') {
    options.shell = process.env.ComSpec || 'cmd.exe';
  }
  return options;
};

const ALWAYS_ON_SKILLS = new Set([
  'admin',
  'bootstrap-tools',
  'deductive-audit',
  'feedback',
  'init-strategy',
  'inject-rule',
  'pd-mentor',
  'plan-script',
  'profile',
  'triage',
]);

const FEATURE_SKILL_MAP: Record<string, string[]> = {
  evolution: ['evolve-task', 'evolution-framework-update', 'evolve-system', 'watch-evolution', 'pd-daily', 'report'],
  trust: [], // Built-in feature (trust-engine.ts, gate.ts), no skills needed
  pain: ['pain', 'root-cause'],
  reflection: ['reflection', 'reflection-log'],
  okr: ['manage-okr'],
  hygiene: ['pd-grooming'],
};

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
  if (existsSync(extDir)) {
    await fse.remove(extDir);
    logger.info(`已删除旧版本: ${extDir}`);
  }
}

/**
 * 构建插件
 */
async function buildPlugin(pluginDir: string): Promise<void> {
  logger.step('构建插件');
  
  const execOpts = getExecOptions(pluginDir);
  
  // 安装依赖
  execSync('npm install --silent', execOpts);
  
  // 构建
  execSync('npm run build', execOpts);
  
  logger.success('插件构建完成');
}

/**
 * 安装插件到 OpenClaw
 */
async function installPlugin(pluginDir: string): Promise<void> {
  logger.step('安装插件到 OpenClaw');
  
  const extDir = getPluginExtDir();
  const configDir = getOpenClawConfigDir();
  const configPath = path.join(configDir, 'openclaw.json');
  
  // 方案一：尝试使用 openclaw plugins install（静默模式）
  try {
    const execOpts: ExecSyncOptions = {
      encoding: 'utf-8',
      timeout: 60000,
      env: process.env,
    };
    if (process.platform === 'win32') {
      execOpts.shell = process.env.ComSpec || 'cmd.exe';
    }
    execSync(`openclaw plugins install "${pluginDir}" 2>&1`, execOpts);
    // 检查是否安装成功
    if (existsSync(extDir) && existsSync(path.join(extDir, 'dist', 'index.js'))) {
      logger.success('插件安装成功 (openclaw)');
      return;
    }
  } catch {
    // 继续使用备用方案
  }
  
  // 方案二：手动复制 + 更新配置
  logger.info('使用手动安装方式...');
  
  // 1. 复制插件文件
  await fse.ensureDir(extDir);
  await fse.copy(pluginDir, extDir, { overwrite: true });
  
  // 2. 读取并更新 openclaw.json
  if (existsSync(configPath)) {
    const config = JSON.parse(readFileSync(configPath, 'utf-8'));
    
    // 添加到 allow 列表
    if (!config.plugins) config.plugins = {};
    if (!config.plugins.allow) config.plugins.allow = [];
    if (!config.plugins.allow.includes('principles-disciple')) {
      config.plugins.allow.push('principles-disciple');
    }
    
    // 添加到 entries
    if (!config.plugins.entries) config.plugins.entries = {};
    config.plugins.entries['principles-disciple'] = { enabled: true };
    
    // 添加到 installs（使用 OpenClaw 正确格式）
    if (!config.plugins.installs) config.plugins.installs = {};
    config.plugins.installs['principles-disciple'] = {
      source: 'path',
      installPath: extDir,
      installedAt: new Date().toISOString(),
    };
    
    writeFileSync(configPath, JSON.stringify(config, null, 2));
  }
  
  logger.success('插件安装成功 (手动)');
}

/**
 * 安装插件依赖
 */
async function installPluginDependencies(): Promise<void> {
  const extDir = getPluginExtDir();
  const micromatchPath = path.join(extDir, 'node_modules', 'micromatch');
  
  // 检查关键依赖是否存在
  if (!existsSync(micromatchPath)) {
    logger.step('安装插件运行时依赖');
    try {
      const execOpts = getExecOptions(extDir);
      execSync('npm install --silent micromatch@^4.0.8 @sinclair/typebox@^0.34.48', execOpts);
      logger.success('插件依赖安装完成');
    } catch (error) {
      logger.warn('依赖安装失败，插件可能无法正常工作');
      logger.info('手动修复: cd ~/.openclaw/extensions/principles-disciple && npm install micromatch @sinclair/typebox');
    }
  }
}

/**
 * 复制 Skills
 */
async function copySkills(pluginDir: string, language: string, features: string[]): Promise<number> {
  logger.step('复制 Skills');
  
  const skillsSrc = path.join(getTemplatesDir(pluginDir, language), 'skills');
  const skillsDest = path.join(getPluginExtDir(), 'skills');
  
  if (!existsSync(skillsSrc)) {
    // 回退到中文
    const fallbackSrc = path.join(getTemplatesDir(pluginDir, 'zh'), 'skills');
    if (existsSync(fallbackSrc)) {
      await fse.ensureDir(skillsDest);
      await fse.copy(fallbackSrc, skillsDest, { overwrite: true });
    }
  } else {
    await fse.ensureDir(skillsDest);
    await fse.copy(skillsSrc, skillsDest, { overwrite: true });
  }
  
  const selectedFeatureSet = new Set(features);
  const enabledSkills = new Set<string>(ALWAYS_ON_SKILLS);

  for (const feature of selectedFeatureSet) {
    const mappedSkills = FEATURE_SKILL_MAP[feature] || [];
    for (const skill of mappedSkills) {
      enabledSkills.add(skill);
    }
  }

  if (existsSync(skillsDest)) {
    const installedSkills = readdirSync(skillsDest).filter((entry) => statSync(path.join(skillsDest, entry)).isDirectory());

    for (const skillDir of installedSkills) {
      if (!enabledSkills.has(skillDir)) {
        await fse.remove(path.join(skillsDest, skillDir));
      }
    }
  }

  const count = existsSync(skillsDest)
    ? readdirSync(skillsDest).filter((entry) => statSync(path.join(skillsDest, entry)).isDirectory()).length
    : 0;
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
  logger.step('复制核心模板');
  
  let count = 0;
  const coreSrc = path.join(getTemplatesDir(pluginDir, language), 'core');
  
  if (!existsSync(coreSrc)) {
    logger.warn('核心模板目录不存在');
    return 0;
  }
  
  const files = readdirSync(coreSrc).filter(f => f.endsWith('.md'));
  
  for (const file of files) {
    const srcPath = path.join(coreSrc, file);
    const destPath = path.join(workspaceDir, file);
    
    if (existsSync(destPath) && mode === 'smart') {
      // 智能模式：生成 .update 文件
      const updatePath = `${destPath}.update`;
      await fse.copy(srcPath, updatePath, { overwrite: true });
      logger.info(`${file} -> ${file}.update (智能模式)`);
    } else {
      await fse.ensureDir(workspaceDir);
      await fse.copy(srcPath, destPath, { overwrite: true });
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
  logger.step('复制身份层文件');
  
  let count = 0;
  const principlesSrc = path.join(pluginDir, 'templates', 'workspace', '.principles');
  const principlesDest = path.join(workspaceDir, '.principles');
  
  if (!existsSync(principlesSrc)) {
    logger.warn('身份层模板目录不存在');
    return 0;
  }
  
  // 复制所有文件
  const files = readdirSync(principlesSrc);
  
  for (const file of files) {
    const srcPath = path.join(principlesSrc, file);
    const destPath = path.join(principlesDest, file);
    
    // 跳过目录（models 目录单独处理）
    if (statSync(srcPath).isDirectory()) {
      continue;
    }
    
    if (existsSync(destPath) && mode === 'smart') {
      const updatePath = `${destPath}.update`;
      await fse.copy(srcPath, updatePath, { overwrite: true });
      logger.info(`.principles/${file} -> .update (智能模式)`);
    } else {
      await fse.ensureDir(principlesDest);
      await fse.copy(srcPath, destPath, { overwrite: true });
      logger.info(`.principles/${file} (已复制)`);
    }
    count++;
  }
  
  // 复制 models 目录
  const modelsSrc = path.join(principlesSrc, 'models');
  const modelsDest = path.join(principlesDest, 'models');
  
  if (existsSync(modelsSrc)) {
    await fse.ensureDir(modelsDest);
    await fse.copy(modelsSrc, modelsDest, { overwrite: true });
    const modelCount = readdirSync(modelsDest).length;
    logger.info(`.principles/models/ (${modelCount} 个思维模型)`);
    count += modelCount;
  }
  
  logger.success(`身份层文件已复制`);
  return count;
}

/**
 * 创建配置文件
 */
async function createConfigFile(workspaceDir: string, features: string[]): Promise<void> {
  const configDir = getOpenClawConfigDir();
  const configPath = path.join(configDir, 'principles-disciple.json');
  
  const config = {
    workspace: workspaceDir,
    state: path.join(workspaceDir, '.state'),
    features,
    debug: false,
    installedAt: new Date().toISOString(),
  };
  
  await fse.ensureDir(configDir);
  await fse.writeJson(configPath, config, { spaces: 2 });
  
  logger.success(`配置文件已创建: ${configPath}`);
}

/**
 * 生成更新摘要
 */
async function generateUpdateSummary(
  workspaceDir: string,
  mode: 'smart' | 'force'
): Promise<number> {
  // 只在智能模式（更新）时生成
  if (mode !== 'smart') return 0;
  
  const updateFiles: string[] = [];
  
  // 查找所有 .update 文件
  const findUpdateFiles = (dir: string): void => {
    if (!existsSync(dir)) return;
    const entries = readdirSync(dir);
    for (const entry of entries) {
      const fullPath = path.join(dir, entry);
      if (statSync(fullPath).isDirectory()) {
        // 跳过隐藏目录和 node_modules
        if (entry.startsWith('.') || entry === 'node_modules') continue;
        findUpdateFiles(fullPath);
      } else if (entry.endsWith('.update')) {
        updateFiles.push(fullPath);
      }
    }
  };
  
  findUpdateFiles(workspaceDir);
  
  if (updateFiles.length === 0) return 0;
  
  // 生成更新摘要
  const summaryPath = path.join(workspaceDir, '.principles', 'UPDATE_SUMMARY.md');
  const timestamp = new Date().toISOString().split('T')[0];
  
  let content = `# 更新摘要 (${timestamp})

## ⚠️ 待合并的更新文件

以下文件有新版本可用，**必须手动合并**：

| 文件 | 状态 |
|------|------|
`;
  
  for (const file of updateFiles) {
    const relativePath = path.relative(workspaceDir, file);
    content += `| \`${relativePath}\` | 待合并 |\n`;
  }
  
  content += `
## 合并步骤

1. 逐个打开 .update 文件
2. 对比原文件，识别新增/修改内容
3. 将有价值的更新合并到原文件
4. 删除 .update 文件

## 查看完整变更日志

\`\`\`bash
cat ~/clawd/docs/CHANGELOG.md | head -100
\`\`\`

---
*此文件在每次更新时自动生成，合并完成后可删除*
`;
  
  await fse.ensureDir(path.dirname(summaryPath));
  await fse.writeFile(summaryPath, content);
  
  logger.info(`更新摘要已生成: ${summaryPath}`);
  logger.warn(`发现 ${updateFiles.length} 个待合并的更新文件`);
  
  return updateFiles.length;
}

export interface InstallResult {
  success: boolean;
  pluginDir: string;
  workspaceDir: string;
  skillsCount: number;
  templatesCount: number;
  updateFilesCount?: number;
  error?: string;
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
    const skillsCount = await copySkills(pluginDir, options.language, options.features);
    
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
    await createConfigFile(options.workspaceDir, options.features);
    
    // 9. 生成更新摘要（如果是更新模式）
    spinner.text = '生成更新摘要...';
    const updateFilesCount = await generateUpdateSummary(options.workspaceDir, options.mode);
    
    spinner.succeed('安装完成！');
    
    return {
      success: true,
      pluginDir: getPluginExtDir(),
      workspaceDir: options.workspaceDir,
      skillsCount,
      templatesCount: templatesCount + principlesCount,
      updateFilesCount,
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