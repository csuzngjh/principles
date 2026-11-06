import { describe, it, expect } from 'vitest';
import { DefaultScribeValidator } from '../scribe-output.js';
import { DefaultEvaluatorValidator } from '../evaluator-output.js';

/**
 * r6 review fix (P1-2 + P2-1) validator hard-rejection coverage — the
 * "present-but-malformed is a hard rejection" contract for the two structured
 * governance channels had no tests. A corrupted governance signal is worse
 * than none: these tests pin the rejection so the channels cannot silently
 * degrade into free-text ambiguity again.
 */

function scribeOutputWithGaps(gaps: unknown): Record<string, unknown> {
  return {
    taskId: 'scribe-gaps-validator',
    sourcePhilosopherArtifactId: 'pi-art-phil-1',
    principleDraft: {
      title: 'T', statement: 'S', rationale: 'R', applicability: ['write_file'], antiPatterns: [], confidence: 0.9,
    },
    sourceTrace: { philosopherArtifactId: 'pi-art-phil-1' },
    risks: [],
    ...(gaps !== undefined ? { ownerRequirementGaps: gaps } : {}),
    generatedAt: '2026-10-12T00:00:00.000Z',
  };
}

function evaluatorOutputWithFindings(findings: unknown): Record<string, unknown> {
  return {
    taskId: 'evaluator-gaps-validator',
    sourceArtificerArtifactId: 'pi-art-artificer-1',
    evaluation: {
      decision: 'needs_revision',
      summary: 'review',
      score: 0.6,
      strengths: [],
      concerns: [],
      ...(findings !== undefined ? { mismatchFindings: findings } : {}),
      requiredChanges: ['fix the guard'],
    },
    sourceTrace: { artificerArtifactId: 'pi-art-artificer-1' },
    risks: [],
    generatedAt: '2026-10-12T00:00:00.000Z',
  };
}

describe('structured governance channels — present-but-malformed is a hard rejection', () => {
  it('scribe validator rejects non-array ownerRequirementGaps', async () => {
    const validator = new DefaultScribeValidator();
    const result = await validator.validate(scribeOutputWithGaps('protected/ reads need confirmation'), 'scribe-gaps-validator', 'pi-art-phil-1');
    expect(result.valid).toBe(false);
    expect(result.errors.join(' ')).toContain('ownerRequirementGaps');
  });

  it('scribe validator rejects ownerRequirementGaps with non-string or blank entries', async () => {
    const validator = new DefaultScribeValidator();
    for (const bad of [[42], [''], ['  '], ['ok', null]]) {
      const result = await validator.validate(scribeOutputWithGaps(bad), 'scribe-gaps-validator', 'pi-art-phil-1');
      expect(result.valid, JSON.stringify(bad)).toBe(false);
      expect(result.errors.join(' ')).toContain('ownerRequirementGaps');
    }
  });

  it('scribe validator accepts well-formed gaps and tolerates absence (legacy outputs)', async () => {
    const validator = new DefaultScribeValidator();
    const declared = await validator.validate(
      scribeOutputWithGaps(['protected/ read access requires confirmation — narrowed to write-only']),
      'scribe-gaps-validator', 'pi-art-phil-1',
    );
    expect(declared.valid, JSON.stringify(declared.errors)).toBe(true);
    const legacy = scribeOutputWithGaps(undefined);
    const absent = await validator.validate(legacy, 'scribe-gaps-validator', 'pi-art-phil-1');
    expect(absent.valid).toBe(true);
  });

  it('evaluator validator rejects non-array mismatchFindings', async () => {
    const validator = new DefaultEvaluatorValidator();
    const result = await validator.validate(evaluatorOutputWithFindings('[principle_pain_mismatch] not an array'), 'evaluator-gaps-validator');
    expect(result.valid).toBe(false);
    expect(result.errors.join(' ')).toContain('mismatchFindings');
  });

  it('evaluator validator rejects mismatchFindings with non-string or blank entries', async () => {
    const validator = new DefaultEvaluatorValidator();
    for (const bad of [[42], [''], ['  ']]) {
      const result = await validator.validate(evaluatorOutputWithFindings(bad), 'evaluator-gaps-validator');
      expect(result.valid, JSON.stringify(bad)).toBe(false);
      expect(result.errors.join(' ')).toContain('mismatchFindings');
    }
  });

  it('evaluator validator accepts well-formed findings and tolerates absence', async () => {
    const validator = new DefaultEvaluatorValidator();
    const declared = await validator.validate(
      evaluatorOutputWithFindings(['[principle_pain_mismatch] contract requires persisted records — diagnosis attributes no such requirement (evidence: rootCause excerpt)']),
      'evaluator-gaps-validator',
    );
    expect(declared.valid, JSON.stringify(declared.errors)).toBe(true);
    const absent = await validator.validate(evaluatorOutputWithFindings(undefined), 'evaluator-gaps-validator');
    expect(absent.valid).toBe(true);
  });
});
