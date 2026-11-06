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

const PATH_FIELDS = new Set(['file_path', 'path', 'filePath']);

const PROTOTYPE_POLLUTION_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

const SELF_MODIFICATION_PATTERNS = [
  /\.principles[\\/]/i,
  /\.pd[\\/]/i,
  /\.openclaw[\\/]/i,
  /principles-disciple/i,
  /openclaw\.plugin\.json/i,
  /rule-host/i,
  /nocturnal-/i,
  /symphony/i,
];

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Check that a value is a record-like object (non-null, non-array, typeof object).
 *
 * PRI-437: We intentionally do NOT check Object.getPrototypeOf() here because
 * VM-executed code creates objects whose prototype belongs to the VM context's
 * realm, not the host realm. Using Object.getPrototypeOf() === Object.prototype
 * would reject all valid auto_correct proposals from VM-executed RuleCode.
 *
 * Prototype pollution is handled separately via Object.hasOwn checks for
 * __proto__/constructor/prototype keys in the validators below.
 */
function isRecordLike(value: unknown): value is Record<string, unknown> {
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
  try {
    if (Array.isArray(value)) {
      return value.every(item => isJsonSerializable(item, seen));
    }
    return Object.values(value as Record<string, unknown>).every(v => isJsonSerializable(v, seen));
  } catch {
    return false;
  } finally {
    seen.delete(value);
  }
}

// ---------------------------------------------------------------------------
// Path boundary validation (PRI-210)
// ---------------------------------------------------------------------------

export interface PathValidationResult {
  valid: boolean;
  reason: string;
}

export function isPathWithinWorkspace(
  proposedPath: string,
  workspaceDir: string,
): PathValidationResult {
  if (typeof proposedPath !== 'string' || proposedPath.trim().length === 0) {
    return { valid: false, reason: 'proposed path is empty or not a string' };
  }

  const normalizedPath = proposedPath.replace(/\\/g, '/').replace(/\/+/g, '/');
  const normalizedWorkspace = workspaceDir.replace(/\\/g, '/').replace(/\/+/g, '/').replace(/\/+$/, '');

  if (/^\\\\/.test(proposedPath) || /^\/\/[^/]/.test(proposedPath)) {
    return { valid: false, reason: `UNC/network path not allowed: ${proposedPath}` };
  }

  function resolveSegments(path: string): string[] {
    const segments = path.split('/').filter(s => s.length > 0);
    const resolved: string[] = [];
    for (const seg of segments) {
      if (seg === '..') {
        if (resolved.length > 0) resolved.pop();
      } else if (seg !== '.') {
        resolved.push(seg);
      }
    }
    return resolved;
  }

  function isWithin(pathSegs: string[], wsSegs: string[], caseInsensitive: boolean): boolean {
    if (wsSegs.length > pathSegs.length) return false;
    for (let i = 0; i < wsSegs.length; i++) {
      const pSeg = pathSegs[i] ?? '';
      const wSeg = wsSegs[i] ?? '';
      const p = caseInsensitive ? pSeg.toLowerCase() : pSeg;
      const w = caseInsensitive ? wSeg.toLowerCase() : wSeg;
      if (p !== w) return false;
    }
    return true;
  }

  const pathIsWindowsDrive = normalizedPath.length >= 2 && normalizedPath[1] === ':';
  const wsIsWindowsDrive = normalizedWorkspace.length >= 2 && normalizedWorkspace[1] === ':';
  const pathIsPosixAbsolute = !pathIsWindowsDrive && normalizedPath.startsWith('/');
  const wsIsPosixAbsolute = !wsIsWindowsDrive && normalizedWorkspace.startsWith('/');
  const caseInsensitive = pathIsWindowsDrive && wsIsWindowsDrive;

  function resolveWorkspaceSegments(): string[] {
    if (wsIsWindowsDrive) return resolveSegments(normalizedWorkspace.substring(2));
    if (wsIsPosixAbsolute) return resolveSegments(normalizedWorkspace.substring(1));
    return resolveSegments(normalizedWorkspace);
  }

  const wsSegments = resolveWorkspaceSegments();

  function resolvePathSegments(): string[] {
    if (pathIsWindowsDrive) {
      const driveLetter = (normalizedPath[0] ?? '').toUpperCase();
      const workspaceDrive = (normalizedWorkspace[0] ?? '').toUpperCase();
      if (driveLetter !== workspaceDrive) {
        return [];
      }
      return resolveSegments(normalizedPath.substring(2));
    }
    if (pathIsPosixAbsolute) {
      return resolveSegments(normalizedPath.substring(1));
    }
    const rawSegments = normalizedPath.split('/').filter(s => s.length > 0);
    const resolved = [...wsSegments];
    for (const seg of rawSegments) {
      if (seg === '..') {
        if (resolved.length === 0) {
          return [];
        }
        resolved.pop();
      } else if (seg !== '.') {
        resolved.push(seg);
      }
    }
    return resolved;
  }

  if (pathIsWindowsDrive && !wsIsWindowsDrive) {
    return { valid: false, reason: `Windows drive-letter path with non-Windows workspace: ${proposedPath}` };
  }
  if (pathIsWindowsDrive) {
    const driveLetter = (normalizedPath[0] ?? '').toUpperCase();
    const workspaceDrive = (normalizedWorkspace[0] ?? '').toUpperCase();
    if (driveLetter !== workspaceDrive) {
      return { valid: false, reason: `Windows drive-letter path targets different drive: ${proposedPath}` };
    }
  }

  const pathSegments = resolvePathSegments();

  if (pathSegments.length === 0 && normalizedPath.includes('..') && !pathIsWindowsDrive && !pathIsPosixAbsolute) {
    return { valid: false, reason: `path traversal ".." escapes workspace root: ${proposedPath}` };
  }

  if (!isWithin(pathSegments, wsSegments, caseInsensitive)) {
    if (normalizedPath.includes('..')) {
      return { valid: false, reason: `path traversal ".." resolves outside workspace: ${proposedPath}` };
    }
    if (pathIsWindowsDrive) {
      return { valid: false, reason: `absolute Windows path outside workspace: ${proposedPath}` };
    }
    if (pathIsPosixAbsolute) {
      return { valid: false, reason: `absolute path outside workspace: ${proposedPath}` };
    }
    return { valid: false, reason: `relative path resolves outside workspace: ${proposedPath}` };
  }

  for (const pattern of SELF_MODIFICATION_PATTERNS) {
    if (pattern.test(proposedPath)) {
      return { valid: false, reason: `self-modification path targets PD/Symphony control files: ${proposedPath}` };
    }
  }

  return { valid: true, reason: '' };
}

