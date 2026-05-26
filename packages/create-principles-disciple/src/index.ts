#!/usr/bin/env node
import { Command } from 'commander';
import * as path from 'path';
import * as url from 'url';
import { banner, logger, setQuietMode } from './utils/logger.js';
import { runPrompts, type InstallOptions } from './prompts.js';
import { install } from './installer.js';
import { uninstall, checkInstallStatus } from './uninstaller.js';
import { checkEnvironment, detectWorkspace } from './utils/env.js';
import { MVP_CHANNELS, validateMvpChannels, buildFailureReason, type MvpChannel } from './mvp-config.js';

const __filename = url.fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PLUGIN_DIR = path.resolve(__dirname, '..');

async function runInstall(options: Record<string, unknown>): Promise<void> {
  const jsonMode = options.json === true;

  if (jsonMode) {
    setQuietMode(true);
  }

  if (!jsonMode) {
    console.log(banner);
    console.log();
  }

  const env = checkEnvironment();

  if (!env.hasNode) {
    if (jsonMode) {
      const result = {
        success: false as const,
        reason: buildFailureReason('node_not_found'),
        nextAction: 'Install Node.js >= 18 and retry',
      };
      console.log(JSON.stringify(result, null, 2));
    } else {
      logger.error('Node.js is required (>= 18). Install Node.js first.');
    }
    process.exit(1);
    return;
  }

  if (!jsonMode) {
    logger.success(`Node.js ${env.nodeVersion}`);
    if (!env.hasOpenClaw) {
      logger.warn('OpenClaw not detected — PD CLI commands still work in standalone mode');
    } else {
      logger.success(`OpenClaw ${env.openclawVersion}`);
    }
  }

  const workspaceInfo = detectWorkspace();

  const cliOptions: Partial<InstallOptions> = {
    language: options.lang as 'zh' | 'en',
    workspaceDir: options.workspace as string,
  };

  if (options.force) {
    cliOptions.mode = 'force';
  } else if (options.smart) {
    cliOptions.mode = 'smart';
  } else {
    cliOptions.mode = workspaceInfo.isFirstInstall ? 'force' : 'smart';
  }

  if (!jsonMode && !options.nonInteractive && !options.yes) {
    if (workspaceInfo.isFirstInstall) {
      logger.info('First-time install detected — will copy all files');
    } else {
      logger.info('Existing install detected — will use smart merge mode');
      if (workspaceInfo.coreFiles.length > 0) {
        logger.info(`  Existing core files: ${workspaceInfo.coreFiles.join(', ')}`);
      }
    }
    console.log();
  }

  const nonInteractive = options.nonInteractive || options.yes;

  const installOptions: InstallOptions | null = nonInteractive
    ? (() => {
        const parsedChannels = options.channels
          ? (options.channels as string).split(',').map((f: string) => f.trim().toLowerCase()).filter(Boolean)
          : [...MVP_CHANNELS];

        const { valid, unknowns } = validateMvpChannels(parsedChannels);

        if (unknowns.length > 0 && !jsonMode) {
          logger.warn(`Unknown channels ignored: ${unknowns.join(', ')}`);
          logger.info(`Valid MVP channels: ${MVP_CHANNELS.join(', ')}`);
        }

        const channels: MvpChannel[] = valid.length > 0 ? valid : [...MVP_CHANNELS];

        const opts: InstallOptions = {
          language: cliOptions.language || 'zh',
          mode: cliOptions.mode || (workspaceInfo.isFirstInstall ? 'force' : 'smart'),
          workspaceDir: cliOptions.workspaceDir || workspaceInfo.detectedPath,
          channels,
          overwriteConfig: false,
        };

        if (!jsonMode) {
          if (!options.force && !options.smart) {
            logger.info(`Auto-detected install mode: ${opts.mode === 'force' ? 'first install' : 'smart merge'}`);
          }
          logger.info(`Non-interactive mode: channels = ${channels.join(', ')}`);
        }

        return opts;
      })()
    : await runPrompts(cliOptions, workspaceInfo);

  if (!installOptions) {
    if (jsonMode) {
      console.log(JSON.stringify({ success: false, reason: 'cancelled', nextAction: 'Re-run the installer' }, null, 2));
    } else {
      logger.info('Install cancelled');
    }
    process.exit(0);
    return;
  }

  const result = await install(installOptions, PLUGIN_DIR, jsonMode);

  if (jsonMode) {
    console.log(JSON.stringify(result, null, 2));
    if (!result.success) {
      process.exit(1);
      return;
    }
  } else {
    if (result.success) {
      console.log();
      logger.success('Install complete!');
      console.log();
      console.log('Install info:');
      console.log(`  Language: ${installOptions.language}`);
      console.log(`  Mode: ${installOptions.mode === 'force' ? 'force overwrite' : 'smart merge'}`);
      console.log(`  Channels: ${installOptions.channels.join(', ')}`);
      console.log(`  Workspace: ${result.workspaceDir}`);
      console.log(`  Feature flags: ${result.featureFlagsPath}`);

      if (installOptions.mode === 'smart' && result.updateFilesCount && result.updateFilesCount > 0) {
        console.log();
        console.log(`  ${result.updateFilesCount} update file(s) need manual merge`);
      }

      console.log();
      console.log('Next steps:');
      console.log(`  1. Verify MVP channels:  pd demo story-a`);
      console.log(`  2. Inspect feature flags: pd runtime features --json`);
    } else {
      logger.error(`Install failed: ${result.reason || result.error}`);
      if (result.nextAction) {
        logger.info(`Next action: ${result.nextAction}`);
      }
      process.exit(1);
      return;
    }
  }
}

