import * as yaml from 'js-yaml';
import * as path from 'path';
import { existsSync, readFileSync } from 'fs';
import { execSync } from 'child_process';
import { errnoCode } from './utils/config-file-io.js';
export const MVP_CHANNELS = ['prompt', 'code_tool_hook', 'defer_archive'] as const;
export type MvpChannel = (typeof MVP_CHANNELS)[number];

export const MVP_QUIET_FLAGS = ['gfi'] as const;
export const MVP_GONE_FLAGS = ['nocturnal', 'idle_trigger'] as const;

/**
 * Product-level feedback defaults (PRI-543). The PD 控制台的"意见反馈"收集的是
 * 使用者对 PD 产品的功能建议 / Bug,接收者是 PD 项目所有者,而非使用者自己。
 * 因此 installer 生成的默认 config 预置:
 * - `maintainer_email`:产品所有者的邮箱(兜底邮箱通道发到这里)。
 * - `ingest_url` + `ingest_token`:主通道,让新装使用者开箱即可把反馈经 Cloudflare
 *   relay 落到所有者的 Linear,无需使用者自行配置。
 *
 * `ingest_token` 是随发布版分发的固定"产品公共令牌",按 spec §9.2 属反滥用边界
 * (非安全边界),靠 relay 端 IP 限流兜底。改动此值必须同步更新 Cloudflare Pages
 * secret `INGEST_TOKEN` 为同一值,并更新 `packages/website` 端 relay 的校验常量;
 * 同时保持与 `tests/mvp-config.test.ts` 的断言一致(spec §10 双点同步)。
 */
export const PRODUCT_FEEDBACK_MAINTAINER_EMAIL = 'csuzngjh@hotmail.com';
export const PRODUCT_FEEDBACK_INGEST_URL = 'https://principles-website.pages.dev/api/feedback';
export const PRODUCT_FEEDBACK_INGEST_TOKEN = 'pd_prod_pdxk4of3grc9vws2uz7te8iy'; // gitleaks:allow — 产品公共 ingest 令牌,spec §9.2 反滥用边界,非安全边界(随发布分发)

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
  /** Task 8: when the installer auto-launches the console via `pd console open`,
   * this holds the URL the browser was opened to (ends with /welcome). Undefined
   * when auto-launch was not performed or failed. */
  consoleUrl?: string;
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
  /** Task 8: URL the browser was opened to when the installer auto-launched the
   * console. When provided and the install is complete, the success output's
   * nextAction references this URL instead of the manual "pd console" instruction. */
  consoleUrl?: string;
}

