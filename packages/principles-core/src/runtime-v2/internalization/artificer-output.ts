import { Type, type Static } from '@sinclair/typebox';

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

export class DefaultArtificerValidator implements ArtificerValidator {
  // eslint-disable-next-line @typescript-eslint/class-methods-use-this
  async validate(output: unknown, taskId: string, expectedSourceScribeArtifactId?: string): Promise<ArtificerValidationResult> {
    const errors: string[] = [];

    if (typeof output !== 'object' || output === null) {
      return { valid: false, errors: ['Output is not an object'], errorCategory: 'output_invalid' };
    }

    // Narrow to Record for property access on unknown (ERR-001).
    const rec = output as Record<string, unknown>;

    if (rec.taskId !== taskId) {
      errors.push(`taskId mismatch: expected ${taskId}, got ${String(rec.taskId)}`);
    }

    if (typeof rec.sourceScribeArtifactId !== 'string' || rec.sourceScribeArtifactId.trim() === '') {
      errors.push('sourceScribeArtifactId must be non-empty string');
    } else if (expectedSourceScribeArtifactId && rec.sourceScribeArtifactId !== expectedSourceScribeArtifactId) {
      errors.push(`sourceScribeArtifactId mismatch: expected ${expectedSourceScribeArtifactId}, got ${rec.sourceScribeArtifactId}`);
    }

    if (typeof rec.implementationPlan !== 'object' || rec.implementationPlan === null) {
      errors.push('implementationPlan must be an object');
    } else {
      const ip = rec.implementationPlan as Record<string, unknown>;
      if (typeof ip.summary !== 'string' || ip.summary.trim() === '') errors.push('implementationPlan.summary must be non-empty string');
      if (typeof ip.targetSurface !== 'string' || ip.targetSurface.trim() === '') errors.push('implementationPlan.targetSurface must be non-empty string');
      if (!Array.isArray(ip.changes)) errors.push('implementationPlan.changes must be an array');
      else if (!(ip.changes as unknown[]).every(e => typeof e === 'string')) errors.push('implementationPlan.changes must be an array of strings');
      if (!Array.isArray(ip.tests)) errors.push('implementationPlan.tests must be an array');
      else if (!(ip.tests as unknown[]).every(e => typeof e === 'string')) errors.push('implementationPlan.tests must be an array of strings');
      if (!Array.isArray(ip.rolloutNotes)) errors.push('implementationPlan.rolloutNotes must be an array');
      else if (!(ip.rolloutNotes as unknown[]).every(e => typeof e === 'string')) errors.push('implementationPlan.rolloutNotes must be an array of strings');
      if (typeof ip.confidence !== 'number' || !Number.isFinite(ip.confidence)) errors.push('implementationPlan.confidence must be number');
      else if (ip.confidence < 0 || ip.confidence > 1) errors.push('implementationPlan.confidence must be in [0, 1]');
    }

    if (typeof rec.sourceTrace !== 'object' || rec.sourceTrace === null) {
      errors.push('sourceTrace must be an object');
    } else {
      const st = rec.sourceTrace as Record<string, unknown>;
      if (typeof st.scribeArtifactId !== 'string' || st.scribeArtifactId.trim() === '') {
        errors.push('sourceTrace.scribeArtifactId must be non-empty string');
      } else if (expectedSourceScribeArtifactId && st.scribeArtifactId !== expectedSourceScribeArtifactId) {
        errors.push(`sourceTrace.scribeArtifactId mismatch: expected ${expectedSourceScribeArtifactId}, got ${st.scribeArtifactId}`);
      }
      if (st.philosopherArtifactId !== undefined && typeof st.philosopherArtifactId !== 'string') {
        errors.push('sourceTrace.philosopherArtifactId must be string if present');
      }
      if (st.dreamerArtifactId !== undefined && typeof st.dreamerArtifactId !== 'string') {
        errors.push('sourceTrace.dreamerArtifactId must be string if present');
      }
    }

    if (!Array.isArray(rec.risks)) {
      errors.push('risks must be an array');
    } else if (!(rec.risks as unknown[]).every(e => typeof e === 'string')) {
      errors.push('risks must be an array of strings');
    }

    if (typeof rec.sourceScribeArtifactId === 'string' && rec.sourceScribeArtifactId.trim() !== ''
      && typeof rec.sourceTrace === 'object' && rec.sourceTrace !== null
      && typeof (rec.sourceTrace as Record<string, unknown>).scribeArtifactId === 'string'
      && rec.sourceScribeArtifactId !== (rec.sourceTrace as Record<string, unknown>).scribeArtifactId) {
      errors.push('sourceScribeArtifactId and sourceTrace.scribeArtifactId must match');
    }

    if (typeof rec.generatedAt !== 'string' || rec.generatedAt.trim() === '') {
      errors.push('generatedAt must be non-empty string');
    }

    return errors.length > 0
      ? { valid: false, errors, errorCategory: 'output_invalid' }
      : { valid: true, errors: [] };
  }
}
