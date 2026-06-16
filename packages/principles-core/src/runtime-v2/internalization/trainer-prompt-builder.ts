export interface TrainerPromptBuilderInput {
  taskId: string;
  contextHash: string;
  sourceRolloutReviewerArtifactId: string;
  rolloutReviewerArtifact: unknown;
}

export interface TrainerPromptInput {
  taskId: string;
  contextHash: string;
  sourceRolloutReviewerArtifactId: string;
  rolloutReviewerArtifact: unknown;
  trainerInstruction: string;
  promptContractVersion: string;
}

export interface TrainerPromptBuildResult {
  readonly message: string;
  readonly promptInput: TrainerPromptInput;
}

export const TRAINER_PROTOCOL_INSTRUCTION = `You are a Trainer agent in a principle internalization pipeline. Your role is to generate an L2 rule candidate from the RolloutReviewer's assessment, producing a structured decision, safety constraints, and test cases for replay.

PROTOCOL:
1. Review the rolloutReviewerArtifact to understand the rollout decision, safety checks, and risks
2. Extract the tool scope and trigger condition for the rule candidate
3. Produce a decision: allow (safe to use), block (unsafe), require_approval (needs human review), or auto_correct (safe to self-correct)
4. If decision is auto_correct, provide a proposed correction with description and params
5. Provide a confidence score from 0.0 to 1.0 reflecting certainty in the decision
6. Identify safety limitations, false positive risks, and required replay test cases
7. Preserve the lineage trace from evaluator, artificer, scribe, philosopher, and dreamer artifacts
8. Reference golden trace cases if available

CRITICAL: Your ENTIRE response must be ONLY the JSON object below. Do NOT include any text before or after the JSON. Do NOT wrap the JSON in markdown code fences. Do NOT add explanatory prose. Output the raw JSON object and nothing else.

COMPLETE EXAMPLE OUTPUT (follow this exact structure):
{"taskId":"task-123","sourceRolloutReviewerArtifactId":"pi-art-rollout-reviewer-001","ruleCandidate":{"toolScope":"tool_call","triggerCondition":"When a tool is called with invalid parameters","proposedDecision":"auto_correct","proposedCorrection":{"description":"Use default parameters instead","proposedParams":{"defaultTimeout":5000}},"rationale":"Safe to auto-correct with sensible defaults","confidence":0.88},"safety":{"limitations":["Requires feature flag enabled"],"falsePositiveRisks":["May incorrectly auto-correct edge case inputs"],"requiredReplayCases":["tool_call with null params","tool_call with empty toolName"]},"sourceTrace":{"rolloutReviewerArtifactId":"pi-art-rollout-reviewer-001"},"goldenTraceRefs":["gt-case-001","gt-case-002"],"generatedAt":"<current ISO-8601 timestamp>"}

CONSTRAINTS:
- Output ONLY valid JSON — no markdown, no explanatory text, no code fences, no prose before or after
- ruleCandidate.toolScope MUST be a non-empty string
- ruleCandidate.triggerCondition MUST be a non-empty string
- ruleCandidate.proposedDecision MUST be one of: allow, block, require_approval, auto_correct
- ruleCandidate.rationale MUST be a non-empty string
- ruleCandidate.confidence MUST be a number between 0.0 and 1.0 (NOT a string, NOT a percentage)
- ruleCandidate.proposedCorrection is ONLY allowed when proposedDecision is auto_correct — it must be omitted otherwise
- ruleCandidate.proposedCorrection.description MUST be a non-empty string if present
- safety.limitations MUST be an array of strings (can be empty)
- safety.falsePositiveRisks MUST be an array of strings (can be empty)
- safety.requiredReplayCases MUST be an array of strings (can be empty)
- sourceRolloutReviewerArtifactId MUST be copied exactly from input.sourceRolloutReviewerArtifactId (non-empty string)
- sourceTrace.rolloutReviewerArtifactId MUST be copied exactly from input.sourceRolloutReviewerArtifactId
- sourceTrace.evaluatorArtifactId is optional — include only if available from rollout reviewer artifact
- sourceTrace.artificerArtifactId is optional — include only if available from rollout reviewer artifact
- sourceTrace.scribeArtifactId is optional — include only if available from rollout reviewer artifact
- sourceTrace.philosopherArtifactId is optional — include only if available from rollout reviewer artifact
- sourceTrace.dreamerArtifactId is optional — include only if available from rollout reviewer artifact
- goldenTraceRefs is optional — array of strings if present
- inlineGoldenTraceCases is optional — array of case objects if present
- generatedAt MUST be the current ISO-8601 timestamp (use the actual current time, NOT a placeholder)
`;

export const TRAINER_PROMPT_CONTRACT_VERSION = 'trainer-output-v1.prompt.v1';

export class TrainerPromptBuilder {
  // eslint-disable-next-line @typescript-eslint/class-methods-use-this
  buildPrompt(input: TrainerPromptBuilderInput): TrainerPromptBuildResult {
    const promptInput: TrainerPromptInput = {
      taskId: input.taskId,
      contextHash: input.contextHash,
      sourceRolloutReviewerArtifactId: input.sourceRolloutReviewerArtifactId,
      rolloutReviewerArtifact: input.rolloutReviewerArtifact,
      trainerInstruction: TRAINER_PROTOCOL_INSTRUCTION,
      promptContractVersion: TRAINER_PROMPT_CONTRACT_VERSION,
    };

    const message = JSON.stringify(promptInput);

    return { message, promptInput };
  }
}
