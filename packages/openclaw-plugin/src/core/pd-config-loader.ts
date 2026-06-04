/**
 * PD Config Loader (Plugin I/O boundary) — PRI-307
 *
 * Reads `.pd/config.yaml`, validates via core, computes effective config.
 * Replaces the old `.pd/feature-flags.yaml` and `.state/workflows.yaml` reading
 * for plugin production paths.
 *
 * ADR-0016: PD owns exactly one user config file.
 * - Missing config → defaults with nextAction
 * - Malformed config → fail loud with errors and nextAction
 * - No secrets in output
 * - Observer disabled → no start / no noisy log cycling
 * - Observer enabled + missing setup → structured needs_setup + nextAction
 */

import * as fs from 'fs';
import * as path from 'path';
import yaml from 'js-yaml';
import {
  validatePdConfig,
  computeEffectivePdConfig,
  computeFeatureFlagsFromConfig,
  INTERNAL_AGENT_NAMES,
} from '@principles/core/runtime-v2';
import type {
  EffectivePdConfig,
  PdConfigValidationResult,
  InternalAgentName,
} from '@principles/core/runtime-v2';

// ── Constants ────────────────────────────────────────────────────────────────

export const PD_CONFIG_DIR = '.pd';
export const PD_CONFIG_FILENAME = 'config.yaml';

// ── Types ────────────────────────────────────────────────────────────────────

export type ObserverReadiness = 'disabled' | 'needs_setup' | 'ready' | 'not_ready' | 'config_malformed';

export interface ObserverConfigResult {
  /** Whether the observer feature is enabled in config */
  enabled: boolean;
  /** Observer readiness state */
  readiness: ObserverReadiness;
  /** Config source: 'defaults' | 'user_config' | 'malformed' */
  source: string;
  /** Reason for current state */
  reason: string;
  /** What the user should do next */
  nextAction: string;
  /** The runtime profile ID for this observer, if configured */
  runtimeProfileId: string | null;
  /** The runtime profile type, if configured */
  runtimeProfileType: string | null;
  /** The apiKeyEnv for the runtime profile, if applicable */
  apiKeyEnv: string | null;
  /** Whether the apiKeyEnv is present in process.env */
  apiKeyPresent: boolean;
  /** Provider name from runtime profile */
  provider: string | null;
  /** Model name from runtime profile */
  model: string | null;
  /** Timeout from runtime profile */
  timeoutMs: number | null;
  /** Base URL from runtime profile */
  baseUrl: string | null;
  /** Config validation errors (only present when readiness=config_malformed) */
  configErrors?: Array<{ path: string; reason: string; nextAction: string }>;
}

export interface PluginConfigLoadResult {
  ok: boolean;
  effective: EffectivePdConfig;
  source: 'defaults' | 'user_config' | 'malformed';
  configPath: string;
  warnings: string[];
  errors: Array<{ path: string; reason: string; nextAction: string }>;
}

// ── Config Path ──────────────────────────────────────────────────────────────

export function getPdConfigPath(workspaceDir: string): string {
  return path.join(workspaceDir, PD_CONFIG_DIR, PD_CONFIG_FILENAME);
}

// ── Load PD Config ───────────────────────────────────────────────────────────

/**
 * Load and validate `.pd/config.yaml` from the workspace.
 * Never throws on malformed input. Always provides a usable fallback.
 */
export function loadPdConfigForPlugin(workspaceDir: string): PluginConfigLoadResult {
  const configPath = getPdConfigPath(workspaceDir);

  // 1) Config file missing → use defaults
  if (!fs.existsSync(configPath)) {
    const effective = computeEffectivePdConfig(null);
    return {
      ok: true,
      effective,
      source: 'defaults',
      configPath,
      warnings: effective.warnings,
      errors: [],
    };
  }

  // 2) Read the file
  let raw: string;
  try {
    raw = fs.readFileSync(configPath, 'utf8');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const effective = computeEffectivePdConfig(null);
    return {
      ok: false,
      effective,
      source: 'malformed',
      configPath,
      warnings: [],
      errors: [{ path: '', reason: `Failed to read .pd/config.yaml: ${message}`, nextAction: 'Check file permissions for .pd/config.yaml' }],
    };
  }

  // 3) Parse YAML — treat as unknown (ERR-001)
  let parsed: unknown;
  try {
    parsed = yaml.load(raw, { schema: yaml.JSON_SCHEMA });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const effective = computeEffectivePdConfig(null);
    return {
      ok: false,
      effective,
      source: 'malformed',
      configPath,
      warnings: [],
      errors: [{ path: '', reason: `YAML parse error in .pd/config.yaml: ${message}`, nextAction: 'Fix YAML syntax in .pd/config.yaml' }],
    };
  }

  // 4) Validate via core (ERR-001, ERR-005: no `as` bypasses)
  const validationResult: PdConfigValidationResult = validatePdConfig(parsed);

  if (!validationResult.ok) {
    const effective = computeEffectivePdConfig(null);
    return {
      ok: false,
      effective,
      source: 'malformed',
      configPath,
      warnings: [],
      errors: validationResult.errors.map(e => ({
        path: e.path,
        reason: e.reason,
        nextAction: e.nextAction,
      })),
    };
  }

  // 5) Compute effective config
  const effective = computeEffectivePdConfig(validationResult.value);

  return {
    ok: true,
    effective,
    source: 'user_config',
    configPath,
    warnings: effective.warnings,
    errors: [],
  };
}

