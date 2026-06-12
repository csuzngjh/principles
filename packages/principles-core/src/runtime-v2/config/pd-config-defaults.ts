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
  type InternalAgentBinding,
  type InternalAgentName,
  type InternalAgentsConfig,
  type UiConfig,
  PD_CONFIG_VERSION,
  INTERNAL_AGENT_NAMES,
} from './pd-config-types.js';

// ── Default Feature Flags ───────────────────────────────────────────────────

export const DEFAULT_FEATURE_FLAGS: Record<string, FeatureFlagEntry> = {
  // MVP-Core (ADR-0014 §2.4)
  prompt:             { category: 'core',  enabled: true },
  code_tool_hook:     { category: 'core',  enabled: true },
  defer_archive:      { category: 'core',  enabled: true },
  correction_observer:{ category: 'quiet', enabled: false },

  // MVP-Quiet (ADR-0014 §2.5)
  feedback_channel:   { category: 'quiet', enabled: true },
  gfi:                { category: 'quiet', enabled: false },
  evolution_worker:   { category: 'quiet', enabled: false },
  empathy_observer:   { category: 'quiet', enabled: false },
  painEvidenceAdmission:{ category: 'quiet', enabled: false },
  diagnostician_async_cli: { category: 'quiet', enabled: false },
  diagnostician_core_grounding: { category: 'quiet', enabled: false },
  diagnostician_split_pipeline: { category: 'quiet', enabled: false },

  // MVP-Gone (ADR-0014 §2.6)
  nocturnal:          { category: 'gone',  enabled: false },
  idle_trigger:       { category: 'gone',  enabled: false },
  model_training:     { category: 'gone',  enabled: false },
  trainer:            { category: 'gone',  enabled: false },
};

// ── Default Runtime Profile ─────────────────────────────────────────────────

export const DEFAULT_RUNTIME_PROFILE_ID = 'openclaw.default';

export const DEFAULT_RUNTIME_PROFILE: OpenClawRuntimeProfile = {
  type: 'openclaw',
  source: 'default',
};

// ── Default Internal Agents ─────────────────────────────────────────────────

const DEFAULT_AGENT_ENABLED: Record<InternalAgentName, boolean> = {
  diagnostician: true,
  dreamer: true,
  philosopher: false,
  scribe: true,
  artificer: true,
  evaluator: false,
  rolloutReviewer: false,
  trainer: false,
  correctionObserver: false,
  empathyObserver: false,
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

// ── Full Default Config ─────────────────────────────────────────────────────

export function getDefaultPdConfig(): PdConfig {
  return {
    version: PD_CONFIG_VERSION,
    features: { ...DEFAULT_FEATURE_FLAGS },
    runtimeProfiles: {
      [DEFAULT_RUNTIME_PROFILE_ID]: { ...DEFAULT_RUNTIME_PROFILE },
    },
    internalAgents: getDefaultInternalAgents(),
    ui: { ...DEFAULT_UI },
    principles: { outputLanguage: undefined },
  };
}
