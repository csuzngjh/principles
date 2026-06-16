/**
 * Unified runtime config resolver from .pd/config.yaml — PRI-393
 *
 * All MVP mainline execution paths (probe, run-once, diagnose, pain-retry)
 * MUST use this helper instead of the legacy resolveRuntimeConfig(stateDir)
 * which reads .state/workflows.yaml.
 *
 * Canonical source: .pd/config.yaml via loadPdConfig → resolveRuntimeConfigFromPdConfig.
 * .state/workflows.yaml is reported as a legacy warning only.
 *
 * ERR refs:
 * - ERR-002: fail loud with reason + nextAction
 * - EP-07: runtime state source alignment
 */

import {
  resolveRuntimeConfigFromPdConfig,
  isRuntimeConfigError,
  resolveAgentRuntimeBinding,
} from '@principles/core/runtime-v2';
import type {
  RuntimeConfigResult,
  RuntimeConfig,
  RuntimeConfigError,
} from '@principles/core/runtime-v2';
import { loadPdConfig } from './pd-config-loader.js';
import type { PdConfigLoadResult } from './pd-config-loader.js';

export interface ResolvedRuntimeFromPdConfig {
  /** The resolved runtime config (or error). */
  result: RuntimeConfigResult;
  /** Legacy files detected (.state/workflows.yaml etc.) — informational only. */
  legacyWarnings: string[];
  /** The PD config load result for downstream use (feature flags, etc.). */
  configLoadResult: PdConfigLoadResult;
  /** Canonical config source label, e.g. ".pd/config.yaml". */
  configSource: string;
  /**
   * PRI-402: Resolved runtime profile ID for the diagnostician agent.
   * e.g. "pi-ai.lmstudio". null when config resolution fails or profile is not found.
   */
  runtimeProfileId: string | null;
  /**
   * PRI-402: Human-readable runtime profile label for the diagnostician agent.
   * e.g. "pi-ai: lmstudio/qwen3.6-27b-mtp". null when config resolution fails.
   * Matches the label format used by `pd config doctor`.
   */
  runtimeProfileLabel: string | null;
}

/**
 * Build a profile label matching the format used by `pd config doctor`.
 * Mirrors `buildProfileLabel` in `pd-config-redaction.ts` (core).
 */
function buildProfileLabel(profileId: string, profile: { type: string; provider?: string; model?: string; source?: string }): string {
  if (profile.type === 'openclaw') {
    const parts: string[] = ['openclaw'];
    if (profile.provider) parts.push(profile.provider);
    if (profile.model) parts.push(profile.model);
    if (profile.source && !profile.provider && !profile.model) parts.push(profile.source);
    return parts.join(': ');
  }
  // pi-ai
  return `pi-ai: ${profile.provider ?? 'unknown'}/${profile.model ?? 'unknown'}`;
}

/**
 * Resolve runtime configuration exclusively from .pd/config.yaml.
 *
 * This is the ONLY production entry point for runtime config resolution
 * in pd-cli commands. Legacy resolveRuntimeConfig(stateDir) must NOT be
 * called by probe/run-once/diagnose/pain-retry.
 *
 * @param workspaceDir - The resolved workspace directory.
 * @param getEnvVar - Env var accessor, defaults to process.env.
 * @returns Resolved runtime config with legacy warnings.
 */
