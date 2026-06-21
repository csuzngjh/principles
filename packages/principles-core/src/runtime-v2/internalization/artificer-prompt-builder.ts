import { serializePromptInput } from './prompt-serializer.js';

export interface ArtificerPromptBuilderInput {
  taskId: string;
  contextHash: string;
  sourceScribeArtifactId: string;
  scribeArtifact: unknown;
  /**
   * Prior adversarial replay failures to address (RuleHost MVP, PRI-428).
   * Present only on Round-2+ retries inside runAdversarialLoop. When absent,
   * the prompt is the initial generation prompt (backward compatible).
   */
  adversarialFeedback?: string;
}

export interface ArtificerPromptInput {
  taskId: string;
  contextHash: string;
  sourceScribeArtifactId: string;
  scribeArtifact: unknown;
  artificerInstruction: string;
  promptContractVersion: string;
  /** Present only when this is a retry with prior adversarial failures. */
  adversarialFeedback?: string;
}

export interface ArtificerPromptBuildResult {
  readonly message: string;
  readonly promptInput: ArtificerPromptInput;
}

export const ARTIFICER_PROTOCOL_INSTRUCTION = `You are an Artificer agent in a principle internalization pipeline. Your role is to transform the Scribe's formal principle draft into executable RuleHost code with a concise implementation summary, tests, and rollout notes.

PROTOCOL:
1. Review the scribeArtifact to understand the formal principle draft
2. Transform the principle draft into executable RuleHost code and a brief implementation summary
3. Preserve the lineage trace from scribe, philosopher, and dreamer artifacts
4. Identify risks associated with implementing this principle
5. The implementation summary should clearly describe what the code does and why

OUTPUT FORMAT (pure JSON, no markdown):
{
  "taskId": "<from input>",
  "sourceScribeArtifactId": "<copy exactly from input.sourceScribeArtifactId>",
  "implementationSummary": "<concise summary of what the code does and the implementation approach>",
  "sourceTrace": {
    "scribeArtifactId": "<copy exactly from input.sourceScribeArtifactId>",
    "philosopherArtifactId": "<from scribe artifact if available, or omit>",
    "dreamerArtifactId": "<from scribe artifact if available, or omit>"
  },
  "risks": ["<risk 1>", "<risk 2>"],
  "implementationCode": "function evaluate(input, helpers) { ... }",
  "goldenTraceCases": [
    {"caseId":"negative-1","kind":"negative","toolName":"write_file","params":{"path":"/system/file"},"expectedDecision":"block"},
    {"caseId":"positive-1","kind":"positive","toolName":"write_file","params":{"path":"/workspace/file"},"expectedDecision":"allow"}
  ],
  "affectedTools": ["write_file"],
  "generatedAt": "<ISO-8601 timestamp>"
}

CONSTRAINTS:
- Output ONLY valid JSON (no markdown, no explanatory text, no code fences)
- implementationSummary MUST be a non-empty string describing what the code does and the implementation approach
- sourceScribeArtifactId MUST be copied exactly from input.sourceScribeArtifactId (non-empty string)
- sourceTrace.scribeArtifactId MUST be copied exactly from input.sourceScribeArtifactId
- sourceTrace.philosopherArtifactId is optional — include only if available from scribe artifact
- sourceTrace.dreamerArtifactId is optional — include only if available from scribe artifact
- risks MUST be an array of strings (can be empty if no risks identified)
- generatedAt MUST be the current ISO-8601 timestamp (use the actual current time, NOT a placeholder)
- implementationCode MUST define exactly function evaluate(input, helpers) and return { decision, matched, reason }
- EVERY return statement inside evaluate() MUST include ALL three fields: decision, matched, reason
- Do NOT return partial objects — missing fields will fail sandbox validation and block activation
- GOOD: return { decision: 'allow', matched: false, reason: 'path is within workspace, no risk' }
- GOOD: return { decision: 'block', matched: true, reason: 'write to system path outside workspace' }
- BAD:  return { matched: false } — missing decision and reason, will be rejected
- BAD:  return { decision: 'allow', matched: true } — missing reason, will be rejected
- input.action contains toolName, normalizedPath, and paramsSummary; inspect only these RuleHost inputs
- implementationCode MUST be deterministic and self-contained: no imports, require, eval, Function, I/O, network, timers, Date.now, or randomness
- goldenTraceCases MUST contain 2-10 cases with at least one positive allow case and one negative block/propose_correction case
- propose_correction cases MUST include expectedProposedParams and expectedApplicationMode (shadow or live)
- affectedTools MUST contain the non-empty tool names the rule can match

PRIOR ADVERSARIAL FAILURES (when \`adversarialFeedback\` is present):
- This is a RETRY. A prior version of your generated code was reviewed and failed adversarial sandbox replay.
- The \`adversarialFeedback\` field lists the specific cases that failed, each with the attack type, the expected vs actual decision, and a rationale.
- You MUST address each listed failure specifically — do not regenerate blind. Adjust the matcher/logic so the failed cases produce the expected decision while preserving the cases that previously passed.
`;

export const ARTIFICER_PROMPT_CONTRACT_VERSION = 'artificer-output-v2.prompt.v1';

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
      // Only include adversarialFeedback when present + non-empty, so
      // Round-1 prompts stay backward-compatible (test asserts absence).
      ...(typeof input.adversarialFeedback === 'string' && input.adversarialFeedback.trim() !== ''
        ? { adversarialFeedback: input.adversarialFeedback }
        : {}),
    };

    const message = serializePromptInput(promptInput);

    return { message, promptInput };
  }
}
