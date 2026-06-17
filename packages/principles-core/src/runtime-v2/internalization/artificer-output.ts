import { Type, type Static } from '@sinclair/typebox';
import type { GoldenTraceDecision } from '../golden-trace.js';

export interface ArtificerImplementationPlan {
  readonly summary: string;
  readonly targetSurface: string;
  readonly changes: readonly string[];
  readonly tests: readonly string[];
  readonly rolloutNotes: readonly string[];
  readonly confidence: number;
}

export interface ArtificerSourceTrace {
  readonly scribeArtifactId: string;
  readonly philosopherArtifactId?: string;
  readonly dreamerArtifactId?: string;
}

export interface ArtificerOutputV1 {
  readonly taskId: string;
  readonly sourceScribeArtifactId: string;
  readonly implementationPlan: ArtificerImplementationPlan;
  readonly sourceTrace: ArtificerSourceTrace;
  readonly risks: readonly string[];
  readonly generatedAt: string;
}

/**
 * Artificer-generated golden trace case input (RuleHost MVP Activation, ADR-0014
 * Amendment 2026-06-17 Decision 1).
 *
 * `expectedDecision` uses `GoldenTraceDecision` ('allow'|'block'|'propose_correction'),
 * NOT `RuleHostDecision`. The sandbox replay layer maps the two enums (see PRD
 * Decision 1 mapping table). `kind='positive'` requires `expectedDecision='allow'`
 * (mirrors `validateGoldenTraceCase` invariant in golden-trace.ts:116).
 */
export interface GoldenTraceCaseInput {
  readonly caseId: string;
  readonly kind: 'positive' | 'negative';
  readonly toolName: string;
  readonly params: Record<string, unknown>;
  readonly expectedDecision: GoldenTraceDecision;
  readonly expectedProposedParams?: Record<string, unknown>;
  readonly expectedApplicationMode?: 'shadow' | 'live';
}

/**
 * ArtificerOutputV2 — V1 plus executable rule code fields (Decision 1).
 *
 * A V2 output is produced only by `ArtificerL2Adapter` (write-test-fix loop).
 * V1 outputs (no code fields) flow through the existing principle-artifact
 * path unchanged. `isArtificerOutputV2()` distinguishes the two at runtime;
 * never `as`-cast (Runtime Contract Rule 2, ERR-001).
 */
export interface ArtificerOutputV2 extends ArtificerOutputV1 {
  readonly implementationCode: string;
  readonly goldenTraceCases: readonly GoldenTraceCaseInput[];
  readonly affectedTools: readonly string[];
}

export const ArtificerImplementationPlanSchema = Type.Object({
  summary: Type.String({ minLength: 1 }),
  targetSurface: Type.String({ minLength: 1 }),
  changes: Type.Array(Type.String()),
  tests: Type.Array(Type.String()),
  rolloutNotes: Type.Array(Type.String()),
  confidence: Type.Number({ minimum: 0, maximum: 1 }),
});

export const ArtificerSourceTraceSchema = Type.Object({
  scribeArtifactId: Type.String({ minLength: 1 }),
  philosopherArtifactId: Type.Optional(Type.String()),
  dreamerArtifactId: Type.Optional(Type.String()),
});

export const ArtificerOutputV1Schema = Type.Object({
  taskId: Type.String({ minLength: 1 }),
  sourceScribeArtifactId: Type.String({ minLength: 1 }),
  implementationPlan: ArtificerImplementationPlanSchema,
  sourceTrace: ArtificerSourceTraceSchema,
  risks: Type.Array(Type.String()),
  generatedAt: Type.String({ minLength: 1 }),
});

export type ArtificerOutputV1TB = Static<typeof ArtificerOutputV1Schema>;

export interface ArtificerValidationResult {
  readonly valid: boolean;
  readonly errors: readonly string[];
  readonly errorCategory?: string;
}

