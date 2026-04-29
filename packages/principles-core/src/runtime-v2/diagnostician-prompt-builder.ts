/**
 * DiagnosticianPromptBuilder — transforms DiagnosticianContextPayload into PromptInput for OpenClaw agent.
 *
 * Phase: m6-03
 * Requirements: DPB-01, DPB-02, DPB-03, DPB-04, DPB-05
 *
 * ## Contract
 *
 * buildPrompt() takes DiagnosticianContextPayload and returns a JSON string
 * to be passed as `openclaw agent --message <json>`.
 *
 * ## Output Structure (DPB-06)
 *
 * PromptInput has explicit top-level fields (taskId, contextHash, diagnosisTarget,
 * conversationWindow, sourceRefs) plus nested `context: DiagnosticianContextPayload`.
 *
 * ## Diagnostic Instruction (5 Whys / Root Cause Protocol)
 *
 * Per SKILL.md (pd-diagnostician): The LLM MUST follow the 5-phase protocol
 * (Phase 0 context → Phase 1 evidence → Phase 2 causal chain → Phase 3 classification
 * → Phase 4 principle extraction). The diagnosticInstruction field makes this explicit
 * so the LLM follows the protocol even if OpenClaw does not load SKILL.md automatically.
 *
 * ## Constraints (LOCKED)
 *
 * - DPB-02: Output is ONLY JSON — no markdown, no file ops, no tool calls
 * - DPB-07: NO extraSystemPrompt field — system prompt is agent profile's responsibility
 * - DPB-05: LLM only analyzes — PD database commits are handled by caller code
 */
import type {
  DiagnosticianContextPayload,
  HistoryQueryEntry,
  DiagnosisTarget,
} from './context-payload.js';

/**
 * PromptInput — the JSON message sent to openclaw agent via --message flag.
 *
 * Per DPB-06: Explicit top-level fields make LLM's job clearer and easier to validate.
 * The DiagnosticianContextPayload is nested under `context` for backward compatibility.
 * The diagnosticInstruction field carries the 5-phase protocol so the LLM follows it.
 *
 * @see DEFAULT_LIMITS for size constraints applied during buildPrompt()
 */
export interface PromptInput {
  /** Task being diagnosed */
  taskId: string;
  /** Hash of the context for integrity verification */
  contextHash: string;
  /** What to diagnose (pain event, failure mode, etc.) */
  diagnosisTarget: DiagnosisTarget;
  /**
   * Conversation window summary (may be truncated if too large).
   * Full HistoryQueryEntry[] is available in context.conversationWindow;
   * this field may contain a condensed version for the LLM prompt.
   */
  conversationWindow: HistoryQueryEntry[];
  /** Source references for the diagnosis */
  sourceRefs: string[];
  /** Full DiagnosticianContextPayload for backward compatibility */
  context: DiagnosticianContextPayload;
  /**
   * Explicit 5-phase diagnostic protocol instruction.
   * Tells the LLM to follow Phase 1 (evidence) → Phase 2 (5 Whys causal chain)
   * → Phase 3 (root cause classification) → Phase 4 (principle extraction),
   * and to output DiagnosticianOutputV1 JSON.
   */
  diagnosticInstruction: string;
  /** Warnings added during truncation (e.g., conversationWindow entries removed) */
  truncationWarnings?: string[];
}

/** Size limits for buildPrompt() to prevent token overflow. */
export interface PromptBuilderLimits {
  /** Maximum number of conversation entries (default: 30) */
  maxConversationEntries: number;
  /** Maximum characters per entry text (default: 2000) */
  maxEntryTextChars: number;
  /** Maximum total message characters (default: 80000) */
  maxMessageChars: number;
}

export const DEFAULT_PROMPT_BUILDER_LIMITS: PromptBuilderLimits = {
  maxConversationEntries: 30,
  maxEntryTextChars: 2000,
  maxMessageChars: 80_000,
} as const;

/**
 * Build result — the JSON string to pass as --message argument.
 *
 * Per DPB-02: Output is ONLY JSON (no markdown, no file ops, no tool calls).
 * Per DPB-07: NO extraSystemPrompt field in this result.
 */
export interface PromptBuildResult {
  /** JSON string — the exact value to pass as openclaw agent --message argument */
  readonly message: string;
  /** The PromptInput object that was serialized to JSON */
  readonly promptInput: PromptInput;
}

/**
 * 5-phase diagnostic protocol instruction for the LLM.
 *
 * Per DPB-02 (LOCKED): Output is ONLY JSON — no markdown, no file ops, no tool calls.
 * Per DPB-04: LLM can only analyze the context provided in the prompt; it must NOT
 *   read files, call tools, or write to databases. All evidence must be drawn from
 *   the context payload (sourceRefs, conversationWindow, eventSummaries).
 *
 * The 5-phase protocol is embedded directly in the prompt so the LLM follows it
 * regardless of whether OpenClaw loads SKILL.md as the agent system prompt.
 */
