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
 *
 * PRI-360 S1: All source-kind resolution now goes through this single entry point.
 */
export { resolveSourceKind, buildToolFailureObservation, buildLlmDetectionObservation, type RawObservation } from './raw-observation-adapter.js';
// All callers should use resolveSourceKind with RawObservation.

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
    consecutiveErrors?: number;
    isRisky?: boolean;
  },
): TriageResult {
  const input: TriageInput = {
    sourceKind,
    score,
    isUnsafeHighConfidence: options?.isUnsafeHighConfidence,
    provenance: options?.provenance,
  };

  let result = evaluateTriage(input);

  // PEAT-B1 upgrade logic: risky high-score overrides evidence_only
  // Matches PainDiagnosticGate.risky_high_score: isRisky && score >= 70 → admit
  if (
    result.decision === 'evidence_only' &&
    options?.isRisky === true &&
    score >= 70
  ) {
    result = {
      ...result,
      decision: 'admit',
      reason: 'Risky high-score operation overrides evidence-only decision. Immediate diagnosis required.',
      nextAction: 'create_diagnostic_task',
    };
  }

  // PEAT-B1 upgrade logic: repeated failures override evidence_only
  // Threshold: 4 consecutive failures (matches PainDiagnosticGate.repeatedFailure)
  if (
    result.decision === 'evidence_only' &&
    options?.consecutiveErrors !== undefined &&
    options.consecutiveErrors >= 4
  ) {
    result = {
      ...result,
      decision: 'admit',
      reason: 'Repeated failures override evidence-only decision. Pattern suggests systemic issue requiring diagnosis.',
      nextAction: 'create_diagnostic_task',
    };
  }

  return result;
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
