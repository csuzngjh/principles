/**
 * OpenClaw compatibility facade for the shared production PD config loader.
 * Observer resolution remains host-owned because it interprets OpenClaw agent runtime profiles.
 */
import {
  INTERNAL_AGENT_NAMES,
  type InternalAgentName,
} from '@principles/core/runtime-v2';
import {
  loadPdConfigForPlugin,
  type PluginConfigLoadResult,
} from '@principles/host-runtime';

export {
  getPdConfigPath,
  loadFeatureFlagFromConfig,
  loadPdConfigForPlugin,
  PD_CONFIG_DIR,
  PD_CONFIG_FILENAME,
} from '@principles/host-runtime';
export type { PluginConfigLoadResult } from '@principles/host-runtime';

export type ObserverReadiness = 'disabled' | 'needs_setup' | 'ready' | 'not_ready' | 'config_malformed';

export interface ObserverConfigResult {
  enabled: boolean;
  readiness: ObserverReadiness;
  source: string;
  reason: string;
  nextAction: string;
  runtimeProfileId: string | null;
  runtimeProfileType: string | null;
  apiKeyEnv: string | null;
  apiKeyPresent: boolean;
  provider: string | null;
  model: string | null;
  timeoutMs: number | null;
  baseUrl: string | null;
  configErrors?: PluginConfigLoadResult['errors'];
}

function base(result: PluginConfigLoadResult): Pick<ObserverConfigResult, 'source'> {
  return { source: result.source };
}

function emptyRuntime(): Pick<ObserverConfigResult, 'runtimeProfileId' | 'runtimeProfileType' | 'apiKeyEnv' | 'apiKeyPresent' | 'provider' | 'model' | 'timeoutMs' | 'baseUrl'> {
  return { runtimeProfileId: null, runtimeProfileType: null, apiKeyEnv: null, apiKeyPresent: false, provider: null, model: null, timeoutMs: null, baseUrl: null };
}

function isInternalAgentName(value: string): value is InternalAgentName {
  return INTERNAL_AGENT_NAMES.some((name) => name === value);
}

export function resolveObserverConfig(
  workspaceDir: string,
  observerFlagId: string,
  observerAgentName: string,
  _logger?: { warn?: (message: string) => void; info?: (message: string) => void; debug?: (message: string) => void },
): ObserverConfigResult {
  const result = loadPdConfigForPlugin(workspaceDir);
  if (!result.ok) {
    return {
      enabled: false, readiness: 'config_malformed', ...base(result), ...emptyRuntime(),
      reason: `Config validation failed: ${result.errors.map((error) => error.reason).join('; ')}`,
      nextAction: result.errors[0]?.nextAction ?? 'Fix .pd/config.yaml and retry', configErrors: result.errors,
    };
  }
  const config = result.effective.config;
  const feature = config.features[observerFlagId];
  if (!feature?.enabled) {
    return { enabled: false, readiness: 'disabled', ...base(result), ...emptyRuntime(), reason: `${observerFlagId} is disabled in .pd/config.yaml`, nextAction: `Set features.${observerFlagId}.enabled=true in .pd/config.yaml to enable` };
  }
  if (!isInternalAgentName(observerAgentName)) {
    return { enabled: false, readiness: 'needs_setup', ...base(result), ...emptyRuntime(), reason: `Unknown agent name '${observerAgentName}'`, nextAction: `Use one of the known agent names: ${INTERNAL_AGENT_NAMES.join(', ')}` };
  }
  const agent = config.internalAgents.agents[observerAgentName];
  if (!agent?.enabled) {
    return { enabled: false, readiness: 'disabled', ...base(result), ...emptyRuntime(), reason: `${observerFlagId} feature flag is enabled but internalAgents.agents.${observerAgentName}.enabled is false`, nextAction: `Set internalAgents.agents.${observerAgentName}.enabled=true in .pd/config.yaml, or disable features.${observerFlagId}` };
  }
  const runtimeProfileId = agent.runtimeProfile ?? config.internalAgents.defaultRuntime;
  const profile = config.runtimeProfiles[runtimeProfileId];
  if (!profile) {
    return { enabled: true, readiness: 'needs_setup', ...base(result), ...emptyRuntime(), runtimeProfileId, reason: `Runtime profile '${runtimeProfileId}' not found in .pd/config.yaml`, nextAction: `Add runtime profile '${runtimeProfileId}' to .pd/config.yaml runtimeProfiles` };
  }
  if (profile.type !== 'pi-ai') {
    return { enabled: true, readiness: 'needs_setup', ...base(result), ...emptyRuntime(), runtimeProfileId, runtimeProfileType: profile.type, provider: profile.provider ?? null, model: profile.model ?? null, reason: `OpenClaw profile '${runtimeProfileId}' is not supported for observer runtime. Observers require a pi-ai profile with an API key.`, nextAction: `Configure a pi-ai runtime profile for ${observerAgentName} in .pd/config.yaml (e.g., add a pi-ai profile with provider, model, and apiKeyEnv)` };
  }
  const apiKeyEnv = profile.apiKeyEnv ?? null;
  if (!apiKeyEnv) {
    return { enabled: true, readiness: 'needs_setup', ...base(result), ...emptyRuntime(), runtimeProfileId, runtimeProfileType: profile.type, provider: profile.provider ?? null, model: profile.model ?? null, timeoutMs: profile.timeoutMs ?? null, baseUrl: profile.baseUrl ?? null, reason: `pi-ai profile '${runtimeProfileId}' missing apiKeyEnv`, nextAction: `Add apiKeyEnv to runtime profile '${runtimeProfileId}' in .pd/config.yaml` };
  }
  const apiKeyPresent = Object.hasOwn(process.env, apiKeyEnv) && Boolean(process.env[apiKeyEnv]);
  if (!apiKeyPresent) {
    return { enabled: true, readiness: 'needs_setup', ...base(result), runtimeProfileId, runtimeProfileType: profile.type, apiKeyEnv, apiKeyPresent: false, provider: profile.provider ?? null, model: profile.model ?? null, timeoutMs: profile.timeoutMs ?? null, baseUrl: profile.baseUrl ?? null, reason: `Environment variable '${apiKeyEnv}' is not set or empty`, nextAction: `Set the environment variable '${apiKeyEnv}' with a valid API key` };
  }
  return { enabled: true, readiness: 'not_ready', ...base(result), runtimeProfileId, runtimeProfileType: profile.type, apiKeyEnv, apiKeyPresent: true, provider: profile.provider ?? null, model: profile.model ?? null, timeoutMs: profile.timeoutMs ?? null, baseUrl: profile.baseUrl ?? null, reason: `pi-ai profile configured with apiKeyEnv='${apiKeyEnv}' (key present); runtime availability unknown`, nextAction: 'Run pd runtime probe to verify end-to-end connectivity' };
}