export const DIAGNOSTIC_PROTOCOL_INSTRUCTION = `You are a root cause analysis expert. Follow this protocol:

PHASE 1 — Evidence Review:
Review the provided sourceRefs, conversationWindow entries, and eventSummaries
from the context payload. Do NOT read any files or call any tools.
Record all evidence by referencing the sourceRef identifiers and conversation
entries already present in the context. Each evidence item must cite its source.

PHASE 2 — Causal Chain (5 Whys):
Build a Why-1 through Why-5 causal chain. Each Why MUST have evidence from Phase 1.
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

PHASE 4 — Principle Extraction:
Extract ONE highly abstracted principle (max 200 chars, cross-scenario).
- trigger_pattern: regex/keywords for when this applies
- action: what to do differently
- abstracted_principle: one sentence, max 200 chars

OUTPUT FORMAT (pure JSON, no markdown):
{
  "valid": true,
  "diagnosisId": "<generate UUID>",
  "taskId": "<from input>",
  "summary": "<one line root cause summary>",
  "rootCause": "<Design|People|Assumption|Tooling>: <specific root cause>",
  "violatedPrinciples": [{"rationale": "<why this principle was violated>"}],
  "evidence": [{"sourceRef": "<sourceRef from context or conversationWindow entry>", "note": "<what this shows>"}],
  "recommendations": [
    {
      "kind": "principle",
      "description": "<specific action>",
      "triggerPattern": "<regex/keywords>",
      "action": "<what to do differently>",
      "abstractedPrinciple": "<one sentence, max 200 chars>"
    },
    {"kind": "rule|implementation|defer", "description": "<specific action>"}
  ],
  "confidence": 0.0-1.0,
  "ambiguityNotes": ["<optional: anything uncertain>"]
}

CONSTRAINTS:
- Output ONLY valid JSON (no markdown, no explanatory text)
- Do NOT read files, call tools, or write to any database
- rootCause MUST include category prefix: "Design: ..." or "People: ..." etc.
- confidence is a number 0.0-1.0
- All evidence must reference sourceRef identifiers or conversationWindow entries from the context payload
`;

/**
 * Summarizes a conversation window for inclusion in the prompt.
 * DPB-04: Prompt includes conversationWindow summary.
 *
 * Default implementation returns entries as-is.
 * Subclasses or configuration can provide condensation logic.
 */
export function summarizeConversationWindow(
  entries: HistoryQueryEntry[]
): HistoryQueryEntry[] {
  return entries;
}

export class DiagnosticianPromptBuilder {
  /**
   * Transform DiagnosticianContextPayload into a PromptInput object,
   * then serialize to JSON for the --message argument.
   *
   * @param payload — DiagnosticianContextPayload from context assembly (DPB-01)
   * @param limits — Size limits to prevent token overflow (default: DEFAULT_PROMPT_BUILDER_LIMITS)
   * @returns PromptBuildResult with JSON string + PromptInput object (DPB-02, DPB-03, DPB-04, DPB-06)
   *
   * Per DPB-05: This method only builds the prompt; it does NOT commit to PD database.
   * The caller (DiagnosticianRunner or CLI layer) handles database commits.
   *
   * Per DPB-07: NO extraSystemPrompt is added — agent profile is the source of truth.
   */
  // eslint-disable-next-line @typescript-eslint/class-methods-use-this
  buildPrompt(
    payload: DiagnosticianContextPayload,
    limits: PromptBuilderLimits = DEFAULT_PROMPT_BUILDER_LIMITS,
  ): PromptBuildResult {
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
    // to avoid duplicating full content at top-level AND in context
    const compactContext: DiagnosticianContextPayload = {
      ...payload,
      conversationWindow,
    };

    // DPB-04: Explicit top-level fields at the prompt level
    const promptInput: PromptInput = {
      taskId: payload.taskId,
      contextHash: payload.contextHash,
      diagnosisTarget: payload.diagnosisTarget,
      conversationWindow,
      sourceRefs: payload.sourceRefs,
      context: compactContext,
      diagnosticInstruction: DIAGNOSTIC_PROTOCOL_INSTRUCTION,
      ...(truncationWarnings.length > 0 ? { truncationWarnings } : {}),
    };

    // DPB-02: Output is ONLY JSON — no markdown, no file ops, no tool calls
    // DPB-03: JSON must conform to what DiagnosticianOutputV1 expects (caller validates)
    let message = JSON.stringify(promptInput);

    // If message exceeds maxMessageChars, truncate the diagnostic instruction
    if (message.length > limits.maxMessageChars) {
      const surplus = message.length - limits.maxMessageChars;
      const instruction = DIAGNOSTIC_PROTOCOL_INSTRUCTION;
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