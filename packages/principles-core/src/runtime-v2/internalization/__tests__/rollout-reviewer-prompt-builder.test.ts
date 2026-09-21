import { describe, it, expect } from 'vitest';
import {
  RolloutReviewerPromptBuilder,
  ROLLOUT_REVIEWER_PROTOCOL_INSTRUCTION,
} from '../rollout-reviewer-prompt-builder.js';

describe('RolloutReviewerPromptBuilder', () => {
  const builder = new RolloutReviewerPromptBuilder();

  // Shared-contract note (PRI-888): valid-JSON message, sourceEvaluatorArtifactId
  // passthrough (by reference), taskId/contextHash, promptContractVersion and the
  // CRITICAL JSON-only directive probes for this builder now run in
  // peer-prompt-builder-contract.test.ts.

  it('systemPrompt carries the rollout reviewer instruction (PRI-633)', () => {
    const result = builder.buildPrompt({
      taskId: 'task-rr-001',
      contextHash: 'ctx-abc123',
      sourceEvaluatorArtifactId: 'pi-art-evaluator-001',
      evaluatorArtifact: null,
    });

    expect(result.systemPrompt).toBe(ROLLOUT_REVIEWER_PROTOCOL_INSTRUCTION);
  });

  it('protocol instruction contains complete example output', () => {
    expect(ROLLOUT_REVIEWER_PROTOCOL_INSTRUCTION).toContain('COMPLETE EXAMPLE OUTPUT');
    expect(ROLLOUT_REVIEWER_PROTOCOL_INSTRUCTION).toContain('approve_rollout');
  });
});
