#!/usr/bin/env node
/**
 * Principles Disciple - OpenClaw Plugin Installer
 * 
 * 交互式安装器，支持：
 * - npx create-principles-disciple
 * - npx create-principles-disciple --lang zh --force
 */
import { Command } from 'commander';
import * as path from 'path';
import * as url from 'url';
import { banner, logger } from './utils/logger.js';
import { runPrompts, type InstallOptions } from './prompts.js';
import { install } from './installer.js';
import { checkEnvironment } from './utils/env.js';

// ESM 模块中获取 __dirname
const __filename = url.fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 插件目录（相对于此文件的上级上级）
const PLUGIN_DIR = path.resolve(__dirname, '..', '..', 'openclaw-plugin');

const program = new Command();

program
  .name('create-principles-disciple')
  .description('Principles Disciple - OpenClaw Plugin Interactive Installer')
  .version('1.0.0')
  .option('-l, --lang <lang>', 'Language (zh/en)', 'zh')
  .option('-f, --force', 'Force overwrite mode', false)
  .option('-s, --smart', 'Smart merge mode (generate .update files)', false)
  .option('-w, --workspace <path>', 'Workspace directory')
  .option('--non-interactive', 'Skip interactive prompts', false)
  .parse(process.argv);

const options = program.opts();

async function main(): Promise<void> {
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
      workspaceDir: cliOptions.workspaceDir || path.join(process.env.HOME || '', 'clawd'),
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

// 错误处理
process.on('uncaughtException', (error) => {
  if (error instanceof Error && error.name === 'ExitPromptError') {
    logger.info('👋 再见！');
  } else {
    logger.error(`未捕获的错误: ${error.message}`);
    process.exit(1);
  }
});

// 运行
main().catch((error) => {
  logger.error(error.message);
  process.exit(1);
});
