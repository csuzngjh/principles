/**
 * PhilosopherOutputV1 — Output schema for the Philosopher peer runner.
 *
 * The Philosopher reads a Dreamer artifact and produces a principle candidate
 * with philosophical analysis. This is the second stage in the internalization
 * pipeline (Dreamer → Philosopher → Scribe).
 *
 * @see docs/adr/0003-peer-agent-state-machine-orchestration.md
 */

import { Type, type Static } from '@sinclair/typebox';

// ── Output Types ──────────────────────────────────────────────────────────────

export interface PhilosopherPrincipleCandidate {
  readonly title: string;
  readonly rationale: string;
  readonly scope: string;
  readonly confidence: number;
}

export interface PhilosopherOutputV1 {
  readonly taskId: string;
  readonly sourceDreamerArtifactId: string;
  readonly thesis: string;
  readonly principleCandidate: PhilosopherPrincipleCandidate;
  readonly risks: readonly string[];
  readonly generatedAt: string;
}

// ── TypeBox Schema ──────────────────────────────────────────────────────────

export const PhilosopherPrincipleCandidateSchema = Type.Object({
  title: Type.String({ minLength: 1 }),
  rationale: Type.String({ minLength: 1 }),
  scope: Type.String({ minLength: 1 }),
  confidence: Type.Number({ minimum: 0, maximum: 1 }),
});

export const PhilosopherOutputV1Schema = Type.Object({
  taskId: Type.String({ minLength: 1 }),
  sourceDreamerArtifactId: Type.String({ minLength: 1 }),
  thesis: Type.String({ minLength: 1 }),
  principleCandidate: PhilosopherPrincipleCandidateSchema,
  risks: Type.Array(Type.String()),
  generatedAt: Type.String({ minLength: 1 }),
});

export type PhilosopherOutputV1TB = Static<typeof PhilosopherOutputV1Schema>;

// ── Validation ────────────────────────────────────────────────────────────────

export interface PhilosopherValidationResult {
  readonly valid: boolean;
  readonly errors: readonly string[];
  readonly errorCategory?: string;
}

export interface PhilosopherValidator {
  /**
   * Validate untrusted LLM/runtime output.
   *
   * Receives `unknown` — must perform runtime validation before
   * treating as PhilosopherOutputV1 (ERR-001, ERR-005, ERR-054).
   */
  validate(output: unknown, taskId: string): Promise<PhilosopherValidationResult>;
}

export class DefaultPhilosopherValidator implements PhilosopherValidator {
  // eslint-disable-next-line @typescript-eslint/class-methods-use-this
  async validate(output: unknown, taskId: string): Promise<PhilosopherValidationResult> {
    const errors: string[] = [];

    if (typeof output !== 'object' || output === null) {
      return { valid: false, errors: ['Output is not an object'], errorCategory: 'output_invalid' };
    }

    // Safe property access via Record<string, unknown> — no `as PhilosopherOutputV1` (ERR-001).
    const record = output as Record<string, unknown>;

    if (record.taskId !== taskId) {
      errors.push(`taskId mismatch: expected ${taskId}, got ${String(record.taskId)}`);
    }

    if (typeof record.sourceDreamerArtifactId !== 'string' || record.sourceDreamerArtifactId.trim() === '') {
      errors.push('sourceDreamerArtifactId must be non-empty string');
    }

    if (typeof record.thesis !== 'string' || record.thesis.trim() === '') {
      errors.push('thesis must be non-empty string');
    }

    if (typeof record.principleCandidate !== 'object' || record.principleCandidate === null) {
      errors.push('principleCandidate must be an object');
    } else {
      const pc = record.principleCandidate as Record<string, unknown>;
      if (typeof pc.title !== 'string' || pc.title.trim() === '') errors.push('principleCandidate.title must be non-empty string');
      if (typeof pc.rationale !== 'string' || pc.rationale.trim() === '') errors.push('principleCandidate.rationale must be non-empty string');
      if (typeof pc.scope !== 'string' || pc.scope.trim() === '') errors.push('principleCandidate.scope must be non-empty string');
      if (typeof pc.confidence !== 'number') errors.push('principleCandidate.confidence must be number');
      else if (pc.confidence < 0 || pc.confidence > 1) errors.push('principleCandidate.confidence must be in [0, 1]');
    }

    if (!Array.isArray(record.risks)) {
      errors.push('risks must be an array');
    } else if (record.risks.some((risk: unknown) => typeof risk !== 'string')) {
      errors.push('risks must contain only strings');
    }

    if (typeof record.generatedAt !== 'string' || record.generatedAt.trim() === '') {
      errors.push('generatedAt must be non-empty string');
    }

    return errors.length > 0
      ? { valid: false, errors, errorCategory: 'output_invalid' }
      : { valid: true, errors: [] };
  }
}
