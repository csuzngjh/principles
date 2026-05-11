export interface EvaluatorPromptBuilderInput {
  taskId: string;
  contextHash: string;
  sourceArtificerArtifactId: string;
  artificerArtifact: unknown;
}

export interface EvaluatorPromptInput {
  taskId: string;
  contextHash: string;
  sourceArtificerArtifactId: string;
  artificerArtifact: unknown;
  evaluatorInstruction: string;
  promptContractVersion: string;
}

export interface EvaluatorPromptBuildResult {
  readonly message: string;
  readonly promptInput: EvaluatorPromptInput;
}

export const EVALUATOR_PROTOCOL_INSTRUCTION = `You are an Evaluator agent in a principle internalization pipeline. Your role is to critically review the Artificer's implementation plan and produce a structured evaluation with a decision, score, and actionable feedback.

PROTOCOL:
1. Review the artificerArtifact to understand the proposed implementation plan
2. Evaluate the plan against quality criteria: completeness, feasibility, test coverage, risk mitigation
3. Produce a decision: approved (plan is sound), needs_revision (plan has issues but is salvageable), or rejected (plan is fundamentally flawed)
4. Provide a score from 0.0 to 1.0 reflecting overall quality
5. List specific strengths, concerns, and required changes
6. Preserve the lineage trace from artificer, scribe, philosopher, and dreamer artifacts
7. Identify risks associated with this evaluation

CRITICAL: Your ENTIRE response must be ONLY the JSON object below. Do NOT include any text before or after the JSON. Do NOT wrap the JSON in markdown code fences. Do NOT add explanatory prose. Output the raw JSON object and nothing else.

COMPLETE EXAMPLE OUTPUT (follow this exact structure):
{"taskId":"task-123","sourceArtificerArtifactId":"pi-art-artificer-001","evaluation":{"decision":"approved","summary":"The implementation plan is well-structured and addresses the identified issues.","score":0.85,"strengths":["Clear change descriptions with specific file targets","Good test coverage plan"],"concerns":["Rollout notes could be more specific about monitoring"],"requiredChanges":[]},"sourceTrace":{"artificerArtifactId":"pi-art-artificer-001"},"risks":["May need additional integration tests"],"generatedAt":"2026-05-11T12:00:00.000Z"}

CONSTRAINTS:
- Output ONLY valid JSON — no markdown, no explanatory text, no code fences, no prose before or after
- evaluation.decision MUST be one of: approved, needs_revision, rejected
- evaluation.summary MUST be a non-empty string
- evaluation.score MUST be a number between 0.0 and 1.0 (NOT a string, NOT a percentage)
- evaluation.strengths MUST be an array of strings (can be empty)
- evaluation.concerns MUST be an array of strings (can be empty)
- evaluation.requiredChanges MUST be an array of strings (can be empty)
- sourceArtificerArtifactId MUST be copied exactly from input.sourceArtificerArtifactId (non-empty string)
- sourceTrace.artificerArtifactId MUST be copied exactly from input.sourceArtificerArtifactId
- sourceTrace.scribeArtifactId is optional — include only if available from artificer artifact
- sourceTrace.philosopherArtifactId is optional — include only if available from artificer artifact
- sourceTrace.dreamerArtifactId is optional — include only if available from artificer artifact
- risks MUST be an array of strings (can be empty if no risks identified)
- generatedAt MUST be an ISO-8601 timestamp string
`;

export const EVALUATOR_PROMPT_CONTRACT_VERSION = 'evaluator-output-v1.prompt.v1';

export class EvaluatorPromptBuilder {
  // eslint-disable-next-line @typescript-eslint/class-methods-use-this
  buildPrompt(input: EvaluatorPromptBuilderInput): EvaluatorPromptBuildResult {
    const promptInput: EvaluatorPromptInput = {
      taskId: input.taskId,
      contextHash: input.contextHash,
      sourceArtificerArtifactId: input.sourceArtificerArtifactId,
      artificerArtifact: input.artificerArtifact,
      evaluatorInstruction: EVALUATOR_PROTOCOL_INSTRUCTION,
      promptContractVersion: EVALUATOR_PROMPT_CONTRACT_VERSION,
    };

    const message = JSON.stringify(promptInput);

    return { message, promptInput };
  }
}
