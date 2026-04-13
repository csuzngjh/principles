/**
 * Nocturnal Reasoning Deriver — Runtime Reasoning Signal Extraction
 * ==============================================================
 *
 * PURPOSE: Derive structured reasoning signals from existing snapshot data
 * without any snapshot schema changes. Pure functions, zero dependencies.
 *
 * THREE FUNCTIONS:
 * - deriveReasoningChain: Extract thinking content, uncertainty, confidence from assistant turns
 * - deriveDecisionPoints: Extract before/after context per tool call (Plan 02)
 * - deriveContextualFactors: Compute contextual factors from snapshot (Plan 02)
 */

import type { NocturnalAssistantTurn, NocturnalToolCall, NocturnalUserTurn, NocturnalSessionSnapshot } from './nocturnal-trajectory-extractor.js';
import { detectThinkingModelMatches, listThinkingModels } from './thinking-models.js';

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** Parse an ISO 8601 timestamp, returning NaN for invalid formats. */
function parseTs(ts: string): number {
  // ISO 8601 strings without Z suffix or offset are treated as local time.
  // Log a warning for ambiguous formats (missing timezone indicator).
  if (
    typeof ts === 'string' &&
    !ts.endsWith('Z') &&
    !ts.includes('+') &&
    ts.includes('-', 4)
  ) {
    // Looks like an ISO date but no timezone — could be ambiguous
    const bare = ts.slice(0, 10);
    if (/^\d{4}-\d{2}-\d{2}$/.test(bare)) {
      // Plain YYYY-MM-DD without time or Z — definitely ambiguous
      console.warn(`[Deriver] Timestamp missing timezone: "${ts}"`);
    }
  }
  return Date.parse(ts);
}

// ---------------------------------------------------------------------------
// Shared types (used across all three derive functions)
// ---------------------------------------------------------------------------

export interface DerivedReasoningSignal {
  turnIndex: number;
  thinkingContent: string;
  uncertaintyMarkers: string[];
  confidenceSignal: "high" | "medium" | "low";
}

export interface DerivedDecisionPoint {
  toolName: string;
  outcome: "success" | "failure" | "blocked";
  beforeContext: string;
  afterReflection?: string;
  confidenceDelta?: number;
}

