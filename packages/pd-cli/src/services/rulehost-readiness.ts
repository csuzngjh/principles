/**
 * RuleHost Readiness Resolver — PRI-461
 *
 * Checks all preconditions for `run-rulehost` BEFORE constructing adapters,
 * returning one of three user-visible statuses:
 *   - `ready`: all agents enabled with pi-ai profiles and API keys; code-rule capability ON
 *   - `text_principle_only`: dreamer/philosopher/scribe ready, but code-rule capability OFF
 *     (flag disabled, or artificer/evaluator not ready)
 *   - `refused`: dreamer/philosopher/scribe chain broken (disabled, wrong profile, missing API key,
 *     or config malformed)
 *
 * This module NEVER throws. It always returns a structured result with reason + nextAction,
 * so the CLI handler can emit a clear status instead of an opaque adapter-resolution failure.
 *
 * ERR refs:
 *   - EP-02 / ERR-024, ERR-025: wired into the production handler path (runtime-internalization-run-rulehost.ts)
 *   - EP-03: refused/text_principle_only include reason + nextAction
 *   - EP-07: uses the same config source as the pipeline (resolveRuntimeFromPdConfig)
 *   - EP-09: tests cover the default installed config pattern
 */

import {
  resolveAgentRuntimeBinding,
  checkAgentRuntimeReadiness,
  computeFeatureFlagsFromConfig,
  isFeatureEnabled,
} from '@principles/core/runtime-v2';
import type {
  EffectivePdConfig,
  InternalAgentName,
  RuntimeProfile,
} from '@principles/core/runtime-v2';
import { resolveRuntimeFromPdConfig } from './resolve-runtime-from-pd-config.js';

// ── Types ────────────────────────────────────────────────────────────────────

export type RuleHostReadinessStatus = 'ready' | 'text_principle_only' | 'refused';

export interface AgentReadiness {
  readonly status: 'ready' | 'disabled' | 'not_ready' | 'needs_setup' | 'wrong_profile_type';
  readonly reason?: string;
  readonly nextAction?: string;
  readonly profileId?: string;
  readonly profileType?: string;
}

export interface CodeRuleCapabilityReadiness {
  readonly enabled: boolean;
  readonly disabledReason?: string;
}

export interface RuleHostReadinessResult {
  readonly status: RuleHostReadinessStatus;
  readonly reason: string;
  readonly nextAction: string;
  readonly agentStatuses: {
    readonly dreamer: AgentReadiness;
    readonly philosopher: AgentReadiness;
    readonly scribe: AgentReadiness;
    readonly artificer: AgentReadiness;
    readonly evaluator: AgentReadiness;
  };
  readonly codeRuleCapability: CodeRuleCapabilityReadiness;
}

// ── Constants ─────────────────────────────────────────────────────────────────

/**
 * Agents required for the text-principle path (dreamer → philosopher → scribe).
 * If any of these is not ready, the pipeline cannot produce even text principles.
 */
const REQUIRED_AGENTS: readonly InternalAgentName[] = ['dreamer', 'philosopher', 'scribe'];

/**
 * Agents required for the code-rule capability (artificer + evaluator).
 * Both must be ready for the adversarial loop to run.
 */
const CODE_RULE_AGENTS: readonly InternalAgentName[] = ['artificer', 'evaluator'];

// ── Implementation ────────────────────────────────────────────────────────────

/**
 * Check a single agent's readiness for the RuleHost pipeline.
 *
 * Checks (in order):
 *   1. Agent enabled (via resolveAgentRuntimeBinding)
 *   2. Profile exists (via resolveAgentRuntimeBinding)
 *   3. Profile type is 'pi-ai' (RuleHost needs PiAiRuntimeAdapter)
 *   4. Profile is ready (via checkAgentRuntimeReadiness — provider/model/apiKeyEnv set, env var exists)
 *
 * Returns a structured AgentReadiness result. Never throws.
 */
