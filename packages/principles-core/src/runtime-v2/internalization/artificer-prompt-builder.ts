export interface ArtificerPromptBuilderInput {
  taskId: string;
  contextHash: string;
  sourceScribeArtifactId: string;
  scribeArtifact: unknown;
}

export interface ArtificerPromptInput {
  taskId: string;
  contextHash: string;
  sourceScribeArtifactId: string;
  scribeArtifact: unknown;
  artificerInstruction: string;
  promptContractVersion: string;
}

export interface ArtificerPromptBuildResult {
  readonly message: string;
  readonly promptInput: ArtificerPromptInput;
}

export const ARTIFICER_PROTOCOL_INSTRUCTION = `You are an Artificer agent in a principle internalization pipeline. Your role is to transform the Scribe's formal principle draft into an implementation-oriented plan with concrete changes, tests, and rollout notes.

PROTOCOL:
1. Review the scribeArtifact to understand the formal principle draft
2. Transform the principle draft into an implementation plan with summary, target surface, specific changes, test requirements, and rollout notes
3. Preserve the lineage trace from scribe, philosopher, and dreamer artifacts
4. Identify risks associated with implementing this principle
5. The implementation plan should be concrete enough to guide code changes, not just philosophical

OUTPUT FORMAT (pure JSON, no markdown):
{
  "taskId": "<from input>",
  "sourceScribeArtifactId": "<copy exactly from input.sourceScribeArtifactId>",
  "implementationPlan": {
    "summary": "<concise summary of the implementation approach>",
    "targetSurface": "<specific code/module/surface area to modify>",
    "changes": ["<specific change 1>", "<specific change 2>"],
    "tests": ["<test requirement 1>", "<test requirement 2>"],
    "rolloutNotes": ["<rollout consideration 1>", "<rollout consideration 2>"],
    "confidence": 0.8
  },
  "sourceTrace": {
    "scribeArtifactId": "<copy exactly from input.sourceScribeArtifactId>",
    "philosopherArtifactId": "<from scribe artifact if available, or omit>",
    "dreamerArtifactId": "<from scribe artifact if available, or omit>"
  },
  "risks": ["<risk 1>", "<risk 2>"],
  "generatedAt": "<ISO-8601 timestamp>"
}

CONSTRAINTS:
- Output ONLY valid JSON (no markdown, no explanatory text, no code fences)
- implementationPlan.summary MUST be a non-empty string
- implementationPlan.targetSurface MUST be a non-empty string
- implementationPlan.changes MUST be an array of strings
- implementationPlan.tests MUST be an array of strings
- implementationPlan.rolloutNotes MUST be an array of strings
- implementationPlan.confidence MUST be a number between 0.0 and 1.0 (NOT a string, NOT a percentage)
- sourceScribeArtifactId MUST be copied exactly from input.sourceScribeArtifactId (non-empty string)
- sourceTrace.scribeArtifactId MUST be copied exactly from input.sourceScribeArtifactId
- sourceTrace.philosopherArtifactId is optional — include only if available from scribe artifact
- sourceTrace.dreamerArtifactId is optional — include only if available from scribe artifact
- risks MUST be an array of strings (can be empty if no risks identified)
- generatedAt MUST be the current ISO-8601 timestamp (use the actual current time, NOT a placeholder)
`;

export const ARTIFICER_PROMPT_CONTRACT_VERSION = 'artificer-output-v1.prompt.v1';

export class ArtificerPromptBuilder {
  // eslint-disable-next-line @typescript-eslint/class-methods-use-this
  buildPrompt(input: ArtificerPromptBuilderInput): ArtificerPromptBuildResult {
    const promptInput: ArtificerPromptInput = {
      taskId: input.taskId,
      contextHash: input.contextHash,
      sourceScribeArtifactId: input.sourceScribeArtifactId,
      scribeArtifact: input.scribeArtifact,
      artificerInstruction: ARTIFICER_PROTOCOL_INSTRUCTION,
      promptContractVersion: ARTIFICER_PROMPT_CONTRACT_VERSION,
    };

    const message = JSON.stringify(promptInput);

    return { message, promptInput };
  }
}
