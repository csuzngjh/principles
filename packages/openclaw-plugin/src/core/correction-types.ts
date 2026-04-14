/**
 * Correction Cue Keyword Types
 *
 * Types for the dynamic correction cue detection system.
 * Replaces the previous hardcoded cue list in detectCorrectionCue()
 * with a persistent, learnable keyword store.
 */

// =========================================================================
// Keyword Store
// =========================================================================

export interface CorrectionKeyword {
  /** The keyword term to match against normalized user text */
  term: string;
  /** Contribution weight (0-1) */
  weight: number;
  /** How this keyword was introduced */
  source: 'seed' | 'llm' | 'user';
  /** ISO 8601 timestamp of when this keyword was added */
  addedAt: string;
}

export interface CorrectionKeywordStore {
  /** All correction keywords */
  keywords: CorrectionKeyword[];
  /** Schema version */
  version: number;
}

// =========================================================================
// Match Result
// =========================================================================

export interface CorrectionMatchResult {
  /** Whether any keyword matched */
  matched: boolean;
  /** The first matched term (empty array when no match) */
  matchedTerms: string[];
  /** 1.0 if matched, 0.0 if not (binary match semantics) */
  score: number;
}

// =========================================================================
// Seed Keywords (16 terms — sourced from detectCorrectionCue)
// =========================================================================

/** Maximum number of keywords the store may hold (D-06). */
export const MAX_CORRECTION_KEYWORDS = 200;

/**
 * Preset seed keywords for correction cue detection.
 * Mirrors the hardcoded list in detectCorrectionCue() exactly (D-08).
 * addedAt is intentionally empty here — it is filled in at runtime by
 * createDefaultStore() when the store is first persisted to disk.
 */
export const CORRECTION_SEED_KEYWORDS: CorrectionKeyword[] = [
  // Chinese (8)
  { term: '不是这个', weight: 0.6, source: 'seed', addedAt: '' },
  { term: '不对', weight: 0.5, source: 'seed', addedAt: '' },
  { term: '错了', weight: 0.5, source: 'seed', addedAt: '' },
  { term: '搞错了', weight: 0.7, source: 'seed', addedAt: '' },
  { term: '理解错了', weight: 0.7, source: 'seed', addedAt: '' },
  { term: '你理解错了', weight: 0.8, source: 'seed', addedAt: '' },
  { term: '重新来', weight: 0.6, source: 'seed', addedAt: '' },
  { term: '再试一次', weight: 0.4, source: 'seed', addedAt: '' },
  // English (8)
  { term: 'you are wrong', weight: 0.7, source: 'seed', addedAt: '' },
  { term: 'wrong file', weight: 0.6, source: 'seed', addedAt: '' },
  { term: 'not this', weight: 0.4, source: 'seed', addedAt: '' },
  { term: 'redo', weight: 0.6, source: 'seed', addedAt: '' },
  { term: 'try again', weight: 0.4, source: 'seed', addedAt: '' },
  { term: 'again', weight: 0.3, source: 'seed', addedAt: '' },
  { term: 'please redo', weight: 0.6, source: 'seed', addedAt: '' },
  { term: 'please try again', weight: 0.5, source: 'seed', addedAt: '' },
];
