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
 * Map RawObservation to SourceKind.
 *
 * This is the unified entry point for source-kind classification.
 * It replaces the scattered resolveSourceKindFrom* functions.
 */
export { resolveSourceKind } from './raw-observation-adapter.js';

/**
 * Map after_tool_call hook context to SourceKind.
 *
 * @deprecated Use resolveSourceKind directly with RawObservation.
 */
export { resolveSourceKindFromToolFailure } from './raw-observation-adapter.js';

/**
 * Map empathy/semantic detection context to SourceKind.
 *
 * @deprecated Use resolveSourceKind directly with RawObservation.
 */
export { resolveSourceKindFromLlmDetection } from './raw-observation-adapter.js';

/**
 * Map gate-block context to SourceKind.
 *
 * @deprecated Use resolveSourceKind directly with RawObservation.
 */
export { resolveSourceKindFromGateBlock } from './raw-observation-adapter.js';

/**
 * Map /pd-pain command to SourceKind.
 *
 * @deprecated Use resolveSourceKind directly with RawObservation.
 */
export { resolveSourceKindFromCommand } from './raw-observation-adapter.js';

/**
 * Map provider/rate-limit failure to SourceKind.
 *
 * @deprecated Use resolveSourceKind directly with RawObservation.
 */
export { resolveSourceKindFromProvider } from './raw-observation-adapter.js';

/**
 * Map subagent error to SourceKind.
 *
 * @deprecated Use resolveSourceKind directly with RawObservation.
 */
export { resolveSourceKindFromSubagent } from './raw-observation-adapter.js';

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
