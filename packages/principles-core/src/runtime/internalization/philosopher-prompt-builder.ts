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
 * buildPrompt() takes PhilosopherPromptBuilderInput and returns a build result
 * whose `message` is the JSON string to be passed as `inputPayload` in
 * StartRunInput, and whose `systemPrompt` is the base-layer system prompt
 * (role + protocol) to pass via `StartRunInput.systemPrompt` (PRI-633).
 *
 * ## Constraints
 *
 * - Message payload is ONLY task data (JSON) — no markdown, no file ops, no tool calls
 * - Role/protocol instructions travel as the base systemPrompt layer, NOT in
 *   the user payload (PRI-633); the profile's configured systemPrompt remains
 *   the append layer owned by the agent profile (DPB-07, as revised by PRI-633)
 * - buildPrompt() is a pure function — no DB calls, no side effects
 */

import { buildCoreAxiomBlock } from '../core-principles/core-axiom-block.js';
import type { CoreAxiomBlockOptions } from '../core-principles/core-axiom-block.js';
import type { OutputLanguage } from '../language-directive.js';
import { buildLanguageDirective } from '../language-directive.js';

interface PhilosopherPromptBuilderInput {
  taskId: string;
  contextHash: string;
  dreamerArtifact: unknown;
  sourceDreamerArtifactId: string;
  /**
   * SIA v1.2 (TECH §6.2): the Stage A/C diagnosis artifact. Present only when
   * the diagnostic stage was resolvable; absent keeps the pre-SIA prompt shape
   * (the degradation is emitted by the runner as an event).
   */
  diagnosisArtifact?: unknown;
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
  /** SIA v1.2: only included when the diagnosis actually resolved. */
  diagnosisArtifact?: unknown;
}

interface PhilosopherPromptBuildResult {
  readonly message: string;
  readonly promptInput: PhilosopherPromptInput;
  /**
   * PRI-633: base-layer system prompt (role + protocol). Previously embedded
   * in the payload as `philosopherInstruction`; now delivered via the system
   * channel by the runtime adapter.
   */
  readonly systemPrompt: string;
}

/**
 * SIA v1.2 (SPEC §9.4 / TECH §6.2): the dual-anchor review contract.
 *
 * Appended only when the Stage A diagnosis is actually in the payload — an
 * absent diagnosis must not be papered over with instructions the model cannot
 * satisfy. The block states the authority boundaries explicitly so the model
 * can check consistency without becoming a second relevance authority.
 */
export const PHILOSOPHER_DUAL_ANCHOR_BLOCK = `
DUAL ANCHOR REVIEW (the payload carries diagnosisArtifact — the Stage A/C diagnosis that started this formation):
- diagnosisArtifact.intentTension is Stage A's OWN judgment of how the diagnosed pain relates to the Owner strategic intent. It is a TENSION TYPE (none | action_drift | intent_suspect | healthy_tension), NOT a strategic-relevance verdict, and it is NOT the list of violated core principles.
- diagnosisArtifact.intentSnapshot.sections is the captured INTENT.md text Stage A actually read (with its server-computed contentHash). It is the strategic basis of record; do not ask for, assume, or reconstruct a newer INTENT.md.
- For EVERY candidate, check: (a) is candidates[].strategicPerspective consistent with intentTension / intentSnapshot.sections? (b) did the Dreamer MISS a conflict between the candidate and a core axiom or the Owner intent? (c) does a candidate trade long-term Owner intent for a local patch?
- Stage A is the ONLY authority for strategic relevance. Do not re-derive, re-label, or override it; report inconsistencies and potential conflicts in thesis / risks instead, citing the section key (why | desired_outcome | non_negotiables | stop_escalation | current_strategic_focus) or the core axiom id you relied on.
- Never invent strategic content. If intentTension or intentSnapshot is absent from diagnosisArtifact, state that in risks and continue with the core-axiom anchor alone.`;

export interface PhilosopherProtocolOptions extends CoreAxiomBlockOptions {
  /** SIA v1.2: the Stage A diagnosis is present in the payload. */
  readonly dualAnchor?: boolean;
}

/**
 * Build the Philosopher protocol instruction with optional core axiom grounding.
 *
 * When `coreGrounding` is true, a CORE AXIOMS section is injected so the
 * Philosopher can check whether the new principle candidate duplicates or
 * contradicts an existing core principle.
 *
 * PRI-714 (review fix): when `outputLanguage` is provided, a language
 * directive is appended so the OUTPUT (not just the axiom block) follows the
 * owner's language — thesis/principleCandidate.{title,rationale,scope}/risks
 * are the human-readable fields (confidence stays numeric; lineage IDs stay
 * untranslated). Undefined = no directive (byte-identical to pre-PRI-714).
 */
export function buildPhilosopherProtocolInstruction(
  opts: PhilosopherProtocolOptions = {},
): string {
  const { dualAnchor = false, ...axiomOpts } = opts;
  const coreAxiomsBlock = buildCoreAxiomBlock(axiomOpts);
  // PRI-714: output-language directive (empty string when outputLanguage is
  // undefined — instruction stays byte-identical).
  const languageDirective = buildLanguageDirective(axiomOpts.outputLanguage, 'philosopher');
  const dualAnchorBlock = dualAnchor ? PHILOSOPHER_DUAL_ANCHOR_BLOCK : '';

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
${dualAnchorBlock}${languageDirective}`;
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
      dualAnchor: input.diagnosisArtifact !== undefined,
    });

    const promptInput: PhilosopherPromptInput = {
      taskId: input.taskId,
      contextHash: input.contextHash,
      dreamerArtifact: input.dreamerArtifact,
      sourceDreamerArtifactId: input.sourceDreamerArtifactId,
      ...(input.diagnosisArtifact !== undefined ? { diagnosisArtifact: input.diagnosisArtifact } : {}),
    };

    const message = JSON.stringify(promptInput);

    return { message, promptInput, systemPrompt: philosopherInstruction };
  }
}