export interface ArtificerValidator {
  /** Validate untrusted output. Accepts `unknown` — must perform runtime checks (ERR-001). */
  validate(output: unknown, taskId: string, expectedSourceScribeArtifactId?: string): Promise<ArtificerValidationResult>;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

const GOLDEN_TRACE_DECISIONS: ReadonlySet<string> = new Set(['allow', 'block', 'propose_correction']);
const MAX_GOLDEN_TRACE_CASES = 10;
const MIN_GOLDEN_TRACE_CASES = 2;

/**
 * Validate Artificer's goldenTraceCases input. Mirrors the structural invariants
 * of `validateGoldenTraceCase` / `validateGoldenTrace` in golden-trace.ts but
 * operates on the artificer-input shape (GoldenTraceCaseInput, no sourceRefs).
 * - At least 1 positive + 1 negative case (PRD Decision 1).
 * - 2..10 cases inclusive.
 * - positive case must expect 'allow' (golden-trace.ts:116).
 * - expectedDecision ∈ {allow, block, propose_correction}.
 */
function validateGoldenTraceCasesInput(raw: unknown): string[] {
  const errors: string[] = [];
  if (!Array.isArray(raw)) {
    errors.push('goldenTraceCases must be an array');
    return errors;
  }
  if (raw.length < MIN_GOLDEN_TRACE_CASES) {
    errors.push(`goldenTraceCases must contain at least ${MIN_GOLDEN_TRACE_CASES} cases (1 positive + 1 negative), got ${raw.length}`);
  }
  if (raw.length > MAX_GOLDEN_TRACE_CASES) {
    errors.push(`goldenTraceCases must contain at most ${MAX_GOLDEN_TRACE_CASES} cases, got ${raw.length}`);
  }

  let hasPositive = false;
  let hasNegative = false;
  raw.forEach((entry, index) => {
    const prefix = `goldenTraceCases[${index}]`;
    if (!isRecord(entry)) {
      errors.push(`${prefix} must be an object`);
      return;
    }
    if (!Object.hasOwn(entry, 'caseId') || typeof entry.caseId !== 'string' || entry.caseId.trim() === '') {
      errors.push(`${prefix}.caseId must be a non-empty string`);
    }
    if (!Object.hasOwn(entry, 'kind') || (entry.kind !== 'positive' && entry.kind !== 'negative')) {
      errors.push(`${prefix}.kind must be 'positive' or 'negative'`);
    } else if (entry.kind === 'positive') {
      hasPositive = true;
    } else {
      hasNegative = true;
    }
    if (!Object.hasOwn(entry, 'toolName') || typeof entry.toolName !== 'string' || entry.toolName.trim() === '') {
      errors.push(`${prefix}.toolName must be a non-empty string`);
    }
    if (!Object.hasOwn(entry, 'params') || !isRecord(entry.params)) {
      errors.push(`${prefix}.params must be an object`);
    }
    if (
      !Object.hasOwn(entry, 'expectedDecision')
      || typeof entry.expectedDecision !== 'string'
      || !GOLDEN_TRACE_DECISIONS.has(entry.expectedDecision)
    ) {
      errors.push(`${prefix}.expectedDecision must be one of allow|block|propose_correction, got ${String(entry.expectedDecision)}`);
    } else if (entry.kind === 'positive' && entry.expectedDecision !== 'allow') {
      errors.push(`${prefix}: positive cases must expect allow (got ${entry.expectedDecision})`);
    }
    // propose_correction requires expectedProposedParams + expectedApplicationMode
    // (mirrors golden-trace.ts:110-114). Enforced here so malformed V2 output
    // fails at validation, not later in the sandbox.
    if (entry.expectedDecision === 'propose_correction') {
      if (!Object.hasOwn(entry, 'expectedProposedParams') || !isRecord(entry.expectedProposedParams)) {
        errors.push(`${prefix}.expectedProposedParams is required when expectedDecision is propose_correction`);
      }
    }
  });

  // Only check positive/negative presence when array shape is valid (avoid
  // double-reporting on the same malformed array).
  if (Array.isArray(raw) && raw.length > 0) {
    if (!hasPositive) errors.push('goldenTraceCases must include at least one positive case');
    if (!hasNegative) errors.push('goldenTraceCases must include at least one negative case');
  }

  return errors;
}

function validateAffectedTools(raw: unknown): string[] {
  const errors: string[] = [];
  if (!Array.isArray(raw)) {
    errors.push('affectedTools must be an array');
    return errors;
  }
  if (raw.length === 0) {
    errors.push('affectedTools must be a non-empty array');
  }
  raw.forEach((entry, index) => {
    if (typeof entry !== 'string') {
      errors.push(`affectedTools[${index}] must be a string, got ${typeof entry}`);
    }
  });
  return errors;
}

/**
 * Runtime type guard distinguishing V2 (code-bearing) artificer output from V1.
 * Use this — not `as ArtificerOutputV2` — after `validate()` succeeds to decide
 * whether the rule-artifact assembly path applies (Runtime Contract Rule 2).
 *
 * Detection: V2 requires ALL three code fields present and well-formed. A
 * partially-populated object is NOT V2 (it is malformed and will have been
 * rejected by validate()).
 */
export function isArtificerOutputV2(output: unknown): output is ArtificerOutputV2 {
  if (!isRecord(output)) return false;
  if (typeof output.implementationCode !== 'string' || output.implementationCode.trim() === '') return false;
  if (!Array.isArray(output.goldenTraceCases) || output.goldenTraceCases.length === 0) return false;
  if (!Array.isArray(output.affectedTools) || output.affectedTools.length === 0) return false;
  return true;
}

export class DefaultArtificerValidator implements ArtificerValidator {
  // eslint-disable-next-line @typescript-eslint/class-methods-use-this
  async validate(output: unknown, taskId: string, expectedSourceScribeArtifactId?: string): Promise<ArtificerValidationResult> {
    const errors: string[] = [];

    if (!isRecord(output)) {
      return { valid: false, errors: ['Output is not an object'], errorCategory: 'output_invalid' };
    }

    const rec = output;

    if (!Object.hasOwn(rec, 'taskId') || rec.taskId !== taskId) {
      errors.push(`taskId mismatch: expected ${taskId}, got ${String(rec.taskId)}`);
    }

    if (!Object.hasOwn(rec, 'sourceScribeArtifactId') || typeof rec.sourceScribeArtifactId !== 'string' || rec.sourceScribeArtifactId.trim() === '') {
      errors.push('sourceScribeArtifactId must be non-empty string');
    } else if (expectedSourceScribeArtifactId && rec.sourceScribeArtifactId !== expectedSourceScribeArtifactId) {
      errors.push(`sourceScribeArtifactId mismatch: expected ${expectedSourceScribeArtifactId}, got ${rec.sourceScribeArtifactId}`);
    }

    if (!Object.hasOwn(rec, 'implementationPlan') || !isRecord(rec.implementationPlan)) {
      errors.push('implementationPlan must be an object');
    } else {
      const ip = rec.implementationPlan;
      if (!Object.hasOwn(ip, 'summary') || typeof ip.summary !== 'string' || ip.summary.trim() === '') errors.push('implementationPlan.summary must be non-empty string');
      if (!Object.hasOwn(ip, 'targetSurface') || typeof ip.targetSurface !== 'string' || ip.targetSurface.trim() === '') errors.push('implementationPlan.targetSurface must be non-empty string');
      if (!Object.hasOwn(ip, 'changes') || !Array.isArray(ip.changes)) errors.push('implementationPlan.changes must be an array');
      else if (!ip.changes.every((e: unknown) => typeof e === 'string')) errors.push('implementationPlan.changes must be an array of strings');
      if (!Object.hasOwn(ip, 'tests') || !Array.isArray(ip.tests)) errors.push('implementationPlan.tests must be an array');
      else if (!ip.tests.every((e: unknown) => typeof e === 'string')) errors.push('implementationPlan.tests must be an array of strings');
      if (!Object.hasOwn(ip, 'rolloutNotes') || !Array.isArray(ip.rolloutNotes)) errors.push('implementationPlan.rolloutNotes must be an array');
      else if (!ip.rolloutNotes.every((e: unknown) => typeof e === 'string')) errors.push('implementationPlan.rolloutNotes must be an array of strings');
      if (!Object.hasOwn(ip, 'confidence') || typeof ip.confidence !== 'number' || !Number.isFinite(ip.confidence)) errors.push('implementationPlan.confidence must be number');
      else if (ip.confidence < 0 || ip.confidence > 1) errors.push('implementationPlan.confidence must be in [0, 1]');
    }

    if (!Object.hasOwn(rec, 'sourceTrace') || !isRecord(rec.sourceTrace)) {
      errors.push('sourceTrace must be an object');
    } else {
      const st = rec.sourceTrace;
      if (!Object.hasOwn(st, 'scribeArtifactId') || typeof st.scribeArtifactId !== 'string' || st.scribeArtifactId.trim() === '') {
        errors.push('sourceTrace.scribeArtifactId must be non-empty string');
      } else if (expectedSourceScribeArtifactId && st.scribeArtifactId !== expectedSourceScribeArtifactId) {
        errors.push(`sourceTrace.scribeArtifactId mismatch: expected ${expectedSourceScribeArtifactId}, got ${st.scribeArtifactId}`);
      }
      if (Object.hasOwn(st, 'philosopherArtifactId') && st.philosopherArtifactId !== undefined) {
        if (typeof st.philosopherArtifactId !== 'string' || st.philosopherArtifactId.trim() === '') {
          errors.push('sourceTrace.philosopherArtifactId must be non-empty string if present');
        }
      }
      if (Object.hasOwn(st, 'dreamerArtifactId') && st.dreamerArtifactId !== undefined) {
        if (typeof st.dreamerArtifactId !== 'string' || st.dreamerArtifactId.trim() === '') {
          errors.push('sourceTrace.dreamerArtifactId must be non-empty string if present');
        }
      }
    }

    if (!Object.hasOwn(rec, 'risks') || !Array.isArray(rec.risks)) {
      errors.push('risks must be an array');
    } else if (!rec.risks.every((e: unknown) => typeof e === 'string')) {
      errors.push('risks must be an array of strings');
    }

    if (typeof rec.sourceScribeArtifactId === 'string' && rec.sourceScribeArtifactId.trim() !== ''
      && isRecord(rec.sourceTrace)
      && Object.hasOwn(rec.sourceTrace, 'scribeArtifactId')
      && typeof rec.sourceTrace.scribeArtifactId === 'string'
      && rec.sourceScribeArtifactId !== rec.sourceTrace.scribeArtifactId) {
      errors.push('sourceScribeArtifactId and sourceTrace.scribeArtifactId must match');
    }

    if (!Object.hasOwn(rec, 'generatedAt') || typeof rec.generatedAt !== 'string' || rec.generatedAt.trim() === '') {
      errors.push('generatedAt must be non-empty string');
    }

    // ── V2 fields (optional; present when ArtificerL2Adapter produces code) ──
    // V1 backward compatibility: absence of code fields is valid (existing path).
    // When ANY V2 field is present, ALL must be present and well-formed (fail loud,
    // ERR-009/010). Detection via Object.hasOwn (ERR-013), never `in`.
    const hasCode = Object.hasOwn(rec, 'implementationCode');
    const hasCases = Object.hasOwn(rec, 'goldenTraceCases');
    const hasTools = Object.hasOwn(rec, 'affectedTools');
    if (hasCode || hasCases || hasTools) {
      // All three must be present together — partial V2 is malformed.
      if (!hasCode) errors.push('implementationCode is required when goldenTraceCases or affectedTools are present (V2 output)');
      if (!hasCases) errors.push('goldenTraceCases is required when implementationCode or affectedTools are present (V2 output)');
      if (!hasTools) errors.push('affectedTools is required when implementationCode or goldenTraceCases are present (V2 output)');

      if (hasCode) {
        const code = rec.implementationCode;
        if (typeof code !== 'string' || code.trim() === '') {
          errors.push('implementationCode must be a non-empty string');
        }
      }

      if (hasCases) {
        const casesErr = validateGoldenTraceCasesInput(rec.goldenTraceCases);
        errors.push(...casesErr);
      }

      if (hasTools) {
        const toolsErr = validateAffectedTools(rec.affectedTools);
        errors.push(...toolsErr);
      }
    }

    return errors.length > 0
      ? { valid: false, errors, errorCategory: 'output_invalid' }
      : { valid: true, errors: [] };
  }
}

