import { select, confirm, input } from '@inquirer/prompts';
import * as path from 'path';
import * as os from 'os';
import { detectWorkspace, type WorkspaceInfo } from './utils/env.js';
import { MVP_CHANNELS, type MvpChannel, type RuntimeProfileInput } from './mvp-config.js';
import { setLanguage, getLanguage, t, type Language } from './i18n.js';
import { type HostTarget } from './installers/index.js';

export interface InstallOptions {
  language: Language;
  mode: 'smart' | 'force';
  workspaceDir: string;
  channels: MvpChannel[];
  overwriteConfig: boolean;
  /**
   * ADR-0020 §2.3: Host target for install/uninstall.
   * - 'openclaw' (default) — writes ~/.openclaw/openclaw.json.
   * - 'codex'              — writes ~/.codex/hooks.json.
   * - 'all'                — writes both.
   */
  host: HostTarget;
  /** Fix-4 (P0-BUG-4): optional LLM runtime profile collected during prompts. */
  runtimeProfile?: RuntimeProfileInput;
  /**
   * When true, the installer auto-stops a running OpenClaw gateway before
   * install (to avoid EPERM on the backup rename) and restarts it afterwards.
   * Set by the --stop-gateway CLI flag.
   */
  stopGateway: boolean;
}

// Fix-4 (P0-BUG-4): Supported pi-ai providers for the interactive prompt.
// Keep in sync with packages/principles-core pi-ai adapter capabilities.
const RUNTIME_PROFILE_PROVIDERS = [
  { name: 'openai', value: 'openai' },
  { name: 'anthropic', value: 'anthropic' },
  { name: 'deepseek', value: 'deepseek' },
  { name: 'skip — configure later in console', value: '__skip__' },
] as const;

/**
 * Fix-4 (P0-BUG-4): Interactive prompt for LLM runtime profile.
 *
 * Why this exists: without a configured runtimeProfile, `.pd/config.yaml`
 * leaves `pd.default` provider/model/apiKeyEnv empty, and LLM-dependent
 * features (diagnose, candidate intake, internalization) fail silently
 * (rc-9: no silent fallback). This prompt collects the values up front so
 * first-run experience is not broken.
 *
 * Returns `undefined` when the user skips — installer falls back to empty
 * profile and surfaces a clear next-action pointing to the console settings.
 */
async function promptRuntimeProfile(): Promise<RuntimeProfileInput | undefined> {
  const configure = await confirm({
    message: 'Configure LLM runtime profile now? (recommended for first-time users — needed for pain diagnosis and principle generation)',
    default: true,
  });
  if (!configure) return undefined;

  const providerChoice = await select({
    message: 'Select LLM provider:',
    choices: RUNTIME_PROFILE_PROVIDERS,
    default: 'openai',
  });
  if (providerChoice === '__skip__') return undefined;

  const apiKeyEnv = await input({
    message: 'Enter API key environment variable name (e.g. OPENAI_API_KEY), or "skip" to skip:',
    default: providerChoice === 'openai' ? 'OPENAI_API_KEY'
      : providerChoice === 'anthropic' ? 'ANTHROPIC_API_KEY'
      : providerChoice === 'deepseek' ? 'DEEPSEEK_API_KEY'
      : 'LLM_API_KEY',
    validate: (value) => {
      const trimmed = value.trim();
      if (!trimmed) return 'Environment variable name cannot be empty (enter "skip" to skip)';
      if (trimmed.toLowerCase() === 'skip') return true;
      if (!/^[A-Z_][A-Z0-9_]*$/.test(trimmed)) {
        return 'Must be a valid environment variable name (uppercase letters, digits, underscore; cannot start with a digit). Enter "skip" to skip.';
      }
      return true;
    },
  });
  if (apiKeyEnv.trim().toLowerCase() === 'skip') return undefined;

  // Model is optional — sensible defaults exist per provider, user can override
  // via console later. We don't prompt for it to keep onboarding short.
  const modelDefault = providerChoice === 'openai' ? 'gpt-4o-mini'
    : providerChoice === 'anthropic' ? 'claude-3-5-haiku-latest'
    : providerChoice === 'deepseek' ? 'deepseek-chat'
    : '';

  return {
    provider: providerChoice,
    model: modelDefault,
    apiKeyEnv: apiKeyEnv.trim(),
  };
}

/**
 * ADR-0020 §2.3: Prompt for host target (interactive mode only).
 *
 * Default is 'openclaw' for backward compatibility. Operators who also use
 * Codex CLI should select 'codex' or 'all'.
 */
async function promptHost(defaultHost: HostTarget = 'openclaw'): Promise<HostTarget> {
  return await select({
    message: 'Select host platform / 选择主机平台',
    choices: [
      {
        name: 'OpenClaw (default)',
        value: 'openclaw' as const,
        description: 'Writes ~/.openclaw/openclaw.json — PD runs as an OpenClaw plugin.',
      },
      {
        name: 'Codex CLI',
        value: 'codex' as const,
        description: 'Writes ~/.codex/hooks.json — PD runs as a Codex hook subprocess.',
      },
      {
        name: 'All hosts',
        value: 'all' as const,
        description: 'Writes both OpenClaw and Codex configs — for operators using multiple hosts.',
      },
    ],
    default: defaultHost,
  });
}