export function resolveRuntimeFromPdConfig(
  workspaceDir: string,
  getEnvVar: (name: string) => string | undefined = (name) => process.env[name],
): ResolvedRuntimeFromPdConfig {
  const configLoadResult = loadPdConfig(workspaceDir);

  // Malformed config → fail loud. Do NOT fall back to defaults for execution.
  // Missing config is ok (loadPdConfig returns ok:true with defaults), but
  // ok:false always means the file exists and is broken.
  if (!configLoadResult.ok) {
    const [firstError] = configLoadResult.errors;
    const result: RuntimeConfigError = {
      ok: false,
      reason: `config_malformed:${firstError?.reason ?? 'unknown'}`,
      message: firstError?.reason ?? '.pd/config.yaml is malformed',
      nextAction: firstError?.nextAction ?? 'Fix .pd/config.yaml syntax and retry',
    };

    const legacyWarnings = configLoadResult.legacyFilesDetected.length > 0
      ? [
          `Legacy config files detected: ${configLoadResult.legacyFilesDetected.join(', ')}. ` +
          `These are NOT used for runtime resolution. PD uses .pd/config.yaml exclusively.`,
        ]
      : [];

    return {
      result,
      legacyWarnings,
      configLoadResult,
      configSource: '.pd/config.yaml',
      runtimeProfileId: null,
      runtimeProfileLabel: null,
    };
  }

  const result = resolveRuntimeConfigFromPdConfig(configLoadResult.effective, getEnvVar);

  // PRI-402: Extract profile ID and label for probe output alignment with doctor
  let runtimeProfileId: string | null = null;
  let runtimeProfileLabel: string | null = null;
  const bindingResult = resolveAgentRuntimeBinding(configLoadResult.effective, 'diagnostician');
  if (bindingResult.ok) {
    runtimeProfileId = bindingResult.profileId;
    runtimeProfileLabel = buildProfileLabel(bindingResult.profileId, bindingResult.profile);
  }

  const legacyWarnings = configLoadResult.legacyFilesDetected.length > 0
    ? [
        `Legacy config files detected: ${configLoadResult.legacyFilesDetected.join(', ')}. ` +
        `These are NOT used for runtime resolution. PD uses .pd/config.yaml exclusively.`,
      ]
    : [];

  return {
    result,
    legacyWarnings,
    configLoadResult,
    configSource: '.pd/config.yaml',
    runtimeProfileId,
    runtimeProfileLabel,
  };
}


/**
 * Resolve runtime config from .pd/config.yaml, then merge with CLI flag overrides.
 *
 * CLI flags take priority over config values (same semantics as before PRI-393,
 * but reading from .pd/config.yaml instead of .state/workflows.yaml).
 *
 * @param workspaceDir - The resolved workspace directory.
 * @param overrides - CLI flag overrides (provider, model, apiKeyEnv, etc.).
 * @param getEnvVar - Env var accessor.
 */
export function resolveRuntimeWithOverrides(
  workspaceDir: string,
  overrides: {
    provider?: string;
    model?: string;
    apiKeyEnv?: string;
    baseUrl?: string;
    maxRetries?: number;
    timeoutMs?: number;
  },
  getEnvVar: (name: string) => string | undefined = (name) => process.env[name],
): ResolvedRuntimeFromPdConfig & { mergedConfig: RuntimeConfig | null } {
  const base = resolveRuntimeFromPdConfig(workspaceDir, getEnvVar);

  if (isRuntimeConfigError(base.result)) {
    return { ...base, mergedConfig: null };
  }

  const config = base.result;
  // CLI flags override config values
  // Use ?? (not ||) so empty-string overrides are preserved until the guard below
  const merged: RuntimeConfig = {
    ...config,
    provider: overrides.provider ?? config.provider,
    model: overrides.model ?? config.model,
    apiKeyEnv: overrides.apiKeyEnv ?? config.apiKeyEnv,
    baseUrl: overrides.baseUrl ?? config.baseUrl,
    maxRetries: overrides.maxRetries ?? config.maxRetries,
    timeoutMs: overrides.timeoutMs ?? config.timeoutMs,
  };

  // Guard: empty-string provider/model/apiKeyEnv/baseUrl after merge means the user
  // explicitly passed '' or the config has a blank value. Normalise to
  // undefined so downstream validation (handlePiAiProbe) can catch it.
  if (!merged.provider) merged.provider = undefined;
  if (!merged.model) merged.model = undefined;
  if (!merged.apiKeyEnv) merged.apiKeyEnv = undefined;
  if (!merged.baseUrl) merged.baseUrl = undefined;

  return { ...base, mergedConfig: merged };
}
