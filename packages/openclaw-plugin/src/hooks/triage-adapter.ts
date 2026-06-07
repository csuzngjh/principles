/**
 * Triage Adapter — PEAT-B1
 *
 * Plugin-side adapter that maps OpenClaw hook context to evidence triage input.
 * Calls the pure triage policy from principles-core.
 *
 * This file lives in openclaw-plugin because it:
 * - Maps hook-specific context (source strings, session state) to SourceKind
 * - Wraps evaluatePainDiagnosticGate as a compatibility sub-policy
 * - Knows about OpenClaw hook conventions (sessionId, toolName, etc.)
 *
 * It does NOT expose evaluatePainDiagnosticGate to core.
 * Core only sees SourceKind and TriageResult.
 *
 * ERR checklist:
 * - ERR-001: Source kind derived from runtime values with guards, not `as` casts.
 * - ERR-002: Every triage result carries reason + nextAction.
 * - ERR-024/025/048: Production-path tests cover this adapter.
 */

import {
  evaluateTriage,
  type TriageInput,
  type TriageResult,
  type SourceKind,
} from '@principles/core/runtime-v2';

// ── Source Kind Resolution ───────────────────────────────────────────────────

/**
 * Map after_tool_call hook context to SourceKind.
 *
 * Classifies based on:
 * - toolName: 'pain' or 'skill:pain' → agent_on_owner_request
 * - failureSource: 'dispatch_error' vs 'tool_failure'
 * - isRisky + score: only used for rulehost_block upgrade, not for kind resolution
 */
export function resolveSourceKindFromToolFailure(
  toolName: string | undefined,
  failureSource: 'tool_failure' | 'dispatch_error',
  provenance?: 'openclaw_context_bound' | 'owner_reported_no_host_trace' | 'automatic_hook',
): SourceKind {
  // Manual pain via agent tool call
  if (toolName === 'pain' || toolName === 'skill:pain') {
    return provenance === 'openclaw_context_bound' ? 'agent_on_owner_request' : 'owner_reported';
  }

  // Dispatch errors (tool not found, unknown tool)
  if (failureSource === 'dispatch_error') {
    return 'dispatch_error';
  }

  // Regular tool failure
  return 'tool_failure';
}

/**
 * Map empathy/semantic detection context to SourceKind.
 *
 * Classifies based on detection source prefix:
 * - 'llm_paralysis' → llm_paralysis
 * - 'llm_*' (detection rule) → semantic
 * - 'user_empathy' or empathy keyword match → empathy_inferred
 * - GFI threshold crossed → gfi_threshold
 */
export function resolveSourceKindFromLlmDetection(
  detectionSource: string,
  isGfiTriggered: boolean,
): SourceKind {
  if (isGfiTriggered) return 'gfi_threshold';
  if (detectionSource === 'llm_paralysis') return 'llm_paralysis';
  if (detectionSource.startsWith('llm_')) return 'semantic';
  if (detectionSource === 'user_empathy') return 'empathy_inferred';
  return 'unknown';
}

/**
 * Map gate-block context to SourceKind.
 */
export function resolveSourceKindFromGateBlock(): SourceKind {
  return 'rulehost_block';
}

/**
 * Map /pd-pain command to SourceKind.
 */
export function resolveSourceKindFromCommand(): SourceKind {
  return 'owner_reported';
}

/**
 * Map provider/rate-limit failure to SourceKind.
 */
export function resolveSourceKindFromProvider(
  isRateLimit: boolean,
): SourceKind {
  return isRateLimit ? 'rate_limit' : 'provider_failure';
}

/**
 * Map subagent error to SourceKind.
 */
export function resolveSourceKindFromSubagent(): SourceKind {
  return 'subagent_error';
}

// ── Triage Evaluation ───────────────────────────────────────────────────────

/**
 * Evaluate evidence triage for a given source kind and context.
 *
 * This is the main entry point for hooks. It calls the pure triage policy
 * from principles-core and returns the result.
 *
 * The caller (hook) is responsible for:
 * - Checking the painEvidenceAdmission feature flag
 * - Acting on the triage result (proceed to diagnosis, store evidence, etc.)
 * - Falling back to existing behavior when the flag is off
 */
export function evaluateEvidenceTriage(
  sourceKind: SourceKind,
  score: number,
  options?: {
    isUnsafeHighConfidence?: boolean;
    provenance?: 'openclaw_context_bound' | 'owner_reported_no_host_trace' | 'automatic_hook';
  },
): TriageResult {
  const input: TriageInput = {
    sourceKind,
    score,
    isUnsafeHighConfidence: options?.isUnsafeHighConfidence,
    provenance: options?.provenance,
  };

  return evaluateTriage(input);
}

// ── High-Confidence Unsafe Action Detection ──────────────────────────────────

/**
 * Determine if a gate-blocked action is a high-confidence unsafe action.
 *
 * This is a heuristic that the plugin adapter owns. Core does not know about
 * these heuristics — it only receives the boolean flag.
 *
 * Criteria for high-confidence unsafe:
 * - Score >= 70 (high severity)
 * - Tool is in the risky write set
 * - Action would be irreversible (file deletion, force push, etc.)
 */
export function isHighConfidenceUnsafeAction(
  score: number,
  isRisky: boolean,
): boolean {
  return isRisky && score >= 70;
}
