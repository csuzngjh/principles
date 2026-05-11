import { Type, type Static } from '@sinclair/typebox';

export interface RolloutReviewerReview {
  readonly decision: 'approve_rollout' | 'needs_revision' | 'reject';
  readonly summary: string;
  readonly confidence: number;
  readonly requiredChanges: readonly string[];
  readonly rolloutRisks: readonly string[];
  readonly safetyChecks: readonly string[];
}

export interface RolloutReviewerSourceTrace {
  readonly evaluatorArtifactId: string;
  readonly artificerArtifactId?: string;
  readonly scribeArtifactId?: string;
  readonly philosopherArtifactId?: string;
  readonly dreamerArtifactId?: string;
}

export interface RolloutReviewerOutputV1 {
  readonly taskId: string;
  readonly sourceEvaluatorArtifactId: string;
  readonly review: RolloutReviewerReview;
  readonly sourceTrace: RolloutReviewerSourceTrace;
  readonly risks: readonly string[];
  readonly generatedAt: string;
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
  evaluatorArtifactId: Type.String({ minLength: 1 }),
  artificerArtifactId: Type.Optional(Type.String()),
  scribeArtifactId: Type.Optional(Type.String()),
  philosopherArtifactId: Type.Optional(Type.String()),
  dreamerArtifactId: Type.Optional(Type.String()),
});

export const RolloutReviewerOutputV1Schema = Type.Object({
  taskId: Type.String({ minLength: 1 }),
  sourceEvaluatorArtifactId: Type.String({ minLength: 1 }),
  review: RolloutReviewerReviewSchema,
  sourceTrace: RolloutReviewerSourceTraceSchema,
  risks: Type.Array(Type.String()),
  generatedAt: Type.String({ minLength: 1 }),
});

export type RolloutReviewerOutputV1TB = Static<typeof RolloutReviewerOutputV1Schema>;

export interface RolloutReviewerValidationResult {
  readonly valid: boolean;
  readonly errors: readonly string[];
  readonly errorCategory?: string;
}

export interface RolloutReviewerValidator {
  validate(output: RolloutReviewerOutputV1, taskId: string, expectedSourceEvaluatorArtifactId?: string): Promise<RolloutReviewerValidationResult>;
}

export class DefaultRolloutReviewerValidator implements RolloutReviewerValidator {
  // eslint-disable-next-line @typescript-eslint/class-methods-use-this
  async validate(output: RolloutReviewerOutputV1, taskId: string, expectedSourceEvaluatorArtifactId?: string): Promise<RolloutReviewerValidationResult> {
    const errors: string[] = [];

    if (typeof output !== 'object' || output === null) {
      return { valid: false, errors: ['Output is not an object'], errorCategory: 'output_invalid' };
    }

    if (output.taskId !== taskId) {
      errors.push(`taskId mismatch: expected ${taskId}, got ${String(output.taskId)}`);
    }

    if (typeof output.sourceEvaluatorArtifactId !== 'string' || output.sourceEvaluatorArtifactId.trim() === '') {
      errors.push('sourceEvaluatorArtifactId must be non-empty string');
    } else if (expectedSourceEvaluatorArtifactId && output.sourceEvaluatorArtifactId !== expectedSourceEvaluatorArtifactId) {
      errors.push(`sourceEvaluatorArtifactId mismatch: expected ${expectedSourceEvaluatorArtifactId}, got ${output.sourceEvaluatorArtifactId}`);
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
      if (!Array.isArray(rv.rolloutRisks)) errors.push('review.rolloutRisks must be an array');
      else if (!(rv.rolloutRisks as unknown[]).every(e => typeof e === 'string')) errors.push('review.rolloutRisks must be an array of strings');
      if (!Array.isArray(rv.safetyChecks)) errors.push('review.safetyChecks must be an array');
      else if (!(rv.safetyChecks as unknown[]).every(e => typeof e === 'string')) errors.push('review.safetyChecks must be an array of strings');
    }

    if (typeof output.sourceTrace !== 'object' || output.sourceTrace === null) {
      errors.push('sourceTrace must be an object');
    } else {
      const st = output.sourceTrace as unknown as Record<string, unknown>;
      if (typeof st.evaluatorArtifactId !== 'string' || (st.evaluatorArtifactId).trim() === '') {
        errors.push('sourceTrace.evaluatorArtifactId must be non-empty string');
      } else if (expectedSourceEvaluatorArtifactId && st.evaluatorArtifactId !== expectedSourceEvaluatorArtifactId) {
        errors.push(`sourceTrace.evaluatorArtifactId mismatch: expected ${expectedSourceEvaluatorArtifactId}, got ${st.evaluatorArtifactId}`);
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

    if (typeof output.sourceEvaluatorArtifactId === 'string' && output.sourceEvaluatorArtifactId.trim() !== ''
      && typeof output.sourceTrace === 'object' && output.sourceTrace !== null
      && typeof (output.sourceTrace as unknown as Record<string, unknown>).evaluatorArtifactId === 'string'
      && output.sourceEvaluatorArtifactId !== (output.sourceTrace as unknown as Record<string, unknown>).evaluatorArtifactId) {
      errors.push('sourceEvaluatorArtifactId and sourceTrace.evaluatorArtifactId must match');
    }

    if (typeof output.generatedAt !== 'string' || output.generatedAt.trim() === '') {
      errors.push('generatedAt must be non-empty string');
    }

    return errors.length > 0
      ? { valid: false, errors, errorCategory: 'output_invalid' }
      : { valid: true, errors: [] };
  }
}