export function buildSuccessOutput(opts: BuildOutputOptions): InstallOutput {
  const { workspace, components, channels, verification, consoleUrl } = opts;
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
    // Task 8: when the installer auto-launched the console (consoleUrl set),
    // point the user at the live URL instead of the manual start instruction.
    // EP-03: when consoleUrl is absent, keep the manual instruction so the
    // user is never left without a way to reach the console.
    if (consoleUrl) {
      nextActions.push(`Console ready at ${consoleUrl} (browser opened automatically)`);
    } else {
      nextActions.push('Start console: pd console --workspace <path> --no-auth (listens on 127.0.0.1 only)');
    }
  }

  if (isComplete) {
    return {
      success: true as const,
      workspace,
      components,
      enabledChannels: channels,
      verification,
      nextAction: nextActions.join(' | '),
      consoleUrl,
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

/** Host-neutral PD installation root. Shared runtime must not live under a
 * host's discovery directory (ADR-0020 / ERR-097). */
export function getPdDir(): string {
  return path.join(getHomeDir(), '.pd');
}

export function getPdRuntimeDir(): string {
  return path.join(getPdDir(), 'runtime');
}

export function getInstallManifestPath(): string {
  return path.join(getPdDir(), 'install.json');
}

export function getPdRuntimeBackupsDir(): string {
  return path.join(getPdDir(), 'backups');
}

export function getPluginExtDir(): string {
  return path.join(getOpenClawDir(), 'extensions', 'principles-disciple');
}

/** Common plugin package used by pd-cli/console. OpenClaw gets an adapter copy
 * under getPluginExtDir(); Codex-only installs use this host-neutral copy. */
export function getInstalledPluginDir(): string {
  return path.join(getPdRuntimeDir(), 'plugin');
}

export function getInstalledLayoutPackageDir(): string {
  return path.join(getPdRuntimeDir(), 'install-layout');
}

/**
 * PD 备份根目录（~/.openclaw/pd-backups）—— 必须位于 extensions/ 之外。
 * OpenClaw 插件发现会扫描 extensions/ 下每个子目录；备份目录内含
 * package.json(openclaw.extensions) + dist/bundle.js 时会被识别为第二个
 * principles-disciple 插件，导致每次 gateway 启动都出现
 * "duplicate plugin id detected" 告警。备份一律放这里，禁止放 extensions/ 内。
 */
export function getPdBackupsDir(): string {
  return path.join(getOpenClawDir(), 'pd-backups');
}

export function getInstalledPdCliDir(): string {
  return path.join(getPdRuntimeDir(), 'pd-cli');
}

export function getInstalledBinDir(): string {
  return path.join(getPdRuntimeDir(), 'bin');
}

export function getInstalledConsoleDir(): string {
  return path.join(getPdRuntimeDir(), 'console');
}

export function isWindows(): boolean {
  return process.platform === 'win32';
}

/**
 * Fix-4 (P0-BUG-4): Optional runtime profile input collected by the installer
 * prompt flow. When provided, the generated config.yaml's `pd.default` profile
 * is pre-filled instead of left empty, so LLM-dependent features (diagnose,
 * candidate intake, internalization) work on first run instead of failing
 * silently (rc-9: no silent fallback).
 *
 * All fields optional — if undefined, the corresponding config field stays
 * empty (backward compatible with the previous behavior).
 */
export interface RuntimeProfileInput {
  provider?: string;
  model?: string;
  apiKeyEnv?: string;
}

/**
 * PRI-308: Generate .pd/config.yaml content.
 *
 * This replaces the old feature-flags.yaml generation.
 * The config.yaml follows the PdConfig schema from principles-core
 * (pd-config-types.ts), inlined to avoid a runtime dependency.
 *
 * Fix-4 (P0-BUG-4): `runtimeProfile` optional parameter — when provided,
 * the `pd.default` profile is pre-filled with user-supplied values instead
 * of being left empty. Empty profile causes LLM features to fail silently.
 *
 * PRI-543 (slice 5): `maintainerEmail` optional parameter — when provided,
 * it pre-fills `feedback.maintainer_email` so the email fallback channel uses
 * a real address instead of the loader's placeholder. Added so the config
 * template and pd-config-store stay in sync (spec §10 double-sync).
 */
export function generateConfigYamlContent(
  runtimeProfile?: RuntimeProfileInput,
  maintainerEmail?: string,
): string {
  const config: Record<string, unknown> = {
    version: 1,
    // PRI-645: the feature registry (principles-core feature-flag-contract.ts)
    // owns ALL default values. A fresh config records only explicit intent —
    // an empty map means "every flag follows its registry default", which the
    // effective resolver (computeEffectivePdConfig) fills at read time. Do NOT
    // add registry-default-equivalent entries here: a default snapshot would
    // freeze today's defaults against future graduation flips and re-create
    // the DEFAULT_FEATURE_FLAGS duplicate this file must not own. If a fresh
    // install ever needs a deliberate bootstrap override (value differing from
    // the registry default), document the product/safety reason inline — the
    // core-side installer-config-parity contract test enforces registration +
    // non-default value for any entry added here.
    features: {},
    runtimeProfiles: {
      // M9 default: pi-ai profile. Fix-4: when the installer collected
      // provider/model/apiKeyEnv from the user, pre-fill them here so
      // LLM-dependent features work on first run. Otherwise leave empty
      // (user must configure via web console).
      'pd.default': {
        type: 'pi-ai',
        provider: runtimeProfile?.provider ?? '',
        model: runtimeProfile?.model ?? '',
        apiKeyEnv: runtimeProfile?.apiKeyEnv ?? '',
      },
      // Fallback: openclaw.default delegates LLM calls to the OpenClaw main
      // agent. Users can switch back via web console if pi-ai is unavailable.
      'openclaw.default': {
        type: 'openclaw',
        source: 'default',
      },
    },
    internalAgents: {
      defaultRuntime: 'pd.default',
      agents: {
        diagnostician:     { enabled: true,  runtimeProfile: 'pd.default' },
        dreamer:           { enabled: true,  runtimeProfile: 'pd.default' },
        philosopher:       { enabled: false, runtimeProfile: 'pd.default' },
        scribe:            { enabled: true,  runtimeProfile: 'pd.default' },
        artificer:         { enabled: true,  runtimeProfile: 'pd.default' },
        evaluator:         { enabled: false, runtimeProfile: 'pd.default' },
        rolloutReviewer:   { enabled: false, runtimeProfile: 'pd.default' },
        correctionObserver:{ enabled: false, runtimeProfile: 'pd.default' },
        empathyObserver:   { enabled: false, runtimeProfile: 'pd.default' },
        signalCollector:   { enabled: false, runtimeProfile: 'pd.default' },
      },
    },
    ui: {
      diagnostics: { mode: 'simple' },
    },
    // PRI-543 feedback submit → config double-sync (spec §10). These channel
    // params MUST mirror what pd-config-store reads (feedback.maintainer_email
    // + feedback.ingest_url / ingest_token / github_repo / github_proxy). The
    // installer writes this segment so a fresh workspace always carries it.
    // 产品反馈接收者是 PD 项目所有者:maintainer_email 默认=所有者邮箱;ingest_url
    // / ingest_token 预置产品公共主通道(新装使用者开箱即可把反馈直送所有者 Linear,
    // 无需使用者配置)。github 通道默认留空(需使用者按需配置 gh)。
    feedback: {
      maintainer_email: maintainerEmail ?? PRODUCT_FEEDBACK_MAINTAINER_EMAIL,
      ingest_url: PRODUCT_FEEDBACK_INGEST_URL,
      ingest_token: PRODUCT_FEEDBACK_INGEST_TOKEN,
      github_repo: '',
      github_proxy: '',
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
 * PRI-645: structural validation of an existing config.yaml the installer is
 * about to preserve (PRI-308 preserve contract).
 *
 * The PRI-523 migration that used to live here (adding `host.codex` /
 * `abstraction_layer_v1` to existing configs) is retired: both entries were
 * exactly registry defaults, and writing them re-created the default snapshot
 * PRI-645 removes. Effective values never depended on those entries — the
 * registry (DEFAULT_FEATURE_FLAGS) resolves both at read time — so retiring
 * the write changes representation only, never behavior. Existing configs are
 * now preserved verbatim: no normalization, no cleanup (source=system is an
 * origin hint, not an auto-delete license — PRI-637).
 */
export class ExistingConfigVerifyInfraError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'ExistingConfigVerifyInfraError';
  }
}

export function validateExistingConfigYamlForPreserve(workspaceDir: string): void {
  try {
    validateConfigYamlFull(workspaceDir);
  } catch (error) {
    // Infrastructure failure reading the file (EPERM/EBUSY/...): the config is
    // NOT necessarily malformed — callers must not advise deleting it. Contrast
    // with validation errors thrown by validateConfigYamlFull itself, which do
    // indicate a malformed config (PRI-523 review finding preserved).
    if (typeof errnoCode(error) === 'string') {
      const message = error instanceof Error ? error.message : String(error);
      throw new ExistingConfigVerifyInfraError(message, { cause: error });
    }
    throw error;
  }
}

/**
 * PRI-308: Read the ENABLED MVP channels from .pd/config.yaml.
 *
 * PRI-645: computed with sparse/effective semantics, not raw presence —
 * the MVP channels are registered core capabilities whose registry default
 * is ON and which cannot be disabled by omission (PRI-435), so:
 *   entry absent            → enabled (follows registry default)
 *   entry { enabled: true }  → enabled
 *   entry { enabled: false } → disabled (explicit Owner override)
 * A present-but-malformed entry still fails loud (rc-3).
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
    if (!Object.hasOwn(features, key)) {
      // Absence ≠ disabled: the registry default (ON, core) applies — the
      // sparse fresh config is the normal PRI-645 shape.
      enabled.push(key);
      continue;
    }
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
