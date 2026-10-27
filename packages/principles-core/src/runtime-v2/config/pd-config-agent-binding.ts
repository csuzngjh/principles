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
  /** Optional reasoning level (from profile, flows to PiAiRuntimeAdapter; PRI-758). */
  reasoning?: 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | false;
  /** Optional system prompt (from profile, flows to PiAiRuntimeAdapter). */
  systemPrompt?: string;
  workspace: string;
}

// ADR-0029 retired the 'openclaw' profile type, so pi-ai is the only adapter
// PD can build a config for — there is no second member to union with.

// ── Private helpers (defined before public functions to satisfy no-use-before-define) ──

function checkOpenClawReadiness(profile: OpenClawRuntimeProfile): AgentRuntimeReadinessResult {
  // ADR-0029: the 'openclaw' profile type is read-only legacy. It still parses
  // and still gets reported, but nothing runs on it — and a profile that used to
  // be "always ready" because it delegated to the host must never look ready now.
  const referenced = [profile.provider, profile.model].filter((v): v is string => typeof v === 'string' && v.length > 0).join('/');
  const reference = referenced.length > 0 ? ` It referenced host model '${referenced}'` : '';
  return {
    readiness: 'needs_setup',
    reason: `Runtime profile type 'openclaw' is retired (ADR-0029): PD runs internal agents only on its own pi-ai runtime, never through a host CLI agent session.${reference}`,
    nextAction: `Define a pi-ai profile in .pd/config.yaml runtimeProfiles (provider + model + apiKeyEnv) and point this agent's runtimeProfile / internalAgents.defaultRuntime at it, or configure it in the PD console Control Center`,
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
 * For pi-ai profiles (the only executable type, ADR-0029):
 *   - provider, model, apiKeyEnv all set AND apiKeyEnv exists in env → ready
 *   - apiKeyEnv missing from env → not_ready (config is correct but env is not set up)
 *   - provider or model missing → needs_setup (config is incomplete)
 *
 * For legacy openclaw profiles: always needs_setup with the retirement reason
 * and a nextAction pointing at a pi-ai profile. Readiness is never reported as
 * 'ready' for a profile nothing can execute (rc-9).
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
 * For a legacy openclaw profile: throws. The type still parses and still gets
 * reported (read-only legacy, ADR-0029), but readiness already answers
 * needs_setup, so reaching this function with one means a caller bypassed the
 * readiness gate — failing loud is the only honest outcome (rc-3).
 *
 * This is a pure data transform. No I/O, no env access.
 */
export function createAdapterConfigFromProfile(
  profile: RuntimeProfile,
  workspaceDir: string,
): PiAiAdapterConfigResult {
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
    if (profile.reasoning !== undefined) {
      result.reasoning = profile.reasoning;
    }
    if (profile.systemPrompt) {
      result.systemPrompt = profile.systemPrompt;
    }
    return result;
  }

  // ADR-0029: the 'openclaw' backend is retired. Nothing constructs a host CLI
  // agent session any more, so there is no adapter config to return.
  throw new Error(
    `[createAdapterConfigFromProfile] Runtime profile type 'openclaw' is retired (ADR-0029) and cannot ` +
    `produce an adapter config; only 'pi-ai' profiles are executable. ` +
    `nextAction: replace this profile with a pi-ai profile (provider + model + apiKeyEnv) in .pd/config.yaml runtimeProfiles.`,
  );
}
