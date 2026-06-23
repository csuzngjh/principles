/**
 * Triage Policy — PEAT-B1
 *
 * Pure policy evaluation for pre-diagnosis evidence triage.
 * No I/O, no plugin imports, no side effects.
 *
 * This module evaluates a TriageInput against source descriptors
 * and returns a TriageResult. The plugin adapter calls this function
 * and uses the result to decide whether to proceed to diagnosis.
 *
 * ERR checklist:
 * - ERR-001: No `as` casts. Input validated with runtime guards.
 * - ERR-002: Every result carries structured reason + nextAction.
 * - ERR-005: Input is unknown, validated field-by-field.
 */

import type { SourceKind, TriageDecision, TriageInput, TriageResult } from './types.js';
import { isSourceKind } from './types.js';
import { getSourceDescriptor } from './source-descriptors.js';

// ── Upgrade Thresholds (PRI-446 — migrated verbatim from the plugin adapter) ──
//
// These constants previously lived inline in the plugin-side triage-adapter
// as magic numbers `70` and `4`. They are moved here byte-for-byte so the
// upgrade decision has a single source of truth. The adapter now passes
// isRisky / consecutiveErrors through to core instead of overriding the result.

/** Pain score at or above which a risky action upgrades to admit. */
export const RISKY_HIGH_SCORE_THRESHOLD = 70;
/** Consecutive failures at or above which a tool failure upgrades to admit. */
export const REPEATED_FAILURE_THRESHOLD = 4;

// ── Upgrade Rules ───────────────────────────────────────────────────────────

/**
 * Apply upgrade rules for upgradable source kinds.
 *
 * Three rules (PRI-446 consolidated all of them into core):
 * 1. rulehost_block + isUnsafeHighConfidence → admit
 * 2. tool_failure (or any evidence_only upgradeable kind) + isRisky + score >= 70 → admit
 * 3. tool_failure (or any evidence_only upgradeable kind) + consecutiveErrors >= 4 → admit
 *
 * This is the ONLY place where context-dependent upgrades happen in core.
 * The plugin adapter sets the context flags based on hook context.
 *
 * Rule precedence matches the prior plugin implementation: risky high-score is
 * checked before repeated failure, but since both produce the same upgraded
 * decision with the same nextAction, the order is only observable via the
 * reason string. We preserve the plugin's prior order (risky first).
 */
function applyUpgradeRules(input: TriageInput, defaultDecision: TriageDecision): TriageDecision {
  if (defaultDecision !== 'evidence_only') {
    return defaultDecision;
  }

  // Rule 1: rulehost_block unsafe action (pre-existing).
  if (input.sourceKind === 'rulehost_block' && input.isUnsafeHighConfidence === true) {
    return 'admit';
  }

  // Rule 2: risky high-score (migrated from plugin, PRI-446).
  if (input.isRisky === true && input.score >= RISKY_HIGH_SCORE_THRESHOLD) {
    return 'admit';
  }

  // Rule 3: repeated failure (migrated from plugin, PRI-446).
  if (input.consecutiveErrors !== undefined && input.consecutiveErrors >= REPEATED_FAILURE_THRESHOLD) {
    return 'admit';
  }

  return defaultDecision;
}

function getUpgradeReason(sourceKind: SourceKind, decision: TriageDecision, input: TriageInput): string {
  if (decision !== 'admit') {
    return `Upgraded decision for ${sourceKind}: ${decision}`;
  }

  if (sourceKind === 'rulehost_block' && input.isUnsafeHighConfidence === true) {
    return `RuleHost blocked a high-confidence unsafe action (score=${input.score}). Upgrading to direct diagnosis.`;
  }

  // PRI-446: verbatim string from the plugin triage-adapter
  if (input.isRisky === true && input.score >= RISKY_HIGH_SCORE_THRESHOLD) {
    return 'Risky high-score operation overrides evidence-only decision. Immediate diagnosis required.';
  }

  // PRI-446: verbatim string from the plugin triage-adapter
  if (input.consecutiveErrors !== undefined && input.consecutiveErrors >= REPEATED_FAILURE_THRESHOLD) {
    return 'Repeated failures override evidence-only decision. Pattern suggests systemic issue requiring diagnosis.';
  }

  // Should not reach here — fallback
  return `Upgraded decision for ${sourceKind}: ${decision}`;
}

function getUpgradeNextAction(sourceKind: SourceKind, decision: TriageDecision, input: TriageInput): string {
  if (decision !== 'admit') {
    return 'none';
  }

  if (sourceKind === 'rulehost_block' && input.isUnsafeHighConfidence === true) {
    return 'none';
  }

  // PRI-446: verbatim nextAction from the plugin triage-adapter
  // (both risky-high-score and repeated-failure used 'create_diagnostic_task').
  if (
    (input.isRisky === true && input.score >= RISKY_HIGH_SCORE_THRESHOLD) ||
    (input.consecutiveErrors !== undefined && input.consecutiveErrors >= REPEATED_FAILURE_THRESHOLD)
  ) {
    return 'create_diagnostic_task';
  }

  return 'none';
}

// ── Evaluation ──────────────────────────────────────────────────────────────

/**
 * Evaluate triage policy for incoming evidence.
 *
 * This is the pure policy function. It does not:
 * - Call PainDiagnosticGate
 * - Write to event log or trajectory
 * - Create diagnostic tasks
 * - Import anything from the plugin layer
 *
 * It only reads source descriptors and applies policy rules.
 *
 * @param input - Triage input with source kind and context
 * @returns Structured triage result with decision, reason, and nextAction
 */
export function evaluateTriage(input: TriageInput): TriageResult {
  // ERR-001: validate sourceKind with runtime guard
  const sourceKind: SourceKind = isSourceKind(input.sourceKind) ? input.sourceKind : 'unknown';

  // Look up descriptor
  const descriptor = getSourceDescriptor(sourceKind);
  if (!descriptor) {
    // Fallback for unregistered kinds (should not happen with 'unknown' in registry)
    return {
      decision: 'evidence_only',
      sourceKind: 'unknown',
      reason: `Source kind '${sourceKind}' not found in descriptor registry. Conservative default.`,
      nextAction: 'classify_source_kind_and_store_as_evidence',
    };
  }

  // Apply upgrade rules. PRI-446: rule 1 (rulehost_block) is gated by
  // descriptor.canUpgrade; rules 2/3 (risky high-score / repeated failure) are
  // context-driven and apply to any evidence_only kind when the relevant flag is
  // present, matching the prior plugin behavior. applyUpgradeRules internally
  // guards on defaultDecision === 'evidence_only', so non-upgradeable kinds
  // (admit/health_only/owner_confirm) are never affected.
  const upgradeable =
    descriptor.canUpgrade ||
    input.isRisky !== undefined ||
    input.consecutiveErrors !== undefined;
  if (upgradeable) {
    const upgraded = applyUpgradeRules(input, descriptor.defaultDecision);
    if (upgraded !== descriptor.defaultDecision) {
      return {
        decision: upgraded,
        sourceKind,
        reason: getUpgradeReason(sourceKind, upgraded, input),
        nextAction: getUpgradeNextAction(sourceKind, upgraded, input),
      };
    }
  }

  return {
    decision: descriptor.defaultDecision,
    sourceKind,
    reason: descriptor.reason,
    nextAction: descriptor.nextAction,
  };
}
