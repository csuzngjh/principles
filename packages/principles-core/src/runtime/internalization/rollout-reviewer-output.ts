import { Type } from '@sinclair/typebox';

export interface RolloutReviewerReview {
  readonly decision: 'approve_rollout' | 'needs_revision' | 'reject';
  readonly summary: string;
  readonly confidence: number;
  readonly requiredChanges: readonly string[];
  readonly rolloutRisks: readonly string[];
  readonly safetyChecks: readonly string[];
}

export interface RolloutReviewerSourceTrace {
  /**
   * Code-chain reviews only (PRI-720): the reviewed evaluator artifact.
   * Optional at the schema/contract level — which trace id is REQUIRED is
   * enforced per review mode by DefaultRolloutReviewerValidator (code_chain
   * ⇔ evaluatorArtifactId, principle_semantic ⇔ scribeArtifactId), so the
   * real LLM output path (tool-call/JSON-mode validation against the
   * registered `rollout-reviewer-output` schema) accepts both modes.
   */
  readonly evaluatorArtifactId?: string;
  readonly artificerArtifactId?: string;
  readonly scribeArtifactId?: string;
  readonly philosopherArtifactId?: string;
  readonly dreamerArtifactId?: string;
}

export interface RolloutReviewerOutputV1 {
  readonly taskId: string;
  /** Code-chain reviews: the reviewed evaluator artifact (validator-enforced). */
  readonly sourceEvaluatorArtifactId?: string;
  /**
   * PRI-720 principle semantic mode: the reviewed source is the SCRIBE
   * principle artifact. Required (and validated against the runner-owned
   * authority) when the review runs in principle semantic mode; absent on
   * code-chain reviews.
   */
  readonly sourceScribeArtifactId?: string;
  readonly review: RolloutReviewerReview;
  readonly sourceTrace: RolloutReviewerSourceTrace;
  readonly risks: readonly string[];
  readonly generatedAt: string;
}

/** PRI-720: which contract the rollout review runs under. */
export type RolloutReviewMode = 'principle_semantic' | 'code_chain';

/** Reads one field off an untrusted record without `as` casts (rc-1/rc-2). */
function readTraceField(source: unknown, field: string): unknown {
  if (typeof source !== 'object' || source === null) return undefined;
  return Reflect.get(source, field);
}

export const ROLLOUT_REVIEWER_DECISIONS = ['approve_rollout', 'needs_revision', 'reject'] as const;

export const RolloutReviewerReviewSchema = Type.Object({
  decision: Type.Union([
    Type.Literal('approve_rollout'),
    Type.Literal('needs_revision'),
    Type.Literal('reject'),
  ]),
  summary: Type.String({ minLength: 1 }),
  confidence: Type.Number({ minimum: 0, maximum: 1 }),
  requiredChanges: Type.Array(Type.String()),
  rolloutRisks: Type.Array(Type.String()),
  safetyChecks: Type.Array(Type.String()),
});

export const RolloutReviewerSourceTraceSchema = Type.Object({
  // PRI-720 P1 fix: optional here — the mode-aware DefaultRolloutReviewerValidator
  // is the single authority for which trace id is required (evaluatorArtifactId
  // on code_chain, scribeArtifactId on principle_semantic). A required entry in
  // this schema made the registered `rollout-reviewer-output` structured
  // output gate reject every valid principle-semantic LLM output before the
  // runner validator ever ran.
  evaluatorArtifactId: Type.Optional(Type.String({ minLength: 1 })),
  artificerArtifactId: Type.Optional(Type.String()),
  scribeArtifactId: Type.Optional(Type.String()),
  philosopherArtifactId: Type.Optional(Type.String()),
  dreamerArtifactId: Type.Optional(Type.String()),
});

export const RolloutReviewerOutputV1Schema = Type.Object({
  taskId: Type.String({ minLength: 1 }),
  // PRI-720: per-mode presence is enforced by DefaultRolloutReviewerValidator
  // (code_chain requires sourceEvaluatorArtifactId, principle_semantic requires
  // sourceScribeArtifactId) — the schema keeps both optional so one output
  // contract serves both review modes.
  sourceEvaluatorArtifactId: Type.Optional(Type.String({ minLength: 1 })),
  sourceScribeArtifactId: Type.Optional(Type.String({ minLength: 1 })),
  review: RolloutReviewerReviewSchema,
  sourceTrace: RolloutReviewerSourceTraceSchema,
  risks: Type.Array(Type.String()),
  generatedAt: Type.String({ minLength: 1 }),
});


export interface RolloutReviewerValidationResult {
  readonly valid: boolean;
  readonly errors: readonly string[];
  readonly errorCategory?: string;
}

interface RolloutReviewerValidatorOptions {
  /** Runner-owned source artifact id the output must echo exactly (rc-6). */
  expectedSourceArtifactId?: string;
  /** PRI-720: review contract mode; defaults to the legacy code_chain. */
  reviewMode?: RolloutReviewMode;
  /**
   * PD-BEHAVIOR-FIDELITY-001 Gate 2: runner-owned authority — the reviewed
   * scribe artifact's declared `ownerRequirementGaps` (principle_semantic
   * only; read via readUnresolvedOwnerRequirementGaps from the artifact the
   * runner already loaded, never from model output). Non-empty = unresolved
   * Owner-attributed coverage gaps, which can only be closed by the Owner, so
   * they forbid `approve_rollout`.
   */
  unresolvedOwnerRequirementGaps?: readonly string[];
}

