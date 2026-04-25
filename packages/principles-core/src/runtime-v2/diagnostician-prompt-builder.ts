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
  /**
   * Explicit 5-phase diagnostic protocol instruction.
   * Tells the LLM to follow Phase 1 (evidence) → Phase 2 (5 Whys causal chain)
   * → Phase 3 (root cause classification) → Phase 4 (principle extraction),
   * and to output DiagnosticianOutputV1 JSON.
   */
  diagnosticInstruction: string;
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
 * 5-phase diagnostic protocol instruction for the LLM.
 *
 * Source: templates/langs/en/skills/pd-diagnostician/SKILL.md
 * Copied here so the instruction is embedded directly in the prompt payload,
 * ensuring the LLM follows the 5 Whys / root cause methodology regardless of
 * whether OpenClaw automatically loads SKILL.md as the agent system prompt.
 */
export const DIAGNOSTIC_PROTOCOL_INSTRUCTION = `You are a root cause analysis expert. Follow this protocol:

PHASE 1 — Evidence Gathering:
Read .state/.pain_flag and .state/logs/events.jsonl for context. Search codebase for related error patterns. Record all evidence with file:line references.

PHASE 2 — Causal Chain (5 Whys):
Build a Why-1 through Why-5 causal chain. Each Why MUST have evidence.
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
Extract ONE highly abstracted principle (max 40 chars, cross-scenario).
- trigger_pattern: regex/keywords for when this applies
- action: what to do differently
- abstracted_principle: one sentence, max 40 chars
Deduplicate against existing principles before adding new.

OUTPUT FORMAT (pure JSON, no markdown):
{
  "valid": true,
  "diagnosisId": "<generate UUID>",
  "taskId": "<from input>",
  "summary": "<one line root cause summary>",
  "rootCause": "<Design|People|Assumption|Tooling>: <specific root cause>",
  "violatedPrinciples": [{"rationale": "<why this principle was violated>"}],
  "evidence": [{"sourceRef": "file:line or log", "note": "<what this shows>"}],
  "recommendations": [{"kind": "principle|rule|implementation|defer", "description": "<specific action>"}],
  "confidence": 0.0-1.0,
  "ambiguityNotes": ["<optional: anything uncertain>"]
}

CONSTRAINTS:
- Output ONLY valid JSON (no markdown, no explanatory text)
- rootCause MUST include category prefix: "Design: ..." or "People: ..." etc.
- confidence is a number 0.0-1.0
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
   * @returns PromptBuildResult with JSON string + PromptInput object (DPB-02, DPB-03, DPB-04, DPB-06)
   *
   * Per DPB-05: This method only builds the prompt; it does NOT commit to PD database.
   * The caller (DiagnosticianRunner or CLI layer) handles database commits.
   *
   * Per DPB-07: NO extraSystemPrompt is added — agent profile is the source of truth.
   */
  // eslint-disable-next-line @typescript-eslint/class-methods-use-this
  buildPrompt(payload: DiagnosticianContextPayload): PromptBuildResult {
    // DPB-04: Explicit top-level fields at the prompt level
    const promptInput: PromptInput = {
      taskId: payload.taskId,
      contextHash: payload.contextHash,
      diagnosisTarget: payload.diagnosisTarget,
      conversationWindow: summarizeConversationWindow(payload.conversationWindow),
      sourceRefs: payload.sourceRefs,
      context: payload,
      diagnosticInstruction: DIAGNOSTIC_PROTOCOL_INSTRUCTION,
    };

    // DPB-02: Output is ONLY JSON — no markdown, no file ops, no tool calls
    // DPB-03: JSON must conform to what DiagnosticianOutputV1 expects (caller validates)
    const message = JSON.stringify(promptInput);

    return { message, promptInput };
  }
}