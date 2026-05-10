import { Type, type Static } from '@sinclair/typebox';

export interface ScribePrincipleDraft {
  readonly title: string;
  readonly statement: string;
  readonly rationale: string;
  readonly applicability: readonly string[];
  readonly antiPatterns: readonly string[];
  readonly confidence: number;
}

export interface ScribeSourceTrace {
  readonly dreamerArtifactId?: string;
  readonly philosopherArtifactId: string;
}

export interface ScribeOutputV1 {
  readonly taskId: string;
  readonly sourcePhilosopherArtifactId: string;
  readonly principleDraft: ScribePrincipleDraft;
  readonly sourceTrace: ScribeSourceTrace;
  readonly risks: readonly string[];
  readonly generatedAt: string;
}

export const ScribePrincipleDraftSchema = Type.Object({
  title: Type.String({ minLength: 1 }),
  statement: Type.String({ minLength: 1 }),
  rationale: Type.String({ minLength: 1 }),
  applicability: Type.Array(Type.String()),
  antiPatterns: Type.Array(Type.String()),
  confidence: Type.Number({ minimum: 0, maximum: 1 }),
});

export const ScribeSourceTraceSchema = Type.Object({
  dreamerArtifactId: Type.Optional(Type.String()),
  philosopherArtifactId: Type.String({ minLength: 1 }),
});

export const ScribeOutputV1Schema = Type.Object({
  taskId: Type.String({ minLength: 1 }),
  sourcePhilosopherArtifactId: Type.String({ minLength: 1 }),
  principleDraft: ScribePrincipleDraftSchema,
  sourceTrace: ScribeSourceTraceSchema,
  risks: Type.Array(Type.String()),
  generatedAt: Type.String({ minLength: 1 }),
});

export type ScribeOutputV1TB = Static<typeof ScribeOutputV1Schema>;

export interface ScribeValidationResult {
  readonly valid: boolean;
  readonly errors: readonly string[];
  readonly errorCategory?: string;
}

export interface ScribeValidator {
  validate(output: ScribeOutputV1, taskId: string): Promise<ScribeValidationResult>;
}

export class DefaultScribeValidator implements ScribeValidator {
  // eslint-disable-next-line @typescript-eslint/class-methods-use-this
  async validate(output: ScribeOutputV1, taskId: string): Promise<ScribeValidationResult> {
    const errors: string[] = [];

    if (typeof output !== 'object' || output === null) {
      return { valid: false, errors: ['Output is not an object'], errorCategory: 'output_invalid' };
    }

    if (output.taskId !== taskId) {
      errors.push(`taskId mismatch: expected ${taskId}, got ${String(output.taskId)}`);
    }

    if (typeof output.sourcePhilosopherArtifactId !== 'string' || output.sourcePhilosopherArtifactId.trim() === '') {
      errors.push('sourcePhilosopherArtifactId must be non-empty string');
    }

    if (typeof output.principleDraft !== 'object' || output.principleDraft === null) {
      errors.push('principleDraft must be an object');
    } else {
      const pd = output.principleDraft as unknown as Record<string, unknown>;
      if (typeof pd.title !== 'string' || (pd.title).trim() === '') errors.push('principleDraft.title must be non-empty string');
      if (typeof pd.statement !== 'string' || (pd.statement).trim() === '') errors.push('principleDraft.statement must be non-empty string');
      if (typeof pd.rationale !== 'string' || (pd.rationale).trim() === '') errors.push('principleDraft.rationale must be non-empty string');
      if (!Array.isArray(pd.applicability)) errors.push('principleDraft.applicability must be an array');
      if (!Array.isArray(pd.antiPatterns)) errors.push('principleDraft.antiPatterns must be an array');
      if (typeof pd.confidence !== 'number') errors.push('principleDraft.confidence must be number');
      else if (pd.confidence < 0 || pd.confidence > 1) errors.push('principleDraft.confidence must be in [0, 1]');
    }

    if (typeof output.sourceTrace !== 'object' || output.sourceTrace === null) {
      errors.push('sourceTrace must be an object');
    } else {
      const st = output.sourceTrace as unknown as Record<string, unknown>;
      if (typeof st.philosopherArtifactId !== 'string' || (st.philosopherArtifactId).trim() === '') {
        errors.push('sourceTrace.philosopherArtifactId must be non-empty string');
      }
    }

    if (!Array.isArray(output.risks)) {
      errors.push('risks must be an array');
    }

    if (typeof output.generatedAt !== 'string' || output.generatedAt.trim() === '') {
      errors.push('generatedAt must be non-empty string');
    }

    return errors.length > 0
      ? { valid: false, errors, errorCategory: 'output_invalid' }
      : { valid: true, errors: [] };
  }
}