/**
 * Reads the `ownerRequirementGaps` declared by the reviewed scribe artifact.
 *
 * Returns `[]` when the artifact carries none. Present-but-malformed values
 * were already hard-rejected at the Scribe trust boundary
 * (DefaultScribeValidator), so a malformed value here can only come from
 * storage corruption; like the other artifact-read degradations in this
 * package it degrades to "no declared gaps" instead of inventing data (rc-9:
 * the byte boundary itself is checked by the Scribe validator, not here).
 */
export function readUnresolvedOwnerRequirementGaps(sourceArtifactJson: string | null): readonly string[] {
  if (typeof sourceArtifactJson !== 'string' || sourceArtifactJson.length === 0) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(sourceArtifactJson);
  } catch {
    return [];
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return [];
  if (!Object.hasOwn(parsed, 'ownerRequirementGaps')) return [];
  const gaps: unknown = Reflect.get(parsed, 'ownerRequirementGaps');
  if (!Array.isArray(gaps)) return [];
  return gaps.filter((g): g is string => typeof g === 'string' && g.trim() !== '');
}

export interface RolloutReviewerValidator {
  validate(
    output: RolloutReviewerOutputV1,
    taskId: string,
    options?: RolloutReviewerValidatorOptions,
  ): Promise<RolloutReviewerValidationResult>;
}