// ── Feature Flag from Config ─────────────────────────────────────────────────

/**
 * Get a single feature flag's enabled state from .pd/config.yaml.
 * Replaces the old `loadFeatureFlagFromWorkspace` which read .pd/feature-flags.yaml.
 */
export function loadFeatureFlagFromConfig(
  workspaceDir: string,
  flagId: string,
  logger?: { warn?: (msg: string) => void; info?: (msg: string) => void },
): { enabled: boolean; source: string } {
  const result = loadPdConfigForPlugin(workspaceDir);
  const flags = computeFeatureFlagsFromConfig(result.effective);
  const flag = flags.flags[flagId];

  if (!result.ok) {
    logger?.warn?.(`[PD:Config] Config validation failed: ${result.errors.map(e => e.reason).join('; ')} — using defaults`);
  }

  return {
    enabled: flag?.enabled ?? false,
    source: result.source,
  };
}

// ── Observer Config Resolution ───────────────────────────────────────────────

/**
 * Resolve observer configuration from .pd/config.yaml.
 *
 * Returns structured state:
 * - config_malformed: config file is invalid — no guessing, fail loud
 * - disabled: observer feature flag is off OR agent.enabled=false → no start, no noisy logs
 * - needs_setup: observer enabled but runtime profile missing, API key not set, or unsupported profile type
 * - ready: observer enabled and fully configured (pi-ai with key present)
 * - not_ready: observer enabled, API key present, but runtime availability unknown
 */
