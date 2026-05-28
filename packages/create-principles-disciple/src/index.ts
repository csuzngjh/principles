#!/usr/bin/env node
import { Command } from 'commander';
import * as path from 'path';
import * as url from 'url';
import { banner, logger, setQuietMode } from './utils/logger.js';
import { runPrompts, type InstallOptions } from './prompts.js';
import { install } from './installer.js';
import { uninstall, checkInstallStatus } from './uninstaller.js';
import { checkEnvironment, detectWorkspace } from './utils/env.js';
import {
  MVP_CHANNELS,
  buildFailureOutput,
} from './mvp-config.js';
import { setLanguage, t, getLanguage, type Language } from './i18n.js';

export { isLanguage } from './i18n.js';

const __filename = url.fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PLUGIN_DIR = path.resolve(__dirname, '..');

async function runInstall(options: Record<string, unknown>): Promise<void> {
  const jsonMode = options.json === true;

  if (!isLanguage(options.lang)) {
    if (jsonMode) {
      console.log(JSON.stringify(buildFailureOutput(
        'invalid_language',
        `--lang must be 'zh' or 'en', got: ${JSON.stringify(options.lang)}. Next: re-run with --lang zh or --lang en`,
      ), null, 2));
    } else {
      logger.error(`--lang must be 'zh' or 'en', got: ${JSON.stringify(options.lang)}`);
      logger.info(`${t('next_action')}: re-run with --lang zh or --lang en`);
    }
    process.exit(1);
    return;
  }

  setLanguage(options.lang);

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
      console.log(JSON.stringify(buildFailureOutput('node_not_found', 'Install Node.js >= 18 and retry'), null, 2));
    } else {
      logger.error(t('node_required'));
    }
    process.exit(1);
    return;
  }

  if (!jsonMode) {
    logger.success(`Node.js ${env.nodeVersion}`);
    if (!env.hasOpenClaw) {
      logger.warn(t('openclaw_not_detected'));
    } else {
      logger.success(`OpenClaw ${env.openclawVersion}`);
    }
  }

  if (jsonMode && !options.yes && !options.nonInteractive) {
    options.yes = true;
  }

  const workspaceInfo = detectWorkspace();

  const cliOptions: Partial<InstallOptions> = {
    language: options.lang,
    workspaceDir: typeof options.workspace === 'string' ? options.workspace : undefined,
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
      logger.info(t('first_install_detected'));
    } else {
      logger.info(t('existing_install_detected'));
      if (workspaceInfo.coreFiles.length > 0) {
        logger.info(`  ${t('existing_core_files')} ${workspaceInfo.coreFiles.join(', ')}`);
      }
    }
    console.log();
  }

  const nonInteractive = options.nonInteractive || options.yes || jsonMode;

  const installOptions: InstallOptions | null = nonInteractive
    ? {
        language: cliOptions.language || getLanguage(),
        mode: cliOptions.mode || (workspaceInfo.isFirstInstall ? 'force' : 'smart'),
        workspaceDir: cliOptions.workspaceDir || workspaceInfo.detectedPath,
        channels: [...MVP_CHANNELS],
        overwriteConfig: false,
      }
    : await runPrompts(cliOptions, workspaceInfo);

  if (!installOptions) {
    if (jsonMode) {
      console.log(JSON.stringify(buildFailureOutput('cancelled', 'Re-run the installer'), null, 2));
    } else {
      logger.info(t('cancel_install'));
    }
    process.exit(0);
    return;
  }

  const result = await install(installOptions, PLUGIN_DIR, jsonMode);

  if (jsonMode) {
    const output = {
      success: result.success,
      workspace: result.workspaceDir,
      components: result.components,
      enabledChannels: result.enabledChannels,
      verification: result.verification,
      nextAction: result.nextAction,
      ...(result.success ? {} : { reason: result.reason }),
    };
    console.log(JSON.stringify(output, null, 2));
    if (!result.success) {
      process.exit(1);
      return;
    }
  } else {
    if (result.success) {
      console.log();
      logger.success(t('install_complete'));
      console.log();
      console.log(t('principles_disciple_setup'));
      console.log();
      console.log(t('detecting_environment'));
      console.log(`  OpenClaw integration target .... ${env.hasOpenClaw ? t('openclaw_target_found') : t('openclaw_target_not_found')}`);
      console.log(`  Node.js ........................ ${t('node_found')} (${env.nodeVersion})`);
      console.log();
      console.log(t('installing_mvp_components'));
      console.log(`  Runtime integration ............ ${result.components.plugin}`);
      console.log(`  Operator CLI ................... ${result.components.cli}`);
      console.log(`  Review console ................. ${result.components.console}${result.components.consoleEntrypoint ? ` (${result.components.consoleEntrypoint})` : ''}`);
      console.log();
      console.log(t('enabled_capabilities'));
      for (const ch of result.enabledChannels) {
        console.log(`  ${ch}`);
      }
      console.log();
      console.log(t('verification'));
      console.log(`  Feature flags .................. ${result.verification.features}`);
      console.log(`  Story A demo ................... ${result.verification.storyA}${result.verification.storyASkipReason ? ` (${result.verification.storyASkipReason})` : ''}`);
      console.log();
      console.log(t('ready'));
      console.log(`${t('diagnostics')}: pd runtime canary --workspace "${result.workspaceDir}" --json`);
    } else if (result.components.plugin === 'verified' && (result.components.cli === 'verified' || result.components.cli === 'verified_local_only')) {
      const cliLabel = result.components.cli === 'verified_local_only' ? 'verified (local only)' : result.components.cli;
      const diagCmd = result.components.cli === 'verified_local_only' && result.components.cliLocalPath
        ? `"${result.components.cliLocalPath}" runtime canary --workspace "${result.workspaceDir}" --json`
        : `pd runtime canary --workspace "${result.workspaceDir}" --json`;
      console.log();
      logger.warn(t('install_partial_complete'));
      console.log();
      console.log(t('principles_disciple_setup'));
      console.log();
      console.log(t('installing_mvp_components'));
      console.log(`  Runtime integration ............ ${result.components.plugin}`);
      console.log(`  Operator CLI ................... ${cliLabel}`);
      console.log(`  Review console ................. ${result.components.console}`);
      console.log();
      console.log(t('enabled_capabilities'));
      for (const ch of result.enabledChannels) {
        console.log(`  ${ch}`);
      }
      console.log();
      console.log(t('verification'));
      console.log(`  Feature flags .................. ${result.verification.features}`);
      console.log(`  Story A demo ................... ${result.verification.storyA}${result.verification.storyASkipReason ? ` (${result.verification.storyASkipReason})` : ''}`);
      console.log();
      console.log(t('not_ready_for_release'));
      console.log(`${t('diagnostics')}: ${diagCmd}`);
      process.exit(1);
      return;
    } else {
      logger.error(`${t('install_failed')}: ${result.reason || result.error}`);
      if (result.nextAction) {
        logger.info(`${t('next_action')}: ${result.nextAction}`);
      }
      process.exit(1);
      return;
    }
  }
}

