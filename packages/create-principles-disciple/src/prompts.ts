import { select, confirm, input } from '@inquirer/prompts';
import * as path from 'path';
import * as os from 'os';
import { detectWorkspace, type WorkspaceInfo } from './utils/env.js';
import { MVP_CHANNELS, type MvpChannel } from './mvp-config.js';
import { setLanguage, getLanguage, t, type Language } from './i18n.js';

export interface InstallOptions {
  language: Language;
  mode: 'smart' | 'force';
  workspaceDir: string;
  channels: MvpChannel[];
  overwriteConfig: boolean;
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
  console.log(`  ${t('mode')}: ${options.mode === 'force' ? t('force_overwrite') : t('smart_merge')}`);
  console.log(`  ${t('workspace')}: ${options.workspaceDir}`);
  console.log(`  ${t('mvp_channels_enabled')}: ${MVP_CHANNELS.join(', ')}`);

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

  const options: InstallOptions = {
    language,
    mode,
    workspaceDir,
    channels: [...MVP_CHANNELS],
    overwriteConfig: false,
  };

  const confirmed = await promptConfirm(options);
  if (!confirmed) {
    console.log(`\n${t('cancel_install')}\n`);
    return null;
  }

  return options;
}

export { confirm, input, select };
