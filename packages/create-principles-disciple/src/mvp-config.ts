import * as yaml from 'js-yaml';
import * as path from 'path';
import { existsSync, readFileSync } from 'fs';
import { execSync } from 'child_process';

export const MVP_CHANNELS = ['prompt', 'code_tool_hook', 'defer_archive'] as const;
export type MvpChannel = (typeof MVP_CHANNELS)[number];

export const MVP_QUIET_FLAGS = ['gfi'] as const;
export const MVP_GONE_FLAGS = ['nocturnal', 'idle_trigger'] as const;

export interface ComponentStatus {
  plugin: 'verified' | 'failed' | 'skipped';
  cli: 'verified' | 'verified_local_only' | 'failed' | 'skipped';
  console: 'configured' | 'skipped';
  consoleEntrypoint?: string;
  cliLocalPath?: string;
}

export interface VerificationResult {
  features: 'passed' | 'failed' | 'skipped';
  storyA: 'passed' | 'failed' | 'skipped';
  storyASkipReason?: string;
  manifestActivation?: 'verified' | 'missing_hook' | 'missing_setup_entry' | 'skipped';
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
  const channelSet = new Set<string>(valid);
  for (const core of MVP_CHANNELS) {
    channelSet.add(core);
  }
  const channels = [...MVP_CHANNELS].filter(ch => channelSet.has(ch));
  return { channels, unknowns };
}