async function runUninstall(options: Record<string, unknown>): Promise<void> {
  setLanguage('zh');
  console.log(banner);
  console.log();

  logger.info('Preparing to uninstall Principles Disciple...\n');

  const result = await uninstall({
    force: options.force === true,
  });

  if (!result.success) {
    logger.error(`${t('uninstall_failed')}: ${result.error}`);
    process.exit(1);
    return;
  }
}

async function showStatus(): Promise<void> {
  setLanguage('zh');
  console.log(banner);
  console.log();

  const status = checkInstallStatus();

  console.log(`${t('install_status')}\n`);

  for (const p of status.paths) {
    const icon = p.type === 'dir' ? '[dir]' : '[file]';
    const statusIcon = p.exists ? t('install_status_ok') : t('install_status_missing');
    console.log(`  ${statusIcon} ${icon} ${p.name}`);
    console.log(`     ${p.path}`);
  }

  console.log();
  if (status.isInstalled) {
    logger.success(t('pd_installed'));
    console.log('\n  User data (MD files, memory, state) is preserved on uninstall');
  } else {
    logger.warn(t('pd_not_installed'));
    console.log(`\n  ${t('install_hint')}:`);
    console.log('  npx create-principles-disciple');
  }
}

const program = new Command();

program
  .name('create-principles-disciple')
  .description('Principles Disciple - MVP-First Integration Wizard')
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
  .option('--json', 'Output result as JSON (implies non-interactive)', false)
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
