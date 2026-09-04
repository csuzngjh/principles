/**
 * PRI-480 — Phase 1 Core ABI (rule-context-v2.ts)
 *
 * Pure logic: types + canonicalize + validators + behavior-facts computation.
 * Zero I/O — this module MUST NOT import node:fs / node:path / better-sqlite3 /
 * any network module. The runtime-v2 architecture-regression test enforces the
 * file boundary.
 *
 * Err-prevention:
 *   - ERR-001 (validate-as-unknown): every public validator takes `unknown` and
 *     validates structurally. No `as` bypass on parsed input.
 *   - ERR-076 (prototype-pollution / host-realm independence): structural checks
 *     use Object.keys + a PROTO_KEYS set. We never touch the host realm's
 *     prototype chain (no `instanceof`, no `in`).
 *   - rc-2: no `as` casts on parsed input.
 *   - rc-5: Object.hasOwn / Object.keys over the `in` operator.
 *
 * Spec: docs/superpowers/specs/2026-06-27-rulecode-context-vision-design.md §4.
 */

import { baselineToolAlias as TOOL_ALIAS } from './tool-semantic-baseline.js';

// ── public types ───────────────────────────────────────────────────────────

export type CanonicalKind = 'read' | 'search' | 'write' | 'execute' | 'agent' | 'other';

export type EvidenceState = 'yes' | 'no' | 'unknown';

export type RuleToolOutcome = 'success' | 'failure' | 'blocked';

export type RuleHistoryStatus = 'available' | 'unavailable';

export interface RuleToolCallRecord {
  sequenceId: number;
  toolName: string;
  canonicalKind: CanonicalKind;
  normalizedPath: string | null;
  paramsSummary: Record<string, unknown>;
  outcome: RuleToolOutcome;
}

export interface RuleHistoryWindow {
  status: RuleHistoryStatus;
  unavailableReason?: string;
  truncated: boolean;
  calls: readonly RuleToolCallRecord[];
}

export interface RuleBehaviorFacts {
  priorReadOfTarget: EvidenceState;
  readCount: number | null;
  writeCount: number | null;
  uniqueWritePathCount: number | null;
  sameActionBlockCount: number | null;
}

export interface RuleContextV2 {
  version: 2;
  history: RuleHistoryWindow;
  facts: RuleBehaviorFacts;
}

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

// ── internal constants ─────────────────────────────────────────────────────

const CANONICAL_KINDS: ReadonlySet<string> = new Set<CanonicalKind>([
  'read',
  'search',
  'write',
  'execute',
  'agent',
  'other',
]);

const EVIDENCE_STATES: ReadonlySet<string> = new Set<EvidenceState>(['yes', 'no', 'unknown']);

const TOOL_OUTCOMES: ReadonlySet<string> = new Set<RuleToolOutcome>(['success', 'failure', 'blocked']);

const HISTORY_STATUSES: ReadonlySet<string> = new Set<RuleHistoryStatus>(['available', 'unavailable']);

const PROTO_KEYS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);

const OK_RESULT: ValidationResult = { valid: true, errors: [] };

function fail(errors: string[]): ValidationResult {
  return errors.length === 0 ? OK_RESULT : { valid: false, errors };
}

