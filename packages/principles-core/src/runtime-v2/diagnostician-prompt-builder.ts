/**
 * DiagnosticianPromptBuilder — transforms DiagnosticianContextPayload into PromptInput for OpenClaw agent.
 *
 * Phase: m6-03
 * Requirements: DPB-01, DPB-02, DPB-03, DPB-04, DPB-05
 *
 * ## Output Structure (DPB-06)
 *
 * PromptInput has explicit top-level fields (taskId, contextHash, diagnosisTarget,
 * conversationWindow, sourceRefs) plus nested `context: DiagnosticianContextPayload`.
 *
 * (Note: monolithic DiagnosticianPromptBuilder and buildDiagnosticProtocolInstruction have been deleted per PRI-373).
 */
import type {
  DiagnosticianContextPayload,
  HistoryQueryEntry,
  DiagnosisTarget,
} from './context-payload.js';
import type { OutputLanguage } from './language-directive.js';

/** Options for DiagnosticianPromptBuilder.buildPrompt() beyond the required payload. */
export interface BuildPromptOptions {
  /** Size limits to prevent token overflow (default: DEFAULT_PROMPT_BUILDER_LIMITS) */
  limits?: PromptBuilderLimits;
  /** Output language directive (default: none) */
  outputLanguage?: OutputLanguage;
  /** T-E (PRI-371): Inject core axiom grounding as PHASE 3.5 (default: false) */
  coreGrounding?: boolean;
}

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