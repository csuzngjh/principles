#!/usr/bin/env node
/**
 * Principles Disciple - OpenClaw Plugin Installer
 * 
 * 交互式安装/卸载器，支持：
 * - npx create-principles-disciple [install]
 * - npx create-principles-disciple uninstall
 * - npx create-principles-disciple --lang zh --force
 */
import { Command } from 'commander';
import * as path from 'path';
import * as url from 'url';
import { banner, logger } from './utils/logger.js';
import { runPrompts, type InstallOptions } from './prompts.js';
import { install } from './installer.js';
import { uninstall, checkInstallStatus } from './uninstaller.js';
import { checkEnvironment, detectWorkspace } from './utils/env.js';

const SUPPORTED_FEATURES = ['evolution', 'trust', 'pain', 'reflection', 'okr', 'hygiene'] as const;
const DEFAULT_FEATURES = ['evolution', 'trust', 'pain'] as const;

// ESM 模块中获取 __dirname
const __filename = url.fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 插件目录（打包后 templates 在 dist 上级）
const PLUGIN_DIR = path.resolve(__dirname, '..');

/**
 * 运行安装
 */
async function runInstall(options: Record<string, unknown>): Promise<void> {
  console.log(banner);
  console.log();

  // 1. 环境检测
  const env = checkEnvironment();

  if (!env.hasNode) {
    logger.error('Node.js 未安装，请先安装 Node.js >= 18');
    process.exit(1);
  }
  logger.success(`Node.js ${env.nodeVersion}`);

  if (!env.hasOpenClaw) {
    logger.warn('OpenClaw 未安装，部分功能可能不可用');
    logger.info('安装指南: https://github.com/openclaw/openclaw');
  } else {
    logger.success(`OpenClaw ${env.openclawVersion}`);
  }

  // 2. 检测工作区状态
  const workspaceInfo = detectWorkspace();

  // 3. 解析 CLI 选项
  const cliOptions: Partial<InstallOptions> = {
    language: options.lang as 'zh' | 'en',
    workspaceDir: options.workspace,
  };

  // 确定安装模式
  // 优先级：--force > --smart > 自动检测
  if (options.force) {
    cliOptions.mode = 'force';
  } else if (options.smart) {
    cliOptions.mode = 'smart';
  } else {
    // 自动检测：首次安装用 force，更新用 smart
    cliOptions.mode = workspaceInfo.isFirstInstall ? 'force' : 'smart';
  }

  // 4. 显示安装类型提示
  if (!options.nonInteractive && !options.yes) {
    if (workspaceInfo.isFirstInstall) {
      logger.info('🎉 检测到首次安装，将直接复制所有文件');
    } else {
      logger.info('🔄 检测到已有安装，将生成 .update 文件保护您的修改');
      if (workspaceInfo.coreFiles.length > 0) {
        logger.info(`   已存在的核心文件: ${workspaceInfo.coreFiles.join(', ')}`);
      }
    }
    console.log();
  }

  // 5. 运行交互式问答
  let installOptions: InstallOptions | null = null;

  // 检查是否是非交互模式
  const nonInteractive = options.nonInteractive || options.yes;

  if (nonInteractive) {
    // 非交互模式：使用 CLI 参数或默认值
    const parsedFeatures = options.features
      ? options.features.split(',').map((f: string) => f.trim().toLowerCase()).filter(Boolean)
      : [...DEFAULT_FEATURES];

    const uniqueFeatures: string[] = Array.from(new Set(parsedFeatures));
    const invalidFeatures = uniqueFeatures.filter((f) => !SUPPORTED_FEATURES.includes(f as (typeof SUPPORTED_FEATURES)[number]));
    const validFeatures = uniqueFeatures.filter((f) => SUPPORTED_FEATURES.includes(f as (typeof SUPPORTED_FEATURES)[number]));

    if (invalidFeatures.length > 0) {
      logger.warn(`检测到无效 features，已忽略: ${invalidFeatures.join(', ')}`);
      logger.info(`支持的 features: ${SUPPORTED_FEATURES.join(', ')}`);
    }

    const features = validFeatures.length > 0 ? validFeatures : [...DEFAULT_FEATURES];

    installOptions = {
      language: cliOptions.language || 'zh',
      mode: cliOptions.mode || (workspaceInfo.isFirstInstall ? 'force' : 'smart'),
      workspaceDir: cliOptions.workspaceDir || workspaceInfo.detectedPath,
      features,
      overwriteConfig: false,
    };

    // 显示自动检测的安装模式
    if (!options.force && !options.smart) {
      logger.info(`自动检测安装模式: ${installOptions.mode === 'force' ? '首次安装' : '更新（智能合并）'}`);
    }
    logger.info(`非交互模式：使用配置 features = ${features.join(', ')}`);
  } else {
    // 交互模式
    installOptions = await runPrompts(cliOptions, workspaceInfo);
  }

  // 用户取消
  if (!installOptions) {
    logger.info('安装已取消');
    process.exit(0);
  }

  // 6. 执行安装
  const result = await install(installOptions, PLUGIN_DIR);

  // 7. 显示结果
  if (result.success) {
    console.log();
    logger.success('安装完成！');
    console.log();
    console.log('📁 安装信息:');
    console.log(`   语言: ${installOptions.language}`);
    console.log(`   模式: ${installOptions.mode === 'force' ? '强制覆盖' : '智能合并'}`);
    console.log(`   Skills: ${result.skillsCount} 个`);
    console.log(`   模板: ${result.templatesCount} 个`);
    console.log(`   工作区: ${result.workspaceDir}`);

    // 如果是更新模式且有 .update 文件，给出提示
    if (installOptions.mode === 'smart') {
      if (result.updateFilesCount && result.updateFilesCount > 0) {
        console.log();
        console.log('⚠️  更新提示:');
        console.log(`   发现 ${result.updateFilesCount} 个待合并的更新文件`);
        console.log('   请查看: ~/.principles/UPDATE_SUMMARY.md');
        console.log();
        console.log('   合并步骤:');
        console.log('   1. 打开 *.update 文件');
        console.log('   2. 对比原文件，识别新增/修改内容');
        console.log('   3. 将有价值的更新合并到原文件');
        console.log('   4. 删除 .update 文件');
        console.log();
        console.log('   查看完整变更日志:');
        console.log('   cat ~/clawd/docs/CHANGELOG.md | head -100');
      } else {
        console.log();
        console.log('✅ 本次更新无需合并文件');
      }
    }

    console.log();
    console.log('🚀 下一步操作:');
    console.log('   1. 重启 OpenClaw Gateway:');
    console.log('      openclaw gateway --force');
    console.log();
    console.log('   2. 在项目中初始化核心文件:');
    console.log('      openclaw skill init-strategy');
  } else {
    logger.error(`安装失败: ${result.error}`);
    process.exit(1);
  }
}