function isPlainObjectLike(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasNoProtoKeys(value: Record<string, unknown>): boolean {
  for (const key of Object.keys(value)) {
    if (PROTO_KEYS.has(key)) return false;
  }
  return true;
}

function isFiniteNumber(value: unknown): boolean {
  return typeof value === 'number' && Number.isFinite(value);
}

function isNullOrNonNegativeFinite(value: unknown): boolean {
  return value === null || (typeof value === 'number' && Number.isFinite(value) && value >= 0);
}

// ── canonicalizeToolKind (baseline alias table, spec §4.4) ──────────────────
//
// PRI-634-F: the table moved to tool-semantic-baseline.ts (host-neutral
// generic vocabulary only) so canonicalizeToolKind and the host-layered
// ToolSemanticRegistry read ONE table. canonicalizeToolKind itself stays
// baseline-only — host-aware callers use buildToolSemanticRegistry().

export function canonicalizeToolKind(toolName: unknown): CanonicalKind {
  if (typeof toolName !== 'string') return 'other';
  // ERR-076: Object.hasOwn guards against inherited Object.prototype keys
  // (__proto__, constructor, toString, hasOwnProperty, ...) that direct
  // indexing would otherwise leak as non-CanonicalKind values (e.g. the
  // Object.prototype object, the Object constructor function). Without this
  // guard `TOOL_ALIAS['__proto__']` returns Object.prototype, not undefined.
  if (!Object.hasOwn(TOOL_ALIAS, toolName)) return 'other';
  const hit = TOOL_ALIAS[toolName];
  return hit !== undefined ? hit : 'other';
}

// ── validators ─────────────────────────────────────────────────────────────

export function validateRuleToolCallRecord(value: unknown): ValidationResult {
  if (!isPlainObjectLike(value)) {
    return { valid: false, errors: ['record must be a plain object'] };
  }
  if (!hasNoProtoKeys(value)) {
    return { valid: false, errors: ['record must not carry prototype-pollution keys'] };
  }
  const errors: string[] = [];

  if (!isFiniteNumber(value.sequenceId)) {
    errors.push('sequenceId must be a finite number');
  }
  const {toolName} = value;
  if (typeof toolName !== 'string' || toolName.length === 0) {
    errors.push('toolName must be a non-empty string');
  }
  const {canonicalKind} = value;
  if (typeof canonicalKind !== 'string' || !CANONICAL_KINDS.has(canonicalKind)) {
    errors.push('canonicalKind must be a valid CanonicalKind');
  }
  const {normalizedPath} = value;
  if (normalizedPath !== null && typeof normalizedPath !== 'string') {
    errors.push('normalizedPath must be a string or null');
  }
  if (!isPlainObjectLike(value.paramsSummary)) {
    errors.push('paramsSummary must be a plain object');
  }
  const {outcome} = value;
  if (typeof outcome !== 'string' || !TOOL_OUTCOMES.has(outcome)) {
    errors.push('outcome must be success | failure | blocked');
  }

  return fail(errors);
}

export function validateRuleHistoryWindow(value: unknown): ValidationResult {
  if (!isPlainObjectLike(value)) {
    return { valid: false, errors: ['history window must be a plain object'] };
  }
  if (!hasNoProtoKeys(value)) {
    return { valid: false, errors: ['history window must not carry prototype-pollution keys'] };
  }
  const errors: string[] = [];

  const {status} = value;
  if (typeof status !== 'string' || !HISTORY_STATUSES.has(status)) {
    errors.push('status must be available | unavailable');
  }
  const {unavailableReason} = value;
  if (unavailableReason !== undefined && typeof unavailableReason !== 'string') {
    errors.push('unavailableReason must be a string or undefined');
  }
  if (typeof value.truncated !== 'boolean') {
    errors.push('truncated must be a boolean');
  }
  const {calls} = value;
  if (!Array.isArray(calls)) {
    errors.push('calls must be an array');
  } else {
    for (let i = 0; i < calls.length; i++) {
      const recordResult = validateRuleToolCallRecord(calls[i]);
      if (!recordResult.valid) {
        errors.push(`calls[${i}] invalid: ${recordResult.errors.join('; ')}`);
      }
    }
  }

  return fail(errors);
}

export function validateRuleBehaviorFacts(value: unknown): ValidationResult {
  if (!isPlainObjectLike(value)) {
    return { valid: false, errors: ['facts must be a plain object'] };
  }
  if (!hasNoProtoKeys(value)) {
    return { valid: false, errors: ['facts must not carry prototype-pollution keys'] };
  }
  const errors: string[] = [];

  const {priorReadOfTarget} = value;
  if (typeof priorReadOfTarget !== 'string' || !EVIDENCE_STATES.has(priorReadOfTarget)) {
    errors.push('priorReadOfTarget must be yes | no | unknown');
  }
  if (!isNullOrNonNegativeFinite(value.readCount)) {
    errors.push('readCount must be a non-negative finite number or null');
  }
  if (!isNullOrNonNegativeFinite(value.writeCount)) {
    errors.push('writeCount must be a non-negative finite number or null');
  }
  if (!isNullOrNonNegativeFinite(value.uniqueWritePathCount)) {
    errors.push('uniqueWritePathCount must be a non-negative finite number or null');
  }
  if (!isNullOrNonNegativeFinite(value.sameActionBlockCount)) {
    errors.push('sameActionBlockCount must be a non-negative finite number or null');
  }

  return fail(errors);
}

export function validateRuleContextV2(value: unknown): ValidationResult {
  if (!isPlainObjectLike(value)) {
    return { valid: false, errors: ['context must be a plain object'] };
  }
  if (!hasNoProtoKeys(value)) {
    return { valid: false, errors: ['context must not carry prototype-pollution keys'] };
  }
  const errors: string[] = [];

  if (value.version !== 2) {
    errors.push('version must be 2');
  }

  const historyResult = validateRuleHistoryWindow(value.history);
  if (!historyResult.valid) {
    errors.push(`history invalid: ${historyResult.errors.join('; ')}`);
  }
  const factsResult = validateRuleBehaviorFacts(value.facts);
  if (!factsResult.valid) {
    errors.push(`facts invalid: ${factsResult.errors.join('; ')}`);
  }

  // Unavailable invariant (acceptance C): when history.status === 'unavailable',
  // facts MUST be the canonical unavailable posture — priorReadOfTarget='unknown'
  // and every count null. Any drift is rejected so downstream gates can't be
  // fooled by a host that fabricates numbers while claiming history is missing.
  const {history} = value;
  const {facts} = value;
  if (
    historyResult.valid &&
    factsResult.valid &&
    isPlainObjectLike(history) &&
    isPlainObjectLike(facts) &&
    history.status === 'unavailable'
  ) {
    if (facts.priorReadOfTarget !== 'unknown') {
      errors.push('unavailable invariant: priorReadOfTarget must be "unknown" when history is unavailable');
    }
    if (facts.readCount !== null) {
      errors.push('unavailable invariant: readCount must be null when history is unavailable');
    }
    if (facts.writeCount !== null) {
      errors.push('unavailable invariant: writeCount must be null when history is unavailable');
    }
    if (facts.uniqueWritePathCount !== null) {
      errors.push('unavailable invariant: uniqueWritePathCount must be null when history is unavailable');
    }
    if (facts.sameActionBlockCount !== null) {
      errors.push('unavailable invariant: sameActionBlockCount must be null when history is unavailable');
    }
  }

  return fail(errors);
}

// ── computeBehaviorFacts (pure) ────────────────────────────────────────────

export function computeBehaviorFacts(
  window: RuleHistoryWindow,
  targetPath: string | null,
  sameActionBlockCount: number | null,
): RuleBehaviorFacts {
  if (window.status === 'unavailable') {
    return {
      priorReadOfTarget: 'unknown',
      readCount: null,
      writeCount: null,
      uniqueWritePathCount: null,
      sameActionBlockCount: null,
    };
  }

  let readCount = 0;
  let writeCount = 0;
  const writePaths = new Set<string>();
  let priorReadOfTarget: EvidenceState = targetPath === null ? 'unknown' : 'no';

  const {calls} = window;
  for (const call of calls) {
    const kind = call.canonicalKind;
    if (kind === 'read' || kind === 'search') {
      readCount++;
      if (targetPath !== null && call.normalizedPath === targetPath) {
        priorReadOfTarget = 'yes';
      }
    } else if (kind === 'write') {
      writeCount++;
      if (typeof call.normalizedPath === 'string') {
        writePaths.add(call.normalizedPath);
      }
    }
  }

  return {
    priorReadOfTarget,
    readCount,
    writeCount,
    uniqueWritePathCount: writePaths.size,
    sameActionBlockCount,
  };
}

// ── UNAVAILABLE_RULE_CONTEXT sentinel (deep-frozen) ────────────────────────
//
// The canonical "host gave us no history" context. Downstream code compares
// against this (or checks history.status) instead of null-checking, so the
// unavailable posture is always well-typed. Deep-frozen so a buggy host cannot
// mutate the shared sentinel and poison every subsequent rule evaluation.

const _UNAVAILABLE_FACTS: RuleBehaviorFacts = {
  priorReadOfTarget: 'unknown',
  readCount: null,
  writeCount: null,
  uniqueWritePathCount: null,
  sameActionBlockCount: null,
};
Object.freeze(_UNAVAILABLE_FACTS);

const _UNAVAILABLE_HISTORY: RuleHistoryWindow = {
  status: 'unavailable',
  unavailableReason: 'host did not provide a history window',
  truncated: false,
  calls: [],
};
Object.freeze(_UNAVAILABLE_HISTORY.calls);
Object.freeze(_UNAVAILABLE_HISTORY);

const _UNAVAILABLE_VALUE: RuleContextV2 = {
  version: 2,
  history: _UNAVAILABLE_HISTORY,
  facts: _UNAVAILABLE_FACTS,
};
Object.freeze(_UNAVAILABLE_VALUE);

export const UNAVAILABLE_RULE_CONTEXT: Readonly<RuleContextV2> = _UNAVAILABLE_VALUE;
