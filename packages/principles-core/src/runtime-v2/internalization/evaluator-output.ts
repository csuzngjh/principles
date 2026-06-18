import { Type, type Static } from '@sinclair/typebox';
import type { GoldenTraceDecision } from '../golden-trace.js';

/**
 * Attack type for adversarial cases (PRD Decision 4).
 * - boundary: probe ambiguous edges of principle text
 * - omission: satisfy all-but-one condition the code may have skipped
 * - inversion: mutate a positive case so it should become negative
 */
export type AdversarialAttackType = 'boundary' | 'omission' | 'inversion';

export interface AdversarialCase {
  readonly caseId: string;
  readonly attackType: AdversarialAttackType;
  readonly toolName: string;
  readonly params: Record<string, unknown>;
  /** GoldenTraceDecision, NOT RuleHostDecision. */
  readonly expectedDecision: GoldenTraceDecision;
  readonly rationale: string;
}

export interface AdversarialFailedCase {
  readonly caseId: string;
  readonly attackType: AdversarialAttackType;
  readonly actualDecision: string;
  readonly expectedDecision: string;
  readonly rationale: string;
}

export interface EvaluatorCodeReview {
  readonly intentConsistency: {
    readonly aligned: boolean;
    readonly explanation: string;
  };
  readonly scopePrecision: {
    readonly verdict: 'precise' | 'too_broad' | 'too_narrow';
    readonly explanation: string;
  };
  readonly traceCoverage: {
    readonly sufficient: boolean;
    readonly gaps: readonly string[];
    readonly explanation: string;
  };
}

export interface EvaluatorAdversarialResult {
  readonly passed: boolean;
  readonly failedCases: readonly AdversarialFailedCase[];
}

export interface EvaluatorEvaluation {
  readonly decision: 'approved' | 'needs_revision' | 'rejected';
  readonly summary: string;
  readonly score: number;
  readonly strengths: readonly string[];
  readonly concerns: readonly string[];
  readonly requiredChanges: readonly string[];
}

export interface EvaluatorSourceTrace {
  readonly artificerArtifactId: string;
  readonly scribeArtifactId?: string;
  readonly philosopherArtifactId?: string;
  readonly dreamerArtifactId?: string;
}

export interface EvaluatorOutputV1 {
  readonly taskId: string;
  readonly sourceArtificerArtifactId: string;
  readonly evaluation: EvaluatorEvaluation;
  readonly sourceTrace: EvaluatorSourceTrace;
  readonly risks: readonly string[];
  readonly generatedAt: string;
}

/**
 * EvaluatorOutputV2 — V1 plus code review + adversarial attack fields
 * (PRD Decision 2, ADR-0014 Amendment 2026-06-17).
 *
 * All V2 fields are optional: they appear only when the upstream Artificer
 * output is V2 (code-bearing). V1 Artificer → Evaluator skips code review
 * entirely (no codeReview, no adversarialCases). Use `isEvaluatorOutputV2()`
 * after `validate()` to decide which assembly path applies.
 */
export interface EvaluatorOutputV2 extends EvaluatorOutputV1 {
  readonly codeReview?: EvaluatorCodeReview;
  readonly adversarialCases?: readonly AdversarialCase[];
  readonly adversarialResult?: EvaluatorAdversarialResult;
}

export const EVALUATOR_DECISIONS = ['approved', 'needs_revision', 'rejected'] as const;

export const EvaluatorEvaluationSchema = Type.Object({
  decision: Type.Union([
    Type.Literal('approved'),
    Type.Literal('needs_revision'),
    Type.Literal('rejected'),
  ]),
  summary: Type.String({ minLength: 1 }),
  score: Type.Number({ minimum: 0, maximum: 1 }),
  strengths: Type.Array(Type.String()),
  concerns: Type.Array(Type.String()),
  requiredChanges: Type.Array(Type.String()),
});

export const EvaluatorSourceTraceSchema = Type.Object({
  artificerArtifactId: Type.String({ minLength: 1 }),
  scribeArtifactId: Type.Optional(Type.String()),
  philosopherArtifactId: Type.Optional(Type.String()),
  dreamerArtifactId: Type.Optional(Type.String()),
});

export const EvaluatorOutputV1Schema = Type.Object({
  taskId: Type.String({ minLength: 1 }),
  sourceArtificerArtifactId: Type.String({ minLength: 1 }),
  evaluation: EvaluatorEvaluationSchema,
  sourceTrace: EvaluatorSourceTraceSchema,
  risks: Type.Array(Type.String()),
  generatedAt: Type.String({ minLength: 1 }),
});

