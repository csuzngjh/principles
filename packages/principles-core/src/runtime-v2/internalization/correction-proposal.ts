/**
 * CorrectionProposal — Pure domain types and validators for auto-correction
 *
 * PRI-114: Extends RuleHost with auto_correct decision support.
 * Proposes parameter corrections but never applies them directly.
 *
 * TRUST BOUNDARY:
 *   - Pure functions only, zero side effects
 *   - No filesystem, VM, process, or network access
 *   - All validation is fail-closed (invalid -> rejected, never applied)
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CorrectionProposal {
  proposedParams: Record<string, unknown>;
  correctedFields: {
    field: string;
    original: unknown;
    proposed: unknown;
    reason: string;
  }[];
  applicationMode: 'shadow' | 'live';
  confidence: number;
  ruleId: string;
  principleId?: string;
  notifyAgent: boolean;
}

export interface CorrectionProposalValidationResult {
  valid: boolean;
  errors: string[];
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const IDENTITY_FIELDS = new Set(['toolName', 'sessionId']);

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isJsonSerializable(value: unknown, seen: Set<unknown> = new Set()): boolean {
  if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return true;
  }
  if (typeof value === 'function' || typeof value === 'symbol' || typeof value === 'undefined' || typeof value === 'bigint') {
    return false;
  }
  if (typeof value !== 'object') {
    return false;
  }
  if (seen.has(value)) {
    return false;
  }
  seen.add(value);
  if (Array.isArray(value)) {
    return value.every(item => isJsonSerializable(item, seen));
  }
  return Object.values(value as Record<string, unknown>).every(v => isJsonSerializable(v, seen));
}

// ---------------------------------------------------------------------------
// validateProposedParams
// ---------------------------------------------------------------------------

export function validateProposedParams(
  proposedParams: unknown,
  originalParams: Record<string, unknown>,
): CorrectionProposalValidationResult {
  const errors: string[] = [];

  if (!isPlainObject(proposedParams)) {
    const type = proposedParams === null ? 'null'
      : Array.isArray(proposedParams) ? 'array'
      : typeof proposedParams;
    errors.push(`proposedParams must be a plain object, got ${type}`);
    return { valid: false, errors };
  }

  for (const key of Object.keys(proposedParams)) {
    const value = proposedParams[key];

    if (IDENTITY_FIELDS.has(key)) {
      errors.push(`proposedParams must not modify identity field "${key}"`);
      continue;
    }

    if (!(key in originalParams)) {
      errors.push(`proposedParams key "${key}" is not present in original params`);
      continue;
    }

    if (typeof value === 'function') {
      errors.push(`proposedParams["${key}"] contains a Function value (not JSON-serializable)`);
    } else if (typeof value === 'undefined') {
      errors.push(`proposedParams["${key}"] contains undefined (not JSON-serializable)`);
    } else if (typeof value === 'symbol') {
      errors.push(`proposedParams["${key}"] contains a Symbol value (not JSON-serializable)`);
    } else if (typeof value === 'bigint') {
      errors.push(`proposedParams["${key}"] contains a BigInt value (not JSON-serializable)`);
    }
  }

  // Always check serializability regardless of other errors
  if (!isJsonSerializable(proposedParams)) {
    errors.push('proposedParams contains a circular reference (not JSON-serializable)');
  }

  return { valid: errors.length === 0, errors };
}

// ---------------------------------------------------------------------------
// validateCorrectionProposal
// ---------------------------------------------------------------------------

export function validateCorrectionProposal(
  proposal: unknown,
): CorrectionProposalValidationResult {
  const errors: string[] = [];

  if (!isPlainObject(proposal)) {
    errors.push('proposal must be a plain object');
    return { valid: false, errors };
  }

  // proposedParams — required, must be a plain object
  if (!('proposedParams' in proposal)) {
    errors.push('proposedParams is required');
  } else if (!isPlainObject(proposal.proposedParams)) {
    errors.push('proposedParams must be a plain object');
  } else if (!isJsonSerializable(proposal.proposedParams)) {
    errors.push('proposedParams is not JSON-serializable');
  }

  // correctedFields — required, must be array
  if (!('correctedFields' in proposal)) {
    errors.push('correctedFields is required');
  } else if (!Array.isArray(proposal.correctedFields)) {
    errors.push('correctedFields must be an array');
  }

  // applicationMode — required, must be 'shadow' or 'live'
  if (!('applicationMode' in proposal)) {
    errors.push('applicationMode is required');
  } else if (proposal.applicationMode !== 'shadow' && proposal.applicationMode !== 'live') {
    errors.push(`applicationMode must be "shadow" or "live", got "${String(proposal.applicationMode)}"`);
  }

  // confidence — required, number in [0, 1]
  if (!('confidence' in proposal)) {
    errors.push('confidence is required');
  } else if (typeof proposal.confidence !== 'number' || !Number.isFinite(proposal.confidence) || proposal.confidence < 0 || proposal.confidence > 1) {
    errors.push(`confidence must be a number in [0, 1], got ${String(proposal.confidence)}`);
  }

  // ruleId — required, non-empty string
  if (!('ruleId' in proposal)) {
    errors.push('ruleId is required');
  } else if (typeof proposal.ruleId !== 'string' || proposal.ruleId.length === 0) {
    errors.push('ruleId must be a non-empty string');
  }

  // notifyAgent — required, boolean
  if (!('notifyAgent' in proposal)) {
    errors.push('notifyAgent is required');
  } else if (typeof proposal.notifyAgent !== 'boolean') {
    errors.push(`notifyAgent must be a boolean, got ${typeof proposal.notifyAgent}`);
  }

  return { valid: errors.length === 0, errors };
}
