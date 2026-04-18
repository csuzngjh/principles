/**
 * Writing domain types for principles-core.
 *
 * Per D-01: Writing adapter receives pre-evaluated TextAnalysisResult
 * from an upstream quality evaluator. The adapter does pure translation
 * only — no LLM calls, no external dependencies.
 */

/**
 * Issue types for creative writing quality problems.
 * These are produced by an upstream text quality evaluator.
 */
export type WritingIssueType =
  | 'text_coherence_violation'
  | 'style_inconsistency'
  | 'narrative_arc_break'
  | 'tone_mismatch';

/**
 * Structured text analysis result from upstream quality evaluator.
 *
 * The evaluator is OUTSIDE this adapter. The adapter only translates
 * this structured result into a PainSignal. This keeps the adapter
 * pure and testable with synthetic data.
 */
export interface TextAnalysisResult {
  /** Type of quality issue detected */
  issueType: WritingIssueType;
  /** Quality score 0-100 (higher = more severe issue) */
  severityScore: number;
  /** Description of the quality issue */
  description: string;
  /** Text snippet that triggered the issue */
  excerpt: string;
  /** Session ID from the conversation */
  sessionId: string;
  /** Optional trace ID for correlation */
  traceId?: string;
}
