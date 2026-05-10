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
  validate(output: PhilosopherOutputV1, taskId: string): Promise<PhilosopherValidationResult>;
}

export class DefaultPhilosopherValidator implements PhilosopherValidator {
  // eslint-disable-next-line @typescript-eslint/class-methods-use-this
  async validate(output: PhilosopherOutputV1, taskId: string): Promise<PhilosopherValidationResult> {
    const errors: string[] = [];

    if (typeof output !== 'object' || output === null) {
      return { valid: false, errors: ['Output is not an object'], errorCategory: 'output_invalid' };
    }

    if (output.taskId !== taskId) {
      errors.push(`taskId mismatch: expected ${taskId}, got ${String(output.taskId)}`);
    }

    if (typeof output.sourceDreamerArtifactId !== 'string' || output.sourceDreamerArtifactId.trim() === '') {
      errors.push('sourceDreamerArtifactId must be non-empty string');
    }

    if (typeof output.thesis !== 'string' || output.thesis.trim() === '') {
      errors.push('thesis must be non-empty string');
    }

    if (typeof output.principleCandidate !== 'object' || output.principleCandidate === null) {
      errors.push('principleCandidate must be an object');
    } else {
      const pc = output.principleCandidate as unknown as Record<string, unknown>;
      if (typeof pc.title !== 'string' || (pc.title).trim() === '') errors.push('principleCandidate.title must be non-empty string');
      if (typeof pc.rationale !== 'string' || (pc.rationale).trim() === '') errors.push('principleCandidate.rationale must be non-empty string');
      if (typeof pc.scope !== 'string' || (pc.scope).trim() === '') errors.push('principleCandidate.scope must be non-empty string');
      if (typeof pc.confidence !== 'number') errors.push('principleCandidate.confidence must be number');
      else if (pc.confidence < 0 || pc.confidence > 1) errors.push('principleCandidate.confidence must be in [0, 1]');
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
