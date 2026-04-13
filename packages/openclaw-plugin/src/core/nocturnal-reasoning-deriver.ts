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

const THINKING_TAG_REGEX = /<thinking>([\s\S]*?)<\/thinking>/;

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

    // Extract <thinking> content
    const thinkingMatch = text.match(THINKING_TAG_REGEX);
    const thinkingContent = thinkingMatch ? thinkingMatch[1].trim() : '';

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
// Plan 02 implementations (stubs)
// ---------------------------------------------------------------------------

export function deriveDecisionPoints(
  _assistantTurns: NocturnalAssistantTurn[],
  _toolCalls: NocturnalToolCall[],
): DerivedDecisionPoint[] {
  // Plan 02: DERIV-02
  return [];
}

export function deriveContextualFactors(
  _snapshot: NocturnalSessionSnapshot,
): DerivedContextualFactors {
  // Plan 02: DERIV-03
  return { fileStructureKnown: false, errorHistoryPresent: false, userGuidanceAvailable: false, timePressure: false };
}
