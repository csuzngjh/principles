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

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
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

    return errors.length > 0
      ? { valid: false, errors, errorCategory: 'output_invalid' }
      : { valid: true, errors: [] };
  }
}
