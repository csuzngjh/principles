/**
 * Raw Observation Adapter — PRI-362
 *
 * Unified source-kind resolution from RawObservation.
 *
 * Replaces scattered resolveSourceKindFrom* functions with a single
 * field-driven adapter that maps observation fields to SourceKind.
 *
 * Field precedence (highest to lowest):
 * 1. isManualEntry → owner_reported
 * 2. isGateBlock → rulehost_block
 * 3. isSubagentError → subagent_error
 * 4. isRateLimit → rate_limit (if true)
 * 5. toolName === 'pain' / 'skill:pain' → agent_on_owner_request (with openclaw_context_bound) / owner_reported
 * 6. failureSource → tool_failure / dispatch_error
 * 7. isGfiTriggered → gfi_threshold
 * 8. detectionSource → llm_paralysis / semantic / empathy_inferred / unknown
 * 9. Fallback → unknown
 *
 * ERR checklist:
 * - ERR-001: Source kind resolved from runtime values, no `as` casts.
 * - ERR-002: Every path returns a valid SourceKind (fallback to 'unknown').
 * - EP-01: Runtime values validated before use.
 */

import type { SourceKind } from '@principles/core/runtime-v2';
import type { RawObservation } from './raw-observation-types.js';

// Re-export RawObservation for plugin consumers
export type { RawObservation } from './raw-observation-types.js';

/**
 * Resolve SourceKind from a unified RawObservation.
 *
 * This function replaces the scattered resolveSourceKindFrom* functions
 * and provides a single entry point for source-kind classification.
 *
 * Field precedence is explicitly defined in the function body to ensure
 * deterministic behavior and make the logic easy to understand and test.
 */
export function resolveSourceKind(observation: RawObservation): SourceKind {
  const {
    isManualEntry,
    isGateBlock,
    isSubagentError,
    isRateLimit,
    toolName,
    failureSource,
    isGfiTriggered,
    detectionSource,
    nonZeroExit,
    timedOut,
    toolNotFound,
  } = observation;

  // Priority 1: Manual entry (CLI, owner-reported)
  if (isManualEntry) {
    return 'owner_reported';
  }

  // Priority 2: Gate block
  if (isGateBlock) {
    return 'rulehost_block';
  }

  // Priority 3: Subagent error
  if (isSubagentError) {
    return 'subagent_error';
  }

  // Priority 4: Provider rate limit (explicit true/false)
  if (isRateLimit === true) {
    return 'rate_limit';
  }
  if (isRateLimit === false) {
    return 'provider_failure';
  }

  // Priority 5: Manual pain tool
  if (toolName === 'pain' || toolName === 'skill:pain') {
    // Match resolveSourceKindFromToolFailure behavior:
    // openclaw_context_bound → agent_on_owner_request
    // other provenance or undefined → owner_reported
    if (observation.provenance === 'openclaw_context_bound') {
      return 'agent_on_owner_request';
    }
    return 'owner_reported';
  }

  // Priority 6: GFI threshold (must check before failure source for LLM detection path)
  if (isGfiTriggered) {
    return 'gfi_threshold';
  }

  // Priority 7: Tool failure / dispatch error
  if (failureSource) {
    // Match resolveSourceKindFromToolFailure behavior:
    // dispatch_error → dispatch_error, anything else → tool_failure
    if (failureSource === 'dispatch_error') {
      return 'dispatch_error';
    }
    return 'tool_failure';
  }

  // Infer failureSource from tool failure indicators if not explicitly set
  if (toolNotFound) {
    return 'dispatch_error';
  }

  // Match classifyToolFailureSource behavior: unknown tool name → dispatch_error
  // BUT only if this looks like a tool failure context (has other tool fields)
  // Otherwise, this is likely a non-tool observation (e.g., LLM detection)
  const hasToolContext = toolName !== undefined || nonZeroExit || timedOut || toolNotFound;
  if (hasToolContext && (!toolName || toolName.trim() === '')) {
    return 'dispatch_error';
  }

  // Exit code-based detection: non-zero exit or timeout → tool_failure
  if (nonZeroExit || timedOut) {
    return 'tool_failure';
  }

  // Priority 8: LLM detection source
  if (detectionSource) {
    // Match resolveSourceKindFromLlmDetection behavior:
    if (detectionSource === 'llm_paralysis') {
      return 'llm_paralysis';
    }
    if (detectionSource.startsWith('llm_')) {
      return 'semantic';
    }
    if (detectionSource === 'user_empathy') {
      return 'empathy_inferred';
    }
  }

  // Fallback: unknown
  return 'unknown';
}

// PRI-360 S1: Legacy resolveSourceKindFrom* functions removed.
// All callers should use resolveSourceKind with RawObservation.