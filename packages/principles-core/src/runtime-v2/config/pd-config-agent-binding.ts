/**
 * Agent Runtime Binding Resolution — PRI-306
 *
 * Pure functions that resolve which RuntimeProfile an internal agent uses,
 * check readiness, and produce adapter configuration.
 *
 * No I/O — env var access is injected via getEnvVar callback.
 * No `as` casts on untrusted data (ERR-001).
 * Missing fields fail loud with reason + nextAction (ERR-002, ERR-009).
 * Uses Object.hasOwn() for key checks (ERR-013).
 */

import type {
  EffectivePdConfig,
  InternalAgentName,
  RuntimeProfile,
  PdLocalRuntimeProfile,
  OpenClawRuntimeProfile,
} from './pd-config-types.js';

// ── Agent Runtime Binding Result ─────────────────────────────────────────────

export interface AgentRuntimeBindingOk {
  ok: true;
  /** The resolved runtime profile */
  profile: RuntimeProfile;
  /** The profile ID in the runtimeProfiles map */
  profileId: string;
  /** How this binding was resolved: 'agent_override' = per-agent override, 'default_runtime' = fallback to defaultRuntime */
  source: 'agent_override' | 'default_runtime';
}

export interface AgentRuntimeBindingErr {
  ok: false;
  /** Readiness status */
  readiness: 'needs_setup' | 'not_ready' | 'disabled';
  /** Human-readable reason */
  reason: string;
  /** Actionable next step */
  nextAction: string;
}

export type AgentRuntimeBindingResult = AgentRuntimeBindingOk | AgentRuntimeBindingErr;

// ── Agent Runtime Readiness Result ───────────────────────────────────────────

export interface AgentRuntimeReadinessResult {
  readiness: 'ready' | 'not_ready' | 'needs_setup';
  reason?: string;
  nextAction?: string;
}

// ── Adapter Config Result ────────────────────────────────────────────────────

export interface PiAiAdapterConfigResult {
  runtimeKind: 'pi-ai';
  provider: string;
  model: string;
  apiKeyEnv: string;
  baseUrl?: string;
  timeoutMs?: number;
  maxRetries?: number;
  /** Optional max output tokens (max_tokens) for pi-ai LLM calls. */
  maxTokens?: number;
  /** Optional system prompt (from profile, flows to PiAiRuntimeAdapter). */
  systemPrompt?: string;
  workspace: string;
}

export interface OpenClawAdapterConfigResult {
  runtimeKind: 'openclaw-cli';
  workspaceDir: string;
  /** 'default' = delegate to OpenClaw's own mode resolution (CLI flags, workflows.yaml).
   *  'local' | 'gateway' = explicit mode from profile config. */
  openclawMode: 'local' | 'gateway' | 'default';
}

export type AdapterConfigResult = PiAiAdapterConfigResult | OpenClawAdapterConfigResult;

// ── Private helpers (defined before public functions to satisfy no-use-before-define) ──

function checkOpenClawReadiness(profile: OpenClawRuntimeProfile): AgentRuntimeReadinessResult {
  // OpenClaw profile with source=default is always "ready" (delegated to OpenClaw)
  if (profile.source === 'default') {
    return { readiness: 'ready' };
  }

  // OpenClaw profile with provider+model may be ready
  if (profile.provider && profile.model) {
    return { readiness: 'ready' };
  }

  return {
    readiness: 'needs_setup',
    reason: `OpenClaw profile missing provider and/or model. Provide both 'provider' and 'model' fields, or set 'source: default' to delegate to OpenClaw defaults.`,
    nextAction: `Add 'provider' and 'model' to the openclaw runtime profile in .pd/config.yaml, or set source: default`,
  };
}

function checkPdLocalReadiness(
  profile: PdLocalRuntimeProfile,
  getEnvVar: (name: string) => string | undefined,
): AgentRuntimeReadinessResult {
  // Check required config fields first
  if (!profile.provider || profile.provider.length === 0) {
    return {
      readiness: 'needs_setup',
      reason: `pi-ai profile missing required 'provider' field`,
      nextAction: `Add 'provider' to the pi-ai runtime profile in .pd/config.yaml (e.g. "anthropic", "openrouter")`,
    };
  }

  if (!profile.model || profile.model.length === 0) {
    return {
      readiness: 'needs_setup',
      reason: `pi-ai profile missing required 'model' field`,
      nextAction: `Add 'model' to the pi-ai runtime profile in .pd/config.yaml (e.g. "claude-3-5-sonnet")`,
    };
  }

  if (!profile.apiKeyEnv || profile.apiKeyEnv.length === 0) {
    return {
      readiness: 'needs_setup',
      reason: `pi-ai profile missing required 'apiKeyEnv' field`,
      nextAction: `Add 'apiKeyEnv' to the pi-ai runtime profile in .pd/config.yaml (e.g. "ANTHROPIC_API_KEY")`,
    };
  }

  // Check if the env var actually exists (empty string counts as "set but empty")
  const apiKeyValue = getEnvVar(profile.apiKeyEnv);
  if (apiKeyValue === undefined) {
    return {
      readiness: 'not_ready',
      reason: `Environment variable '${profile.apiKeyEnv}' is not set. The profile is configured correctly but the API key is not available in the environment.`,
      nextAction: `Set the environment variable '${profile.apiKeyEnv}' with your API key before running PD, or change apiKeyEnv in .pd/config.yaml to reference an existing env var`,
    };
  }

  if (apiKeyValue.length === 0) {
    return {
      readiness: 'not_ready',
      reason: `Environment variable '${profile.apiKeyEnv}' is set but empty. An API key value is required.`,
      nextAction: `Provide a non-empty value for '${profile.apiKeyEnv}' or change apiKeyEnv in .pd/config.yaml to reference a different env var`,
    };
  }

  // PRI-621: the deepseek-specific reasoning-model hint is retired — the
  // adapter no longer applies a provider-name heuristic budget. Without an
  // explicit maxTokens, pi-ai's native defaulting picks the model's catalog
  // ceiling, which already accounts for reasoning models.
  return { readiness: 'ready' };
}

