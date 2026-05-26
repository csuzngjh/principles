import { DEFAULT_FEATURE_FLAGS } from '@principles/core/runtime-v2';
import * as yaml from 'js-yaml';
import * as path from 'path';

export const MVP_CHANNELS = ['prompt', 'code_tool_hook', 'defer_archive'] as const;
export type MvpChannel = (typeof MVP_CHANNELS)[number];

export const MVP_QUIET_FLAGS = ['gfi'] as const;
export const MVP_GONE_FLAGS = ['nocturnal', 'idle_trigger', 'model_training', 'trainer'] as const;

export interface ComponentStatus {
  plugin: 'verified' | 'failed' | 'skipped';
  cli: 'verified' | 'failed' | 'skipped';
  console: 'configured' | 'not_deliverable' | 'skipped';
  consoleEntrypoint?: string;
}

export interface VerificationResult {
  features: 'passed' | 'failed' | 'skipped';
  storyA: 'passed' | 'failed' | 'skipped';
  storyASkipReason?: string;
}

export interface InstallSuccessOutput {
  success: true;
  workspace: string;
  components: ComponentStatus;
  enabledChannels: MvpChannel[];
  verification: VerificationResult;
  nextAction: string;
}

export interface InstallFailureOutput {
  success: false;
  reason: string;
  nextAction: string;
  components?: Partial<ComponentStatus>;
  verification?: Partial<VerificationResult>;
}

export type InstallOutput = InstallSuccessOutput | InstallFailureOutput;

export function generateFeatureFlagsYamlContent(channels?: string[]): string {
  const enabledSet = new Set<string>(channels ?? MVP_CHANNELS);
  const flags: Record<string, { enabled: boolean; category: string; since: string; description?: string }> = {};

  for (const flag of DEFAULT_FEATURE_FLAGS) {
    const isEnabled = enabledSet.has(flag.id);
    flags[flag.id] = {
      enabled: isEnabled,
      category: flag.category,
      since: flag.since,
    };
    if (flag.description) {
      flags[flag.id].description = flag.description;
    }
  }

  return yaml.dump(flags, { lineWidth: -1, quotingType: '"' });
}

export function validateMvpChannels(channels: unknown): {
  valid: MvpChannel[];
  unknowns: string[];
} {
  if (!Array.isArray(channels)) {
    return { valid: [], unknowns: [] };
  }

  const mvpSet = new Set<string>(MVP_CHANNELS);
  const valid: MvpChannel[] = [];
  const unknowns: string[] = [];

  for (const ch of channels) {
    if (typeof ch !== 'string') continue;
    if (mvpSet.has(ch)) {
      valid.push(ch as MvpChannel);
    } else {
      unknowns.push(ch);
    }
  }

  return { valid, unknowns };
}

export function parseChannelsOption(raw: unknown): { channels: MvpChannel[]; unknowns: string[]; error?: string } {
  if (raw == null) {
    return { channels: [...MVP_CHANNELS], unknowns: [] };
  }
  if (typeof raw !== 'string') {
    return { channels: [], unknowns: [], error: `--channels expects a string, got ${typeof raw}` };
  }
  if (raw.trim().length === 0) {
    return { channels: [...MVP_CHANNELS], unknowns: [] };
  }
  const parsed = raw.split(',').map((f: string) => f.trim().toLowerCase()).filter(Boolean);
  const { valid, unknowns } = validateMvpChannels(parsed);
  if (valid.length === 0 && parsed.length > 0) {
    return { channels: [], unknowns, error: `All specified channels are invalid: "${raw}". Valid MVP channels: ${MVP_CHANNELS.join(', ')}` };
  }
  return { channels: valid, unknowns };
}

export function validateOpenClawConfig(config: unknown): { valid: boolean; error?: string } {
  if (config == null) return { valid: true };
  if (typeof config !== 'object' || Array.isArray(config)) {
    return { valid: false, error: 'openclaw.json root must be an object' };
  }
  const obj = config as Record<string, unknown>;
  if (Object.hasOwn(obj, 'plugins')) {
    const { plugins } = obj;
    if (plugins == null) return { valid: true };
    if (typeof plugins !== 'object' || Array.isArray(plugins)) {
      return { valid: false, error: 'openclaw.json plugins must be an object' };
    }
    const pluginsObj = plugins as Record<string, unknown>;
    const { allow, entries, installs } = pluginsObj;
    if (allow !== undefined) {
      if (!Array.isArray(allow)) {
        return { valid: false, error: 'openclaw.json plugins.allow must be an array' };
      }
      for (const elem of allow as unknown[]) {
        if (typeof elem !== 'string') {
          return { valid: false, error: 'openclaw.json plugins.allow contains non-string elements' };
        }
      }
    }
    if (entries !== undefined) {
      if (typeof entries !== 'object' || entries === null || Array.isArray(entries)) {
        return { valid: false, error: 'openclaw.json plugins.entries must be an object' };
      }
    }
    if (installs !== undefined) {
      if (typeof installs !== 'object' || installs === null || Array.isArray(installs)) {
        return { valid: false, error: 'openclaw.json plugins.installs must be an object' };
      }
    }
  }
  return { valid: true };
}

export interface BuildOutputOptions {
  workspace: string;
  components: ComponentStatus;
  channels: MvpChannel[];
  verification: VerificationResult;
}

export function buildSuccessOutput(opts: BuildOutputOptions): InstallOutput {
  const { workspace, components, channels, verification } = opts;
  const isComplete = components.plugin === 'verified' && components.cli === 'verified' && components.console === 'configured';
  const nextActions: string[] = [];
  if (components.cli === 'verified') {
    nextActions.push('Run "pd runtime canary --workspace <path> --json" for diagnostics');
  }
  if (components.console === 'configured' && components.consoleEntrypoint) {
    nextActions.push(`Open review console: ${components.consoleEntrypoint}`);
  }
  if (components.console === 'not_deliverable') {
    nextActions.push('Owner review console is not yet deliverable — see release-blocking follow-up issue');
  }

  if (isComplete) {
    return {
      success: true as const,
      workspace,
      components,
      enabledChannels: channels,
      verification,
      nextAction: nextActions.join(' | '),
    };
  }
  return {
    success: false as const,
    reason: 'owner_review_console_not_deliverable',
    nextAction: nextActions.join(' | '),
    components,
    verification,
  };
}

export function buildFailureOutput(reason: string, nextAction: string): InstallFailureOutput {
  return {
    success: false,
    reason,
    nextAction,
  };
}

export function getFeatureFlagsPath(workspaceDir: string): string {
  return path.join(workspaceDir, '.pd', 'feature-flags.yaml');
}

export function isMvpChannel(value: string): value is MvpChannel {
  return (MVP_CHANNELS as readonly string[]).includes(value);
}

export function getHomeDir(): string {
  return process.env.HOME
    || process.env.USERPROFILE
    || (process.env.HOMEDRIVE && process.env.HOMEPATH ? process.env.HOMEDRIVE + process.env.HOMEPATH : null)
    || '.';
}

export function getOpenClawDir(): string {
  return path.join(getHomeDir(), '.openclaw');
}

export function getPluginExtDir(): string {
  return path.join(getOpenClawDir(), 'extensions', 'principles-disciple');
}

export function getInstalledPdCliDir(): string {
  return path.join(getPluginExtDir(), 'pd-cli');
}

export function getInstalledBinDir(): string {
  return path.join(getPluginExtDir(), 'bin');
}

export function isWindows(): boolean {
  return process.platform === 'win32';
}
