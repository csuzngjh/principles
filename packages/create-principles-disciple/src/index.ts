#!/usr/bin/env node
import { Command } from 'commander';
import * as path from 'path';
import * as url from 'url';
import { createRequire } from 'module';
import { banner, logger, setQuietMode } from './utils/logger.js';
import { runPrompts, type InstallOptions } from './prompts.js';
import { install } from './installer.js';
import { uninstall, checkInstallStatus } from './uninstaller.js';
import { checkEnvironment, detectWorkspace } from './utils/env.js';
import {
  MVP_CHANNELS,
  buildFailureOutput,
} from './mvp-config.js';
import { setLanguage, t, getLanguage, isLanguage } from './i18n.js';
import { isHostTarget, type HostTarget, HOST_TARGETS } from './installers/index.js';

export { isLanguage } from './i18n.js';

const __filename = url.fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PLUGIN_DIR = path.resolve(__dirname, '..');

// Fix-1 (P0-BUG-1): Read version from package.json instead of hardcoding.
// EP-06 (Source of Truth): package.json is the canonical version source.
// rc-2-no-as-bypass: validate the parsed JSON at runtime instead of `as` cast.
const requireFromMeta = createRequire(import.meta.url);
const pkgJson: unknown = requireFromMeta('../package.json');
if (typeof pkgJson !== 'object' || pkgJson === null) {
  throw new Error('Invalid package.json: expected an object');
}
const pkgVersionValue = Object.hasOwn(pkgJson, 'version') ? Reflect.get(pkgJson, 'version') : undefined;
if (typeof pkgVersionValue !== 'string' || pkgVersionValue.length === 0) {
  throw new Error('Invalid package.json: "version" must be a non-empty string');
}
const pkgVersion = pkgVersionValue;

