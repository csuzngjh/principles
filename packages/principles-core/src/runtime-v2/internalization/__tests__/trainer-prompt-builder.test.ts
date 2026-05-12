import { describe, it, expect } from 'vitest';
import { TrainerPromptBuilder, TRAINER_PROTOCOL_INSTRUCTION, TRAINER_PROMPT_CONTRACT_VERSION } from '../trainer-prompt-builder.js';

const TASK_ID = 'trainer-001';
const CONTEXT_HASH = 'ctx-abc123';
const SOURCE_ROLLOUT_REVIEWER_ARTIFACT_ID = 'pi-art-rollout-reviewer-001';

const ROLLOUT_REVIEWER_ARTIFACT = {
  taskId: 'rollout-reviewer-001',
  sourceEvaluatorArtifactId: 'pi-art-evaluator-001',
  review: {
    decision: 'approve_rollout',
    summary: 'The rollout plan is safe to proceed',
    confidence: 0.9,
    requiredChanges: [],
    rolloutRisks: ['Feature flag configuration may need adjustment'],
    safetyChecks: ['Verify feature flag is properly configured'],
  },
  sourceTrace: {
    evaluatorArtifactId: 'pi-art-evaluator-001',
  },
  risks: ['Rollback plan should be tested before deployment'],
  generatedAt: '2026-05-11T12:00:00.000Z',
};

