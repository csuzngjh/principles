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
} from '@principles/core/runtime-v2';
import type {
  RuntimeConfigResult,
  RuntimeConfig,
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

  // Use the effective config (or defaults if malformed) to resolve runtime
  const effective = configLoadResult.ok
    ? configLoadResult.effective
    : configLoadResult.defaults;

  const result = resolveRuntimeConfigFromPdConfig(effective, getEnvVar);

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
  const merged: RuntimeConfig = {
    ...config,
    provider: overrides.provider || config.provider,
    model: overrides.model || config.model,
    apiKeyEnv: overrides.apiKeyEnv || config.apiKeyEnv,
    baseUrl: overrides.baseUrl || config.baseUrl,
    maxRetries: overrides.maxRetries ?? config.maxRetries,
    timeoutMs: overrides.timeoutMs ?? config.timeoutMs,
  };

  return { ...base, mergedConfig: merged };
}
