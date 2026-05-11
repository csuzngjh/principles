import { describe, it, expect } from 'vitest';
import {
  RolloutReviewerPromptBuilder,
  ROLLOUT_REVIEWER_PROTOCOL_INSTRUCTION,
  ROLLOUT_REVIEWER_PROMPT_CONTRACT_VERSION,
} from '../rollout-reviewer-prompt-builder.js';

describe('RolloutReviewerPromptBuilder', () => {
  const builder = new RolloutReviewerPromptBuilder();

  it('buildPrompt produces valid JSON message', () => {
    const result = builder.buildPrompt({
      taskId: 'task-rr-001',
      contextHash: 'ctx-abc123',
      sourceEvaluatorArtifactId: 'pi-art-evaluator-001',
      evaluatorArtifact: { taskId: 'eval-001', evaluation: { decision: 'approved' } },
    });

    expect(result.message).toBeDefined();
    const parsed = JSON.parse(result.message);
    expect(parsed).toBeDefined();
    expect(typeof parsed).toBe('object');
  });

  it('promptInput contains correct sourceEvaluatorArtifactId', () => {
    const result = builder.buildPrompt({
      taskId: 'task-rr-001',
      contextHash: 'ctx-abc123',
      sourceEvaluatorArtifactId: 'pi-art-evaluator-001',
      evaluatorArtifact: { taskId: 'eval-001' },
    });

    expect(result.promptInput.sourceEvaluatorArtifactId).toBe('pi-art-evaluator-001');
  });

  it('promptInput contains rolloutReviewerInstruction', () => {
    const result = builder.buildPrompt({
      taskId: 'task-rr-001',
      contextHash: 'ctx-abc123',
      sourceEvaluatorArtifactId: 'pi-art-evaluator-001',
      evaluatorArtifact: null,
    });

    expect(result.promptInput.rolloutReviewerInstruction).toBe(ROLLOUT_REVIEWER_PROTOCOL_INSTRUCTION);
  });

  it('promptContractVersion is set correctly', () => {
    const result = builder.buildPrompt({
      taskId: 'task-rr-001',
      contextHash: 'ctx-abc123',
      sourceEvaluatorArtifactId: 'pi-art-evaluator-001',
      evaluatorArtifact: null,
    });

    expect(result.promptInput.promptContractVersion).toBe(ROLLOUT_REVIEWER_PROMPT_CONTRACT_VERSION);
  });

  it('promptInput contains taskId and contextHash', () => {
    const result = builder.buildPrompt({
      taskId: 'task-rr-001',
      contextHash: 'ctx-abc123',
      sourceEvaluatorArtifactId: 'pi-art-evaluator-001',
      evaluatorArtifact: null,
    });

    expect(result.promptInput.taskId).toBe('task-rr-001');
    expect(result.promptInput.contextHash).toBe('ctx-abc123');
  });

  it('promptInput contains evaluatorArtifact', () => {
    const evaluatorArtifact = { taskId: 'eval-001', evaluation: { decision: 'approved' } };
    const result = builder.buildPrompt({
      taskId: 'task-rr-001',
      contextHash: 'ctx-abc123',
      sourceEvaluatorArtifactId: 'pi-art-evaluator-001',
      evaluatorArtifact,
    });

    expect(result.promptInput.evaluatorArtifact).toBe(evaluatorArtifact);
  });

  it('protocol instruction contains CRITICAL JSON-only directive', () => {
    expect(ROLLOUT_REVIEWER_PROTOCOL_INSTRUCTION).toContain('CRITICAL');
    expect(ROLLOUT_REVIEWER_PROTOCOL_INSTRUCTION).toContain('ONLY valid JSON');
    expect(ROLLOUT_REVIEWER_PROTOCOL_INSTRUCTION).toContain('no markdown');
    expect(ROLLOUT_REVIEWER_PROTOCOL_INSTRUCTION).toContain('no code fences');
  });

  it('protocol instruction contains complete example output', () => {
    expect(ROLLOUT_REVIEWER_PROTOCOL_INSTRUCTION).toContain('COMPLETE EXAMPLE OUTPUT');
    expect(ROLLOUT_REVIEWER_PROTOCOL_INSTRUCTION).toContain('approve_rollout');
  });
});
