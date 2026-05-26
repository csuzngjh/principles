import { select, confirm, input } from '@inquirer/prompts';
import * as path from 'path';
import * as os from 'os';
import { detectWorkspace, type WorkspaceInfo } from './utils/env.js';
import { MVP_CHANNELS, type MvpChannel } from './mvp-config.js';

export interface InstallOptions {
  language: 'zh' | 'en';
  mode: 'smart' | 'force';
  workspaceDir: string;
  channels: MvpChannel[];
  overwriteConfig: boolean;
}

async function promptLanguage(): Promise<'zh' | 'en'> {
  return await select({
    message: 'Select language / 选择语言',
    choices: [
      { name: 'English', value: 'en' as const },
      { name: '中文', value: 'zh' as const },
    ],
    default: 'en',
  });
}

async function promptInstallMode(defaultMode: 'smart' | 'force' = 'smart'): Promise<'smart' | 'force'> {
  return await select({
    message: 'Select install mode',
    choices: [
      {
        name: 'Smart merge — generate .update files to protect your changes',
        value: 'smart' as const,
        description: 'Recommended for updates: preserves your customizations',
      },
      {
        name: 'Force overwrite — replace all files to match template',
        value: 'force' as const,
        description: 'For first install or reset: overwrites existing files',
      },
    ],
    default: defaultMode,
  });
}

async function promptWorkspace(workspaceInfo: WorkspaceInfo): Promise<string> {
  const choices = [
    {
      name: `Use detected directory: ${workspaceInfo.detectedPath}`,
      value: 'detected' as const,
    },
    {
      name: 'Custom directory',
      value: 'custom' as const,
    },
  ];

  const selection = await select({
    message: `Workspace directory ${workspaceInfo.hasPrinciples ? '(Principles detected)' : ''}`,
    choices,
    default: 'detected',
  });

  if (selection === 'custom') {
    return await input({
      message: 'Enter workspace path',
      default: path.join(os.homedir(), 'clawd'),
      validate: (value) => {
        if (!value.trim()) return 'Path cannot be empty';
        return true;
      },
    });
  }

  return workspaceInfo.detectedPath;
}

function showMvpCoreChannels(): void {
  console.log('\nMVP-Core activation channels (always enabled, cannot be disabled):');
  for (const ch of MVP_CHANNELS) {
    const labels: Record<string, string> = {
      prompt: 'soft principle injection',
      code_tool_hook: 'RuleHost hard enforcement',
      defer_archive: 'graceful deferral',
    };
    console.log(`  ${ch} — ${labels[ch] ?? ''}`);
  }
  console.log();
}

async function promptConfirm(options: Partial<InstallOptions>): Promise<boolean> {
  console.log('\nInstall configuration:');
  console.log(`  Language: ${options.language}`);
  console.log(`  Mode: ${options.mode === 'force' ? 'force overwrite' : 'smart merge'}`);
  console.log(`  Workspace: ${options.workspaceDir}`);
  console.log(`  MVP-Core channels: ${MVP_CHANNELS.join(', ')} (always enabled)`);

  return await confirm({
    message: 'Confirm install?',
    default: true,
  });
}

export async function runPrompts(
  cliOptions: Partial<InstallOptions> = {},
  workspaceInfo?: WorkspaceInfo
): Promise<InstallOptions | null> {
  const wsInfo = workspaceInfo || detectWorkspace();

  const language = cliOptions.language ?? await promptLanguage();

  let { mode } = cliOptions;
  if (!mode) {
    const defaultMode = wsInfo.isFirstInstall ? 'force' : 'smart';

    if (!wsInfo.isFirstInstall && wsInfo.coreFiles && wsInfo.coreFiles.length > 0) {
      console.log(`\nExisting core files detected: ${wsInfo.coreFiles.join(', ')}`);
      console.log('  Smart merge mode recommended to protect your changes\n');
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
    return null;
  }

  return options;
}

export { confirm, input, select };