export class DefaultRolloutReviewerValidator implements RolloutReviewerValidator {
  // eslint-disable-next-line @typescript-eslint/class-methods-use-this
  async validate(
    output: RolloutReviewerOutputV1,
    taskId: string,
    options?: RolloutReviewerValidatorOptions,
  ): Promise<RolloutReviewerValidationResult> {
    const errors: string[] = [];

    if (typeof output !== 'object' || output === null) {
      return { valid: false, errors: ['Output is not an object'], errorCategory: 'output_invalid' };
    }

    if (output.taskId !== taskId) {
      errors.push(`taskId mismatch: expected ${taskId}, got ${String(output.taskId)}`);
    }

    const expectedSourceArtifactId = options?.expectedSourceArtifactId;
    const reviewMode = options?.reviewMode ?? 'code_chain';

    // PRI-720: the lineage field under review depends on the review mode —
    // code_chain reviews the evaluator artifact; principle_semantic reviews
    // the exact SCRIBE principle artifact (reviewed = validated = approved =
    // activated identity).
    const sourceField = reviewMode === 'principle_semantic' ? 'sourceScribeArtifactId' : 'sourceEvaluatorArtifactId';
    const traceField = reviewMode === 'principle_semantic' ? 'scribeArtifactId' : 'evaluatorArtifactId';
    const sourceValue = reviewMode === 'principle_semantic' ? output.sourceScribeArtifactId : output.sourceEvaluatorArtifactId;
    const traceValue = readTraceField(output.sourceTrace, traceField);

    if (typeof sourceValue !== 'string' || sourceValue.trim() === '') {
      errors.push(`${sourceField} must be non-empty string (${reviewMode} review)`);
    } else if (expectedSourceArtifactId && sourceValue !== expectedSourceArtifactId) {
      errors.push(`${sourceField} mismatch: expected ${expectedSourceArtifactId}, got ${sourceValue}`);
    }

    if (typeof output.review !== 'object' || output.review === null) {
      errors.push('review must be an object');
    } else {
      const rv = output.review as unknown as Record<string, unknown>;
      if (!ROLLOUT_REVIEWER_DECISIONS.includes(rv.decision as 'approve_rollout' | 'needs_revision' | 'reject')) {
        errors.push(`review.decision must be one of ${ROLLOUT_REVIEWER_DECISIONS.join('/')}, got ${String(rv.decision)}`);
      }
      if (typeof rv.summary !== 'string' || (rv.summary).trim() === '') errors.push('review.summary must be non-empty string');
      if (typeof rv.confidence !== 'number' || !Number.isFinite(rv.confidence)) errors.push('review.confidence must be number');
      else if (rv.confidence < 0 || rv.confidence > 1) errors.push('review.confidence must be in [0, 1]');
      if (!Array.isArray(rv.requiredChanges)) errors.push('review.requiredChanges must be an array');
      else if (!(rv.requiredChanges as unknown[]).every(e => typeof e === 'string')) errors.push('review.requiredChanges must be an array of strings');

      // PD-BEHAVIOR-FIDELITY-001 Gate 2: 语义一致性门。R3 实测
      // (rollout_reviewer-408fe3a1) 的行为正是这三条结构性矛盾的组合：
      // 评审者在 summary 里写明 statement 的「低风险、可逆」豁免可能绕过硬
      // 门禁、也看见 ownerRequirementGaps，却仍 approve_rollout 且
      // requiredChanges=[]。仅在 principle_semantic 模式启用（code_chain 契约
      // 保持 byte-compatible），错误文本回喂下一次 attempt（可修复），不是
      // 无声改写模型判定。
      const { decision } = rv;
      if (reviewMode === 'principle_semantic'
        && typeof decision === 'string'
        && (ROLLOUT_REVIEWER_DECISIONS as readonly string[]).includes(decision)) {
        const requiredChanges = Array.isArray(rv.requiredChanges) ? rv.requiredChanges : [];
        const unresolvedGaps = options?.unresolvedOwnerRequirementGaps ?? [];
        if (decision === 'approve_rollout' && unresolvedGaps.length > 0) {
          errors.push(`review.decision approve_rollout is not permitted while the reviewed scribe artifact declares ${unresolvedGaps.length} unresolved ownerRequirementGaps (${unresolvedGaps.join(' | ').slice(0, 400)}) — an unresolved Owner-attributed coverage gap can only be closed by the Owner; return needs_revision and name in requiredChanges the Owner requirement to restore, or the unauthorized exception to remove from the statement`);
        }
        if (decision === 'approve_rollout' && requiredChanges.length > 0) {
          errors.push('review.decision approve_rollout contradicts a non-empty review.requiredChanges — a required semantic change means the principle is not approvable; return needs_revision and list it, or drop it from requiredChanges if it is not actually required');
        }
        if (decision === 'needs_revision' && requiredChanges.length === 0) {
          errors.push('review.decision needs_revision requires at least one concrete review.requiredChanges entry naming the semantic fix the Scribe must make');
        }
      }
      if (!Array.isArray(rv.rolloutRisks)) errors.push('review.rolloutRisks must be an array');
      else if (!(rv.rolloutRisks as unknown[]).every(e => typeof e === 'string')) errors.push('review.rolloutRisks must be an array of strings');
      if (!Array.isArray(rv.safetyChecks)) errors.push('review.safetyChecks must be an array');
      else if (!(rv.safetyChecks as unknown[]).every(e => typeof e === 'string')) errors.push('review.safetyChecks must be an array of strings');
    }

    if (typeof output.sourceTrace !== 'object' || output.sourceTrace === null) {
      errors.push('sourceTrace must be an object');
    } else {
      const st = output.sourceTrace as unknown as Record<string, unknown>;
      if (reviewMode === 'code_chain') {
        if (typeof st.evaluatorArtifactId !== 'string' || (st.evaluatorArtifactId).trim() === '') {
          errors.push('sourceTrace.evaluatorArtifactId must be non-empty string');
        } else if (expectedSourceArtifactId && st.evaluatorArtifactId !== expectedSourceArtifactId) {
          errors.push(`sourceTrace.evaluatorArtifactId mismatch: expected ${expectedSourceArtifactId}, got ${st.evaluatorArtifactId}`);
        }
      } else {
        if (typeof st.scribeArtifactId !== 'string' || (st.scribeArtifactId).trim() === '') {
          errors.push('sourceTrace.scribeArtifactId must be non-empty string (principle semantic review)');
        } else if (expectedSourceArtifactId && st.scribeArtifactId !== expectedSourceArtifactId) {
          errors.push(`sourceTrace.scribeArtifactId mismatch: expected ${expectedSourceArtifactId}, got ${st.scribeArtifactId}`);
        }
        if (st.evaluatorArtifactId !== undefined && typeof st.evaluatorArtifactId !== 'string') {
          errors.push('sourceTrace.evaluatorArtifactId must be string if present');
        }
      }
      if (st.artificerArtifactId !== undefined && typeof st.artificerArtifactId !== 'string') {
        errors.push('sourceTrace.artificerArtifactId must be string if present');
      }
      if (st.scribeArtifactId !== undefined && typeof st.scribeArtifactId !== 'string') {
        errors.push('sourceTrace.scribeArtifactId must be string if present');
      }
      if (st.philosopherArtifactId !== undefined && typeof st.philosopherArtifactId !== 'string') {
        errors.push('sourceTrace.philosopherArtifactId must be string if present');
      }
      if (st.dreamerArtifactId !== undefined && typeof st.dreamerArtifactId !== 'string') {
        errors.push('sourceTrace.dreamerArtifactId must be string if present');
      }
    }

    if (!Array.isArray(output.risks)) {
      errors.push('risks must be an array');
    } else if (!(output.risks as unknown[]).every(e => typeof e === 'string')) {
      errors.push('risks must be an array of strings');
    }

    if (typeof sourceValue === 'string' && sourceValue.trim() !== '' && traceValue !== undefined) {
      if (typeof traceValue !== 'string' || traceValue.trim() === '') {
        errors.push(`sourceTrace.${traceField} must be non-empty string when present`);
      } else if (sourceValue !== traceValue) {
        errors.push(`${sourceField} and sourceTrace.${traceField} must match`);
      }
    }

    if (typeof output.generatedAt !== 'string' || output.generatedAt.trim() === '') {
      errors.push('generatedAt must be non-empty string');
    }

    return errors.length > 0
      ? { valid: false, errors, errorCategory: 'output_invalid' }
      : { valid: true, errors: [] };
  }
}