// ── resolveAgentRuntimeBinding ───────────────────────────────────────────────

/**
 * Resolve which RuntimeProfile an internal agent should use.
 *
 * Resolution order:
 *   1. Per-agent override (agent.runtimeProfile) → source: 'agent_override'
 *   2. defaultRuntime → source: 'default_runtime'
 *
 * If the resolved profile ID doesn't exist in runtimeProfiles, returns an error.
 * If the agent is disabled, returns a disabled result.
 */
export function resolveAgentRuntimeBinding(
  effective: EffectivePdConfig,
  agentName: InternalAgentName,
): AgentRuntimeBindingResult {
  const { config } = effective;
  const agentBinding = config.internalAgents.agents[agentName];

  // Check if agent is disabled
  if (!agentBinding || !agentBinding.enabled) {
    return {
      ok: false,
      readiness: 'disabled',
      reason: `Agent '${agentName}' is disabled`,
      nextAction: `Enable agent '${agentName}' in .pd/config.yaml internalAgents.agents.${agentName}.enabled`,
    };
  }

  // Resolve profile ID: per-agent override > defaultRuntime
  // An explicit runtimeProfile that equals defaultRuntime is NOT an override
  const hasExplicitOverride =
    agentBinding.runtimeProfile !== undefined &&
    agentBinding.runtimeProfile !== config.internalAgents.defaultRuntime;
  const profileId = agentBinding.runtimeProfile ?? config.internalAgents.defaultRuntime;
  const source = hasExplicitOverride ? 'agent_override' as const : 'default_runtime' as const;

  // Look up the profile
  if (!Object.hasOwn(config.runtimeProfiles, profileId)) {
    return {
      ok: false,
      readiness: 'needs_setup',
      reason: `Agent '${agentName}' references runtime profile '${profileId}' which does not exist in runtimeProfiles`,
      nextAction: `Add profile '${profileId}' to runtimeProfiles in .pd/config.yaml, or change agent '${agentName}' to reference an existing profile`,
    };
  }

  const profile = config.runtimeProfiles[profileId];
  if (!profile) {
    return {
      ok: false,
      readiness: 'needs_setup',
      reason: `Agent '${agentName}' references runtime profile '${profileId}' which is null/undefined`,
      nextAction: `Fix profile '${profileId}' in runtimeProfiles in .pd/config.yaml`,
    };
  }

  return {
    ok: true,
    profile,
    profileId,
    source,
  };
}

// ── checkAgentRuntimeReadiness ───────────────────────────────────────────────

/**
 * Check whether a RuntimeProfile is ready for use.
 *
 * For openclaw profiles:
 *   - source=default → ready (delegated to OpenClaw)
 *   - provider+model set → ready
 *   - otherwise → needs_setup
 *
 * For pi-ai profiles:
 *   - provider, model, apiKeyEnv all set AND apiKeyEnv exists in env → ready
 *   - apiKeyEnv missing from env → not_ready (config is correct but env is not set up)
 *   - provider or model missing → needs_setup (config is incomplete)
 *
 * The getEnvVar callback is injected to avoid process.env access in core.
 */
export function checkAgentRuntimeReadiness(
  profile: RuntimeProfile,
  getEnvVar: (name: string) => string | undefined,
): AgentRuntimeReadinessResult {
  if (profile.type === 'openclaw') {
    return checkOpenClawReadiness(profile);
  }
  return checkPdLocalReadiness(profile, getEnvVar);
}

// ── createAdapterConfigFromProfile ───────────────────────────────────────────

/**
 * Transform a RuntimeProfile into adapter configuration.
 *
 * For pi-ai profiles: produces PiAiAdapterConfigResult with all fields needed
 * to construct a PiAiRuntimeAdapter.
 *
 * For openclaw profiles: produces OpenClawAdapterConfigResult.
 * OpenClaw profiles do NOT copy secrets — they only reference provider/model.
 *
 * This is a pure data transform. No I/O, no env access.
 */
export function createAdapterConfigFromProfile(
  profile: RuntimeProfile,
  workspaceDir: string,
): AdapterConfigResult {
  if (profile.type === 'pi-ai') {
    const result: PiAiAdapterConfigResult = {
      runtimeKind: 'pi-ai',
      provider: profile.provider,
      model: profile.model,
      apiKeyEnv: profile.apiKeyEnv,
      workspace: workspaceDir,
    };
    if (profile.baseUrl) {
      result.baseUrl = profile.baseUrl;
    }
    if (profile.timeoutMs) {
      result.timeoutMs = profile.timeoutMs;
    }
    if (profile.maxRetries !== undefined) {
      result.maxRetries = profile.maxRetries;
    }
    if (profile.maxTokens !== undefined) {
      result.maxTokens = profile.maxTokens;
    }
    if (profile.systemPrompt) {
      result.systemPrompt = profile.systemPrompt;
    }
    return result;
  }

  // openclaw profile — preserve delegated/default semantics
  // source='default' → openclawMode='default' (let downstream resolve via CLI flags/workflows.yaml)
  // explicit provider+model → openclawMode='local' (explicit profile, default to local mode)
  const openclawMode: 'local' | 'gateway' | 'default' =
    profile.source === 'default' ? 'default' : 'local';
  return {
    runtimeKind: 'openclaw-cli',
    workspaceDir,
    openclawMode,
  };
}
