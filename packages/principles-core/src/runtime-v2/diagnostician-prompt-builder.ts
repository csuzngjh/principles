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
 */
export interface PromptInput {
  /** Task being diagnosed */
  taskId: string;
  /** Hash of the context for integrity verification */
  contextHash: string;
  /** What to diagnose (pain event, failure mode, etc.) */
  diagnosisTarget: DiagnosisTarget;
  /**
   * Conversation window summary.
   * Full HistoryQueryEntry[] is available in context.conversationWindow;
   * this field may contain a condensed version for the LLM prompt.
   */
  conversationWindow: HistoryQueryEntry[];
  /** Source references for the diagnosis */
  sourceRefs: string[];
  /** Full DiagnosticianContextPayload for backward compatibility */
  context: DiagnosticianContextPayload;
}

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
   * @returns PromptBuildResult with JSON string + PromptInput object (DPB-02, DPB-03, DPB-04, DPB-06)
   *
   * Per DPB-05: This method only builds the prompt; it does NOT commit to PD database.
   * The caller (DiagnosticianRunner or CLI layer) handles database commits.
   *
   * Per DPB-07: NO extraSystemPrompt is added — agent profile is the source of truth.
   */
  buildPrompt(payload: DiagnosticianContextPayload): PromptBuildResult {
    // DPB-04: Explicit top-level fields at the prompt level
    const promptInput: PromptInput = {
      taskId: payload.taskId,
      contextHash: payload.contextHash,
      diagnosisTarget: payload.diagnosisTarget,
      conversationWindow: summarizeConversationWindow(payload.conversationWindow),
      sourceRefs: payload.sourceRefs,
      context: payload,
    };

    // DPB-02: Output is ONLY JSON — no markdown, no file ops, no tool calls
    // DPB-03: JSON must conform to what DiagnosticianOutputV1 expects (caller validates)
    const message = JSON.stringify(promptInput);

    return { message, promptInput };
  }
}