export function resolveObserverConfig(
  workspaceDir: string,
  observerFlagId: string,
  observerAgentName: string,
  _logger?: { warn?: (msg: string) => void; info?: (msg: string) => void; debug?: (msg: string) => void },
): ObserverConfigResult {
  const result = loadPdConfigForPlugin(workspaceDir);

  // 0) Malformed config → fail loud, do NOT swallow as "disabled"
  if (!result.ok) {
    return {
      enabled: false,
      readiness: 'config_malformed',
      source: 'malformed',
      reason: `Config validation failed: ${result.errors.map(e => e.reason).join('; ')}`,
      nextAction: result.errors[0]?.nextAction ?? 'Fix .pd/config.yaml and retry',
      runtimeProfileId: null,
      runtimeProfileType: null,
      apiKeyEnv: null,
      apiKeyPresent: false,
      provider: null,
      model: null,
      timeoutMs: null,
      baseUrl: null,
      configErrors: result.errors,
    };
  }

  const config = result.effective.config;

  // 1) Check if the observer feature flag is enabled
  const featureFlag = config.features[observerFlagId];
  if (!featureFlag || !featureFlag.enabled) {
    return {
      enabled: false,
      readiness: 'disabled',
      source: result.source,
      reason: `${observerFlagId} is disabled in .pd/config.yaml`,
      nextAction: `Set features.${observerFlagId}.enabled=true in .pd/config.yaml to enable`,
      runtimeProfileId: null,
      runtimeProfileType: null,
      apiKeyEnv: null,
      apiKeyPresent: false,
      provider: null,
      model: null,
      timeoutMs: null,
      baseUrl: null,
    };
  }

  // 2) Check if the agent itself is enabled (feature flag ≠ agent.enabled)
  const knownNames: readonly string[] = INTERNAL_AGENT_NAMES;
  if (!knownNames.includes(observerAgentName)) {
    return {
      enabled: false,
      readiness: 'needs_setup',
      source: result.source,
      reason: `Unknown agent name '${observerAgentName}'`,
      nextAction: `Use one of the known agent names: ${INTERNAL_AGENT_NAMES.join(', ')}`,
      runtimeProfileId: null,
      runtimeProfileType: null,
      apiKeyEnv: null,
      apiKeyPresent: false,
      provider: null,
      model: null,
      timeoutMs: null,
      baseUrl: null,
    };
  }
  const agentKey = observerAgentName as InternalAgentName;
  const agentConfig = config.internalAgents.agents[agentKey];

  // Feature flag on but agent.enabled=false → disabled (not enabled)
  if (!agentConfig || !agentConfig.enabled) {
    return {
      enabled: false,
      readiness: 'disabled',
      source: result.source,
      reason: `${observerFlagId} feature flag is enabled but internalAgents.agents.${observerAgentName}.enabled is false`,
      nextAction: `Set internalAgents.agents.${observerAgentName}.enabled=true in .pd/config.yaml, or disable features.${observerFlagId}`,
      runtimeProfileId: null,
      runtimeProfileType: null,
      apiKeyEnv: null,
      apiKeyPresent: false,
      provider: null,
      model: null,
      timeoutMs: null,
      baseUrl: null,
    };
  }

  // 3) Find the agent's runtime profile
  const runtimeProfileId = agentConfig.runtimeProfile ?? config.internalAgents.defaultRuntime;
  const profile = config.runtimeProfiles[runtimeProfileId];

  if (!profile) {
    return {
      enabled: true,
      readiness: 'needs_setup',
      source: result.source,
      reason: `Runtime profile '${runtimeProfileId}' not found in .pd/config.yaml`,
      nextAction: `Add runtime profile '${runtimeProfileId}' to .pd/config.yaml runtimeProfiles`,
      runtimeProfileId,
      runtimeProfileType: null,
      apiKeyEnv: null,
      apiKeyPresent: false,
      provider: null,
      model: null,
      timeoutMs: null,
      baseUrl: null,
    };
  }

  // 4) For pi-ai profiles, check API key
  if (profile.type === 'pi-ai') {
    const apiKeyEnv = profile.apiKeyEnv ?? null;
    const apiKeyPresent = !!apiKeyEnv && Object.prototype.hasOwnProperty.call(process.env, apiKeyEnv) && !!process.env[apiKeyEnv];

    if (!apiKeyEnv) {
      return {
        enabled: true,
        readiness: 'needs_setup',
        source: result.source,
        reason: `pi-ai profile '${runtimeProfileId}' missing apiKeyEnv`,
        nextAction: `Add apiKeyEnv to runtime profile '${runtimeProfileId}' in .pd/config.yaml`,
        runtimeProfileId,
        runtimeProfileType: profile.type,
        apiKeyEnv: null,
        apiKeyPresent: false,
        provider: profile.provider ?? null,
        model: profile.model ?? null,
        timeoutMs: profile.timeoutMs ?? null,
        baseUrl: profile.baseUrl ?? null,
      };
    }

    if (!apiKeyPresent) {
      return {
        enabled: true,
        readiness: 'needs_setup',
        source: result.source,
        reason: `Environment variable '${apiKeyEnv}' is not set or empty`,
        nextAction: `Set the environment variable '${apiKeyEnv}' with a valid API key`,
        runtimeProfileId,
        runtimeProfileType: profile.type,
        apiKeyEnv,
        apiKeyPresent: false,
        provider: profile.provider ?? null,
        model: profile.model ?? null,
        timeoutMs: profile.timeoutMs ?? null,
        baseUrl: profile.baseUrl ?? null,
      };
    }

    // pi-ai with key present — runtime availability unknown without actual probe
    return {
      enabled: true,
      readiness: 'not_ready',
      source: result.source,
      reason: `pi-ai profile configured with apiKeyEnv='${apiKeyEnv}' (key present); runtime availability unknown`,
      nextAction: 'Run pd runtime probe to verify end-to-end connectivity',
      runtimeProfileId,
      runtimeProfileType: profile.type,
      apiKeyEnv,
      apiKeyPresent: true,
      provider: profile.provider ?? null,
      model: profile.model ?? null,
      timeoutMs: profile.timeoutMs ?? null,
      baseUrl: profile.baseUrl ?? null,
    };
  }

  // 5) OpenClaw profile — CorrectionObserver does NOT support OpenClaw runtime
  //    Mark as needs_setup with nextAction to configure a pi-ai profile
  return {
    enabled: true,
    readiness: 'needs_setup',
    source: result.source,
    reason: `OpenClaw profile '${runtimeProfileId}' is not supported for observer runtime. Observers require a pi-ai profile with an API key.`,
    nextAction: `Configure a pi-ai runtime profile for ${observerAgentName} in .pd/config.yaml (e.g., add a pi-ai profile with provider, model, and apiKeyEnv)`,
    runtimeProfileId,
    runtimeProfileType: profile.type,
    apiKeyEnv: null,
    apiKeyPresent: false,
    provider: profile.provider ?? null,
    model: profile.model ?? null,
    timeoutMs: null,
    baseUrl: null,
  };
}
