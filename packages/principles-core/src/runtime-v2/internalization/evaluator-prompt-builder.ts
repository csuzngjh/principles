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

OUTPUT FORMAT (pure JSON, no markdown):
{
  "taskId": "<from input>",
  "sourceArtificerArtifactId": "<copy exactly from input.sourceArtificerArtifactId>",
  "evaluation": {
    "decision": "approved" | "needs_revision" | "rejected",
    "summary": "<concise evaluation summary>",
    "score": 0.85,
    "strengths": ["<strength 1>", "<strength 2>"],
    "concerns": ["<concern 1>", "<concern 2>"],
    "requiredChanges": ["<change 1>", "<change 2>"]
  },
  "sourceTrace": {
    "artificerArtifactId": "<copy exactly from input.sourceArtificerArtifactId>",
    "scribeArtifactId": "<from artificer artifact if available, or omit>",
    "philosopherArtifactId": "<from artificer artifact if available, or omit>",
    "dreamerArtifactId": "<from artificer artifact if available, or omit>"
  },
  "risks": ["<risk 1>", "<risk 2>"],
  "generatedAt": "<ISO-8601 timestamp>"
}

CONSTRAINTS:
- Output ONLY valid JSON (no markdown, no explanatory text, no code fences)
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