export type EvaluatorOutputV1TB = Static<typeof EvaluatorOutputV1Schema>;

export interface EvaluatorValidationResult {
  readonly valid: boolean;
  readonly errors: readonly string[];
  readonly errorCategory?: string;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

const ADVERSARIAL_ATTACK_TYPES: ReadonlySet<string> = new Set(['boundary', 'omission', 'inversion']);
const GOLDEN_TRACE_DECISIONS: ReadonlySet<string> = new Set(['allow', 'block', 'propose_correction']);
const SCOPE_VERDICTS: ReadonlySet<string> = new Set(['precise', 'too_broad', 'too_narrow']);

function validateCodeReview(raw: unknown): string[] {
  const errors: string[] = [];
  if (!isRecord(raw)) {
    errors.push('codeReview must be an object');
    return errors;
  }

  // intentConsistency
  if (!Object.hasOwn(raw, 'intentConsistency') || !isRecord(raw.intentConsistency)) {
    errors.push('codeReview.intentConsistency must be an object');
  } else {
    const ic = raw.intentConsistency;
    if (!Object.hasOwn(ic, 'aligned') || typeof ic.aligned !== 'boolean') {
      errors.push('codeReview.intentConsistency.aligned must be a boolean');
    }
    if (!Object.hasOwn(ic, 'explanation') || typeof ic.explanation !== 'string' || ic.explanation.trim() === '') {
      errors.push('codeReview.intentConsistency.explanation must be a non-empty string');
    }
  }

  // scopePrecision
  if (!Object.hasOwn(raw, 'scopePrecision') || !isRecord(raw.scopePrecision)) {
    errors.push('codeReview.scopePrecision must be an object');
  } else {
    const sp = raw.scopePrecision;
    if (!Object.hasOwn(sp, 'verdict') || typeof sp.verdict !== 'string' || !SCOPE_VERDICTS.has(sp.verdict)) {
      errors.push(`codeReview.scopePrecision.verdict must be one of precise|too_broad|too_narrow, got ${String(sp.verdict)}`);
    }
    if (!Object.hasOwn(sp, 'explanation') || typeof sp.explanation !== 'string' || sp.explanation.trim() === '') {
      errors.push('codeReview.scopePrecision.explanation must be a non-empty string');
    }
  }

  // traceCoverage
  if (!Object.hasOwn(raw, 'traceCoverage') || !isRecord(raw.traceCoverage)) {
    errors.push('codeReview.traceCoverage must be an object');
  } else {
    const tc = raw.traceCoverage;
    if (!Object.hasOwn(tc, 'sufficient') || typeof tc.sufficient !== 'boolean') {
      errors.push('codeReview.traceCoverage.sufficient must be a boolean');
    }
    if (!Object.hasOwn(tc, 'gaps') || !Array.isArray(tc.gaps)) {
      errors.push('codeReview.traceCoverage.gaps must be an array');
    } else if (!tc.gaps.every((g: unknown) => typeof g === 'string')) {
      errors.push('codeReview.traceCoverage.gaps must be an array of strings');
    }
    if (!Object.hasOwn(tc, 'explanation') || typeof tc.explanation !== 'string' || tc.explanation.trim() === '') {
      errors.push('codeReview.traceCoverage.explanation must be a non-empty string');
    }
  }

  return errors;
}

function validateAdversarialCases(raw: unknown): string[] {
  const errors: string[] = [];
  if (!Array.isArray(raw)) {
    errors.push('adversarialCases must be an array');
    return errors;
  }
  raw.forEach((entry, index) => {
    const prefix = `adversarialCases[${index}]`;
    if (!isRecord(entry)) {
      errors.push(`${prefix} must be an object`);
      return;
    }
    if (!Object.hasOwn(entry, 'caseId') || typeof entry.caseId !== 'string' || entry.caseId.trim() === '') {
      errors.push(`${prefix}.caseId must be a non-empty string`);
    }
    if (!Object.hasOwn(entry, 'attackType') || typeof entry.attackType !== 'string' || !ADVERSARIAL_ATTACK_TYPES.has(entry.attackType)) {
      errors.push(`${prefix}.attackType must be one of boundary|omission|inversion, got ${String(entry.attackType)}`);
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
    }
    if (!Object.hasOwn(entry, 'rationale') || typeof entry.rationale !== 'string' || entry.rationale.trim() === '') {
      errors.push(`${prefix}.rationale must be a non-empty string`);
    }
  });
  return errors;
}

function validateAdversarialResult(raw: unknown): string[] {
  const errors: string[] = [];
  if (!isRecord(raw)) {
    errors.push('adversarialResult must be an object');
    return errors;
  }
  if (!Object.hasOwn(raw, 'passed') || typeof raw.passed !== 'boolean') {
    errors.push('adversarialResult.passed must be a boolean');
  }
  if (!Object.hasOwn(raw, 'failedCases') || !Array.isArray(raw.failedCases)) {
    errors.push('adversarialResult.failedCases must be an array');
  } else {
    raw.failedCases.forEach((entry: unknown, index: number) => {
      const prefix = `adversarialResult.failedCases[${index}]`;
      if (!isRecord(entry)) {
        errors.push(`${prefix} must be an object`);
        return;
      }
      if (!Object.hasOwn(entry, 'caseId') || typeof entry.caseId !== 'string' || entry.caseId.trim() === '') {
        errors.push(`${prefix}.caseId must be a non-empty string`);
      }
      if (!Object.hasOwn(entry, 'attackType') || typeof entry.attackType !== 'string' || !ADVERSARIAL_ATTACK_TYPES.has(entry.attackType)) {
        errors.push(`${prefix}.attackType must be one of boundary|omission|inversion, got ${String(entry.attackType)}`);
      }
      if (!Object.hasOwn(entry, 'actualDecision') || typeof entry.actualDecision !== 'string') {
        errors.push(`${prefix}.actualDecision must be a string`);
      }
      if (!Object.hasOwn(entry, 'expectedDecision') || typeof entry.expectedDecision !== 'string') {
        errors.push(`${prefix}.expectedDecision must be a string`);
      }
      if (!Object.hasOwn(entry, 'rationale') || typeof entry.rationale !== 'string' || entry.rationale.trim() === '') {
        errors.push(`${prefix}.rationale must be a non-empty string`);
      }
    });
  }
  return errors;
}

/**
 * Runtime type guard distinguishing V2 (code-review/adversarial-bearing)
 * evaluator output from V1. A V2 output is one where at least one V2 field
 * is present AND well-formed. Use after `validate()` (Runtime Contract Rule 2).
 */
export function isEvaluatorOutputV2(output: unknown): output is EvaluatorOutputV2 {
  if (!isRecord(output)) return false;
  const hasCodeReview = Object.hasOwn(output, 'codeReview');
  const hasCases = Object.hasOwn(output, 'adversarialCases');
  const hasResult = Object.hasOwn(output, 'adversarialResult');
  if (!hasCodeReview && !hasCases && !hasResult) return false;
  return (!hasCodeReview || validateCodeReview(output.codeReview).length === 0)
    && (!hasCases || validateAdversarialCases(output.adversarialCases).length === 0)
    && (!hasResult || validateAdversarialResult(output.adversarialResult).length === 0);
}

export interface EvaluatorValidator {
  validate(output: unknown, taskId: string, expectedSourceArtificerArtifactId?: string): Promise<EvaluatorValidationResult>;
}

export class DefaultEvaluatorValidator implements EvaluatorValidator {
  // eslint-disable-next-line @typescript-eslint/class-methods-use-this
  async validate(output: unknown, taskId: string, expectedSourceArtificerArtifactId?: string): Promise<EvaluatorValidationResult> {
    const errors: string[] = [];

    if (!isRecord(output)) {
      return { valid: false, errors: ['Output is not an object'], errorCategory: 'output_invalid' };
    }

    if (!Object.hasOwn(output, 'taskId')) {
      errors.push('taskId is missing');
    } else if (output.taskId !== taskId) {
      errors.push(`taskId mismatch: expected ${taskId}, got ${String(output.taskId)}`);
    }

    if (!Object.hasOwn(output, 'sourceArtificerArtifactId') || typeof output.sourceArtificerArtifactId !== 'string' || output.sourceArtificerArtifactId.trim() === '') {
      errors.push('sourceArtificerArtifactId must be non-empty string');
    } else if (expectedSourceArtificerArtifactId && output.sourceArtificerArtifactId !== expectedSourceArtificerArtifactId) {
      errors.push(`sourceArtificerArtifactId mismatch: expected ${expectedSourceArtificerArtifactId}, got ${output.sourceArtificerArtifactId}`);
    }

    if (!Object.hasOwn(output, 'evaluation') || !isRecord(output.evaluation)) {
      errors.push('evaluation must be an object');
    } else {
      const ev = output.evaluation;
      if (!Object.hasOwn(ev, 'decision') || !EVALUATOR_DECISIONS.includes(ev.decision as 'approved' | 'needs_revision' | 'rejected')) {
        errors.push(`evaluation.decision must be one of ${EVALUATOR_DECISIONS.join('/')}, got ${String(ev.decision)}`);
      }
      if (!Object.hasOwn(ev, 'summary') || typeof ev.summary !== 'string' || (ev.summary).trim() === '') errors.push('evaluation.summary must be non-empty string');
      if (!Object.hasOwn(ev, 'score') || typeof ev.score !== 'number' || !Number.isFinite(ev.score)) errors.push('evaluation.score must be number');
      else if (ev.score < 0 || ev.score > 1) errors.push('evaluation.score must be in [0, 1]');
      if (!Object.hasOwn(ev, 'strengths') || !Array.isArray(ev.strengths)) errors.push('evaluation.strengths must be an array');
      else if (!ev.strengths.every((e: unknown) => typeof e === 'string')) errors.push('evaluation.strengths must be an array of strings');
      if (!Object.hasOwn(ev, 'concerns') || !Array.isArray(ev.concerns)) errors.push('evaluation.concerns must be an array');
      else if (!ev.concerns.every((e: unknown) => typeof e === 'string')) errors.push('evaluation.concerns must be an array of strings');
      if (!Object.hasOwn(ev, 'requiredChanges') || !Array.isArray(ev.requiredChanges)) errors.push('evaluation.requiredChanges must be an array');
      else if (!ev.requiredChanges.every((e: unknown) => typeof e === 'string')) errors.push('evaluation.requiredChanges must be an array of strings');
    }

    if (!Object.hasOwn(output, 'sourceTrace') || !isRecord(output.sourceTrace)) {
      errors.push('sourceTrace must be an object');
    } else {
      const st = output.sourceTrace;
      if (!Object.hasOwn(st, 'artificerArtifactId') || typeof st.artificerArtifactId !== 'string' || (st.artificerArtifactId).trim() === '') {
        errors.push('sourceTrace.artificerArtifactId must be non-empty string');
      } else if (expectedSourceArtificerArtifactId && st.artificerArtifactId !== expectedSourceArtificerArtifactId) {
        errors.push(`sourceTrace.artificerArtifactId mismatch: expected ${expectedSourceArtificerArtifactId}, got ${st.artificerArtifactId}`);
      }
      if (Object.hasOwn(st, 'scribeArtifactId') && st.scribeArtifactId !== undefined && typeof st.scribeArtifactId !== 'string') {
        errors.push('sourceTrace.scribeArtifactId must be string if present');
      }
      if (Object.hasOwn(st, 'philosopherArtifactId') && st.philosopherArtifactId !== undefined && typeof st.philosopherArtifactId !== 'string') {
        errors.push('sourceTrace.philosopherArtifactId must be string if present');
      }
      if (Object.hasOwn(st, 'dreamerArtifactId') && st.dreamerArtifactId !== undefined && typeof st.dreamerArtifactId !== 'string') {
        errors.push('sourceTrace.dreamerArtifactId must be string if present');
      }
    }

    if (!Object.hasOwn(output, 'risks') || !Array.isArray(output.risks)) {
      errors.push('risks must be an array');
    } else if (!output.risks.every((e: unknown) => typeof e === 'string')) {
      errors.push('risks must be an array of strings');
    }

    if (typeof output.sourceArtificerArtifactId === 'string' && output.sourceArtificerArtifactId.trim() !== ''
      && isRecord(output.sourceTrace)
      && Object.hasOwn(output.sourceTrace, 'artificerArtifactId') && typeof output.sourceTrace.artificerArtifactId === 'string'
      && output.sourceArtificerArtifactId !== output.sourceTrace.artificerArtifactId) {
      errors.push('sourceArtificerArtifactId and sourceTrace.artificerArtifactId must match');
    }

    if (!Object.hasOwn(output, 'generatedAt') || typeof output.generatedAt !== 'string' || output.generatedAt.trim() === '') {
      errors.push('generatedAt must be non-empty string');
    }

    // ── V2 fields (optional; present only when Artificer output is V2) ──
    // V1 backward compatibility: absence is valid. Presence requires well-formed
    // structure (fail loud, ERR-009). Detect via Object.hasOwn (ERR-013).
    if (Object.hasOwn(output, 'codeReview')) {
      errors.push(...validateCodeReview(output.codeReview));
    }
    if (Object.hasOwn(output, 'adversarialCases')) {
      errors.push(...validateAdversarialCases(output.adversarialCases));
    }
    if (Object.hasOwn(output, 'adversarialResult')) {
      errors.push(...validateAdversarialResult(output.adversarialResult));
    }

    return errors.length > 0
      ? { valid: false, errors, errorCategory: 'output_invalid' }
      : { valid: true, errors: [] };
  }
}
