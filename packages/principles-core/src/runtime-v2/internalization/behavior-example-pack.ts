/**
 * PRI-484 — Phase 5 BehaviorExamplePack (behavior-example-pack.ts)
 *
 * Pure logic: type + validator for the Artificer BehaviorExamplePack.
 * Zero I/O — this module MUST NOT import node:fs / node:path / better-sqlite3 /
 * any network module. The runtime-v2 architecture-regression test enforces the
 * file boundary.
 *
 * Err-prevention:
 *   - ERR-001 (validate-as-unknown): validator takes `unknown` and validates
 *     structurally. No `as` bypass on parsed input.
 *   - ERR-069 (Artificer shared schema): fail loud on invalid pack, no silent
 *     fallback to empty pack.
 *   - ERR-076 (prototype-pollution / host-realm independence): structural checks
 *     use Object.keys + a PROTO_KEYS set. We never touch the host realm's
 *     prototype chain (no `instanceof`, no `in`).
 *   - rc-2: no `as` casts on parsed input.
 *   - rc-5: Object.hasOwn / Object.keys over the `in` operator.
 *
 * Spec: docs/superpowers/specs/2026-06-27-rulecode-context-vision-design.md §7.2
 */

import type { GoldenTraceCaseInput } from './artificer-output.js';

// ── public types ───────────────────────────────────────────────────────────

/**
 * BehaviorExamplePack — bounded, validated evidence pack for Artificer.
 *
 * Contains only evidence from the current pain lineage; no general memory
 * or arbitrary codebase search.
 *
 * First-version limits (spec §7.2):
 *   - 1 source negative case
 *   - ≤3 positive counterexamples
 *   - ≤5 evidenceRefs
 *   - each string follows existing evidence sanitizer boundaries
 */
export interface BehaviorExamplePack {
  readonly sourceNegativeCase: GoldenTraceCaseInput;
  readonly ownerDesiredOutcome: string;
  readonly positiveCounterexamples: readonly GoldenTraceCaseInput[];
  readonly evidenceRefs: readonly string[];
  readonly redactionNotes: readonly string[];
}

export interface BehaviorExamplePackValidationResult {
  readonly valid: boolean;
  readonly errors: readonly string[];
}

// ── internal constants ─────────────────────────────────────────────────────

const PROTO_KEYS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);

const MAX_POSITIVES = 3;
const MAX_EVIDENCE_REFS = 5;

const GOLDEN_TRACE_DECISIONS: ReadonlySet<string> = new Set(['allow', 'block', 'propose_correction']);

const OK_RESULT: BehaviorExamplePackValidationResult = { valid: true, errors: [] };

// ── internal helpers ───────────────────────────────────────────────────────

