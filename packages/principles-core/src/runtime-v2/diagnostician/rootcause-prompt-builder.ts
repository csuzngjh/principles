/**
 * RootCausePromptBuilder — Stage A prompt builder for the split diagnostician pipeline.
 *
 * Constructs the prompt for the Root Cause stage (Stage A), which identifies
 * the underlying cause of a pain signal using a 5-Whys causal chain and
 * categorises it into one of four root-cause categories.
 *
 * ## Phases
 *
 * - PHASE 1 — Evidence Review
 * - PHASE 2 — Causal Chain (5 Whys)
 * - PHASE 3 — Root Cause Classification
 * - PHASE 3.5 — Core Axiom Grounding (when coreGrounding=true, PRI-371)
 *
 * ## Output
 *
 * The prompt requires output matching DiagRootCauseOutputV1Schema.
 *
 * @see PRI-372
 */

import type { TSchema } from '@sinclair/typebox';
import type { SchemaPromptAdapter } from '../adapter/schema-prompt-adapter.js';
import { DefaultSchemaPromptAdapter } from '../adapter/schema-prompt-adapter.js';
import { DiagRootCauseOutputV1Schema } from './diag-rootcause-output.js';
import type { DiagnosticianContextPayload } from '../context-payload.js';
import type { OutputLanguage } from '../language-directive.js';
import { buildLanguageDirective } from '../language-directive.js';
import { buildCoreAxiomBlock } from '../core-principles/core-axiom-block.js';
import type {
  BuildPromptOptions,
  PromptBuildResult,
} from '../diagnostician-prompt-builder.js';
import {
  DEFAULT_PROMPT_BUILDER_LIMITS,
  summarizeConversationWindow,
} from '../diagnostician-prompt-builder.js';
import type { PromptInput } from '../diagnostician-prompt-builder.js';

// ── Options ──────────────────────────────────────────────────────────────────

/**
 * Build the PHASE 3.6 — Intent Tension Check block (PRI-468, SPEC §17).
 *
 * When `intentGrounding` is true, returns the SPEC §17 verbatim text that
 * instructs the LLM to optionally produce an `intentTension` field.
 *
 * When false/undefined, returns `''` (empty string) so that
 * `${phase35Block}${phase36Block}CRITICAL:` is byte-identical to
 * `${phase35Block}CRITICAL:` — preserving the pre-PRI-468 prompt output
 * (EP-03: no silent fallback).
 *
 * This is a pure function — no I/O, no side effects, never throws.
 */
function buildIntentTensionBlock(intentGrounding?: boolean): string {
  if (!intentGrounding) {
    return '';
  }

  // SPEC §17 — verbatim text. The LLM is told:
  // - INTENT.md is optional reference, not a hard rule system
  // - source='none' / evidenceStrength='weak' when evidence is insufficient
  // - intent_suspect only for contradiction, vagueness, outdatedness, or
  //   repeated challenge — not for strategic preference
  // - intentTension is an optional additive field
  // - PD surfaces tension; Owner decides value
  return `
PHASE 3.6 — Intent Tension Check:
You may be given an optional Owner-owned INTENT.md.

Use it only as a stable reference for judging whether the pain indicates tension between:
- the Owner's stated long-term intent
- the current focus
- the Agent's actions
- the Owner's correction

Do not assume every failure is intent drift.

Do not treat INTENT.md as a hard rule system.
Hard runtime boundaries belong to RuleHost.

If evidence is insufficient, use source='none' or evidenceStrength='weak'.

Only mark intent_suspect when INTENT.md is contradictory, vague, outdated, or repeatedly challenged by confirmed Pain evidence.
Do not mark intent_suspect merely because you prefer another strategy.

Return intentTension as an optional additive field.

PD surfaces tension.
Owner decides value.
`;
}

/**
 * Options for RootCausePromptBuilder constructor and buildRootCauseInstruction.
 *
 * Uses an opts-object pattern to satisfy @typescript-eslint/max-params.
 *
 * @see PRI-372
 */
export interface RootCausePromptBuilderOptions {
  /** Schema prompt adapter (default: DefaultSchemaPromptAdapter) */
  adapter?: SchemaPromptAdapter;
  /** TypeBox schema for output validation (default: DiagRootCauseOutputV1Schema) */
  schema?: TSchema;
  /** Output language directive (default: none) */
  outputLanguage?: OutputLanguage;
  /** T-E (PRI-371): Inject core axiom grounding as PHASE 3.5 (default: false) */
  coreGrounding?: boolean;
  /**
   * PRI-468: Inject intent tension check as PHASE 3.6 (default: false).
   *
   * When true, inserts the SPEC §17 text instructing the LLM to optionally
   * produce an `intentTension` field. When false/undefined, the prompt is
   * byte-identical to the pre-PRI-468 prompt (EP-03: no silent fallback).
   */
  intentGrounding?: boolean;
}

// ── Instruction builder ──────────────────────────────────────────────────────