export function validateProposedPathBounds(
  proposedParams: Record<string, unknown>,
  workspaceDir: string,
): PathValidationResult {
  if (typeof workspaceDir !== 'string' || workspaceDir.trim().length === 0) {
    return { valid: false, reason: 'workspaceDir is required for path boundary validation' };
  }

  for (const key of Object.keys(proposedParams)) {
    if (!PATH_FIELDS.has(key)) continue;
    const value = proposedParams[key];
    if (typeof value !== 'string') {
      return { valid: false, reason: `proposedParams["${key}"]: path field must be a string, got ${typeof value}` };
    }
    const pathResult = isPathWithinWorkspace(value, workspaceDir);
    if (!pathResult.valid) {
      return { valid: false, reason: `proposedParams["${key}"]: ${pathResult.reason}` };
    }
  }

  return { valid: true, reason: '' };
}

// ---------------------------------------------------------------------------
// validateProposedParams
// ---------------------------------------------------------------------------

export function validateProposedParams(
  proposedParams: unknown,
  originalParams: Record<string, unknown>,
): CorrectionProposalValidationResult {
  const errors: string[] = [];

  if (!isRecordLike(originalParams)) {
    return { valid: false, errors: ['originalParams must be a plain object'] };
  }

  if (!isRecordLike(proposedParams)) {
    const type = proposedParams === null ? 'null'
      : Array.isArray(proposedParams) ? 'array'
      : typeof proposedParams;
    errors.push(`proposedParams must be a plain object, got ${type}`);
    return { valid: false, errors };
  }

  for (const ppKey of PROTOTYPE_POLLUTION_KEYS) {
    if (Object.hasOwn(proposedParams, ppKey)) {
      errors.push(`proposedParams must not contain prototype pollution key "${ppKey}"`);
    }
  }

  for (const key of Object.keys(proposedParams)) {
    const value = proposedParams[key];

    if (PROTOTYPE_POLLUTION_KEYS.has(key)) {
      continue;
    }

    if (IDENTITY_FIELDS.has(key)) {
      errors.push(`proposedParams must not modify identity field "${key}"`);
      continue;
    }

    if (!Object.hasOwn(originalParams, key)) {
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

  if (!isRecordLike(proposal)) {
    errors.push('proposal must be a plain object');
    return { valid: false, errors };
  }

  // PRI-437: Prototype pollution check on the proposal itself (ERR-013).
  // Since we no longer check Object.getPrototypeOf(), we must explicitly
  // reject __proto__/constructor/prototype as own properties.
  for (const ppKey of PROTOTYPE_POLLUTION_KEYS) {
    if (Object.hasOwn(proposal, ppKey)) {
      errors.push(`proposal must not contain prototype pollution key "${ppKey}"`);
    }
  }

  // proposedParams — required, must be a plain object
  if (!Object.hasOwn(proposal, 'proposedParams')) {
    errors.push('proposedParams is required');
  } else if (!isRecordLike(proposal.proposedParams)) {
    errors.push('proposedParams must be a plain object');
  } else if (!isJsonSerializable(proposal.proposedParams)) {
    errors.push('proposedParams is not JSON-serializable');
  } else {
    for (const ppKey of PROTOTYPE_POLLUTION_KEYS) {
      if (Object.hasOwn(proposal.proposedParams, ppKey)) {
        errors.push(`proposedParams must not contain prototype pollution key "${ppKey}"`);
      }
    }
  }

  if (!Object.hasOwn(proposal, 'correctedFields')) {
    errors.push('correctedFields is required');
  } else if (!Array.isArray(proposal.correctedFields)) {
    errors.push('correctedFields must be an array');
  } else if (!proposal.correctedFields.every((f) =>
    isRecordLike(f) &&
    typeof f.field === 'string' && f.field.trim().length > 0 &&
    typeof f.reason === 'string' && f.reason.trim().length > 0
  )) {
    errors.push('correctedFields must contain objects with non-empty field and reason');
  } else if (isRecordLike(proposal.proposedParams)) {
    for (const cf of proposal.correctedFields) {
      if (PROTOTYPE_POLLUTION_KEYS.has(cf.field)) {
        errors.push(`correctedFields entry "${cf.field}" is a prototype pollution key`);
        continue;
      }
      if (!Object.hasOwn(proposal.proposedParams, cf.field)) {
        errors.push(`correctedFields entry "${cf.field}" is not present in proposedParams`);
      }
    }
  }

  if (!Object.hasOwn(proposal, 'applicationMode')) {
    errors.push('applicationMode is required');
  } else if (proposal.applicationMode !== 'shadow' && proposal.applicationMode !== 'live') {
    errors.push(`applicationMode must be "shadow" or "live", got "${String(proposal.applicationMode)}"`);
  }

  if (!Object.hasOwn(proposal, 'confidence')) {
    errors.push('confidence is required');
  } else if (typeof proposal.confidence !== 'number' || !Number.isFinite(proposal.confidence) || proposal.confidence < 0 || proposal.confidence > 1) {
    errors.push(`confidence must be a number in [0, 1], got ${String(proposal.confidence)}`);
  }

  if (!Object.hasOwn(proposal, 'ruleId')) {
    errors.push('ruleId is required');
  } else if (typeof proposal.ruleId !== 'string' || proposal.ruleId.length === 0) {
    errors.push('ruleId must be a non-empty string');
  }

  if (!Object.hasOwn(proposal, 'notifyAgent')) {
    errors.push('notifyAgent is required');
  } else if (typeof proposal.notifyAgent !== 'boolean') {
    errors.push(`notifyAgent must be a boolean, got ${typeof proposal.notifyAgent}`);
  }

  return { valid: errors.length === 0, errors };
}
