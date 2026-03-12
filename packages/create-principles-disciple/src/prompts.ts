/**
 * 交互式问答模块
 */
import { select, confirm, input, checkbox } from '@inquirer/prompts';
import * as path from 'path';
import * as os from 'os';
import { detectWorkspace, type WorkspaceInfo } from './utils/env.js';

export interface InstallOptions {
  language: 'zh' | 'en';
  mode: 'smart' | 'force';
  workspaceDir: string;
  features: string[];
  overwriteConfig: boolean;
}

/**
 * 语言选择
 */
async function promptLanguage(): Promise<'zh' | 'en'> {
  return await select({
    message: '选择语言 / Select language',
    choices: [
      { name: '🇨🇳 中文', value: 'zh' as const },
      { name: '🇺🇸 English', value: 'en' as const },
    ],
    default: 'zh',
  });
}

/**
 * 安装模式选择
 */
async function promptInstallMode(): Promise<'smart' | 'force'> {
  return await select({
    message: '选择安装模式',
    choices: [
      {
        name: '智能合并 - 已存在的文件会生成 .update 副本，保护用户修改',
        value: 'smart' as const,
        description: '推荐：保护你的自定义修改'
      },
      {
        name: '强制覆盖 - 直接覆盖所有文件，保持与模板同步',
        value: 'force' as const,
        description: '注意：会覆盖所有已有文件'
      },
    ],
    default: 'smart',
  });
}

/**
 * 工作区路径配置
 */
async function promptWorkspace(workspaceInfo: WorkspaceInfo): Promise<string> {
  const choices = [
    {
      name: `使用检测到的目录: ${workspaceInfo.detectedPath}`,
      value: 'detected' as const,
    },
    {
      name: '自定义目录',
      value: 'custom' as const,
    },
  ];

  const selection = await select({
    message: `工作区目录 ${workspaceInfo.hasPrinciples ? '(已检测到 Principles)' : ''}`,
    choices,
    default: 'detected',
  });

  if (selection === 'custom') {
    return await input({
      message: '输入工作区路径',
      default: path.join(os.homedir(), 'clawd'),
      validate: (value) => {
        if (!value.trim()) return '路径不能为空';
        return true;
      },
    });
  }

  return workspaceInfo.detectedPath;
}

/**
 * 功能选择
 */
async function promptFeatures(): Promise<string[]> {
  return await checkbox({
    message: '选择要安装的功能（空格选择）',
    choices: [
      { name: '进化系统', value: 'evolution', checked: true },
      { name: '信任引擎', value: 'trust', checked: true },
      { name: '深度反思', value: 'reflection' },
      { name: 'OKR 管理', value: 'okr' },
      { name: 'Pain 信号检测', value: 'pain', checked: true },
      { name: '认知卫生', value: 'hygiene' },
    ],
  });
}

/**
 * 确认覆盖配置
 */
async function promptOverwriteConfig(): Promise<boolean> {
  return await confirm({
    message: '检测到已有配置，是否覆盖？',
    default: false,
  });
}

/**
 * 最终确认
 */
async function promptConfirm(options: Partial<InstallOptions>): Promise<boolean> {
  console.log('\n📦 安装配置:');
  console.log(`   语言: ${options.language}`);
  console.log(`   模式: ${options.mode === 'force' ? '强制覆盖' : '智能合并'}`);
  console.log(`   工作区: ${options.workspaceDir}`);
  if (options.features && options.features.length > 0) {
    console.log(`   功能: ${options.features.join(', ')}`);
  }

  return await confirm({
    message: '确认安装？',
    default: true,
  });
}

/**
 * 运行所有交互式问答
 */
export async function runPrompts(
  cliOptions: Partial<InstallOptions> = {}
): Promise<InstallOptions | null> {
  // 检测工作区
  const workspaceInfo = detectWorkspace();

  // 1. 语言选择（如果 CLI 未指定）
  const language = cliOptions.language ?? await promptLanguage();

  // 2. 安装模式选择（如果 CLI 未指定）
  const mode = cliOptions.mode ?? await promptInstallMode();

  // 3. 工作区路径配置（始终询问）
  const workspaceDir = cliOptions.workspaceDir ?? await promptWorkspace(workspaceInfo);

  // 4. 功能选择
  const features = cliOptions.features ?? await promptFeatures();

  // 5. 组装选项
  const options: InstallOptions = {
    language,
    mode,
    workspaceDir,
    features,
    overwriteConfig: false,
  };

  // 6. 最终确认
  const confirmed = await promptConfirm(options);
  if (!confirmed) {
    return null;
  }

  return options;
}

export { confirm, input, select, checkbox };