function isPlainObjectLike(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasNoProtoKeys(value: Record<string, unknown>): boolean {
  for (const key of Object.keys(value)) {
    if (PROTO_KEYS.has(key)) return false;
  }
  return true;
}

function fail(errors: string[]): BehaviorExamplePackValidationResult {
  return errors.length === 0 ? OK_RESULT : { valid: false, errors };
}

function isNonEmptyString(value: unknown): boolean {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * Validate a single GoldenTraceCaseInput structurally.
 * Mirrors the structural invariants of `validateGoldenTraceCase` in
 * golden-trace.ts and `validateGoldenTraceCasesInput` in artificer-output.ts,
 * but operates on a single case (not an array) and enforces `expectedKind`.
 */
function validateSingleCase(
  value: unknown,
  fieldName: string,
  expectedKind: 'positive' | 'negative',
): string[] {
  const errors: string[] = [];
  if (!isPlainObjectLike(value)) {
    errors.push(`${fieldName} must be a plain object`);
    return errors;
  }
  if (!hasNoProtoKeys(value)) {
    errors.push(`${fieldName} must not carry prototype-pollution keys`);
    return errors;
  }

  if (!Object.hasOwn(value, 'caseId') || !isNonEmptyString(value.caseId)) {
    errors.push(`${fieldName}.caseId must be a non-empty string`);
  }
  if (!Object.hasOwn(value, 'kind') || value.kind !== expectedKind) {
    errors.push(`${fieldName}.kind must be '${expectedKind}'`);
  }
  if (!Object.hasOwn(value, 'toolName') || !isNonEmptyString(value.toolName)) {
    errors.push(`${fieldName}.toolName must be a non-empty string`);
  }
  if (!Object.hasOwn(value, 'params') || !isPlainObjectLike(value.params)) {
    errors.push(`${fieldName}.params must be a plain object`);
  }
  if (
    !Object.hasOwn(value, 'expectedDecision')
    || typeof value.expectedDecision !== 'string'
    || !GOLDEN_TRACE_DECISIONS.has(value.expectedDecision)
  ) {
    errors.push(`${fieldName}.expectedDecision must be one of allow|block|propose_correction`);
  } else if (expectedKind === 'positive' && value.expectedDecision !== 'allow') {
    errors.push(`${fieldName}: positive cases must expect allow`);
  }

  return errors;
}

interface StringArrayValidationOptions {
  /** Field name used in error messages. */
  fieldName: string;
  /** Max items allowed. `undefined` means no upper bound. */
  maxLength?: number;
  /** When true, the array must contain at least 1 item. */
  requireNonEmpty?: boolean;
}

function validateStringArray(value: unknown, opts: StringArrayValidationOptions): string[] {
  const { fieldName, maxLength, requireNonEmpty } = opts;
  const errors: string[] = [];
  if (!Array.isArray(value)) {
    errors.push(`${fieldName} must be an array`);
    return errors;
  }
  if (requireNonEmpty && value.length === 0) {
    errors.push(`${fieldName} must contain at least 1 item`);
  }
  if (maxLength !== undefined && value.length > maxLength) {
    errors.push(`${fieldName} must contain at most ${maxLength} items, got ${value.length}`);
  }
  for (let i = 0; i < value.length; i++) {
    if (typeof value[i] !== 'string') {
      errors.push(`${fieldName}[${i}] must be a string`);
    }
  }
  return errors;
}

// ── public validator ───────────────────────────────────────────────────────

/**
 * Validate an untrusted BehaviorExamplePack.
 *
 * Accepts `unknown` and validates structurally (ERR-001). Rejects hostile
 * primitives (null, arrays, wrong types) and prototype-pollution keys
 * (__proto__, constructor, prototype).
 *
 * First-version limits enforced:
 *   - positiveCounterexamples: 1..3 items, each kind='positive'
 *   - evidenceRefs: 1..5 non-empty strings
 *   - ownerDesiredOutcome: non-empty string
 *   - sourceNegativeCase: kind='negative'
 *   - redactionNotes: string array (may be empty)
 *
 * Returns `{ valid: true, errors: [] }` on success, or
 * `{ valid: false, errors: [...] }` on failure — never throws (ERR-069 fail
 * loud is the caller's responsibility: an invalid pack must not silently
 * produce an empty pack).
 */
export function validateBehaviorExamplePack(value: unknown): BehaviorExamplePackValidationResult {
  if (!isPlainObjectLike(value)) {
    return { valid: false, errors: ['BehaviorExamplePack must be a plain object'] };
  }
  if (!hasNoProtoKeys(value)) {
    return { valid: false, errors: ['BehaviorExamplePack must not carry prototype-pollution keys'] };
  }

  const errors: string[] = [];

  // ── sourceNegativeCase (1 negative case, MANDATORY) ──
  if (!Object.hasOwn(value, 'sourceNegativeCase')) {
    errors.push('sourceNegativeCase is required');
  } else {
    errors.push(...validateSingleCase(value.sourceNegativeCase, 'sourceNegativeCase', 'negative'));
  }

  // ── ownerDesiredOutcome (non-empty string, MANDATORY) ──
  if (!Object.hasOwn(value, 'ownerDesiredOutcome') || !isNonEmptyString(value.ownerDesiredOutcome)) {
    errors.push('ownerDesiredOutcome must be a non-empty string');
  }

  // ── positiveCounterexamples (1..3 positive cases, MANDATORY) ──
  if (!Object.hasOwn(value, 'positiveCounterexamples')) {
    errors.push('positiveCounterexamples is required');
  } else if (!Array.isArray(value.positiveCounterexamples)) {
    errors.push('positiveCounterexamples must be an array');
  } else {
    const arr = value.positiveCounterexamples;
    if (arr.length === 0) {
      errors.push('positiveCounterexamples must contain at least 1 item');
    }
    if (arr.length > MAX_POSITIVES) {
      errors.push(`positiveCounterexamples must contain at most ${MAX_POSITIVES} items, got ${arr.length}`);
    }
    for (let i = 0; i < arr.length; i++) {
      errors.push(...validateSingleCase(arr[i], `positiveCounterexamples[${i}]`, 'positive'));
    }
  }

  // ── evidenceRefs (1..5 non-empty strings, MANDATORY) ──
  if (!Object.hasOwn(value, 'evidenceRefs')) {
    errors.push('evidenceRefs is required');
  } else {
    errors.push(...validateStringArray(value.evidenceRefs, {
      fieldName: 'evidenceRefs',
      maxLength: MAX_EVIDENCE_REFS,
      requireNonEmpty: true,
    }));
  }

  // ── redactionNotes (string array, may be empty, MANDATORY) ──
  if (!Object.hasOwn(value, 'redactionNotes')) {
    errors.push('redactionNotes is required');
  } else {
    errors.push(...validateStringArray(value.redactionNotes, {
      fieldName: 'redactionNotes',
    }));
  }

  // ── SPEC-RULECODE-QUALITY-001 Q04: identical-EFFECTIVE-input label conflict ──
  // The rule's effective input is action (toolName + params) AND its
  // ruleContext (history window + facts). Two cases whose effective inputs
  // are canonically identical but carry opposite labels are UNSATISFIABLE —
  // no deterministic rule can pass both — and must fail loud at the pack
  // trust boundary. Cases that differ in context (e.g. the read-before-write
  // teaching pair: same params, different priorReadOfTarget) are materially
  // different inputs and are NOT conflicts; their discrimination quality is
  // the evaluator's semantic judgment, not the pack validator's.
  if (errors.length === 0) {
    const negative = value.sourceNegativeCase as { toolName: unknown; params: unknown; ruleContext?: unknown };
    const positives = value.positiveCounterexamples as Array<{ toolName: unknown; params: unknown; ruleContext?: unknown }>;
    const negativeKey = stableJsonStringify({ toolName: negative.toolName, params: negative.params, ruleContext: negative.ruleContext });
    for (let i = 0; i < positives.length; i++) {
      const positive = positives[i];
      if (positive !== undefined && stableJsonStringify({ toolName: positive.toolName, params: positive.params, ruleContext: positive.ruleContext }) === negativeKey) {
        errors.push(
          `positiveCounterexamples[${i}] conflicting_label: identical effective input (toolName + params + ruleContext) as sourceNegativeCase but opposite expectedDecision — same input cannot carry both labels`,
        );
      }
    }
  }

  return fail(errors);
}

/** Key-stable JSON for value comparison (input labels compare by content, not key order). */
function stableJsonStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableJsonStringify(entry)).join(',')}]`;
  }
  if (typeof value === 'object' && value !== null) {
    const keys = Object.keys(value).filter((key) => key !== '__proto__' && key !== 'constructor' && key !== 'prototype').sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${stableJsonStringify((value as Record<string, unknown>)[key])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}