export interface DerivedContextualFactors {
  fileStructureKnown: boolean;
  errorHistoryPresent: boolean;
  userGuidanceAvailable: boolean;
  timePressure: boolean;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const UNCERTAINTY_PATTERNS: RegExp[] = [
  /let me (check|verify|confirm|understand)/gi,
  /I should (first|probably|maybe)/gi,
  /not sure (if|whether|about)/gi,
];

const THINKING_TAG_REGEX = /<thinking>([\s\S]*?)<\/thinking>/g;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Compute thinking model activation ratio for text.
 * Uses detectThinkingModelMatches() from thinking-models.ts.
 * Returns 0-1, rounded to 2 decimal places.
 */
function computeThinkingModelActivation(text: string): number {
  if (!text || text.trim().length === 0) return 0;
  const matches = detectThinkingModelMatches(text);
  const totalModels = listThinkingModels().length;
  if (totalModels === 0) return 0;
  return Math.round((matches.length / totalModels) * 100) / 100;
}

/**
 * Map activation ratio (0-1) to confidence signal.
 * Thresholds: high > 0.6, medium 0.3-0.6, low < 0.3
 */
function mapConfidenceSignal(activation: number): "high" | "medium" | "low" {
  if (activation > 0.6) return "high";
  if (activation >= 0.3) return "medium";
  return "low";
}

// ---------------------------------------------------------------------------
// deriveReasoningChain (DERIV-01)
// ---------------------------------------------------------------------------

/**
 * Extract thinking content, uncertainty markers, and confidence signal
 * from each assistant turn in the snapshot.
 *
 * DERIV-01: Returns one DerivedReasoningSignal per assistant turn.
 * Empty input returns empty array. Never throws.
 */
export function deriveReasoningChain(assistantTurns: NocturnalAssistantTurn[]): DerivedReasoningSignal[] {
  if (!assistantTurns || assistantTurns.length === 0) return [];

  return assistantTurns.map(turn => {
    const text = turn.sanitizedText ?? '';

    // Extract all <thinking> content blocks (multiple blocks per turn possible)
    const thinkingMatches = [...text.matchAll(THINKING_TAG_REGEX)];
    const thinkingContent = thinkingMatches.map(m => m[1].trim()).join('\n');

    // Detect uncertainty markers (collect all unique matches across 3 patterns)
    const uncertaintyMarkers: string[] = [];
    for (const pattern of UNCERTAINTY_PATTERNS) {
      // Reset lastIndex to avoid g-flag state issues
      pattern.lastIndex = 0;
      const matches = text.match(pattern);
      if (matches) {
        for (const m of matches) {
          if (!uncertaintyMarkers.includes(m)) {
            uncertaintyMarkers.push(m);
          }
        }
      }
    }

    // Compute confidence signal using thinking model activation ratio
    const activation = computeThinkingModelActivation(text);
    const confidenceSignal = mapConfidenceSignal(activation);

    return {
      turnIndex: turn.turnIndex,
      thinkingContent,
      uncertaintyMarkers,
      confidenceSignal,
    };
  });
}

// ---------------------------------------------------------------------------
// Helpers (Plan 02)
// ---------------------------------------------------------------------------

/**
 * Convert confidence signal to numeric value for delta computation.
 * high=1, medium=0.5, low=0
 */
function confidenceToNumber(signal: "high" | "medium" | "low"): number {
  switch (signal) {
    case "high": return 1;
    case "medium": return 0.5;
    case "low": return 0;
  }
}

// ---------------------------------------------------------------------------
// deriveDecisionPoints (DERIV-02)
// ---------------------------------------------------------------------------

/**
 * Extract before-context and after-reflection for each tool call.
 *
 * DERIV-02: For each tool call, find the assistant turn immediately before it
 * (by createdAt timestamp) and extract last 500 chars as beforeContext.
 * On failure outcome, find the next assistant turn and extract first 300 chars
 * as afterReflection. Compute confidence delta between before/after.
 *
 * Empty inputs return empty array. Never throws.
 */
export function deriveDecisionPoints(
  assistantTurns: NocturnalAssistantTurn[],
  toolCalls: NocturnalToolCall[],
): DerivedDecisionPoint[] {
  if (!toolCalls || toolCalls.length === 0) return [];
  if (!assistantTurns || assistantTurns.length === 0) {
    // Return decision points with empty beforeContext when no assistant turns
    return toolCalls.map(tc => ({
      toolName: tc.toolName,
      outcome: tc.outcome,
      beforeContext: '',
    }));
  }

  // Sort assistant turns by createdAt for binary search
  const sortedTurns = [...assistantTurns].sort(
    (a, b) => parseTs(a.createdAt) - parseTs(b.createdAt)
  );

  // Binary search: find rightmost assistant turn with createdAt < tcTime
  const findBeforeTurn = (tcTime: number): NocturnalAssistantTurn | undefined => {
    let lo = 0, hi = sortedTurns.length - 1, result: NocturnalAssistantTurn | undefined;
    while (lo <= hi) {
      const mid = (lo + hi) >>> 1;
      if (parseTs(sortedTurns[mid].createdAt) < tcTime) {
        result = sortedTurns[mid];
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    return result;
  };

  return toolCalls.map(tc => {
    const tcTime = parseTs(tc.createdAt);
    const beforeTurn = findBeforeTurn(tcTime);

    const beforeContext = beforeTurn
      ? beforeTurn.sanitizedText.slice(-500)
      : '';

    // On failure, find next assistant turn after tool call
    let afterReflection: string | undefined;
    let confidenceDelta: number | undefined;

    if (tc.outcome === 'failure') {
      const afterTurn = sortedTurns.find(
        turn => parseTs(turn.createdAt) > tcTime
      );
      if (afterTurn) {
        afterReflection = afterTurn.sanitizedText.slice(0, 300);
      }

      // Compute confidence delta if both before and after turns exist
      if (beforeTurn && afterTurn) {
        const beforeConfidence = confidenceToNumber(
          mapConfidenceSignal(computeThinkingModelActivation(beforeTurn.sanitizedText))
        );
        const afterConfidence = confidenceToNumber(
          mapConfidenceSignal(computeThinkingModelActivation(afterTurn.sanitizedText))
        );
        confidenceDelta = Math.round((afterConfidence - beforeConfidence) * 100) / 100;
      }
    }

    const result: DerivedDecisionPoint = {
      toolName: tc.toolName,
      outcome: tc.outcome,
      beforeContext,
    };
    if (afterReflection !== undefined) result.afterReflection = afterReflection;
    if (confidenceDelta !== undefined) result.confidenceDelta = confidenceDelta;
    return result;
  });
}

// ---------------------------------------------------------------------------
// deriveContextualFactors (DERIV-03)
// ---------------------------------------------------------------------------

/**
 * Compute contextual factors from session snapshot data.
 *
 * DERIV-03: Four boolean factors indicating the environment
 * the agent was operating in. All derived from existing snapshot
 * fields -- no schema changes.
 *
 * Empty/missing data returns all-false defaults. Never throws.
 */
export function deriveContextualFactors(
  snapshot: NocturnalSessionSnapshot,
): DerivedContextualFactors {
  const defaults: DerivedContextualFactors = {
    fileStructureKnown: false,
    errorHistoryPresent: false,
    userGuidanceAvailable: false,
    timePressure: false,
  };

  if (!snapshot) return defaults;

  const { toolCalls = [], userTurns = [] } = snapshot;

  // fileStructureKnown: any Read tool precedes any Write tool in chronological order
  let fileStructureKnown = false;
  const isReadTool = (name: string) => /^(read|grep|search|find|inspect|look)/i.test(name);
  const isWriteTool = (name: string) => /^(edit|write|create|delete|remove|move|rename)/i.test(name);
  let hasSeenRead = false;
  for (const tc of toolCalls) {
    if (isReadTool(tc.toolName)) hasSeenRead = true;
    if (isWriteTool(tc.toolName) && hasSeenRead) {
      fileStructureKnown = true;
      break;
    }
  }

  // errorHistoryPresent: any tool call with outcome === 'failure'
  const errorHistoryPresent = toolCalls.some(tc => tc.outcome === 'failure');

  // userGuidanceAvailable: any user turn with correctionDetected === true
  const userGuidanceAvailable = (userTurns || []).some(ut => ut.correctionDetected === true);

  // timePressure: >50% of consecutive tool call pairs have < 2s gap
  let timePressure = false;
  if (toolCalls.length >= 2) {
    const sorted = [...toolCalls].sort(
      (a, b) => parseTs(a.createdAt) - parseTs(b.createdAt)
    );
    let rapidGaps = 0;
    for (let i = 0; i < sorted.length - 1; i++) {
      const gap = parseTs(sorted[i + 1].createdAt) - parseTs(sorted[i].createdAt);
      if (gap < 2000) rapidGaps++;
    }
    const totalPairs = sorted.length - 1;
    timePressure = rapidGaps / totalPairs > 0.5;
  }

  return {
    fileStructureKnown,
    errorHistoryPresent,
    userGuidanceAvailable,
    timePressure,
  };
}
