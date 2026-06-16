/**
 * DreamerPromptBuilder — transforms Dreamer context into a prompt for the LLM.
 *
 * PRI-107: The Dreamer runner previously sent only `{ taskId, contextHash }` as
 * inputPayload, giving the LLM no instructions about what to produce. This builder
 * follows the DiagnosticianPromptBuilder pattern: it packages context data + an
 * explicit instruction telling the LLM to produce DreamerOutputV1 JSON.
 *
 * ## Contract
 *
 * buildPrompt() takes DreamerPromptBuilderInput and returns a JSON string
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

export interface DreamerPromptBuilderInput {
  taskId: string;
  contextHash: string;
  contextRefs: readonly string[];
  predecessorOutput: unknown;
  /** Inject core axiom grounding section (default: false). */
  coreGrounding?: boolean;
  /** Output language for bilingual principle statements. */
  outputLanguage?: OutputLanguage;
}

export interface DreamerPromptInput {
  taskId: string;
  contextHash: string;
  contextRefs: readonly string[];
  predecessorOutput: unknown;
  dreamerInstruction: string;
}

export interface DreamerPromptBuildResult {
  readonly message: string;
  readonly promptInput: DreamerPromptInput;
}

/**
 * Build the Dreamer protocol instruction with optional core axiom grounding.
 *
 * When `coreGrounding` is true, a CORE AXIOMS section is injected so the
 * Dreamer can correctly reference existing principles via sourcePrincipleId.
 */
export function buildDreamerProtocolInstruction(
  opts: CoreAxiomBlockOptions = {},
): string {
  const coreAxiomsBlock = buildCoreAxiomBlock(opts);

  return `You are a Dreamer agent in a principle internalization pipeline. Your role is to generate alternative decision candidates based on the predecessor's diagnosis analysis.

PROTOCOL:
1. Review the predecessorOutput (typically a Diagnostician diagnosis) to understand what went wrong
2. For each identified root cause, generate 1-5 alternative decision candidates
3. Each candidate must describe: what was done wrong (badDecision), what should have been done instead (betterDecision), and why (rationale)
4. Assign a confidence score (0.0 to 1.0) and risk level (low, medium, or high) to each candidate
5. Provide a strategic perspective for each candidate
${coreAxiomsBlock}CRITICAL: Your ENTIRE response must be ONLY the JSON object below. Do NOT include any text before or after the JSON. Do NOT wrap the JSON in markdown code fences. Do NOT add explanatory prose. Output the raw JSON object and nothing else.

COMPLETE EXAMPLE OUTPUT (follow this exact structure):
{"valid":true,"taskId":"task-dreamer-001","candidates":[{"candidateIndex":0,"badDecision":"Ignored null check on user input before processing","betterDecision":"Add null/undefined guard before accessing user input properties","rationale":"Defensive programming prevents runtime crashes from unexpected null values","confidence":0.9,"riskLevel":"low","strategicPerspective":"defensive_programming"},{"candidateIndex":1,"badDecision":"Used synchronous file read in request handler","betterDecision":"Replace with async fs.readFile to avoid blocking the event loop","rationale":"Non-blocking I/O preserves server responsiveness under load","confidence":0.85,"riskLevel":"medium","strategicPerspective":"fail_fast"}],"sourcePainId":"pain-null-crash","contextRefs":["pi-art-diag-001"],"generatedAt":"<current ISO-8601 timestamp>"}

CONSTRAINTS:
- Output ONLY valid JSON — no markdown, no explanatory text, no code fences, no prose before or after
- Do NOT wrap the JSON in \`\`\`json or any other code fence markers
- Do NOT add any commentary or explanation outside the JSON object
- candidates MUST have 1-5 items
- candidateIndex MUST be a number (0-based)
- badDecision, betterDecision, rationale, strategicPerspective MUST be non-empty strings
- confidence MUST be a number between 0.0 and 1.0 (NOT a string, NOT a percentage)
- riskLevel MUST be exactly one of: "low", "medium", "high" (lowercase only)
- contextRefs MUST be copied from the input contextRefs array
- generatedAt MUST be the current ISO-8601 timestamp (use the actual current time, NOT a placeholder)
- valid MUST be true on success
- sourcePrincipleId is OPTIONAL — only include it if you can identify a specific existing principle that this candidate relates to (use the axiom IDs from the CORE AXIOMS section above, e.g. T-01). Do NOT invent placeholder values like "pri-unknown", "pri-000", or any fabricated ID. If unsure, simply omit this field entirely
- sourcePainId is an optional string
`;
}

export class DreamerPromptBuilder {
  private readonly coreGrounding: boolean;
  private readonly outputLanguage?: OutputLanguage;

  constructor(opts: { coreGrounding?: boolean; outputLanguage?: OutputLanguage } = {}) {
    this.coreGrounding = opts.coreGrounding ?? false;
    this.outputLanguage = opts.outputLanguage;
  }

  buildPrompt(input: DreamerPromptBuilderInput): DreamerPromptBuildResult {
    const coreGrounding = input.coreGrounding ?? this.coreGrounding;
    const outputLanguage = input.outputLanguage ?? this.outputLanguage;

    const dreamerInstruction = buildDreamerProtocolInstruction({
      coreGrounding,
      outputLanguage,
    });

    const promptInput: DreamerPromptInput = {
      taskId: input.taskId,
      contextHash: input.contextHash,
      contextRefs: input.contextRefs,
      predecessorOutput: input.predecessorOutput,
      dreamerInstruction,
    };

    const message = JSON.stringify(promptInput);

    return { message, promptInput };
  }
}
