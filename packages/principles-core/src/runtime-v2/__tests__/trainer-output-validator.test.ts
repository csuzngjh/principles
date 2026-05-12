import { describe, it, expect } from 'vitest';
import { DefaultTrainerValidator } from '../internalization/trainer-output.js';
import type { TrainerOutputV1 } from '../internalization/trainer-output.js';

const TRAINER_TASK_ID = 'trainer-001';
const ROLLOUT_REVIEWER_ARTIFACT_ID = 'pi-art-rollout-reviewer-001';

function makeTrainerOutput(overrides: Partial<TrainerOutputV1> = {}): TrainerOutputV1 {
  return {
    taskId: TRAINER_TASK_ID,
    sourceRolloutReviewerArtifactId: ROLLOUT_REVIEWER_ARTIFACT_ID,
    ruleCandidate: {
      toolScope: 'tool_call',
      triggerCondition: 'When a tool is called',
      proposedDecision: 'allow',
      rationale: 'Standard safe operation pattern',
      confidence: 0.85,
    },
    safety: {
      limitations: ['Requires feature flag'],
      falsePositiveRisks: ['May block legitimate edge cases'],
      requiredReplayCases: ['tool_call with empty params', 'tool_call with null toolName'],
    },
    sourceTrace: {
      rolloutReviewerArtifactId: ROLLOUT_REVIEWER_ARTIFACT_ID,
    },
    generatedAt: new Date().toISOString(),
    ...overrides,
  };
}