async function runUninstall(options: Record<string, unknown>): Promise<void> {
  console.log(banner);
  console.log();

  logger.info('Preparing to uninstall Principles Disciple...\n');

  const result = await uninstall({
    force: options.force as boolean,
  });

  if (!result.success) {
    logger.error(`Uninstall failed: ${result.error}`);
    process.exit(1);
    return;
  }
}

async function showStatus(): Promise<void> {
  console.log(banner);
  console.log();

  const status = checkInstallStatus();

  console.log('Install status:\n');

  for (const p of status.paths) {
    const icon = p.type === 'dir' ? '[dir]' : '[file]';
    const statusIcon = p.exists ? 'OK' : 'MISSING';
    console.log(`  ${statusIcon} ${icon} ${p.name}`);
    console.log(`     ${p.path}`);
  }

  console.log();
  if (status.isInstalled) {
    logger.success('Principles Disciple is installed');
    console.log('\n  User data (MD files, memory, state) is preserved on uninstall');
  } else {
    logger.warn('Principles Disciple is not installed');
    console.log('\n  Install with:');
    console.log('  npx create-principles-disciple');
  }
}

const program = new Command();

program
  .name('create-principles-disciple')
  .description('Principles Disciple - MVP-First Installer')
  .version('2.0.0');

program
  .command('install', { isDefault: true, hidden: true })
  .description('Install Principles Disciple (MVP-First)')
  .option('-l, --lang <lang>', 'Language (zh/en)', 'zh')
  .option('-f, --force', 'Force overwrite mode', false)
  .option('-s, --smart', 'Smart merge mode', false)
  .option('-w, --workspace <path>', 'Workspace directory')
  .option('-y, --yes', 'Non-interactive mode with defaults', false)
  .option('--non-interactive', 'Skip interactive prompts', false)
  .option('--channels <channels>', `Comma-separated MVP channels: ${MVP_CHANNELS.join(',')}`, MVP_CHANNELS.join(','))
  .option('--json', 'Output result as JSON', false)
  .action(async (options) => {
    await runInstall(options);
  });

program
  .command('uninstall')
  .alias('remove')
  .alias('rm')
  .description('Uninstall Principles Disciple (preserves user data)')
  .option('-f, --force', 'Force uninstall without confirmation', false)
  .action(async (options) => {
    await runUninstall(options);
  });

program
  .command('status')
  .description('Check install status')
  .action(async () => {
    await showStatus();
  });

process.on('uncaughtException', (error) => {
  if (error instanceof Error && error.name === 'ExitPromptError') {
    logger.info('Goodbye!');
  } else {
    logger.error(`Uncaught error: ${error.message}`);
    process.exit(1);
  }
});

program.parse(process.argv);