export function toInstallJsonOutput(result: Awaited<ReturnType<typeof install>>): Record<string, unknown> {
  return {
    success: result.success,
    workspace: result.workspaceDir,
    components: result.components,
    enabledChannels: result.enabledChannels,
    verification: result.verification,
    nextAction: result.nextAction,
    ...(result.success ? {} : {
      reason: result.reason,
      component: result.component,
      dependency: result.dependency,
    }),
  };
}

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

  // ADR-0020 §2.3: Validate --host value. Default is 'openclaw' for backward compat.
  const rawHost = typeof options.host === 'string' ? options.host : 'openclaw';
  if (!isHostTarget(rawHost)) {
    if (jsonMode) {
      console.log(JSON.stringify(buildFailureOutput(
        'invalid_host',
        `--host must be one of: ${HOST_TARGETS.join(', ')}. Got: ${JSON.stringify(rawHost)}. Next: re-run with --host openclaw (or --host codex / --host all)`,
      ), null, 2));
    } else {
      logger.error(`--host must be one of: ${HOST_TARGETS.join(', ')}. Got: ${JSON.stringify(rawHost)}`);
      logger.info(`Next: re-run with --host openclaw (or --host codex / --host all)`);
    }
    process.exit(1);
    return;
  }
  const host: HostTarget = rawHost;

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
      console.log(JSON.stringify(buildFailureOutput('node_not_found', 'Install Node.js >= 22 and retry'), null, 2));
    } else {
      logger.error(t('node_required'));
    }
    process.exit(1);
    return;
  }

  if (!env.isNodeSupported) {
    const nextAction = `Install Node.js >= 22 and retry. Detected: ${env.nodeVersion ?? 'unknown'}`;
    if (jsonMode) {
      console.log(JSON.stringify({
        ...buildFailureOutput('node_version_unsupported', nextAction),
        detectedVersion: env.nodeVersion,
      }, null, 2));
    } else {
      logger.error(t('node_version_unsupported'));
      logger.info(`${t('next_action')}: ${nextAction}`);
    }
    process.exit(1);
    return;
  }

  if (!jsonMode) {
    logger.success(`Node.js ${env.nodeVersion}`);
  }

  // ADR-0020: OpenClaw check is only required when host includes 'openclaw'.
  // For --host codex, the operator may not have OpenClaw installed at all.
  const needsOpenClaw = host === 'openclaw' || host === 'all';
  if (needsOpenClaw && !env.hasOpenClaw) {
    if (jsonMode) {
      console.log(JSON.stringify(buildFailureOutput(
        'openclaw_not_found',
        `${t('openclaw_required')} ${t('openclaw_install_hint')} | ${t('next_action')}: ${t('openclaw_rerun_hint')} or use --host codex to skip OpenClaw`,
      ), null, 2));
    } else {
      logger.error(`\u274C ${t('openclaw_required')}`);
      logger.info(`   ${t('openclaw_install_hint')}`);
      logger.info(`   ${t('next_action')}: ${t('openclaw_rerun_hint')} or use --host codex to skip OpenClaw`);
    }
    process.exit(1);
    return;
  }

  if (!jsonMode && needsOpenClaw) {
    logger.success(`OpenClaw ${env.openclawVersion}`);
  }

  if (!jsonMode && host === 'codex') {
    logger.info(`Host: Codex CLI (OpenClaw not required)`);
  }

  if (jsonMode && !options.yes && !options.nonInteractive) {
    options.yes = true;
  }

  const workspaceInfo = detectWorkspace();

  const cliOptions: Partial<InstallOptions> = {
    language: options.lang,
    workspaceDir: typeof options.workspace === 'string' ? options.workspace : undefined,
    host,
    stopGateway: options.stopGateway === true,
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

  // Fix-4 (P0-BUG-4): In non-interactive mode, collect runtime profile from
  // CLI flags (--provider/--api-key-env/--model) or env vars
  // (PD_PROVIDER/PD_API_KEY_ENV/PD_MODEL). rc-9: when provider is given
  // without apiKeyEnv, fail loud instead of silently writing an unusable
  // profile. rc-3: validate provider allowlist and apiKeyEnv format before
  // writing, reusing the same patterns as prompts.ts.
  if (nonInteractive) {
    const provider = typeof options.provider === 'string' ? options.provider : process.env.PD_PROVIDER;
    const apiKeyEnv = typeof options.apiKeyEnv === 'string' ? options.apiKeyEnv : process.env.PD_API_KEY_ENV;
    const model = typeof options.model === 'string' ? options.model : process.env.PD_MODEL;
    if (provider) {
      const allowedProviders: readonly string[] = ['openai', 'anthropic', 'deepseek'];
      if (!allowedProviders.includes(provider)) {
        const msg = `--provider "${provider}" is not supported. Valid: openai, anthropic, deepseek.`;
        if (jsonMode) {
          console.log(JSON.stringify(buildFailureOutput('runtime_profile_invalid', msg), null, 2));
        } else {
          logger.error(msg);
        }
        process.exit(1);
        return;
      }
      if (!apiKeyEnv) {
        const msg = `--provider "${provider}" given but --api-key-env is missing. Pass --api-key-env OPENAI_API_KEY (or set PD_API_KEY_ENV).`;
        if (jsonMode) {
          console.log(JSON.stringify(buildFailureOutput('runtime_profile_incomplete', msg), null, 2));
        } else {
          logger.error(msg);
        }
        process.exit(1);
        return;
      }
      if (!/^[A-Z_][A-Z0-9_]*$/.test(apiKeyEnv)) {
        const msg = `--api-key-env "${apiKeyEnv}" is not a valid environment variable name (uppercase letters, digits, underscore; cannot start with a digit).`;
        if (jsonMode) {
          console.log(JSON.stringify(buildFailureOutput('runtime_profile_invalid', msg), null, 2));
        } else {
          logger.error(msg);
        }
        process.exit(1);
        return;
      }
      cliOptions.runtimeProfile = { provider, apiKeyEnv, model: model || undefined };
    } else if (apiKeyEnv) {
      // rc-3: fail loud — apiKeyEnv without provider is unusable.
      const msg = `--api-key-env given without --provider. Pass --provider openai (or set PD_PROVIDER).`;
      if (jsonMode) {
        console.log(JSON.stringify(buildFailureOutput('runtime_profile_incomplete', msg), null, 2));
      } else {
        logger.error(msg);
      }
      process.exit(1);
      return;
    }
  }

  const installOptions: InstallOptions | null = nonInteractive
    ? {
        language: cliOptions.language || getLanguage(),
        mode: cliOptions.mode || (workspaceInfo.isFirstInstall ? 'force' : 'smart'),
        workspaceDir: cliOptions.workspaceDir || workspaceInfo.detectedPath,
        channels: [...MVP_CHANNELS],
        overwriteConfig: false,
        // ADR-0020 §2.3: propagate validated host target into install options.
        host,
        runtimeProfile: cliOptions.runtimeProfile,
        stopGateway: cliOptions.stopGateway === true,
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

  // Test/hermetic-build override: when set, it must point at a COMPLETE
  // self-contained release asset directory (component trees + _release
  // manifest). Production never sets it.
  const pluginDir = process.env.PD_INSTALL_PLUGIN_DIR ?? PLUGIN_DIR;
  const result = await install(installOptions, pluginDir, { quiet: jsonMode, nonInteractive: Boolean(nonInteractive) });

  if (jsonMode) {
    const output = toInstallJsonOutput(result);
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
      console.log(`  Configuration .................. ${result.verification.features}`);
      console.log(`  Demo verification .............. ${result.verification.storyA}${result.verification.storyASkipReason ? ` (${result.verification.storyASkipReason})` : ''}`);
      // Fix-4: surface runtime profile status so the user knows whether LLM
      // features (diagnose, candidate intake, internalization) will work.
      if (installOptions.runtimeProfile) {
        console.log(`  LLM runtime profile ............ ${installOptions.runtimeProfile.provider} / ${installOptions.runtimeProfile.model ?? '(default)'} (key: $${installOptions.runtimeProfile.apiKeyEnv})`);
      } else {
        console.log(`  LLM runtime profile ............ not configured (configure via console: pd console open --workspace "${result.workspaceDir}")`);
      }
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
      console.log(`  Configuration .................. ${result.verification.features}`);
      console.log(`  Demo verification .............. ${result.verification.storyA}${result.verification.storyASkipReason ? ` (${result.verification.storyASkipReason})` : ''}`);
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
  // rc-3-fail-loud: validate --lang the same way runInstall does, instead of
  // silently defaulting any non-'en' value to 'zh'.
  if (!isLanguage(options.lang)) {
    logger.error(`--lang must be 'zh' or 'en', got: ${JSON.stringify(options.lang)}`);
    logger.info(`Next: re-run with --lang zh or --lang en`);
    process.exit(1);
    return;
  }
  setLanguage(options.lang);

  // ADR-0020 §2.3: validate --host (default 'all' for uninstall).
  const rawHost = typeof options.host === 'string' ? options.host : 'all';
  if (!isHostTarget(rawHost)) {
    logger.error(`--host must be one of: ${HOST_TARGETS.join(', ')}. Got: ${JSON.stringify(rawHost)}`);
    logger.info(`Next: re-run with --host openclaw (or --host codex / --host all)`);
    process.exit(1);
    return;
  }
  const host: HostTarget = rawHost;

  console.log(banner);
  console.log();

  logger.info(`Preparing to uninstall Principles Disciple (host: ${host})...\n`);

  const result = await uninstall({
    force: options.force === true,
    lang: options.lang,
    host,
  });

  if (!result.success) {
    logger.error(`${t('uninstall_failed')}: ${result.error}`);
    process.exit(1);
    return;
  }
}

async function showStatus(options: Record<string, unknown>): Promise<void> {
  // rc-3-fail-loud: validate --lang the same way runInstall does.
  if (!isLanguage(options.lang)) {
    logger.error(`--lang must be 'zh' or 'en', got: ${JSON.stringify(options.lang)}`);
    logger.info(`Next: re-run with --lang zh or --lang en`);
    process.exit(1);
    return;
  }
  setLanguage(options.lang);
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

// cli-7: exported so parser tests can inspect the REAL option registration
// (catches removal/rename/default-change of flags). Not .parse()'d on import —
// see the main-module guard at the bottom of this file.
export const program = new Command();

program
  .name('create-principles-disciple')
  .description('Principles Disciple - MVP-First Integration Wizard')
  .version(pkgVersion);

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
  // Fix-4 (P0-BUG-4): allow non-interactive LLM runtime profile configuration.
  // When --provider is given, the installer pre-fills pd.default profile
  // instead of leaving it empty (which would cause silent LLM failures).
  .option('--provider <provider>', 'LLM provider for pd.default profile (openai/anthropic/deepseek). Enables non-interactive runtime profile config.')
  .option('--api-key-env <name>', 'Environment variable name holding the LLM API key (e.g. OPENAI_API_KEY). Requires --provider.')
  .option('--model <model>', 'LLM model id (optional; sensible default per provider if omitted)')
  // ADR-0020 §2.3: host target selector. Default 'openclaw' for backward compat.
  .option('--host <host>', `Host platform (${HOST_TARGETS.join('/')})`, 'openclaw')
  // Gateway lock prevention: auto-stop a running OpenClaw gateway before
  // install (avoids EPERM on the backup rename) and restart it afterwards.
  .option('--stop-gateway', 'Stop the OpenClaw gateway before install if running, restart after', false)
  .action(async (options) => {
    await runInstall(options);
  });

program
  .command('uninstall')
  .alias('remove')
  .alias('rm')
  .description('Uninstall Principles Disciple (preserves user data)')
  .option('-f, --force', 'Force uninstall without confirmation', false)
  .option('-l, --lang <lang>', 'Language (zh/en)', 'zh')
  // ADR-0020 §2.3: host-scoped uninstall. Default 'all' cleans every host
  // PD ever registered with. Operators can scope to one host via --host codex.
  .option('--host <host>', `Host platform (${HOST_TARGETS.join('/')})`, 'all')
  .action(async (options) => {
    await runUninstall(options);
  });

program
  .command('status')
  .description('Check install status')
  .option('-l, --lang <lang>', 'Language (zh/en)', 'zh')
  .action(async (options) => {
    await showStatus(options);
  });

// cli-7: only wire the process handler and parse argv when this module is the
// CLI entry point — NOT when imported by tests (which inspect `program` opts
// directly). Without this guard, importing index.js would run the installer.
if (url.pathToFileURL(process.argv[1] ?? '').href === import.meta.url) {
  process.on('uncaughtException', (error) => {
    if (error instanceof Error && error.name === 'ExitPromptError') {
      logger.info('Goodbye!');
    } else {
      logger.error(`Uncaught error: ${error.message}`);
      process.exit(1);
    }
  });

  program.parse(process.argv);
}