/**
 * 运行卸载
 */
async function runUninstall(options: Record<string, unknown>): Promise<void> {
  console.log(banner);
  console.log();

  logger.info('准备卸载 Principles Disciple...\n');

  const result = await uninstall({
    force: options.force,
  });

  if (!result.success) {
    logger.error(`卸载失败: ${result.error}`);
    process.exit(1);
  }
}

/**
 * 显示状态
 */
async function showStatus(): Promise<void> {
  console.log(banner);
  console.log();

  const status = checkInstallStatus();

  console.log('📊 安装状态:\n');

  for (const p of status.paths) {
    const icon = p.type === 'dir' ? '📁' : '📄';
    const statusIcon = p.exists ? '✅' : '❌';
    console.log(`  ${statusIcon} ${icon} ${p.name}`);
    console.log(`     ${p.path}`);
  }

  console.log();
  if (status.isInstalled) {
    logger.success('Principles Disciple 已安装');
    console.log('\n  💡 卸载时将保留您的个人数据（MD文件、记忆、状态等）');
  } else {
    logger.warn('Principles Disciple 未安装');
    console.log('\n  运行以下命令安装:');
    console.log('  npx create-principles-disciple');
  }
}

const program = new Command();

program
  .name('create-principles-disciple')
  .description('Principles Disciple - OpenClaw Plugin Installer/Uninstaller')
  .version('1.0.0');

// 默认命令：安装
program
  .command('install', { isDefault: true, hidden: true })
  .description('安装 Principles Disciple 插件')
  .option('-l, --lang <lang>', 'Language (zh/en)', 'zh')
  .option('-f, --force', 'Force overwrite mode', false)
  .option('-s, --smart', 'Smart merge mode (generate .update files; in --non-interactive mode this is default when --force is not set)', false)
  .option('-w, --workspace <path>', 'Workspace directory')
  .option('-y, --yes', 'Non-interactive mode with defaults (alias for --non-interactive)', false)
  .option('--non-interactive', 'Skip interactive prompts', false)
  .option('--features <features>', 'Comma-separated features: evolution,trust,pain,reflection,okr,hygiene', 'evolution,trust,pain')
  .action(async (options) => {
    await runInstall(options);
  });

// 卸载命令
program
  .command('uninstall')
  .alias('remove')
  .alias('rm')
  .description('卸载 Principles Disciple 插件（保留用户数据）')
  .option('-f, --force', 'Force uninstall without confirmation', false)
  .action(async (options) => {
    await runUninstall(options);
  });

// 状态命令
program
  .command('status')
  .description('检查安装状态')
  .action(async () => {
    await showStatus();
  });

// 错误处理
process.on('uncaughtException', (error) => {
  if (error instanceof Error && error.name === 'ExitPromptError') {
    logger.info('👋 再见！');
  } else {
    logger.error(`未捕获的错误: ${error.message}`);
    process.exit(1);
  }
});

// 解析参数
program.parse(process.argv);