export function validateOpenClawConfig(config: unknown): { valid: boolean; error?: string } {
  if (config === undefined) return { valid: true };
  if (config === null) return { valid: false, error: 'openclaw.json exists but parsed as null — expected a non-null object' };
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
  const cliWorking = components.cli === 'verified' || components.cli === 'verified_local_only';
  const isComplete = components.plugin === 'verified' && cliWorking && components.console === 'configured';
  const nextActions: string[] = [];
  if (components.cli === 'verified') {
    nextActions.push('Run pd runtime canary --workspace <path> --json for diagnostics');
  } else if (components.cli === 'verified_local_only' && components.cliLocalPath) {
    const quotedPath = components.cliLocalPath.includes(' ') ? `"${components.cliLocalPath}"` : components.cliLocalPath;
    nextActions.push(`Run ${quotedPath} runtime canary --workspace <path> --json for diagnostics (global pd not on PATH)`);
  }
  if (components.console === 'configured') {
    nextActions.push('Start console: pd console --workspace <path> --no-auth (listens on 127.0.0.1 only)');
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

  const failureReasons: string[] = [];
  if (components.plugin !== 'verified') {
    failureReasons.push(`plugin_${components.plugin}`);
  }
  if (!cliWorking) {
    failureReasons.push(`cli_${components.cli}`);
  }
  if (components.console !== 'configured') {
    failureReasons.push(`console_${components.console}`);
  }
  const reason = failureReasons.length > 0 ? failureReasons.join(',') : 'incomplete_install';

  return {
    success: false as const,
    reason,
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

export function getInstalledConsoleDir(): string {
  return path.join(getPluginExtDir(), 'console');
}

export function isWindows(): boolean {
  return process.platform === 'win32';
}

/**
 * PRI-308: Generate .pd/config.yaml content.
 *
 * This replaces the old feature-flags.yaml generation.
 * The config.yaml follows the PdConfig schema from principles-core
 * (pd-config-types.ts), inlined to avoid a runtime dependency.
 */
export function generateConfigYamlContent(): string {
  const config: Record<string, unknown> = {
    version: 1,
    features: {
      // MVP-Core (ADR-0014 §2.4)
      prompt:             { category: 'core',  enabled: true },
      code_tool_hook:     { category: 'core',  enabled: true },
      defer_archive:      { category: 'core',  enabled: true },
      // PRI-435: Code-rule capability promoted to MVP-Core, default ON.
      code_rule_capability: { category: 'core', enabled: true },
      // MVP-Quiet (ADR-0014 §2.5)
      correction_observer:{ category: 'quiet', enabled: false },
      feedback_channel:   { category: 'quiet', enabled: true },
      gfi:                { category: 'quiet', enabled: false },
      evolution_worker:   { category: 'quiet', enabled: false },
      empathy_observer:   { category: 'quiet', enabled: false },
      // MVP-Gone (ADR-0014 §2.6)
      nocturnal:          { category: 'gone',  enabled: false },
      idle_trigger:       { category: 'gone',  enabled: false },
    },
    runtimeProfiles: {
      'openclaw.default': {
        type: 'openclaw',
        source: 'default',
      },
    },
    internalAgents: {
      defaultRuntime: 'openclaw.default',
      agents: {
        diagnostician:     { enabled: true,  runtimeProfile: 'openclaw.default' },
        dreamer:           { enabled: true,  runtimeProfile: 'openclaw.default' },
        philosopher:       { enabled: false, runtimeProfile: 'openclaw.default' },
        scribe:            { enabled: true,  runtimeProfile: 'openclaw.default' },
        artificer:         { enabled: true,  runtimeProfile: 'openclaw.default' },
        evaluator:         { enabled: false, runtimeProfile: 'openclaw.default' },
        rolloutReviewer:   { enabled: false, runtimeProfile: 'openclaw.default' },
        correctionObserver:{ enabled: false, runtimeProfile: 'openclaw.default' },
        empathyObserver:   { enabled: false, runtimeProfile: 'openclaw.default' },
      },
    },
    ui: {
      diagnostics: { mode: 'simple' },
    },
  };

  return yaml.dump(config, { lineWidth: -1, quoteStyle: 'double' });
}

/**
 * PRI-308: Get the path to .pd/config.yaml for a workspace.
 */
export function getConfigYamlPath(workspaceDir: string): string {
  return path.join(workspaceDir, '.pd', 'config.yaml');
}

/**
 * PRI-308: Full structural validation of .pd/config.yaml.
 *
 * Checks all required top-level sections (version, features, runtimeProfiles,
 * internalAgents) exist and have correct types. This is a lightweight structural
 * check — deep field validation is done by validatePdConfig() in principles-core.
 *
 * Used by the installer to decide whether an existing config.yaml is safe to
 * preserve. A config missing runtimeProfiles/internalAgents would cause runtime
 * failures, so it must be rejected.
 *
 * Throws on any structural problem with reason + nextAction.
 */
export function validateConfigYamlFull(workspaceDir: string): void {
  const configPath = getConfigYamlPath(workspaceDir);
  if (!existsSync(configPath)) {
    throw new Error(`config.yaml not found at ${configPath}. This should not happen during preserve-existing validation.`);
  }

  const rawYaml = readFileSync(configPath, 'utf-8');
  const parsed: unknown = (() => {
    try {
      return yaml.load(rawYaml);
    } catch (e) {
      throw new Error(`config.yaml parse error at ${configPath}: ${e instanceof Error ? e.message : String(e)}. Delete the file and re-run the installer.`, { cause: e });
    }
  })();

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`config.yaml at ${configPath} has invalid structure (expected object, got ${Array.isArray(parsed) ? 'array' : typeof parsed}). Delete the file and re-run the installer.`);
  }

  const config = parsed as Record<string, unknown>;

  // version — must be number 1
  if (!Object.hasOwn(config, 'version') || typeof config.version !== 'number' || config.version !== 1) {
    throw new Error(`config.yaml at ${configPath}: 'version' must be 1, got ${!Object.hasOwn(config, 'version') ? 'missing' : config.version}. Delete the file and re-run the installer.`);
  }

  // features — must be non-null object
  if (!Object.hasOwn(config, 'features') || typeof config.features !== 'object' || config.features === null || Array.isArray(config.features)) {
    throw new Error(`config.yaml at ${configPath}: 'features' must be an object, got ${!Object.hasOwn(config, 'features') ? 'missing' : Array.isArray(config.features) ? 'array' : typeof config.features}. Delete the file and re-run the installer.`);
  }

  // MVP channels must have valid entries
  const features = config.features as Record<string, unknown>;
  for (const key of MVP_CHANNELS) {
    if (!Object.hasOwn(features, key)) continue;
    const value = features[key];
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new Error(`config.yaml at ${configPath}: MVP channel '${key}' has invalid entry (expected object, got ${value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value}). Delete the file and re-run the installer.`);
    }
    const flag = value as Record<string, unknown>;
    if (!Object.hasOwn(flag, 'enabled') || typeof flag.enabled !== 'boolean') {
      throw new Error(`config.yaml at ${configPath}: MVP channel '${key}' has invalid 'enabled' field. Delete the file and re-run the installer.`);
    }
  }

  // runtimeProfiles — must be non-null object
  if (!Object.hasOwn(config, 'runtimeProfiles') || typeof config.runtimeProfiles !== 'object' || config.runtimeProfiles === null || Array.isArray(config.runtimeProfiles)) {
    throw new Error(`config.yaml at ${configPath}: 'runtimeProfiles' must be an object, got ${!Object.hasOwn(config, 'runtimeProfiles') ? 'missing' : Array.isArray(config.runtimeProfiles) ? 'array' : typeof config.runtimeProfiles}. Delete the file and re-run the installer.`);
  }

  // internalAgents — must be non-null object with defaultRuntime
  if (!Object.hasOwn(config, 'internalAgents') || typeof config.internalAgents !== 'object' || config.internalAgents === null || Array.isArray(config.internalAgents)) {
    throw new Error(`config.yaml at ${configPath}: 'internalAgents' must be an object, got ${!Object.hasOwn(config, 'internalAgents') ? 'missing' : Array.isArray(config.internalAgents) ? 'array' : typeof config.internalAgents}. Delete the file and re-run the installer.`);
  }
  const agents = config.internalAgents as Record<string, unknown>;
  if (!Object.hasOwn(agents, 'defaultRuntime') || typeof agents.defaultRuntime !== 'string' || agents.defaultRuntime.length === 0) {
    throw new Error(`config.yaml at ${configPath}: 'internalAgents.defaultRuntime' must be a non-empty string, got ${!Object.hasOwn(agents, 'defaultRuntime') ? 'missing' : typeof agents.defaultRuntime}. Delete the file and re-run the installer.`);
  }
}

