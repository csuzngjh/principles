import type { OutputLanguage } from '../language-directive.js';
import { buildLanguageDirective } from '../language-directive.js';

export interface ScribePromptBuilderInput {
  taskId: string;
  contextHash: string;
  sourcePhilosopherArtifactId: string;
  philosopherArtifact: unknown;
  /** Owner's preferred language for principle generation (PRI-336). */
  outputLanguage?: OutputLanguage;
}

export interface ScribePromptInput {
  taskId: string;
  contextHash: string;
  sourcePhilosopherArtifactId: string;
  philosopherArtifact: unknown;
  scribeInstruction: string;
  promptContractVersion: string;
}

export interface ScribePromptBuildResult {
  readonly message: string;
  readonly promptInput: ScribePromptInput;
}

export const SCRIBE_PROTOCOL_INSTRUCTION = `You are a Scribe agent in a principle internalization pipeline. Your role is to distill the Philosopher's analysis into a formal, implementable principle draft.

PROTOCOL:
1. Review the philosopherArtifact to understand the philosophical thesis and principle candidate
2. Transform the philosopher's analysis into a formal principle draft with clear statement, rationale, applicability, and anti-patterns
3. Preserve the lineage trace from dreamer and philosopher artifacts
4. Identify risks associated with applying this principle
5. The principle draft should be concrete enough to guide implementation, not just philosophical

OUTPUT FORMAT (pure JSON, no markdown):
{
  "taskId": "<from input>",
  "sourcePhilosopherArtifactId": "<copy exactly from input.sourcePhilosopherArtifactId>",
  "principleDraft": {
    "title": "<concise principle title, <=100 chars>",
    "statement": "<formal principle statement describing what should always be done>",
    "rationale": "<why this principle addresses the root cause>",
    "applicability": ["<context where this principle applies>"],
    "antiPatterns": ["<pattern this principle forbids>"],
    "confidence": 0.8
  },
  "sourceTrace": {
    "dreamerArtifactId": "<from philosopher artifact if available, or omit>",
    "philosopherArtifactId": "<copy exactly from input.sourcePhilosopherArtifactId>"
  },
  "risks": ["<risk 1>", "<risk 2>"],
  "generatedAt": "<ISO-8601 timestamp>"
}

CONSTRAINTS:
- Output ONLY valid JSON (no markdown, no explanatory text, no code fences)
- principleDraft.title MUST be a non-empty string (concise, <=100 chars)
- principleDraft.statement MUST be a non-empty string describing the principle
- principleDraft.rationale MUST be a non-empty string
- principleDraft.applicability MUST be an array of strings (at least one recommended)
- principleDraft.antiPatterns MUST be an array of strings (can be empty)
- principleDraft.confidence MUST be a number between 0.0 and 1.0 (NOT a string, NOT a percentage)
- sourcePhilosopherArtifactId MUST be copied exactly from input.sourcePhilosopherArtifactId (non-empty string)
- sourceTrace.philosopherArtifactId MUST be copied exactly from input.sourcePhilosopherArtifactId
- sourceTrace.dreamerArtifactId is optional — include only if available from philosopher artifact
- risks MUST be an array of strings (can be empty if no risks identified)
- generatedAt MUST be an ISO-8601 timestamp string
`;

export const SCRIBE_PROMPT_CONTRACT_VERSION = 'scribe-output-v1.prompt.v1';

export class ScribePromptBuilder {
  /**
   * Build a scribe prompt with optional language directive (PRI-336).
   *
   * When `input.outputLanguage` is provided, a language directive is appended
   * to the scribe instruction telling the LLM to produce human-readable
   * principle fields in the owner's preferred language.
   */
  // eslint-disable-next-line @typescript-eslint/class-methods-use-this
  buildPrompt(input: ScribePromptBuilderInput): ScribePromptBuildResult {
    const languageDirective = buildLanguageDirective(input.outputLanguage);
    const scribeInstruction = input.outputLanguage
      ? SCRIBE_PROTOCOL_INSTRUCTION + languageDirective
      : SCRIBE_PROTOCOL_INSTRUCTION;

    const promptInput: ScribePromptInput = {
      taskId: input.taskId,
      contextHash: input.contextHash,
      sourcePhilosopherArtifactId: input.sourcePhilosopherArtifactId,
      philosopherArtifact: input.philosopherArtifact,
      scribeInstruction,
      promptContractVersion: SCRIBE_PROMPT_CONTRACT_VERSION,
    };

    const message = JSON.stringify(promptInput);

    return { message, promptInput };
  }
}
