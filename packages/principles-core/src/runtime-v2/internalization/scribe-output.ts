/**
 * ScribeOutputV1 — Output schema for the Scribe peer runner.
 *
 * The Scribe reads a Philosopher artifact and produces a formal principle
 * draft with statement, rationale, applicability, and anti-patterns.
 * This is the third stage in the internalization pipeline
 * (Dreamer → Philosopher → Scribe → Artificer).
 *
 * @see docs/adr/0003-peer-agent-state-machine-orchestration.md
 */

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
  /**
   * Validate untrusted LLM/runtime output.
   *
   * Receives `unknown` — must perform runtime validation before
   * treating as ScribeOutputV1 (ERR-001, ERR-005).
   */
  validate(output: unknown, taskId: string, expectedSourcePhilosopherArtifactId?: string): Promise<ScribeValidationResult>;
}

export class DefaultScribeValidator implements ScribeValidator {
  // eslint-disable-next-line @typescript-eslint/class-methods-use-this
  async validate(output: unknown, taskId: string, expectedSourcePhilosopherArtifactId?: string): Promise<ScribeValidationResult> {
    const errors: string[] = [];

    if (typeof output !== 'object' || output === null) {
      return { valid: false, errors: ['Output is not an object'], errorCategory: 'output_invalid' };
    }

    // After null-check, treat as Record for runtime property access (ERR-001, ERR-005).
    const obj = output as Record<string, unknown>;

    if (obj.taskId !== taskId) {
      errors.push(`taskId mismatch: expected ${taskId}, got ${String(obj.taskId)}`);
    }

    if (typeof obj.sourcePhilosopherArtifactId !== 'string' || obj.sourcePhilosopherArtifactId.trim() === '') {
      errors.push('sourcePhilosopherArtifactId must be non-empty string');
    } else if (expectedSourcePhilosopherArtifactId && obj.sourcePhilosopherArtifactId !== expectedSourcePhilosopherArtifactId) {
      errors.push(`sourcePhilosopherArtifactId mismatch: expected ${expectedSourcePhilosopherArtifactId}, got ${obj.sourcePhilosopherArtifactId}`);
    }

    if (typeof obj.principleDraft !== 'object' || obj.principleDraft === null) {
      errors.push('principleDraft must be an object');
    } else {
      const pd = obj.principleDraft as Record<string, unknown>;
      if (typeof pd.title !== 'string' || (pd.title).trim() === '') errors.push('principleDraft.title must be non-empty string');
      if (typeof pd.statement !== 'string' || (pd.statement).trim() === '') errors.push('principleDraft.statement must be non-empty string');
      if (typeof pd.rationale !== 'string' || (pd.rationale).trim() === '') errors.push('principleDraft.rationale must be non-empty string');
      if (!Array.isArray(pd.applicability)) errors.push('principleDraft.applicability must be an array');
      else if (!(pd.applicability as unknown[]).every(e => typeof e === 'string')) errors.push('principleDraft.applicability must be an array of strings');
      if (!Array.isArray(pd.antiPatterns)) errors.push('principleDraft.antiPatterns must be an array');
      else if (!(pd.antiPatterns as unknown[]).every(e => typeof e === 'string')) errors.push('principleDraft.antiPatterns must be an array of strings');
      if (typeof pd.confidence !== 'number') errors.push('principleDraft.confidence must be number');
      else if (pd.confidence < 0 || pd.confidence > 1) errors.push('principleDraft.confidence must be in [0, 1]');
    }

    if (typeof obj.sourceTrace !== 'object' || obj.sourceTrace === null) {
      errors.push('sourceTrace must be an object');
    } else {
      const st = obj.sourceTrace as Record<string, unknown>;
      if (typeof st.philosopherArtifactId !== 'string' || (st.philosopherArtifactId).trim() === '') {
        errors.push('sourceTrace.philosopherArtifactId must be non-empty string');
      } else if (expectedSourcePhilosopherArtifactId && st.philosopherArtifactId !== expectedSourcePhilosopherArtifactId) {
        errors.push(`sourceTrace.philosopherArtifactId mismatch: expected ${expectedSourcePhilosopherArtifactId}, got ${st.philosopherArtifactId}`);
      }
    }

    if (!Array.isArray(obj.risks)) {
      errors.push('risks must be an array');
    } else if (!(obj.risks as unknown[]).every(e => typeof e === 'string')) {
      errors.push('risks must be an array of strings');
    }

    if (typeof obj.generatedAt !== 'string' || obj.generatedAt.trim() === '') {
      errors.push('generatedAt must be non-empty string');
    }

    return errors.length > 0
      ? { valid: false, errors, errorCategory: 'output_invalid' }
      : { valid: true, errors: [] };
  }
}
