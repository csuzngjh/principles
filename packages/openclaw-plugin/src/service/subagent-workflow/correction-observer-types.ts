/**
 * Correction Observer Workflow - Type Definitions
 *
 * Types for the correction observer LLM optimization workflow.
 * This workflow dispatches an LLM subagent to analyze keyword performance
 * and recommend ADD/UPDATE/REMOVE actions for the correction keyword store.
 */

import type { SubagentWorkflowSpec } from './types.js';

/**
 * Input passed to the correction observer subagent.
 */
export interface CorrectionObserverPayload {
  /** Parent session that triggered the optimization */
  parentSessionId: string;
  /** Workspace directory */
  workspaceDir: string;
  /** Current keyword store summary for context */
  keywordStoreSummary: {
    totalKeywords: number;
    terms: Array<{
      term: string;
      weight: number;
      hitCount: number;
      truePositiveCount: number;
      falsePositiveCount: number;
    }>;
  };
  /** Recent user messages for pattern analysis */
  recentMessages: string[];

  /**
   * Trajectory history: user turns where correctionDetected=true (D-40-08).
   * Includes term matched, timestamp, sessionId for FPR trend analysis.
   */
  trajectoryHistory: Array<{
    sessionId: string;
    timestamp: string;
    term: string;
    userMessage: string;
  }>;
}

/**
 * Result from the correction observer subagent.
 */
export interface CorrectionObserverResult {
  /** Whether any changes were made */
  updated: boolean;
  /** The optimization decisions returned by the LLM (optional if updated=false) */
  updates?: Record<string, {
    action: 'add' | 'update' | 'remove';
    weight?: number;
    falsePositiveRate?: number;
    reasoning: string;
  }>;
  /**
   * Terms identified as false positives — user message didn't actually indicate
   * frustration/correction despite correctionDetected firing for these terms.
   * CORR-10 / H-1: Calling recordFalsePositive() decays weight by x0.8 per term.
   * Only meaningful when fpAnalysisStatus='completed'.
   */
  fpTerms?: string[];
  /**
   * Whether FP analysis was performed. 'skipped' means the LLM did not run
   * trajectory analysis (e.g., trajectory was empty). 'completed' means fpTerms
   * contains the LLM's FP findings (may be empty if no FPs were found).
   */
  fpAnalysisStatus?: 'completed' | 'skipped';
  /** Human-readable summary */
  summary: string;
}

/**
 * Workflow spec for the correction observer optimization workflow.
 */
export interface CorrectionObserverWorkflowSpec extends SubagentWorkflowSpec<CorrectionObserverResult> {
  workflowType: 'correction_observer';
  payload: CorrectionObserverPayload;
  result?: CorrectionObserverResult;
}
