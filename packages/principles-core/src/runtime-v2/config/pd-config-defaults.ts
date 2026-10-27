/**
 * PD Config Defaults — PRI-304
 *
 * Deterministic defaults for missing config.
 * All defaults are testable and explicit.
 */

import {
  type PdConfig,
  type FeatureFlagEntry,
  type PdLocalRuntimeProfile,
  type InternalAgentBinding,
  type InternalAgentName,
  type InternalAgentsConfig,
  type UiConfig,
  type ContextInjectionConfig,
  type ReuseEvaluationConfig,
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
// pi-ai is the only runtime backend for PD internal agents (ADR-0029), so the
// default profile is a pi-ai profile. It ships with empty placeholders on
// purpose: an unconfigured pi-ai profile resolves to `needs_setup` with a
// reason and a next action instead of silently running against some other
// model. A legacy `type: 'openclaw'` profile in a user's config still parses
// (read-only legacy) but is never seeded here.

export const PI_AI_DEFAULT_PROFILE_ID = 'pd.default';

export const PI_AI_DEFAULT_PROFILE: PdLocalRuntimeProfile = {
  type: 'pi-ai',
  provider: '',
  model: '',
  apiKeyEnv: '',
};

export const DEFAULT_RUNTIME_PROFILE_ID = PI_AI_DEFAULT_PROFILE_ID;

export const DEFAULT_RUNTIME_PROFILE: PdLocalRuntimeProfile = PI_AI_DEFAULT_PROFILE;

// ── Default Internal Agents ─────────────────────────────────────────────────
//
// Round-4 S1 (WorkBuddy install remediation, 2026-10-14): fresh defaults
// intentionally carry NO explicit per-agent `runtimeProfile` row. A per-agent
// row outranks `internalAgents.defaultRuntime` in resolveAgentRuntimeBinding,
// so seeding one used to pin every learning agent to one profile even after an
// installer flipped `defaultRuntime` to the install-configured profile — the
// diagnostician rode the new runtime while
// dreamer→philosopher→scribe→artificer→evaluator→rolloutReviewer and
// signalCollector stayed behind. With no per-agent row, every agent inherits
// `defaultRuntime`:
//   - vanilla default: defaultRuntime → 'pd.default' (pi-ai) → needs_setup
//     until the Owner configures provider/model/apiKeyEnv (ADR-0029 §5);
//   - install-configured workspace: defaultRuntime → the install profile → the
//     whole learning chain rides it.
// Owner-written explicit rows are untouched by this authority and keep
// outranking defaultRuntime (P4: Owner choice is not silently overridden).

const DEFAULT_AGENT_ENABLED: Record<InternalAgentName, boolean> = {
  diagnostician: true,
  dreamer: true,
  philosopher: false,
  scribe: true,
  artificer: true,
  evaluator: false,
  rolloutReviewer: false,
  correctionObserver: false,
  // PRI-797 (Owner 2026-09-15): 默认启用——语义确认链（Stage2/批量确认/TP 记录）
  // 不再依赖手工开闸；profile 未配置 API 端点时降级为关键词-only 并以 WARN +
  // `pd config doctor` needs_setup 显性呈现，绝不静默。
  signalCollector: true,
};

export function getDefaultInternalAgents(): InternalAgentsConfig {
  const agents: Record<string, InternalAgentBinding> = {};
  for (const name of INTERNAL_AGENT_NAMES) {
    agents[name] = {
      enabled: DEFAULT_AGENT_ENABLED[name],
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
};

// ── Full Default Config ─────────────────────────────────────────────────────

/**
 * PRI-917 v0.3.2 §8 — defaults for the Semantic Reuse Evaluation Capability.
 * `runtimeProfile` stays absent on purpose: the effective layer falls back to
 * `internalAgents.defaultRuntime` (the user's), not to a hard-coded id.
 */
export const DEFAULT_REUSE_EVALUATION: ReuseEvaluationConfig = {
  enabled: true,
};

export function getDefaultPdConfig(): PdConfig {
  return {
    version: PD_CONFIG_VERSION,
    features: { ...DEFAULT_FEATURE_FLAGS },
    runtimeProfiles: {
      [PI_AI_DEFAULT_PROFILE_ID]: { ...PI_AI_DEFAULT_PROFILE },
    },
    internalAgents: getDefaultInternalAgents(),
    ui: { ...DEFAULT_UI },
    principles: { outputLanguage: undefined },
    // PRI-917 v0.3.2 §8: default ON (PRI-797 precedent); runtimeProfile
    // resolved against internalAgents.defaultRuntime by the effective layer.
    reuseEvaluation: { ...DEFAULT_REUSE_EVALUATION },
    contextInjection: undefined,
  };
}