describe('TrainerPromptBuilder (vertical slice)', () => {
  it('buildPrompt returns a message string', () => {
    const builder = new TrainerPromptBuilder();
    const result = builder.buildPrompt({
      taskId: TASK_ID,
      contextHash: CONTEXT_HASH,
      sourceRolloutReviewerArtifactId: SOURCE_ROLLOUT_REVIEWER_ARTIFACT_ID,
      rolloutReviewerArtifact: ROLLOUT_REVIEWER_ARTIFACT,
    });

    expect(typeof result.message).toBe('string');
    expect(result.message.length).toBeGreaterThan(0);
  });

  it('promptInput includes taskId', () => {
    const builder = new TrainerPromptBuilder();
    const result = builder.buildPrompt({
      taskId: TASK_ID,
      contextHash: CONTEXT_HASH,
      sourceRolloutReviewerArtifactId: SOURCE_ROLLOUT_REVIEWER_ARTIFACT_ID,
      rolloutReviewerArtifact: ROLLOUT_REVIEWER_ARTIFACT,
    });

    expect(result.promptInput.taskId).toBe(TASK_ID);
  });

  it('promptInput includes contextHash', () => {
    const builder = new TrainerPromptBuilder();
    const result = builder.buildPrompt({
      taskId: TASK_ID,
      contextHash: CONTEXT_HASH,
      sourceRolloutReviewerArtifactId: SOURCE_ROLLOUT_REVIEWER_ARTIFACT_ID,
      rolloutReviewerArtifact: ROLLOUT_REVIEWER_ARTIFACT,
    });

    expect(result.promptInput.contextHash).toBe(CONTEXT_HASH);
  });

  it('promptInput includes sourceRolloutReviewerArtifactId', () => {
    const builder = new TrainerPromptBuilder();
    const result = builder.buildPrompt({
      taskId: TASK_ID,
      contextHash: CONTEXT_HASH,
      sourceRolloutReviewerArtifactId: SOURCE_ROLLOUT_REVIEWER_ARTIFACT_ID,
      rolloutReviewerArtifact: ROLLOUT_REVIEWER_ARTIFACT,
    });

    expect(result.promptInput.sourceRolloutReviewerArtifactId).toBe(SOURCE_ROLLOUT_REVIEWER_ARTIFACT_ID);
  });

  it('promptInput includes rolloutReviewerArtifact', () => {
    const builder = new TrainerPromptBuilder();
    const result = builder.buildPrompt({
      taskId: TASK_ID,
      contextHash: CONTEXT_HASH,
      sourceRolloutReviewerArtifactId: SOURCE_ROLLOUT_REVIEWER_ARTIFACT_ID,
      rolloutReviewerArtifact: ROLLOUT_REVIEWER_ARTIFACT,
    });

    expect(result.promptInput.rolloutReviewerArtifact).toBe(ROLLOUT_REVIEWER_ARTIFACT);
  });

  it('promptInput includes trainerInstruction', () => {
    const builder = new TrainerPromptBuilder();
    const result = builder.buildPrompt({
      taskId: TASK_ID,
      contextHash: CONTEXT_HASH,
      sourceRolloutReviewerArtifactId: SOURCE_ROLLOUT_REVIEWER_ARTIFACT_ID,
      rolloutReviewerArtifact: ROLLOUT_REVIEWER_ARTIFACT,
    });

    expect(typeof result.promptInput.trainerInstruction).toBe('string');
    expect(result.promptInput.trainerInstruction.length).toBeGreaterThan(0);
  });

  it('promptInput includes promptContractVersion', () => {
    const builder = new TrainerPromptBuilder();
    const result = builder.buildPrompt({
      taskId: TASK_ID,
      contextHash: CONTEXT_HASH,
      sourceRolloutReviewerArtifactId: SOURCE_ROLLOUT_REVIEWER_ARTIFACT_ID,
      rolloutReviewerArtifact: ROLLOUT_REVIEWER_ARTIFACT,
    });

    expect(result.promptInput.promptContractVersion).toBe('trainer-output-v1.prompt.v1');
  });

  it('message is valid JSON parseable', () => {
    const builder = new TrainerPromptBuilder();
    const result = builder.buildPrompt({
      taskId: TASK_ID,
      contextHash: CONTEXT_HASH,
      sourceRolloutReviewerArtifactId: SOURCE_ROLLOUT_REVIEWER_ARTIFACT_ID,
      rolloutReviewerArtifact: ROLLOUT_REVIEWER_ARTIFACT,
    });

    expect(() => JSON.parse(result.message)).not.toThrow();
  });

  it('parsed message contains all required fields', () => {
    const builder = new TrainerPromptBuilder();
    const result = builder.buildPrompt({
      taskId: TASK_ID,
      contextHash: CONTEXT_HASH,
      sourceRolloutReviewerArtifactId: SOURCE_ROLLOUT_REVIEWER_ARTIFACT_ID,
      rolloutReviewerArtifact: ROLLOUT_REVIEWER_ARTIFACT,
    });

    const parsed = JSON.parse(result.message);
    expect(parsed.taskId).toBe(TASK_ID);
    expect(parsed.contextHash).toBe(CONTEXT_HASH);
    expect(parsed.sourceRolloutReviewerArtifactId).toBe(SOURCE_ROLLOUT_REVIEWER_ARTIFACT_ID);
    expect(parsed.rolloutReviewerArtifact).toBeDefined();
    expect(parsed.trainerInstruction).toBeDefined();
    expect(parsed.promptContractVersion).toBe('trainer-output-v1.prompt.v1');
  });

  it('message does not include markdown code fences', () => {
    const builder = new TrainerPromptBuilder();
    const result = builder.buildPrompt({
      taskId: TASK_ID,
      contextHash: CONTEXT_HASH,
      sourceRolloutReviewerArtifactId: SOURCE_ROLLOUT_REVIEWER_ARTIFACT_ID,
      rolloutReviewerArtifact: ROLLOUT_REVIEWER_ARTIFACT,
    });

    expect(result.message).not.toMatch(/^```/);
    expect(result.message).not.toMatch(/```$/);
  });

  it('trainerInstruction contains JSON-only directive', () => {
    expect(TRAINER_PROTOCOL_INSTRUCTION).toContain('JSON');
    expect(TRAINER_PROTOCOL_INSTRUCTION).toContain('only');
  });

  it('promptContractVersion constant is trainer-output-v1.prompt.v1', () => {
    expect(TRAINER_PROMPT_CONTRACT_VERSION).toBe('trainer-output-v1.prompt.v1');
  });
});
