/**
 * Rule Host Result Validator — Runtime validation for untrusted VM output
 *
 * PURPOSE: Validate that a value returned by a VM-executed evaluate() function
 * conforms to the RuleHostResult contract before it reaches merge/mutation.
 *
 * TRUST BOUNDARY:
 *   - All VM output is treated as `unknown` (ERR-001: no `as` bypass)
 *   - Uses Object.hasOwn for untrusted key checks (ERR-013)
 *   - Fail-closed: invalid results are rejected, never enforced (ERR-002)
 *
 * PRI-437: Extracted from demo-rule-compiler.ts isRuleHostResult() and
 * productionized as the shared validator for both production RuleHost
 * and demo/test compilers (ERR-024: validator wired into production).
 */

import type { RuleHostDecision } from './rule-host-contracts.js';
import { validateCorrectionProposal } from './correction-proposal.js';

export interface RuleHostResultValidationResult {
  valid: boolean;
  errors: string[];
}

const VALID_DECISIONS: ReadonlySet<string> = new Set([
  'allow',
  'block',
  'requireApproval',
  'auto_correct',
]);

const PROTOTYPE_POLLUTION_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * Check that a value is a record-like object (non-null, non-array, typeof object).
 *
 * Note: We intentionally do NOT check Object.getPrototypeOf() here because
 * VM-executed code creates objects whose prototype belongs to the VM context's
 * realm, not the host realm. The prototype pollution check is handled
 * separately via Object.hasOwn for __proto__/constructor/prototype keys.
 */
function isRecordLike(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Type guard for RuleHostDecision (ERR-001: no `as` bypass).
 * Checks typeof string + membership in VALID_DECISIONS without a cast.
 */
function isRuleHostDecision(value: unknown): value is RuleHostDecision {
  return typeof value === 'string' && VALID_DECISIONS.has(value);
}

/**
 * Validate that an untrusted value conforms to the RuleHostResult contract.
 *
 * Checks:
 *   - Value is a plain object (not null, array, or non-object)
 *   - No prototype pollution keys (__proto__, constructor, prototype)
 *   - decision: required, one of allow|block|requireApproval|auto_correct
 *   - matched: required, boolean
 *   - reason: required, string
 *   - diagnostics: optional, plain object if present
 *   - ruleId: optional, string if present
 *   - principleId: optional, string if present
 *   - correctionProposal: required when decision is auto_correct, must pass validateCorrectionProposal
 *
 * @returns { valid: boolean, errors: string[] }
 */
export function validateRuleHostResult(value: unknown): RuleHostResultValidationResult {
  const errors: string[] = [];

  if (!isRecordLike(value)) {
    const type = value === null ? 'null'
      : Array.isArray(value) ? 'array'
      : typeof value;
    errors.push(`result must be a plain object, got ${type}`);
    return { valid: false, errors };
  }

  // Prototype pollution check (ERR-013: Object.hasOwn for untrusted keys)
  for (const ppKey of PROTOTYPE_POLLUTION_KEYS) {
    if (Object.hasOwn(value, ppKey)) {
      errors.push(`result must not contain prototype pollution key "${ppKey}"`);
    }
  }

  // decision — required, must be one of the four valid values
  if (!Object.hasOwn(value, 'decision')) {
    errors.push('decision is required');
  } else {
    const { decision } = value;
    if (typeof decision !== 'string' || !isRuleHostDecision(decision)) {
      errors.push(
        `decision must be one of allow|block|requireApproval|auto_correct, got ${String(decision)}`
      );
    }
  }

  // matched — required, must be boolean
  if (!Object.hasOwn(value, 'matched')) {
    errors.push('matched is required');
  } else if (typeof value.matched !== 'boolean') {
    errors.push(`matched must be a boolean, got ${typeof value.matched}`);
  }

  // PRI-439 Phase 2: when matched=false, decision must be 'allow'.
  // A `matched=false, decision='block'` result is contradictory —
  // "the rule did not match, but I want to block" makes no sense.
  // This is checked AFTER both matched and decision are individually validated
  // so we only run the cross-field check when both fields are present and valid.
  if (
    Object.hasOwn(value, 'matched') &&
    typeof value.matched === 'boolean' &&
    value.matched === false &&
    Object.hasOwn(value, 'decision') &&
    typeof value.decision === 'string' &&
    isRuleHostDecision(value.decision) &&
    value.decision !== 'allow'
  ) {
    errors.push(
      `matched=false requires decision 'allow', got '${value.decision}'`,
    );
  }

  // reason — required, must be string
  if (!Object.hasOwn(value, 'reason')) {
    errors.push('reason is required');
  } else if (typeof value.reason !== 'string') {
    errors.push(`reason must be a string, got ${typeof value.reason}`);
  }

  // diagnostics — optional, must be plain object if present
  if (Object.hasOwn(value, 'diagnostics') && value.diagnostics !== undefined) {
    const diag = value.diagnostics;
    if (!isRecordLike(diag)) {
      errors.push('diagnostics must be a plain object if present');
    } else {
      // PRI-437 Slice 5: Adversarial RuleCode may inject __proto__/constructor
      // as own properties on diagnostics. Reject these to prevent prototype
      // pollution from leaking into downstream consumers (ERR-013).
      for (const ppKey of PROTOTYPE_POLLUTION_KEYS) {
        if (Object.hasOwn(diag, ppKey)) {
          errors.push(`diagnostics must not contain prototype pollution key "${ppKey}"`);
        }
      }
    }
  }

  // ruleId — optional, must be string if present
  if (Object.hasOwn(value, 'ruleId') && value.ruleId !== undefined) {
    if (typeof value.ruleId !== 'string') {
      errors.push(`ruleId must be a string if present, got ${typeof value.ruleId}`);
    }
  }

  // principleId — optional, must be string if present
  if (Object.hasOwn(value, 'principleId') && value.principleId !== undefined) {
    if (typeof value.principleId !== 'string') {
      errors.push(`principleId must be a string if present, got ${typeof value.principleId}`);
    }
  }

  // correctionProposal — required when decision is 'auto_correct'
  if (value.decision === 'auto_correct') {
    if (!Object.hasOwn(value, 'correctionProposal') || value.correctionProposal === undefined) {
      errors.push('correctionProposal is required when decision is auto_correct');
    } else {
      const proposalValidation = validateCorrectionProposal(value.correctionProposal);
      if (!proposalValidation.valid) {
        errors.push(`correctionProposal invalid: ${proposalValidation.errors.join('; ')}`);
      }
    }
  }

  return { valid: errors.length === 0, errors };
}