/**
 * Build the Stage A diagnostic protocol instruction (PHASE 1–3 + optional PHASE 3.5).
 *
 * Per DPB-02 (LOCKED): Output is ONLY JSON — no markdown, no file ops, no tool calls.
 * Per DPB-04: LLM can only analyse the context provided in the prompt; it must NOT
 *   read files, call tools, or write to databases.
 *
 * When `coreGrounding` is true, PHASE 3.5 (Core Axiom Grounding) is inserted
 * between PHASE 3 and the final output instruction. When false or undefined,
 * a newline is inserted to preserve byte-identical output (EP-03: no silent fallback).
 *
 * @see PRI-372
 */
export function buildRootCauseProtocolInstruction(
  opts: RootCausePromptBuilderOptions = {},
): string {
  const adapter = opts.adapter ?? new DefaultSchemaPromptAdapter();
  const schema = opts.schema ?? DiagRootCauseOutputV1Schema;
  const { outputLanguage, coreGrounding, intentGrounding } = opts;

  const example = adapter.generateExample(schema);
  const constraints = adapter.generateConstraints(schema);
  const languageDirective = buildLanguageDirective(outputLanguage);

  // T-E (PRI-371): When coreGrounding is true, insert PHASE 3.5.
  // When false or undefined, output is byte-identical to the original
  // (EP-03: no silent fallback).
  const phase35Block = buildCoreAxiomBlock({
    coreGrounding,
    sectionTitle: 'PHASE 3.5 — Core Axiom Grounding:',
    instruction:
      'If the root cause relates to any of these axioms, note the axiom ID (e.g. T-01)\n' +
      'in the ambiguityNotes field of your output.\n\nCore Axioms:',
    outputLanguage,
    fallback: '\n',
  });

  // PRI-468: When intentGrounding is true, insert PHASE 3.6.
  // When false or undefined, output is byte-identical to the pre-PRI-468
  // prompt (EP-03: no silent fallback). The fallback is '' (empty string)
  // so that `${phase35Block}${phase36Block}CRITICAL:` produces the same
  // string as `${phase35Block}CRITICAL:` when intentGrounding is off.
  const phase36Block = buildIntentTensionBlock(intentGrounding);

  return `You are a root cause analysis expert. Follow this protocol:

PHASE 1 — Evidence Review:
Review the provided sourceRefs, diagnosisTarget.evidence entries, and conversationWindow
entries from the context payload. Do NOT read any files or call any tools.
Record all evidence by referencing the sourceRef identifiers and conversation
entries already present in the context. Each evidence item must cite its source.
Pay special attention to diagnosisTarget.evidence — these are the primary behavioral
evidence (owner messages and agent actions) that the root cause analysis must address.

PHASE 2 — Causal Chain (5 Whys):
Build a Why-1 through Why-5 causal chain. Each Why MUST have at least one evidenceRefs entry referencing a sourceRef from Phase 1.
- If no evidence is available for a Why level, reference the closest available evidence and note the gap in ambiguityNotes.
- evidenceRefs MUST NOT be an empty array — every causal chain entry must cite at least one evidence source.
- Why 1: Surface phenomenon (visible error)
- Why 2: Direct cause (nearest trigger)
- Why 3: Process gap (missing check/gate)
- Why 4: Design flaw (why gap exists)
- Why 5: Root cause (systemic defect)
Stop early if you find a directly fixable problem.

PHASE 3 — Root Cause Classification:
Classify into ONE: People | Design | Assumption | Tooling
- People: capability blind spots, habit issues
- Design: architecture defects, missing gates, process gaps
- Assumption: wrong assumptions about env/versions/deps
- Tooling: tool misconfiguration, API changes
${phase35Block}${phase36Block}CRITICAL: Your ENTIRE response must be ONLY the JSON object below. Do NOT include any text before or after the JSON. Do NOT wrap the JSON in markdown code fences. Do NOT add explanatory prose. Output the raw JSON object and nothing else.

COMPLETE EXAMPLE OUTPUT (follow this exact structure):
${example}

IMPORTANT: The example above is ILLUSTRATIVE ONLY. Your root cause analysis MUST be based on the actual evidence in this context — do not copy the example text verbatim.

CONSTRAINTS:
- Output ONLY valid JSON — no markdown, no explanatory text, no code fences, no prose before or after
- Do NOT read files, call tools, or write to any database
- rootCause MUST include category prefix: "People: ..." or "Design: ..." or "Assumption: ..." or "Tooling: ..."
- rootCauseCategory MUST match the category prefix in rootCause
- If diagnosisTarget.evidence is an empty array (length === 0), you MUST NOT fabricate evidence entries.
  Output confidence < 0.3 and set ambiguityNotes to include "Insufficient evidence".
- evidence: list all evidence items that support your analysis. If sourceRefs or diagnosisTarget.evidence
  were provided in the input, you MUST reference them here. Only leave empty if the input genuinely
  contains no evidence at all.
${constraints}${languageDirective}`;
}

// ── Prompt builder class ─────────────────────────────────────────────────────