function checkAgentReadiness(
  effective: EffectivePdConfig,
  agentName: InternalAgentName,
  getEnvVar: (name: string) => string | undefined,
): AgentReadiness {
  const binding = resolveAgentRuntimeBinding(effective, agentName);

  if (!binding.ok) {
    return {
      status: binding.readiness === 'disabled' ? 'disabled' : binding.readiness === 'needs_setup' ? 'needs_setup' : 'not_ready',
      reason: binding.reason,
      nextAction: binding.nextAction,
    };
  }

  const profile: RuntimeProfile = binding.profile;
  const profileType = profile.type;

  // RuleHost pipeline constructs PiAiRuntimeAdapter instances, so the profile
  // must be pi-ai. OpenClaw profiles delegate to OpenClaw's own runtime, which
  // is not available in the RuleHost pipeline context.
  if (profileType !== 'pi-ai') {
    return {
      status: 'wrong_profile_type',
      reason: `Agent '${agentName}' uses profile '${binding.profileId}' with type '${profileType}', but RuleHost requires pi-ai profile type`,
      nextAction: `Add a pi-ai runtime profile to .pd/config.yaml and assign it to ${agentName} via internalAgents.agents.${agentName}.runtimeProfile`,
      profileId: binding.profileId,
      profileType,
    };
  }

  const readiness = checkAgentRuntimeReadiness(profile, getEnvVar);
  if (readiness.readiness !== 'ready') {
    return {
      status: readiness.readiness === 'needs_setup' ? 'needs_setup' : 'not_ready',
      reason: readiness.reason,
      nextAction: readiness.nextAction,
      profileId: binding.profileId,
      profileType,
    };
  }

  return {
    status: 'ready',
    profileId: binding.profileId,
    profileType,
  };
}

// ── Helpers (defined before public function to satisfy no-use-before-define) ──

interface ReadinessResultParts {
  readonly agentStatuses: RuleHostReadinessResult['agentStatuses'];
  readonly codeRuleCapability: CodeRuleCapabilityReadiness;
}

function emptyAgentStatuses(): RuleHostReadinessResult['agentStatuses'] {
  const empty: AgentReadiness = { status: 'not_ready', reason: 'not checked' };
  return {
    dreamer: empty,
    philosopher: empty,
    scribe: empty,
    artificer: empty,
    evaluator: empty,
  };
}

function buildRefusedResult(
  reason: string,
  nextAction: string,
  parts: ReadinessResultParts,
): RuleHostReadinessResult {
  return {
    status: 'refused',
    reason,
    nextAction,
    agentStatuses: parts.agentStatuses,
    codeRuleCapability: parts.codeRuleCapability,
  };
}

function buildTextPrincipleOnlyResult(
  reason: string,
  nextAction: string,
  parts: ReadinessResultParts,
): RuleHostReadinessResult {
  return {
    status: 'text_principle_only',
    reason,
    nextAction,
    agentStatuses: parts.agentStatuses,
    codeRuleCapability: parts.codeRuleCapability,
  };
}

/**
 * Resolve RuleHost readiness from the workspace's .pd/config.yaml.
 *
 * This is the production entry point called by the `run-rulehost` handler
 * BEFORE constructing any adapters. It returns a structured result so the
 * handler can emit a clear status instead of an opaque adapter-resolution failure.
 *
 * @param workspaceDir - The workspace directory containing .pd/config.yaml
 * @param getEnvVar - Env var accessor, defaults to process.env. Injected for testability.
 * @returns Structured readiness result. Never throws.
 */
