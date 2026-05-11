import { Type, type Static } from '@sinclair/typebox';

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

export interface EvaluatorValidator {
  validate(output: EvaluatorOutputV1, taskId: string, expectedSourceArtificerArtifactId?: string): Promise<EvaluatorValidationResult>;
}

export class DefaultEvaluatorValidator implements EvaluatorValidator {
  // eslint-disable-next-line @typescript-eslint/class-methods-use-this
  async validate(output: EvaluatorOutputV1, taskId: string, expectedSourceArtificerArtifactId?: string): Promise<EvaluatorValidationResult> {
    const errors: string[] = [];

    if (typeof output !== 'object' || output === null) {
      return { valid: false, errors: ['Output is not an object'], errorCategory: 'output_invalid' };
    }

    if (output.taskId !== taskId) {
      errors.push(`taskId mismatch: expected ${taskId}, got ${String(output.taskId)}`);
    }

    if (typeof output.sourceArtificerArtifactId !== 'string' || output.sourceArtificerArtifactId.trim() === '') {
      errors.push('sourceArtificerArtifactId must be non-empty string');
    } else if (expectedSourceArtificerArtifactId && output.sourceArtificerArtifactId !== expectedSourceArtificerArtifactId) {
      errors.push(`sourceArtificerArtifactId mismatch: expected ${expectedSourceArtificerArtifactId}, got ${output.sourceArtificerArtifactId}`);
    }

    if (typeof output.evaluation !== 'object' || output.evaluation === null) {
      errors.push('evaluation must be an object');
    } else {
      const ev = output.evaluation as unknown as Record<string, unknown>;
      if (!EVALUATOR_DECISIONS.includes(ev.decision as 'approved' | 'needs_revision' | 'rejected')) {
        errors.push(`evaluation.decision must be one of ${EVALUATOR_DECISIONS.join('/')}, got ${String(ev.decision)}`);
      }
      if (typeof ev.summary !== 'string' || (ev.summary).trim() === '') errors.push('evaluation.summary must be non-empty string');
      if (typeof ev.score !== 'number' || !Number.isFinite(ev.score)) errors.push('evaluation.score must be number');
      else if (ev.score < 0 || ev.score > 1) errors.push('evaluation.score must be in [0, 1]');
      if (!Array.isArray(ev.strengths)) errors.push('evaluation.strengths must be an array');
      else if (!(ev.strengths as unknown[]).every(e => typeof e === 'string')) errors.push('evaluation.strengths must be an array of strings');
      if (!Array.isArray(ev.concerns)) errors.push('evaluation.concerns must be an array');
      else if (!(ev.concerns as unknown[]).every(e => typeof e === 'string')) errors.push('evaluation.concerns must be an array of strings');
      if (!Array.isArray(ev.requiredChanges)) errors.push('evaluation.requiredChanges must be an array');
      else if (!(ev.requiredChanges as unknown[]).every(e => typeof e === 'string')) errors.push('evaluation.requiredChanges must be an array of strings');
    }

    if (typeof output.sourceTrace !== 'object' || output.sourceTrace === null) {
      errors.push('sourceTrace must be an object');
    } else {
      const st = output.sourceTrace as unknown as Record<string, unknown>;
      if (typeof st.artificerArtifactId !== 'string' || (st.artificerArtifactId).trim() === '') {
        errors.push('sourceTrace.artificerArtifactId must be non-empty string');
      } else if (expectedSourceArtificerArtifactId && st.artificerArtifactId !== expectedSourceArtificerArtifactId) {
        errors.push(`sourceTrace.artificerArtifactId mismatch: expected ${expectedSourceArtificerArtifactId}, got ${st.artificerArtifactId}`);
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

    if (typeof output.sourceArtificerArtifactId === 'string' && output.sourceArtificerArtifactId.trim() !== ''
      && typeof output.sourceTrace === 'object' && output.sourceTrace !== null
      && typeof (output.sourceTrace as unknown as Record<string, unknown>).artificerArtifactId === 'string'
      && output.sourceArtificerArtifactId !== (output.sourceTrace as unknown as Record<string, unknown>).artificerArtifactId) {
      errors.push('sourceArtificerArtifactId and sourceTrace.artificerArtifactId must match');
    }

    if (typeof output.generatedAt !== 'string' || output.generatedAt.trim() === '') {
      errors.push('generatedAt must be non-empty string');
    }

    return errors.length > 0
      ? { valid: false, errors, errorCategory: 'output_invalid' }
      : { valid: true, errors: [] };
  }
}