/**
 * RootCausePromptBuilder — Stage A prompt builder for the split diagnostician pipeline.
 *
 * Transforms DiagnosticianContextPayload into a PromptBuildResult for the
 * Root Cause stage (Stage A). The output prompt requires the LLM to produce
 * JSON matching DiagRootCauseOutputV1Schema.
 *
 * Uses an opts-object pattern for all methods to satisfy @typescript-eslint/max-params.
 *
 * @see PRI-372
 */
export class RootCausePromptBuilder {
  private readonly adapter: SchemaPromptAdapter;
  private readonly schema: TSchema;

  constructor(opts: RootCausePromptBuilderOptions = {}) {
    this.adapter = opts.adapter ?? new DefaultSchemaPromptAdapter();
    this.schema = opts.schema ?? DiagRootCauseOutputV1Schema;
  }

  /**
   * Build the Stage A diagnostic protocol instruction.
   *
   * Contains PHASE 1 (evidence review), PHASE 2 (causal chain / 5-Whys),
   * PHASE 3 (root cause classification), and optional PHASE 3.5 (core axiom
   * grounding when coreGrounding=true).
   *
   * @see PRI-372
   */
  buildRootCauseInstruction(opts: RootCausePromptBuilderOptions = {}): string {
    return buildRootCauseProtocolInstruction({
      adapter: opts.adapter ?? this.adapter,
      schema: opts.schema ?? this.schema,
      outputLanguage: opts.outputLanguage,
      coreGrounding: opts.coreGrounding,
      intentGrounding: opts.intentGrounding,
    });
  }

  /**
   * Build the full prompt for Stage A.
   *
   * Transforms DiagnosticianContextPayload into a PromptBuildResult containing
   * the JSON message to pass as the --message argument to the LLM agent.
   *
   * Per DPB-02: Output is ONLY JSON — no markdown, no file ops, no tool calls.
   * Per DPB-05: This method only builds the prompt; it does NOT commit to PD database.
   * Per DPB-07: NO extraSystemPrompt is added — agent profile is the source of truth.
   *
   * @see PRI-372
   */
  buildPrompt(
    payload: DiagnosticianContextPayload,
    opts: BuildPromptOptions = {},
  ): PromptBuildResult {
    const limits = opts.limits ?? DEFAULT_PROMPT_BUILDER_LIMITS;
    const { outputLanguage, coreGrounding, intentGrounding, intentDoc } = opts;

    const truncationWarnings: string[] = [];

    // DPB-04: Apply truncation to conversationWindow to prevent token overflow
    const rawWindow = summarizeConversationWindow(payload.conversationWindow);
    const windowEntries = rawWindow.slice(0, limits.maxConversationEntries);
    if (rawWindow.length > limits.maxConversationEntries) {
      truncationWarnings.push(
        `conversationWindow truncated from ${rawWindow.length} to ${limits.maxConversationEntries} entries`,
      );
    }

    // Truncate individual entry text
    const conversationWindow = windowEntries.map((entry) => {
      if (entry.text && entry.text.length > limits.maxEntryTextChars) {
        return {
          ...entry,
          text: entry.text.slice(0, limits.maxEntryTextChars) + '...[truncated]',
        };
      }
      return entry;
    });

    // Build compact context — replace conversationWindow with truncated version
    const compactContext: DiagnosticianContextPayload = {
      ...payload,
      conversationWindow,
    };

    const diagnosticInstruction = this.buildRootCauseInstruction({
      outputLanguage,
      coreGrounding,
      intentGrounding,
    });

    // DPB-04: Explicit top-level fields at the prompt level
    // PRI-468: Only include `intentDoc` when intentGrounding is on AND a doc
    // was successfully read. When absent, the prompt is byte-identical to
    // the pre-PRI-468 prompt (EP-03: no silent fallback).
    const promptInput: PromptInput = {
      taskId: payload.taskId,
      contextHash: payload.contextHash,
      diagnosisTarget: payload.diagnosisTarget,
      conversationWindow,
      sourceRefs: payload.sourceRefs,
      context: compactContext,
      diagnosticInstruction,
      ...(truncationWarnings.length > 0 ? { truncationWarnings } : {}),
      ...(intentGrounding && intentDoc ? { intentDoc } : {}),
    };

    // DPB-02: Output is ONLY JSON — no markdown, no file ops, no tool calls
    let message = JSON.stringify(promptInput);

    // If message exceeds maxMessageChars, truncate the diagnostic instruction
    if (message.length > limits.maxMessageChars) {
      const surplus = message.length - limits.maxMessageChars;
      const instruction = diagnosticInstruction;

      // Keep at least the first 200 chars of the instruction + a note
      const keepLength = Math.max(200, instruction.length - surplus - 100);
      const truncatedInstruction = instruction.slice(0, keepLength) +
        '\n\n[OUTPUT FORMAT section is REQUIRED; other sections may be summarized if needed]';

      promptInput.diagnosticInstruction = truncatedInstruction;
      promptInput.truncationWarnings = [
        ...truncationWarnings,
        `diagnosticInstruction truncated due to size (${message.length} > ${limits.maxMessageChars})`,
      ];
      message = JSON.stringify(promptInput);
    }

    return { message, promptInput };
  }
}