export function resolveRuleHostReadiness(
  workspaceDir: string,
  getEnvVar: (name: string) => string | undefined = (name) => process.env[name],
): RuleHostReadinessResult {
  // ── Step 1: Load config ──
  const { configLoadResult } = resolveRuntimeFromPdConfig(workspaceDir, getEnvVar);

  if (!configLoadResult.ok) {
    const [firstError] = configLoadResult.errors;
    const reason = `config_malformed: ${firstError?.reason ?? 'unknown config error'}`;
    const nextAction = firstError?.nextAction ?? 'Fix .pd/config.yaml syntax and retry';
    return buildRefusedResult(reason, nextAction, {
      agentStatuses: emptyAgentStatuses(),
      codeRuleCapability: { enabled: false, disabledReason: 'config_malformed' },
    });
  }

  const { effective } = configLoadResult;

  // ── Step 2: Check required agents (dreamer, philosopher, scribe) ──
  // Build agentStatuses with all 5 keys from the start to avoid `as` casts.
  const unchecked: AgentReadiness = { status: 'not_ready', reason: 'not checked' };
  const agentStatuses: RuleHostReadinessResult['agentStatuses'] = {
    dreamer: unchecked,
    philosopher: unchecked,
    scribe: unchecked,
    artificer: unchecked,
    evaluator: unchecked,
  };
  const requiredFailures: string[] = [];

  for (const agentName of REQUIRED_AGENTS) {
    const readiness = checkAgentReadiness(effective, agentName, getEnvVar);
    agentStatuses[agentName] = readiness;
    if (readiness.status !== 'ready') {
      requiredFailures.push(`${agentName}: ${readiness.reason ?? readiness.status}`);
    }
  }

  if (requiredFailures.length > 0) {
    const reason = `required_agents_not_ready: ${requiredFailures.join('; ')}`;
    const nextAction = `Fix the following agent issues in .pd/config.yaml: ${requiredFailures.join('; ')}. RuleHost requires dreamer, philosopher, and scribe agents to be enabled with pi-ai runtime profiles and valid API keys.`;
    return buildRefusedResult(reason, nextAction, {
      agentStatuses,
      codeRuleCapability: { enabled: false, disabledReason: 'required_agents_not_ready' },
    });
  }

  // ── Step 3: Check code_rule_capability feature flag ──
  const featureFlags = computeFeatureFlagsFromConfig(effective);
  if (!isFeatureEnabled(featureFlags, 'code_rule_capability')) {
    const reason = 'code_rule_capability feature flag is disabled';
    const nextAction = "Enable code_rule_capability in .pd/config.yaml features.code_rule_capability.enabled to run the full adversarial pipeline. Text-principle-only mode is available.";
    // Still check artificer/evaluator for reporting, but they don't affect the status
    for (const agentName of CODE_RULE_AGENTS) {
      agentStatuses[agentName] = checkAgentReadiness(effective, agentName, getEnvVar);
    }
    return buildTextPrincipleOnlyResult(reason, nextAction, {
      agentStatuses,
      codeRuleCapability: { enabled: false, disabledReason: reason },
    });
  }

  // ── Step 4: Check code-rule agents (artificer, evaluator) ──
  const codeRuleFailures: string[] = [];

  for (const agentName of CODE_RULE_AGENTS) {
    const readiness = checkAgentReadiness(effective, agentName, getEnvVar);
    agentStatuses[agentName] = readiness;
    if (readiness.status !== 'ready') {
      codeRuleFailures.push(`${agentName}: ${readiness.reason ?? readiness.status}`);
    }
  }

  if (codeRuleFailures.length > 0) {
    const reason = `code_rule_agents_not_ready: ${codeRuleFailures.join('; ')}`;
    const nextAction = `Fix the following agent issues to enable code-rule capability: ${codeRuleFailures.join('; ')}. Text-principle-only mode is available with the current configuration.`;
    return buildTextPrincipleOnlyResult(reason, nextAction, {
      agentStatuses,
      codeRuleCapability: { enabled: false, disabledReason: reason },
    });
  }

  // ── Step 5: All checks pass → ready ──
  return {
    status: 'ready',
    reason: 'All agents ready with pi-ai profiles and valid API keys. Code-rule capability is ON.',
    nextAction: 'Pass --confirm to run the full pipeline.',
    agentStatuses,
    codeRuleCapability: { enabled: true },
  };
}