async function promptLanguage(): Promise<Language> {
  return await select({
    message: 'Select language / 选择语言',
    choices: [
      { name: 'English', value: 'en' as const },
      { name: '中文', value: 'zh' as const },
    ],
    default: 'zh',
  });
}

async function promptInstallMode(defaultMode: 'smart' | 'force' = 'smart'): Promise<'smart' | 'force'> {
  return await select({
    message: t('install_mode'),
    choices: [
      {
        name: t('smart_merge') + ' — ' + t('smart_mode_desc'),
        value: 'smart' as const,
        description: t('smart_mode_desc'),
      },
      {
        name: t('force_overwrite') + ' — ' + t('force_mode_desc'),
        value: 'force' as const,
        description: t('force_mode_desc'),
      },
    ],
    default: defaultMode,
  });
}

async function promptWorkspace(workspaceInfo: WorkspaceInfo): Promise<string> {
  const choices = [
    {
      name: `${t('use_detected')}: ${workspaceInfo.detectedPath}`,
      value: 'detected' as const,
    },
    {
      name: t('custom_dir'),
      value: 'custom' as const,
    },
  ];

  const selection = await select({
    message: `${t('workspace_dir')} ${workspaceInfo.hasPrinciples ? '(Principles detected)' : ''}`,
    choices,
    default: 'detected',
  });

  if (selection === 'custom') {
    return await input({
      message: t('enter_path'),
      default: path.join(os.homedir(), 'clawd'),
      validate: (value) => {
        if (!value.trim()) return t('path_empty_error');
        return true;
      },
    });
  }

  return workspaceInfo.detectedPath;
}

function showMvpCoreChannels(): void {
  console.log(`\n${t('mvp_channels')}`);
  for (const ch of MVP_CHANNELS) {
    const labels: Record<string, Record<Language, string>> = {
      prompt: { en: 'soft principle injection', zh: '软原则注入' },
      code_tool_hook: { en: 'Rule Host hard enforcement', zh: 'Rule Host 强制约束' },
      defer_archive: { en: 'graceful deferral', zh: '优雅延迟' },
    };
    console.log(`  ${ch} — ${labels[ch]?.[getLanguage()] ?? labels[ch]?.en ?? ''}`);
  }
  console.log();
}

async function promptConfirm(options: Partial<InstallOptions>): Promise<boolean> {
  console.log(`\n${t('install_config')}`);
  console.log(`  ${t('language')}: ${options.language}`);
  console.log(`  Host platform: ${options.host ?? 'openclaw (default)'}`);
  console.log(`  ${t('mode')}: ${options.mode === 'force' ? t('force_overwrite') : t('smart_merge')}`);
  console.log(`  ${t('workspace')}: ${options.workspaceDir}`);
  console.log(`  ${t('mvp_channels_enabled')}: ${MVP_CHANNELS.join(', ')}`);
  // Fix-4: surface runtime profile status so user knows whether LLM features will work.
  if (options.runtimeProfile) {
    console.log(`  LLM runtime profile: ${options.runtimeProfile.provider} / ${options.runtimeProfile.model} (key: $${options.runtimeProfile.apiKeyEnv})`);
  } else {
    console.log(`  LLM runtime profile: not configured (configure later via console)`);
  }

  return await confirm({
    message: t('confirm_install'),
    default: true,
  });
}

export async function runPrompts(
  cliOptions: Partial<InstallOptions> = {},
  workspaceInfo?: WorkspaceInfo
): Promise<InstallOptions | null> {
  const wsInfo = workspaceInfo || detectWorkspace();

  const language = cliOptions.language ?? await promptLanguage();
  setLanguage(language);

  // ADR-0020 §2.3: prompt for host target if not supplied via --host.
  const host = cliOptions.host ?? await promptHost();

  let { mode } = cliOptions;
  if (!mode) {
    const defaultMode = wsInfo.isFirstInstall ? 'force' : 'smart';

    if (!wsInfo.isFirstInstall && wsInfo.coreFiles && wsInfo.coreFiles.length > 0) {
      console.log(`\n${t('existing_core_files')} ${wsInfo.coreFiles.join(', ')}`);
      console.log(`  ${t('smart_mode_desc')}\n`);
    }

    mode = await promptInstallMode(defaultMode);
  }

  const workspaceDir = cliOptions.workspaceDir ?? await promptWorkspace(wsInfo);

  showMvpCoreChannels();

  // Fix-4 (P0-BUG-4): collect LLM runtime profile after channels are shown,
  // before final confirmation. Skipped automatically in non-interactive mode
  // (caller passes runtimeProfile via cliOptions or leaves it undefined).
  const runtimeProfile = cliOptions.runtimeProfile !== undefined
    ? cliOptions.runtimeProfile
    : await promptRuntimeProfile();

  const options: InstallOptions = {
    language,
    mode,
    workspaceDir,
    channels: [...MVP_CHANNELS],
    overwriteConfig: false,
    host,
    runtimeProfile,
    stopGateway: cliOptions.stopGateway === true,
  };

  const confirmed = await promptConfirm(options);
  if (!confirmed) {
    console.log(`\n${t('cancel_install')}\n`);
    return null;
  }

  return options;
}

export { confirm, input, select };
