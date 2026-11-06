/**
 * Triage Policy — PEAT-B1
 *
 * Pure policy evaluation for pre-diagnosis evidence triage.
 * No I/O, no plugin imports, no side effects.
 *
 * This module evaluates a TriageInput against source descriptors and returns
 * a TriageResult. The plugin adapter calls this function and uses the result to
 * decide whether to proceed to diagnosis.
 *
 * Phase A (legacy retirement): the context-dependent upgrade rules that used to
 * turn technical failures or RuleHost blocks into admitted Pain are gone
 * (`rulehost_block` / `tool_failure` upgrades, risky high-score and
 * `consecutiveErrors >= 4` escalation). Triage is now a pure descriptor
 * evaluation: only Owner-reported / Owner-requested evidence admits.
 *
 * ERR checklist:
 * - ERR-001: No `as` casts. Input validated with runtime guards.
 * - ERR-002: Every result carries structured reason + nextAction.
 * - ERR-005: Input is unknown, validated field-by-field.
 */

import type { SourceKind, TriageResult, TriageInput } from './types.js';
import { isSourceKind } from './types.js';
import { getSourceDescriptor } from './source-descriptors.js';

/**
 * Evaluate triage policy for incoming evidence.
 *
 * This is the pure policy function. It does not:
 * - Write to event log or trajectory
 * - Create diagnostic tasks
 * - Import anything from the plugin layer
 *
 * It only reads source descriptors.
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

  return {
    decision: descriptor.defaultDecision,
    sourceKind,
    reason: descriptor.reason,
    nextAction: descriptor.nextAction,
  };
}
