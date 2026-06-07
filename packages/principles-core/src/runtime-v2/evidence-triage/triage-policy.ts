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

// ── Upgrade Rules ───────────────────────────────────────────────────────────

/**
 * Apply upgrade rules for upgradable source kinds.
 *
 * Currently only 'rulehost_block' can be upgraded:
 * - If isUnsafeHighConfidence is true, upgrade from 'evidence_only' to 'admit'
 *
 * This is the ONLY place where context-dependent upgrades happen in core.
 * The plugin adapter sets isUnsafeHighConfidence based on hook context.
 */
function applyUpgradeRules(input: TriageInput, defaultDecision: TriageDecision): TriageDecision {
  if (input.sourceKind === 'rulehost_block' && input.isUnsafeHighConfidence === true) {
    return 'admit';
  }
  return defaultDecision;
}

function getUpgradeReason(sourceKind: SourceKind, decision: TriageDecision, input: TriageInput): string {
  if (sourceKind === 'rulehost_block' && decision === 'admit') {
    return `RuleHost blocked a high-confidence unsafe action (score=${input.score}). Upgrading to direct diagnosis.`;
  }
  // Should not reach here — fallback
  return `Upgraded decision for ${sourceKind}: ${decision}`;
}

function getUpgradeNextAction(sourceKind: SourceKind, decision: TriageDecision): string {
  if (sourceKind === 'rulehost_block' && decision === 'admit') {
    return 'none';
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

  // Apply upgrade rules for upgradable kinds
  if (descriptor.canUpgrade) {
    const upgraded = applyUpgradeRules(input, descriptor.defaultDecision);
    if (upgraded !== descriptor.defaultDecision) {
      return {
        decision: upgraded,
        sourceKind,
        reason: getUpgradeReason(sourceKind, upgraded, input),
        nextAction: getUpgradeNextAction(sourceKind, upgraded),
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
