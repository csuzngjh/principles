import { buildCoreAxiomBlock } from '../core-principles/core-axiom-block.js';
import type { CoreAxiomBlockOptions } from '../core-principles/core-axiom-block.js';
import type { OutputLanguage } from '../language-directive.js';
import { buildLanguageDirective } from '../language-directive.js';

export interface ScribePromptBuilderInput {
  taskId: string;
  contextHash: string;
  sourcePhilosopherArtifactId: string;
  philosopherArtifact: unknown;
  /** Owner's preferred language for principle generation (PRI-336). */
  outputLanguage?: OutputLanguage;
  /** Inject core axiom grounding section (default: false). */
  coreGrounding?: boolean;
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

/**
 * Build the Scribe protocol instruction with optional core axiom grounding.
 *
 * When `coreGrounding` is true, a CORE AXIOMS section is injected so the
 * Scribe can ensure the formal principle draft is consistent with the
 * existing core principle framework.
 */
export function buildScribeProtocolInstruction(
  opts: CoreAxiomBlockOptions & { outputLanguage?: OutputLanguage } = {},
): string {
  const { outputLanguage, ...axiomOpts } = opts;
  const coreAxiomsBlock = buildCoreAxiomBlock({ ...axiomOpts, outputLanguage });
  const languageDirective = buildLanguageDirective(outputLanguage);

  return `You are a Scribe agent in a principle internalization pipeline. Your role is to distill the Philosopher's analysis into a formal, implementable principle draft.

PROTOCOL:
1. Review the philosopherArtifact to understand the philosophical thesis and principle candidate
2. Transform the philosopher's analysis into a formal principle draft with clear statement, rationale, applicability, and anti-patterns
3. Preserve the lineage trace from dreamer and philosopher artifacts
4. Identify risks associated with applying this principle
5. The principle draft should be concrete enough to guide implementation, not just philosophical
${coreAxiomsBlock}OUTPUT FORMAT (pure JSON, no markdown):
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
- generatedAt MUST be the current ISO-8601 timestamp (use the actual current time, NOT a placeholder)
- If the CORE AXIOMS section is provided, ensure the principle draft does not duplicate or contradict any existing core axiom. If overlap exists, note it in risks
${languageDirective}`;
}

export const SCRIBE_PROMPT_CONTRACT_VERSION = 'scribe-output-v1.prompt.v1';

export class ScribePromptBuilder {
  private readonly coreGrounding: boolean;
  private readonly outputLanguage?: OutputLanguage;

  constructor(opts: { coreGrounding?: boolean; outputLanguage?: OutputLanguage } = {}) {
    this.coreGrounding = opts.coreGrounding ?? false;
    this.outputLanguage = opts.outputLanguage;
  }

  /**
   * Build a scribe prompt with optional core axiom grounding and language directive (PRI-336).
   */
  buildPrompt(input: ScribePromptBuilderInput): ScribePromptBuildResult {
    const coreGrounding = input.coreGrounding ?? this.coreGrounding;
    const outputLanguage = input.outputLanguage ?? this.outputLanguage;

    const scribeInstruction = buildScribeProtocolInstruction({
      coreGrounding,
      outputLanguage,
    });

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
