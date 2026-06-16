/**
 * PhilosopherPromptBuilder — transforms Philosopher context into a prompt for the LLM.
 *
 * PRI-107: The Philosopher runner previously sent only `{ taskId, contextHash, dreamerArtifact }`
 * as inputPayload, giving the LLM no instructions about what to produce. This builder
 * follows the DiagnosticianPromptBuilder pattern: it packages context data + an
 * explicit instruction telling the LLM to produce PhilosopherOutputV1 JSON.
 *
 * ## Contract
 *
 * buildPrompt() takes PhilosopherPromptBuilderInput and returns a JSON string
 * to be passed as `inputPayload` in StartRunInput.
 *
 * ## Constraints
 *
 * - Output is ONLY JSON — no markdown, no file ops, no tool calls
 * - NO extraSystemPrompt field — system prompt is agent profile's responsibility
 * - buildPrompt() is a pure function — no DB calls, no side effects
 */

import { buildCoreAxiomBlock } from '../core-principles/core-axiom-block.js';
import type { CoreAxiomBlockOptions } from '../core-principles/core-axiom-block.js';
import type { OutputLanguage } from '../language-directive.js';

export interface PhilosopherPromptBuilderInput {
  taskId: string;
  contextHash: string;
  dreamerArtifact: unknown;
  sourceDreamerArtifactId: string;
  /** Inject core axiom grounding section (default: false). */
  coreGrounding?: boolean;
  /** Output language for bilingual principle statements. */
  outputLanguage?: OutputLanguage;
}

export interface PhilosopherPromptInput {
  taskId: string;
  contextHash: string;
  dreamerArtifact: unknown;
  sourceDreamerArtifactId: string;
  philosopherInstruction: string;
}

export interface PhilosopherPromptBuildResult {
  readonly message: string;
  readonly promptInput: PhilosopherPromptInput;
}

/**
 * Build the Philosopher protocol instruction with optional core axiom grounding.
 *
 * When `coreGrounding` is true, a CORE AXIOMS section is injected so the
 * Philosopher can check whether the new principle candidate duplicates or
 * contradicts an existing core principle.
 */
export function buildPhilosopherProtocolInstruction(
  opts: CoreAxiomBlockOptions = {},
): string {
  const coreAxiomsBlock = buildCoreAxiomBlock(opts);

  return `You are a Philosopher agent in a principle internalization pipeline. Your role is to distill a principle candidate from the Dreamer's alternative decision analysis.

PROTOCOL:
1. Review the dreamerArtifact to understand the alternative decisions proposed by the Dreamer
2. Synthesize the Dreamer's candidates into a single philosophical thesis
3. Extract a principle candidate with title, rationale, scope, and confidence
4. Identify risks associated with applying this principle
5. The principle should be abstract and reusable, not tied to a specific instance
${coreAxiomsBlock}OUTPUT FORMAT (pure JSON, no markdown):
{
  "taskId": "<from input>",
  "sourceDreamerArtifactId": "<copy exactly from input.sourceDreamerArtifactId>",
  "thesis": "<philosophical thesis synthesizing the Dreamer's analysis>",
  "principleCandidate": {
    "title": "<concise principle title, <=100 chars>",
    "rationale": "<why this principle addresses the root cause>",
    "scope": "<when/where this principle applies>",
    "confidence": 0.8
  },
  "risks": ["<risk 1>", "<risk 2>"],
  "generatedAt": "<ISO-8601 timestamp>"
}

CONSTRAINTS:
- Output ONLY valid JSON (no markdown, no explanatory text, no code fences)
- thesis MUST be a non-empty string summarizing the philosophical insight
- principleCandidate.title MUST be a non-empty string (concise, <=100 chars)
- principleCandidate.rationale MUST be a non-empty string
- principleCandidate.scope MUST be a non-empty string describing applicability
- principleCandidate.confidence MUST be a number between 0.0 and 1.0 (NOT a string, NOT a percentage)
- risks MUST be an array of strings (can be empty if no risks identified)
- sourceDreamerArtifactId MUST be copied exactly from input.sourceDreamerArtifactId (non-empty string)
- generatedAt MUST be the current ISO-8601 timestamp (use the actual current time, NOT a placeholder)
- If the CORE AXIOMS section is provided, check whether the new principle candidate duplicates or contradicts any existing core axiom. If it does, note this in the risks array
`;
}

export class PhilosopherPromptBuilder {
  private readonly coreGrounding: boolean;
  private readonly outputLanguage?: OutputLanguage;

  constructor(opts: { coreGrounding?: boolean; outputLanguage?: OutputLanguage } = {}) {
    this.coreGrounding = opts.coreGrounding ?? false;
    this.outputLanguage = opts.outputLanguage;
  }

  buildPrompt(input: PhilosopherPromptBuilderInput): PhilosopherPromptBuildResult {
    const coreGrounding = input.coreGrounding ?? this.coreGrounding;
    const outputLanguage = input.outputLanguage ?? this.outputLanguage;

    const philosopherInstruction = buildPhilosopherProtocolInstruction({
      coreGrounding,
      outputLanguage,
    });

    const promptInput: PhilosopherPromptInput = {
      taskId: input.taskId,
      contextHash: input.contextHash,
      dreamerArtifact: input.dreamerArtifact,
      sourceDreamerArtifactId: input.sourceDreamerArtifactId,
      philosopherInstruction,
    };

    const message = JSON.stringify(promptInput);

    return { message, promptInput };
  }
}