describe('DefaultTrainerValidator (vertical slice)', () => {
  const validator = new DefaultTrainerValidator();

  it('accepts valid Trainer output', async () => {
    const result = await validator.validate(makeTrainerOutput(), TRAINER_TASK_ID);
    expect(result.valid).toBe(true);
  });

  it('rejects taskId mismatch', async () => {
    const output = makeTrainerOutput();
    (output as unknown as Record<string, unknown>).taskId = 'wrong';
    const result = await validator.validate(output, TRAINER_TASK_ID);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('taskId mismatch'))).toBe(true);
  });

  it('rejects missing sourceRolloutReviewerArtifactId', async () => {
    const output = makeTrainerOutput();
    (output as unknown as Record<string, unknown>).sourceRolloutReviewerArtifactId = '';
    const result = await validator.validate(output, TRAINER_TASK_ID);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('sourceRolloutReviewerArtifactId'))).toBe(true);
  });

  it('rejects mismatched sourceRolloutReviewerArtifactId when expected is provided', async () => {
    const output = makeTrainerOutput();
    (output as unknown as Record<string, unknown>).sourceRolloutReviewerArtifactId = 'wrong-artifact-id';
    const result = await validator.validate(output, TRAINER_TASK_ID, ROLLOUT_REVIEWER_ARTIFACT_ID);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('sourceRolloutReviewerArtifactId mismatch'))).toBe(true);
  });

  it('rejects mismatched sourceTrace.rolloutReviewerArtifactId vs sourceRolloutReviewerArtifactId', async () => {
    const output = makeTrainerOutput();
    (output.sourceTrace as unknown as Record<string, unknown>).rolloutReviewerArtifactId = 'wrong-trace-id';
    const result = await validator.validate(output, TRAINER_TASK_ID);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('must match'))).toBe(true);
  });

  it('rejects invalid proposedDecision value', async () => {
    const output = makeTrainerOutput();
    (output.ruleCandidate as unknown as Record<string, unknown>).proposedDecision = 'invalid';
    const result = await validator.validate(output, TRAINER_TASK_ID);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('proposedDecision'))).toBe(true);
  });

  it('rejects confidence as string', async () => {
    const output = makeTrainerOutput();
    (output.ruleCandidate as unknown as Record<string, unknown>).confidence = '0.85';
    const result = await validator.validate(output, TRAINER_TASK_ID);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('confidence must be number'))).toBe(true);
  });

  it('rejects confidence > 1', async () => {
    const output = makeTrainerOutput();
    (output.ruleCandidate as unknown as Record<string, unknown>).confidence = 1.5;
    const result = await validator.validate(output, TRAINER_TASK_ID);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('confidence must be in [0, 1]'))).toBe(true);
  });

  it('rejects NaN confidence', async () => {
    const output = makeTrainerOutput();
    (output.ruleCandidate as unknown as Record<string, unknown>).confidence = NaN;
    const result = await validator.validate(output, TRAINER_TASK_ID);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('confidence must be number'))).toBe(true);
  });

  it('rejects Infinity confidence', async () => {
    const output = makeTrainerOutput();
    (output.ruleCandidate as unknown as Record<string, unknown>).confidence = Infinity;
    const result = await validator.validate(output, TRAINER_TASK_ID);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('confidence must be number'))).toBe(true);
  });

  it('rejects null output', async () => {
    const result = await validator.validate(null as unknown as TrainerOutputV1, TRAINER_TASK_ID);
    expect(result.valid).toBe(false);
  });

  it('rejects missing toolScope', async () => {
    const output = makeTrainerOutput();
    (output.ruleCandidate as unknown as Record<string, unknown>).toolScope = '';
    const result = await validator.validate(output, TRAINER_TASK_ID);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('toolScope'))).toBe(true);
  });

  it('rejects missing triggerCondition', async () => {
    const output = makeTrainerOutput();
    (output.ruleCandidate as unknown as Record<string, unknown>).triggerCondition = '';
    const result = await validator.validate(output, TRAINER_TASK_ID);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('triggerCondition'))).toBe(true);
  });

  it('rejects missing rationale', async () => {
    const output = makeTrainerOutput();
    (output.ruleCandidate as unknown as Record<string, unknown>).rationale = '';
    const result = await validator.validate(output, TRAINER_TASK_ID);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('rationale'))).toBe(true);
  });

  it('accepts auto_correct with proposedCorrection', async () => {
    const output = makeTrainerOutput({
      ruleCandidate: {
        toolScope: 'tool_call',
        triggerCondition: 'When a tool is called with invalid params',
        proposedDecision: 'auto_correct',
        proposedCorrection: {
          description: 'Use default params instead',
          proposedParams: { defaultTimeout: 5000 },
        },
        rationale: 'Safe to auto-correct with defaults',
        confidence: 0.9,
      },
    });
    const result = await validator.validate(output, TRAINER_TASK_ID);
    expect(result.valid).toBe(true);
  });

  it('rejects auto_correct without proposedCorrection', async () => {
    const output = makeTrainerOutput({
      ruleCandidate: {
        toolScope: 'tool_call',
        triggerCondition: 'When a tool is called',
        proposedDecision: 'auto_correct',
        rationale: 'Safe to auto-correct',
        confidence: 0.9,
      },
    } as TrainerOutputV1);
    // TypeScript allows this structurally, but validator should reject
    const result = await validator.validate(output, TRAINER_TASK_ID);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('proposedCorrection'))).toBe(true);
  });

  it('rejects non-auto_correct decision with proposedCorrection', async () => {
    const output = makeTrainerOutput({
      ruleCandidate: {
        toolScope: 'tool_call',
        triggerCondition: 'When a tool is called',
        proposedDecision: 'allow',
        proposedCorrection: {
          description: 'Should not exist for allow decision',
          proposedParams: {},
        },
        rationale: 'This should be invalid',
        confidence: 0.85,
      },
    } as TrainerOutputV1);
    const result = await validator.validate(output, TRAINER_TASK_ID);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('proposedCorrection'))).toBe(true);
  });

  it('rejects safety.limitations with non-string elements', async () => {
    const output = makeTrainerOutput();
    (output.safety as unknown as Record<string, unknown>).limitations = [42];
    const result = await validator.validate(output, TRAINER_TASK_ID);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('limitations must be an array of strings'))).toBe(true);
  });

  it('rejects safety.falsePositiveRisks with non-string elements', async () => {
    const output = makeTrainerOutput();
    (output.safety as unknown as Record<string, unknown>).falsePositiveRisks = [true];
    const result = await validator.validate(output, TRAINER_TASK_ID);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('falsePositiveRisks must be an array of strings'))).toBe(true);
  });

  it('rejects safety.requiredReplayCases with non-string elements', async () => {
    const output = makeTrainerOutput();
    (output.safety as unknown as Record<string, unknown>).requiredReplayCases = [{}];
    const result = await validator.validate(output, TRAINER_TASK_ID);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('requiredReplayCases must be an array of strings'))).toBe(true);
  });

  it('accepts output with optional goldenTraceRefs', async () => {
    const output = makeTrainerOutput({
      goldenTraceRefs: ['gt-case-001', 'gt-case-002'],
    });
    const result = await validator.validate(output, TRAINER_TASK_ID);
    expect(result.valid).toBe(true);
  });

  it('rejects goldenTraceRefs with non-string elements', async () => {
    const output = makeTrainerOutput();
    (output as unknown as Record<string, unknown>).goldenTraceRefs = [42];
    const result = await validator.validate(output, TRAINER_TASK_ID);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('goldenTraceRefs must be an array of strings'))).toBe(true);
  });

  it('rejects missing generatedAt', async () => {
    const output = makeTrainerOutput();
    (output as unknown as Record<string, unknown>).generatedAt = '';
    const result = await validator.validate(output, TRAINER_TASK_ID);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('generatedAt'))).toBe(true);
  });

  it('rejects unparseable generatedAt', async () => {
    const output = makeTrainerOutput();
    (output as unknown as Record<string, unknown>).generatedAt = 'not-a-date';
    const result = await validator.validate(output, TRAINER_TASK_ID);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('generatedAt'))).toBe(true);
  });

  it('rejects mismatched sourceRolloutReviewerArtifactId vs sourceTrace.rolloutReviewerArtifactId', async () => {
    const output = makeTrainerOutput();
    (output.sourceTrace as unknown as Record<string, unknown>).rolloutReviewerArtifactId = 'different-id';
    const result = await validator.validate(output, TRAINER_TASK_ID);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('must match'))).toBe(true);
  });

  it('accepts valid output with all optional fields', async () => {
    const output = makeTrainerOutput({
      goldenTraceRefs: ['gt-001'],
      inlineGoldenTraceCases: [
        {
          caseId: 'case-001',
          kind: 'positive',
          toolName: 'tool_call',
          params: { name: 'test' },
          expectedDecision: 'allow',
          sourceRefs: [],
        },
      ],
      sourceTrace: {
        rolloutReviewerArtifactId: ROLLOUT_REVIEWER_ARTIFACT_ID,
        evaluatorArtifactId: 'pi-art-evaluator-001',
      },
    });
    const result = await validator.validate(output, TRAINER_TASK_ID);
    expect(result.valid).toBe(true);
  });

  it('rejects non-string rolloutReviewerArtifactId in sourceTrace', async () => {
    const output = makeTrainerOutput();
    (output.sourceTrace as unknown as Record<string, unknown>).rolloutReviewerArtifactId = 42;
    const result = await validator.validate(output, TRAINER_TASK_ID);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('rolloutReviewerArtifactId'))).toBe(true);
  });
});
