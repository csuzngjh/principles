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

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
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

    return errors.length > 0
      ? { valid: false, errors, errorCategory: 'output_invalid' }
      : { valid: true, errors: [] };
  }
}
