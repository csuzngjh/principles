import { select, confirm, input } from '@inquirer/prompts';
import * as path from 'path';
import { detectWorkspace, type WorkspaceInfo } from './utils/env.js';
import { MVP_CHANNELS, getHomeDir, type MvpChannel, type RuntimeProfileInput, resolveDefaultModelForProvider, isValidHttpBaseUrl } from './mvp-config.js';
import { getInstallLayoutPaths, getWorkbuddyWorkspaceDir } from '@principles/install-layout';
import { setLanguage, getLanguage, t, type Language } from './i18n.js';
import { type HostSelection } from './installers/index.js';
import type { ServiceHostSchedulerIntent } from './service-host-bridge.js';

/**
 * PRI-1278 Phase 5: the background-execution consent as a single, explicit
 * value. Intent says WHAT to do; source says WHY (so the installer can refuse
 * an implicitly-enabled scheduler on a legacy upgrade).
 */
export interface ServiceHostConsent {
  intent: ServiceHostSchedulerIntent;
  source: 'explicit_flag' | 'interactive_consent' | 'recommended_default' | 'policy';
}

export interface InstallOptions {
  language: Language;
  mode: 'smart' | 'force';
  workspaceDir: string;
  /**
   * True when the operator supplied this workspace explicitly (--workspace or
   * the interactive "custom" path). install() uses it to decide whether the
   * Codex host may resolve its own default instead of the shared one (PRI-1247).
   */
  workspaceExplicit?: boolean;
  channels: MvpChannel[];
  overwriteConfig: boolean;
  /**
   * ADR-0020 §2.3 / PRI-1278 Phase 5: host ADAPTER selection, independent of
   * the background execution owner.
   * - 'openclaw' / 'codex' / 'workbuddy' — install that host adapter.
   * - 'all'                             — OpenClaw + Codex.
   * - 'none'                            — Service-Host-only: no host adapter,
   *                                       no fabricated host worker. This is the
   *                                       safe default when --host is omitted.
   */
  host: HostSelection;
  /** Fix-4 (P0-BUG-4): optional LLM runtime profile collected during prompts. */
  runtimeProfile?: RuntimeProfileInput;
  /**
   * When true, the installer auto-stops a running OpenClaw gateway before
   * install (to avoid EPERM on the backup rename) and restarts it afterwards.
   * Set by the --stop-gateway CLI flag.
   */
  stopGateway: boolean;
  /**
   * PRI-1278 Phase 5: a PD install manifest did NOT exist before this run.
   * Only a fresh install may apply the new default (Service Host scheduler
   * registered + enabled, new workspace owned by the Service Host). Legacy
   * installs keep refresh-if-registered semantics.
   */
  freshInstall?: boolean;
  /**
   * PRI-1281 Phase 3 / PRI-1278 Phase 5: EXPLICIT operator consent to
   * register AND enable the scheduler. On a fresh install the interactive
   * prompt defaults to Yes; `--yes` accepts it as the recommended default.
   */
  enableServiceHost?: boolean;
  /**
   * PRI-1281 Phase 3: EXPLICIT operator consent (--register-service-host) to
   * register the scheduler DISABLED (installed_disabled).
   */
  registerServiceHost?: boolean;
  /** PRI-1278 Phase 5: explicit opt-out (`--no-service-host`). */
  disableServiceHost?: boolean;
  /** PRI-1278 Phase 5: the resolved background-execution consent. */
  serviceHost?: ServiceHostConsent;
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
// Round-5 S3: exported for the interactive-collection regression tests (the
// prompt flow IS a public surface; the test scripts the @inquirer layer).
export async function promptRuntimeProfile(): Promise<RuntimeProfileInput | undefined> {
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

  // Model is optional — sensible defaults exist per provider (round-4 S2: the
  // ONE shared resolution, also applied by the non-interactive install path
  // and the governance write boundary), user can override via console later.
  // We don't prompt for it to keep onboarding short.
  const modelDefault = resolveDefaultModelForProvider(providerChoice);

  // Round-5 S3: the custom-endpoint input exists in BOTH modes (a deployment
  // model id the provider catalog does not know is otherwise rejected). Blank
  // = provider default; anything given must parse as a real http(s) endpoint
  // (the ONE shared validation — a prefix regex let `https://` through).
  const baseUrl = await input({
    message: 'Custom OpenAI-compatible endpoint URL (blank = provider default; for self-hosted or gateway deployments):',
    default: '',
    validate: (value) => {
      const trimmed = value.trim();
      if (!trimmed) return true;
      if (!isValidHttpBaseUrl(trimmed)) {
        return 'Must be a valid http(s) URL with a hostname (e.g. https://llm.example.com/v1). Leave blank for the provider default.';
      }
      return true;
    },
  });
  const trimmedBaseUrl = baseUrl.trim();

  return {
    provider: providerChoice,
    model: modelDefault,
    apiKeyEnv: apiKeyEnv.trim(),
    ...(trimmedBaseUrl ? { baseUrl: trimmedBaseUrl } : {}),
  };
}

/**
 * PRI-1278 Phase 5: prompt for host ADAPTER only. The background execution
 * owner (PD Service Host) is chosen separately and is never implied by this
 * answer. There is no OpenClaw default: 'none' (Service-Host-only) is the
 * safe initial focus so an operator who does not pick a host never gets one
 * installed silently.
 */
async function promptHost(defaultHost: HostSelection = 'none'): Promise<HostSelection> {
  return await select({
    message: t('service_host_host_select_message'),
    choices: [
      {
        name: t('service_host_host_none_name'),
        value: 'none' as const,
        description: t('service_host_host_none_desc'),
      },
      {
        name: 'OpenClaw',
        value: 'openclaw' as const,
        description: t('service_host_host_openclaw_desc'),
      },
      {
        name: 'Codex CLI',
        value: 'codex' as const,
        description: t('service_host_host_codex_desc'),
      },
      {
        name: 'WorkBuddy',
        value: 'workbuddy' as const,
        description: t('service_host_host_workbuddy_desc'),
      },
      {
        name: 'All hosts (OpenClaw + Codex)',
        value: 'all' as const,
        description: t('service_host_host_all_desc'),
      },
    ],
    default: defaultHost,
  });
}

/**
 * PRI-1278 Phase 5: fresh-install background-execution consent. The Service
 * Host uses the CURRENT USER'S OS scheduler, so the disclosure is part of the
 * consent — no hidden persistent trigger.
 */
async function promptServiceHost(): Promise<boolean> {
  console.log(`\n${t('service_host_prompt_title')}`);
  console.log(`  ${t('service_host_prompt_intro')}`);
  console.log(`  ${t('service_host_prompt_os')}`);
  console.log(`  ${t('service_host_prompt_interval')}`);
  console.log(`  ${t('service_host_prompt_independent')}`);
  console.log(`  ${t('service_host_prompt_disable')}`);
  return await confirm({
    message: t('service_host_prompt_confirm'),
    default: true,
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

async function promptWorkspace(
  workspaceInfo: WorkspaceInfo,
): Promise<{ workspaceDir: string; explicit: boolean }> {
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
    // The default is the HOST-AWARE detected path, not a hardcoded ~/clawd:
    // for Codex that would reintroduce the OpenClaw directory (PRI-1247).
    const workspaceDir = await input({
      message: t('enter_path'),
      default: workspaceInfo.detectedPath,
      validate: (value) => {
        if (!value.trim()) return t('path_empty_error');
        return true;
      },
    });
    return { workspaceDir, explicit: true };
  }

  return { workspaceDir: workspaceInfo.detectedPath, explicit: false };
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
  console.log(`  ${t('install_host_adapter')}: ${options.host === 'none' ? t('install_host_none') : options.host ?? t('install_host_none')}`);
  console.log(`  ${t('mode')}: ${options.mode === 'force' ? t('force_overwrite') : t('smart_merge')}`);
  console.log(`  ${t('workspace')}: ${options.workspaceDir}`);
  console.log(`  ${t('mvp_channels_enabled')}: ${MVP_CHANNELS.join(', ')}`);
  // PRI-1278 Phase 5: background execution consent is part of the final
  // confirmation — the operator must see the persistent OS trigger before
  // accepting the install.
  if (options.enableServiceHost === true) {
    console.log(`  ${t('background_scheduler_enabled_summary')}`);
    console.log(`    ${t('background_os_registration')}`);
    console.log(`    ${t('background_os_cycle')}`);
    console.log(`    ${t('background_os_disable')}`);
  } else if (options.registerServiceHost === true) {
    console.log(`  ${t('background_scheduler_registered_summary')}`);
    console.log(`    ${t('background_scheduler_enable_hint')}`);
  } else {
    console.log(`  ${t('background_scheduler_disabled_summary')}`);
    console.log(`    ${t('background_scheduler_install_hint')}`);
  }
  // WorkBuddy has its OWN write scope beyond the generic workspace (SPEC
  // workbuddy-host-adapter §6): show exactly what will be written and when it
  // takes effect BEFORE the confirmation (install consent = informed consent).
  if (options.host === 'workbuddy') {
    const layout = getInstallLayoutPaths(getHomeDir());
    console.log('  WorkBuddy target host: WorkBuddy Desktop (settings.json + plugins registry)');
    console.log(`  PD-owned marketplace: ${path.join(layout.pdDir, 'workbuddy-marketplace')} (rewritten)`);
    console.log(`  Governance workspace: ${getWorkbuddyWorkspaceDir(getHomeDir(), process.env.WORKBUDDY_CONFIG_DIR)} (created if absent; NEVER deleted by uninstall)`);
    console.log('  Write scope: settings.json enabledPlugins entry, plugins/installed_plugins.json entry, plugin cache copy, ~/.pd/install.json host+workspace record');
    console.log('  Takes effect: NEW WorkBuddy sessions (or /reload-plugins). PD governance stays OFF until explicitly enabled.');
  }
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
  const language = cliOptions.language ?? await promptLanguage();
  setLanguage(language);

  // PRI-1278 Phase 5: prompt for host ADAPTER only (never implied by the
  // background-execution choice). No OpenClaw default.
  const host = cliOptions.host ?? await promptHost();

  // The host is only known NOW. The caller's detection is OpenClaw-oriented
  // when --host was not supplied, so re-derive for every other host before
  // showing the workspace default (PRI-1247 + Phase 5 'none').
  const detectionHost = host === 'all' ? 'openclaw' : host;
  const wsInfo = detectionHost === 'openclaw'
    ? (workspaceInfo || detectWorkspace({ host: 'openclaw' }))
    : detectWorkspace({ host: detectionHost });

  let { mode } = cliOptions;
  if (!mode) {
    const defaultMode = wsInfo.isFirstInstall ? 'force' : 'smart';

    if (!wsInfo.isFirstInstall && wsInfo.coreFiles && wsInfo.coreFiles.length > 0) {
      console.log(`\n${t('existing_core_files')} ${wsInfo.coreFiles.join(', ')}`);
      console.log(`  ${t('smart_mode_desc')}\n`);
    }

    mode = await promptInstallMode(defaultMode);
  }

  const workspaceSelection = cliOptions.workspaceDir !== undefined
    ? { workspaceDir: cliOptions.workspaceDir, explicit: true }
    : await promptWorkspace(wsInfo);

  showMvpCoreChannels();

  // Fix-4 (P0-BUG-4): collect LLM runtime profile after channels are shown,
  // before final confirmation. Skipped automatically in non-interactive mode
  // (caller passes runtimeProfile via cliOptions or leaves it undefined).
  const runtimeProfile = cliOptions.runtimeProfile !== undefined
    ? cliOptions.runtimeProfile
    : await promptRuntimeProfile();

  // PRI-1278 Phase 5: on a FRESH install the recommended default is "enable
  // the PD Service Host"; the operator is asked explicitly (default Yes) and
  // the answer is repeated in the final confirmation. An upgrade NEVER gets
  // this prompt — it keeps the existing registration/refresh semantics.
  const freshInstall = cliOptions.freshInstall === true;
  const explicitServiceHostChoice = cliOptions.enableServiceHost === true
    || cliOptions.registerServiceHost === true
    || cliOptions.disableServiceHost === true;
  let enableServiceHost = cliOptions.enableServiceHost === true;
  if (freshInstall && !explicitServiceHostChoice) {
    enableServiceHost = await promptServiceHost();
  }

  const options: InstallOptions = {
    language,
    mode,
    workspaceDir: workspaceSelection.workspaceDir,
    workspaceExplicit: workspaceSelection.explicit,
    channels: [...MVP_CHANNELS],
    overwriteConfig: false,
    host,
    runtimeProfile,
    stopGateway: cliOptions.stopGateway === true,
    freshInstall,
    enableServiceHost,
    registerServiceHost: cliOptions.registerServiceHost === true && !enableServiceHost,
    disableServiceHost: !enableServiceHost && cliOptions.disableServiceHost === true,
    serviceHost: enableServiceHost
      ? { intent: 'enable', source: explicitServiceHostChoice ? 'explicit_flag' : 'interactive_consent' }
      : cliOptions.registerServiceHost === true
        ? { intent: 'register_only', source: 'explicit_flag' }
        : !freshInstall
          ? { intent: 'refresh_if_registered', source: 'policy' }
          : { intent: 'opt_out', source: 'interactive_consent' },
  };

  const confirmed = await promptConfirm(options);
  if (!confirmed) {
    console.log(`\n${t('cancel_install')}\n`);
    return null;
  }

  return options;
}

export { confirm, input, select };
