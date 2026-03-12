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
import * as os from 'os';
import { banner, logger } from './utils/logger.js';
import { runPrompts, type InstallOptions } from './prompts.js';
import { install } from './installer.js';
import { uninstall, checkInstallStatus } from './uninstaller.js';
import { checkEnvironment } from './utils/env.js';

// ESM 模块中获取 __dirname
const __filename = url.fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 插件目录（相对于此文件的上级上级）
const PLUGIN_DIR = path.resolve(__dirname, '..', '..', 'openclaw-plugin');

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
  .option('-s, --smart', 'Smart merge mode (generate .update files)', false)
  .option('-w, --workspace <path>', 'Workspace directory')
  .option('--non-interactive', 'Skip interactive prompts', false)
  .action(async (options) => {
    await runInstall(options);
  });

// 卸载命令
program
  .command('uninstall')
  .alias('remove')
  .alias('rm')
  .description('卸载 Principles Disciple 插件')
  .option('-f, --force', 'Force uninstall without confirmation', false)
  .option('-w, --workspace <path>', 'Workspace directory')
  .option('--keep-workspace', 'Keep workspace state files', false)
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

/**
 * 运行安装
 */
async function runInstall(options: any): Promise<void> {
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

  // 2. 解析 CLI 选项
  const cliOptions: Partial<InstallOptions> = {
    language: options.lang as 'zh' | 'en',
    workspaceDir: options.workspace,
  };
  
  // 确定安装模式
  if (options.force) {
    cliOptions.mode = 'force';
  } else if (options.smart) {
    cliOptions.mode = 'smart';
  }

  // 3. 运行交互式问答
  let installOptions: InstallOptions | null;
  
  if (options.nonInteractive) {
    // 非交互模式：使用默认值
    installOptions = {
      language: cliOptions.language || 'zh',
      mode: cliOptions.mode || 'smart',
      workspaceDir: cliOptions.workspaceDir || path.join(os.homedir(), 'clawd'),
      features: ['evolution', 'trust', 'pain'],
      overwriteConfig: false,
    };
  } else {
    // 交互模式
    installOptions = await runPrompts(cliOptions);
  }

  // 用户取消
  if (!installOptions) {
    logger.info('安装已取消');
    process.exit(0);
  }

  // 4. 执行安装
  const result = await install(installOptions, PLUGIN_DIR);

  // 5. 显示结果
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
async function runUninstall(options: any): Promise<void> {
  console.log(banner);
  console.log();
  
  logger.info('准备卸载 Principles Disciple...\n');

  const result = await uninstall({
    workspaceDir: options.workspace,
    keepWorkspace: options.keepWorkspace,
    force: options.force,
  });

  if (result.success) {
    console.log();
    if (result.removedDirs.length > 0 || result.removedFiles.length > 0) {
      logger.success('卸载完成！');
      console.log();
      console.log('🗑️ 已删除:');
      result.removedDirs.forEach(d => console.log(`   📁 ${d}`));
      result.removedFiles.forEach(f => console.log(`   📄 ${f}`));
    } else {
      logger.info('没有需要删除的内容');
    }
  } else {
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
  } else {
    logger.warn('Principles Disciple 未安装');
    console.log('\n  运行以下命令安装:');
    console.log('  npx create-principles-disciple');
  }
}

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