/**
 * PRI-308: Read enabled MVP channels from .pd/config.yaml.
 *
 * Fail-loud: throws on malformed or missing required fields.
 * Returns empty array if file does not exist (first install).
 */
export function readEnabledChannelsFromConfigYaml(workspaceDir: string): string[] {
  const configPath = getConfigYamlPath(workspaceDir);
  if (!existsSync(configPath)) return [];

  const rawYaml = readFileSync(configPath, 'utf-8');
  const parsed: unknown = (() => {
    try {
      return yaml.load(rawYaml);
    } catch (e) {
      throw new Error(`config.yaml parse error at ${configPath}: ${e instanceof Error ? e.message : String(e)}. Delete the file and re-run the installer.`, { cause: e });
    }
  })();

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`config.yaml at ${configPath} has invalid structure (expected object, got ${Array.isArray(parsed) ? 'array' : typeof parsed}). Delete the file and re-run the installer.`);
  }

  const configObj = parsed as Record<string, unknown>;

  if (!Object.hasOwn(configObj, 'features') || typeof configObj.features !== 'object' || configObj.features === null || Array.isArray(configObj.features)) {
    throw new Error(`config.yaml at ${configPath} is missing or has invalid 'features' field. Delete the file and re-run the installer.`);
  }

  const features = configObj.features as Record<string, unknown>;
  const enabled: string[] = [];

  for (const key of MVP_CHANNELS) {
    if (!Object.hasOwn(features, key)) continue;
    const value = features[key];
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new Error(`config.yaml at ${configPath}: MVP channel '${key}' has invalid entry (expected object, got ${value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value}). Delete the file and re-run the installer.`);
    }
    const flag = value as Record<string, unknown>;
    if (!Object.hasOwn(flag, 'enabled')) {
      throw new Error(`config.yaml at ${configPath}: MVP channel '${key}' is missing required 'enabled' field. Delete the file and re-run the installer.`);
    }
    if (typeof flag.enabled !== 'boolean') {
      throw new Error(`config.yaml at ${configPath}: MVP channel '${key}' has invalid 'enabled' value (expected boolean, got ${flag.enabled === null ? 'null' : typeof flag.enabled}). Delete the file and re-run the installer.`);
    }
    if (flag.enabled === true) {
      enabled.push(key);
    }
  }

  return enabled;
}

/**
 * 获取 npm global bin 目录路径
 */
export function getNpmGlobalBinDir(): string | null {
  try {
    const prefix = execSync('npm prefix -g', { encoding: 'utf-8', stdio: 'pipe' }).trim();
    if (!prefix) return null;
    return isWindows() ? prefix : path.join(prefix, 'bin');
  } catch {
    return null;
  }
}

/**
 * 获取所有可能的全局 pd shim 文件路径
 */
export function getGlobalShimPaths(): string[] {
  const globalBin = getNpmGlobalBinDir();
  if (!globalBin) return [];

  if (isWindows()) {
    return [
      path.join(globalBin, 'pd.cmd'),
      path.join(globalBin, 'pd.ps1'),
    ];
  } else {
    return [path.join(globalBin, 'pd')];
  }
}
