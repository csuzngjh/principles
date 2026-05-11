export interface RolloutReviewerPromptBuilderInput {
  taskId: string;
  contextHash: string;
  sourceEvaluatorArtifactId: string;
  evaluatorArtifact: unknown;
}

export interface RolloutReviewerPromptInput {
  taskId: string;
  contextHash: string;
  sourceEvaluatorArtifactId: string;
  evaluatorArtifact: unknown;
  rolloutReviewerInstruction: string;
  promptContractVersion: string;
}

export interface RolloutReviewerPromptBuildResult {
  readonly message: string;
  readonly promptInput: RolloutReviewerPromptInput;
}

export const ROLLOUT_REVIEWER_PROTOCOL_INSTRUCTION = `You are a Rollout Reviewer agent in a principle internalization pipeline. Your role is to review the Evaluator's assessment and produce a rollout review decision with safety checks and risk analysis.

PROTOCOL:
1. Review the evaluatorArtifact to understand the evaluation decision, score, and feedback
2. Assess whether the evaluated plan is safe to proceed with rollout
3. Produce a decision: approve_rollout (safe to proceed), needs_revision (issues found but salvageable), or reject (fundamental safety or quality concerns)
4. Provide a confidence score from 0.0 to 1.0 reflecting your assessment certainty
5. List specific required changes if any
6. Identify rollout-specific risks
7. List safety checks that should be performed before/during rollout
8. Preserve the lineage trace from evaluator, artificer, scribe, philosopher, and dreamer artifacts
9. Identify risks associated with this review

CRITICAL: Your ENTIRE response must be ONLY the JSON object below. Do NOT include any text before or after the JSON. Do NOT wrap the JSON in markdown code fences. Do NOT add explanatory prose. Output the raw JSON object and nothing else.

COMPLETE EXAMPLE OUTPUT (follow this exact structure):
{"taskId":"task-123","sourceEvaluatorArtifactId":"pi-art-evaluator-001","review":{"decision":"approve_rollout","summary":"The evaluation is thorough and the plan is safe to proceed with rollout.","confidence":0.9,"requiredChanges":[],"rolloutRisks":["Feature flag configuration may need adjustment"],"safetyChecks":["Verify feature flag is properly configured","Monitor error rates for 24h post-deploy"]},"sourceTrace":{"evaluatorArtifactId":"pi-art-evaluator-001"},"risks":["Rollback plan should be tested before deployment"],"generatedAt":"2026-05-11T12:00:00.000Z"}

CONSTRAINTS:
- Output ONLY valid JSON — no markdown, no explanatory text, no code fences, no prose before or after
- review.decision MUST be one of: approve_rollout, needs_revision, reject
- review.summary MUST be a non-empty string
- review.confidence MUST be a number between 0.0 and 1.0 (NOT a string, NOT a percentage)
- review.requiredChanges MUST be an array of strings (can be empty)
- review.rolloutRisks MUST be an array of strings (can be empty)
- review.safetyChecks MUST be an array of strings (can be empty)
- sourceEvaluatorArtifactId MUST be copied exactly from input.sourceEvaluatorArtifactId (non-empty string)
- sourceTrace.evaluatorArtifactId MUST be copied exactly from input.sourceEvaluatorArtifactId
- sourceTrace.artificerArtifactId is optional — include only if available from evaluator artifact
- sourceTrace.scribeArtifactId is optional — include only if available from evaluator artifact
- sourceTrace.philosopherArtifactId is optional — include only if available from evaluator artifact
- sourceTrace.dreamerArtifactId is optional — include only if available from evaluator artifact
- risks MUST be an array of strings (can be empty if no risks identified)
- generatedAt MUST be an ISO-8601 timestamp string
`;

export const ROLLOUT_REVIEWER_PROMPT_CONTRACT_VERSION = 'rollout-reviewer-output-v1.prompt.v1';

export class RolloutReviewerPromptBuilder {
  // eslint-disable-next-line @typescript-eslint/class-methods-use-this
  buildPrompt(input: RolloutReviewerPromptBuilderInput): RolloutReviewerPromptBuildResult {
    const promptInput: RolloutReviewerPromptInput = {
      taskId: input.taskId,
      contextHash: input.contextHash,
      sourceEvaluatorArtifactId: input.sourceEvaluatorArtifactId,
      evaluatorArtifact: input.evaluatorArtifact,
      rolloutReviewerInstruction: ROLLOUT_REVIEWER_PROTOCOL_INSTRUCTION,
      promptContractVersion: ROLLOUT_REVIEWER_PROMPT_CONTRACT_VERSION,
    };

    const message = JSON.stringify(promptInput);

    return { message, promptInput };
  }
}
