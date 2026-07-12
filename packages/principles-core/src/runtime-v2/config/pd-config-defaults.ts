/**
 * PD Config Defaults — PRI-304
 *
 * Deterministic defaults for missing config.
 * All defaults are testable and explicit.
 */

import {
  type PdConfig,
  type FeatureFlagEntry,
  type OpenClawRuntimeProfile,
  type PdLocalRuntimeProfile,
  type InternalAgentBinding,
  type InternalAgentName,
  type InternalAgentsConfig,
  type UiConfig,
  type ContextInjectionConfig,
  PD_CONFIG_VERSION,
  INTERNAL_AGENT_NAMES,
} from './pd-config-types.js';
import { DEFAULT_FEATURE_FLAGS as CONTRACT_DEFAULTS } from '../feature-flags/feature-flag-contract.js';

// ── Default Feature Flags ───────────────────────────────────────────────────

export const DEFAULT_FEATURE_FLAGS: Record<string, FeatureFlagEntry> = {};
for (const flag of CONTRACT_DEFAULTS) {
  DEFAULT_FEATURE_FLAGS[flag.id] = {
    category: flag.category,
    enabled: flag.enabled,
  };
}

// ── Default Runtime Profile ─────────────────────────────────────────────────
//
// MVP installs must work with the OpenClaw runtime the plugin is already
// running inside. The optional pi-ai profile remains available for explicit
// configuration, but its empty placeholders must never be the active default.

export const PI_AI_DEFAULT_PROFILE_ID = 'pd.default';

export const PI_AI_DEFAULT_PROFILE: PdLocalRuntimeProfile = {
  type: 'pi-ai',
  provider: '',
  model: '',
  apiKeyEnv: '',
};

export const OPENCLAW_DEFAULT_PROFILE_ID = 'openclaw.default';

export const OPENCLAW_DEFAULT_PROFILE: OpenClawRuntimeProfile = {
  type: 'openclaw',
  source: 'default',
};

export const DEFAULT_RUNTIME_PROFILE_ID = OPENCLAW_DEFAULT_PROFILE_ID;

export const DEFAULT_RUNTIME_PROFILE: OpenClawRuntimeProfile = OPENCLAW_DEFAULT_PROFILE;

// ── Default Internal Agents ─────────────────────────────────────────────────

const DEFAULT_AGENT_ENABLED: Record<InternalAgentName, boolean> = {
  diagnostician: true,
  dreamer: true,
  philosopher: false,
  scribe: true,
  artificer: true,
  evaluator: false,
  rolloutReviewer: false,
  correctionObserver: false,
  empathyObserver: false,
  signalCollector: false,
};

export function getDefaultInternalAgents(): InternalAgentsConfig {
  const agents: Record<string, InternalAgentBinding> = {};
  for (const name of INTERNAL_AGENT_NAMES) {
    agents[name] = {
      enabled: DEFAULT_AGENT_ENABLED[name],
      runtimeProfile: DEFAULT_RUNTIME_PROFILE_ID,
    };
  }
  return {
    defaultRuntime: DEFAULT_RUNTIME_PROFILE_ID,
    agents: agents,
  };
}

// ── Default UI ──────────────────────────────────────────────────────────────

export const DEFAULT_UI: UiConfig = {
  diagnostics: { mode: 'simple' },
};

// ── Default Context Injection ──────────────────────────────────────────────

export const DEFAULT_CONTEXT_INJECTION: ContextInjectionConfig = {
  thinkingOs: false,
  projectFocus: 'off',
  evolutionContext: {
    enabled: true,
    maxMessages: 4,
    maxCharsPerMessage: 200,
  },
};

// ── Full Default Config ─────────────────────────────────────────────────────

export function getDefaultPdConfig(): PdConfig {
  return {
    version: PD_CONFIG_VERSION,
    features: { ...DEFAULT_FEATURE_FLAGS },
    runtimeProfiles: {
      [PI_AI_DEFAULT_PROFILE_ID]: { ...PI_AI_DEFAULT_PROFILE },
      [OPENCLAW_DEFAULT_PROFILE_ID]: { ...OPENCLAW_DEFAULT_PROFILE },
    },
    internalAgents: getDefaultInternalAgents(),
    ui: { ...DEFAULT_UI },
    principles: { outputLanguage: undefined },
    contextInjection: undefined,
  };
}
