/**
 * Correction Cue Learner
 *
 * Persistent, learnable keyword store for correction cue detection.
 * Replaces the hardcoded cue list in detectCorrectionCue() with a
 * crash-safe JSON store that can grow over time.
 *
 * Persistence contract:
 *   - Atomic write: temp-file-then-rename (T-38-02)
 *   - Cache invalidated after every write (D-05)
 *   - 200-term hard cap enforced before any write (T-38-01)
 */

import * as fs from 'fs';
import * as path from 'path';
import type {
  CorrectionKeyword,
  CorrectionKeywordStore,
  CorrectionMatchResult} from './correction-types.js';
import {
  CORRECTION_SEED_KEYWORDS,
  MAX_CORRECTION_KEYWORDS,
} from './correction-types.js';
import { checkKeywordOptCooldown, recordKeywordOptRun } from '../service/nocturnal-runtime.js';
import { atomicWriteFileSync } from '../utils/io.js';

const KEYWORD_STORE_FILE = 'correction_keywords.json';

// CORR-08: Daily optimization throttle (uses checkCooldown in nocturnal-runtime.ts)
// Note: throttle state is stored in nocturnal-runtime.json, not a separate file.

// Weight bounds for correction keywords (D-39-03, D-39-15)
const MIN_KEYWORD_WEIGHT = 0.1;
const MAX_KEYWORD_WEIGHT = 0.9;

// =========================================================================
// Module-level cache (D-04, D-05)
// =========================================================================

/**
 * Invalidated on every successful save so the next load re-reads from disk.
 * Set to null intentionally — never assume disk and memory are in sync after a write.
 */
let _correctionCueCache: CorrectionKeywordStore | null = null;

/**
 * Resets the module-level cache (for testing only).
 * @internal
 */
export function _resetCorrectionCueCache(): void {
  _correctionCueCache = null;
}

// =========================================================================
// Default store factory
// =========================================================================

/**
 * Creates a fresh store populated with the 16 seed keywords (D-08, D-09).
 * addedAt is stamped with the current ISO timestamp.
 */
function createDefaultStore(): CorrectionKeywordStore {
  const now = new Date().toISOString();
  const keywords: CorrectionKeyword[] = CORRECTION_SEED_KEYWORDS.map((k) => ({
    ...k,
    source: 'seed' as const,
    addedAt: now,
  }));
  return { keywords, version: 1, lastOptimizedAt: now };
}

// =========================================================================
// Load / save
// =========================================================================

/**
 * Loads the keyword store from disk.
 * On first run (file absent) or parse failure, creates and persists the default store.
 */
export function loadCorrectionKeywordStore(stateDir: string): CorrectionKeywordStore {
  if (_correctionCueCache) return _correctionCueCache;

  const filePath = path.join(stateDir, KEYWORD_STORE_FILE);

  if (fs.existsSync(filePath)) {
    try {
      const raw = fs.readFileSync(filePath, 'utf-8');
      _correctionCueCache = JSON.parse(raw) as CorrectionKeywordStore;
      return _correctionCueCache;
    } catch {
      // Parse failure — fall through to default
    }
  }

  // File absent or corrupt: seed the store and persist it (D-01)
  const defaultStore = createDefaultStore();
  saveCorrectionKeywordStore(stateDir, defaultStore);
  _correctionCueCache = defaultStore;
  return _correctionCueCache;
}

/**
 * Atomically saves the keyword store to disk (D-03, T-38-02).
 * Uses temp-file-then-rename to ensure the file is always valid JSON or
 * the previous valid state if a crash occurs mid-write.
 * MUST invalidate the cache after the rename (D-05).
 */
export function saveCorrectionKeywordStore(
  stateDir: string,
  store: CorrectionKeywordStore
): void {
  const filePath = path.join(stateDir, KEYWORD_STORE_FILE);

  fs.mkdirSync(stateDir, { recursive: true });
  atomicWriteFileSync(filePath, JSON.stringify(store, null, 2));

  // Invalidate cache so the next read re-loads from disk (D-05)
  _correctionCueCache = null;
}

// =========================================================================
// Throttle helpers (CORR-08)
// =========================================================================
// Singleton state
// =========================================================================

let _instance: CorrectionCueLearner | null = null;
let _lastStateDir: string | null = null;

/** Resets singleton state (for testing only). @internal */
export function _resetCorrectionCueLearnerInstance(): void {
  _instance = null;
  _lastStateDir = null;
}

// =========================================================================
// CorrectionCueLearner class
// =========================================================================

export class CorrectionCueLearner {
  private readonly store: CorrectionKeywordStore;
  private readonly stateDir: string;

  constructor(stateDir: string) {
    this.stateDir = stateDir;
    this.store = loadCorrectionKeywordStore(stateDir);
  }

  // ── Public API ──────────────────────────────────────────────────────────

  /**
   * Checks whether text contains a correction cue (D-11).
   * Pure read-only — does NOT modify the store.
   * Normalisation is equivalent to the original detectCorrectionCue():
   *   trim → lowercase → strip punctuation
   * Returns weighted score based on keyword accuracy (D-39-03, D-39-04).
   *
   * To record hits/TPs, call recordHit() and recordTruePositive() separately.
   */
  match(text: string): CorrectionMatchResult {
    const normalized = text
      .trim()
      .toLowerCase()
      .replace(/[.,!?;:，。！？；：]/g, '');

    const matchedTerms: string[] = [];
    let totalScore = 0;

    for (const keyword of this.store.keywords) {
      if (normalized.includes(keyword.term.toLowerCase())) {
        // D-39-03, D-39-04: Weighted score formula
        // No history (tp=0, fp=0) → accuracy = 1 (trust raw weight)
        // Has history → accuracy = tp / (tp + fp) (proportional to true positive rate)
        const tp = keyword.truePositiveCount ?? 0;
        const fp = keyword.falsePositiveCount ?? 0;
        const accuracy = (tp + fp) > 0 ? tp / (tp + fp) : 1;
        const score = keyword.weight * accuracy;

        totalScore += score;
        matchedTerms.push(keyword.term);
      }
    }

    const cappedScore = Math.min(1, totalScore);
    const isMatched = matchedTerms.length > 0;

    // D-39-04: Confidence derived from multiple signals
    const termConfidence = Math.min(1, matchedTerms.length / 3);
    const scoreConfidence = Math.min(1, cappedScore / 0.8);
    const confidence = Math.max(termConfidence, scoreConfidence);

    return {
      matched: isMatched,
      matchedTerms: matchedTerms.slice(0, 5),
      score: cappedScore,
      confidence,
    };
  }

  /**
   * Records a keyword hit (for hitCount/FPR tracking).
   * Increments hitCount and updates lastHitAt for all matched terms.
   * Intentionally does NOT flush — hitCount is best-effort analytics,
   * persisted by the next recordTruePositive() or flush() call.
   */
  recordHits(terms: string[]): void {
    for (const term of terms) {
      const keywordIndex = this.store.keywords.findIndex(k => k.term.toLowerCase() === term.toLowerCase());
      if (keywordIndex < 0) continue;
      const keyword = this.store.keywords[keywordIndex];
      this.store.keywords[keywordIndex] = {
        ...keyword,
        hitCount: (keyword.hitCount ?? 0) + 1,
        lastHitAt: new Date().toISOString(),
      };
    }
  }

  /**
   * Records a confirmed true positive for the given keyword term.
   * Increments truePositiveCount atomically.
   */
  recordTruePositive(term: string): void {
    const keyword = this.store.keywords.find(k => k.term.toLowerCase() === term.toLowerCase());
    if (!keyword) return;

    keyword.truePositiveCount = (keyword.truePositiveCount ?? 0) + 1;

    // Update in-store reference
    const keywordIndex = this.store.keywords.findIndex(k => k.term.toLowerCase() === term.toLowerCase());
    if (keywordIndex >= 0) {
      this.store.keywords[keywordIndex] = { ...keyword };
    }

    this.flush();
  }

  /**
   * Records a confirmed false positive for the given keyword term.
   * CORR-10: Decreases keyword weight by 20% (x0.8 multiplicative factor).
   * D-39-17: Keywords at very low weight (<0.1) still match but contribute minimally.
   */
  recordFalsePositive(term: string): void {
    const keyword = this.store.keywords.find(k => k.term.toLowerCase() === term.toLowerCase());
    if (!keyword) return;

    keyword.falsePositiveCount = (keyword.falsePositiveCount ?? 0) + 1;

    // D-39-15: Multiplicative weight decay x0.8 on confirmed FP
    keyword.weight = Math.max(MIN_KEYWORD_WEIGHT, keyword.weight * 0.8);
    keyword.lastHitAt = new Date().toISOString();

    // Update in-store reference
    const keywordIndex = this.store.keywords.findIndex(k => k.term.toLowerCase() === term.toLowerCase());
    if (keywordIndex >= 0) {
      this.store.keywords[keywordIndex] = { ...keyword };
    }

    // D-39-16: Apply decay BEFORE flush to disk
    this.flush();
  }

  /**
   * Returns true if optimization is allowed (within daily throttle limit).
   * CORR-08: Max 4 optimizations per day across all triggers.
   */
  canRunKeywordOptimization(): boolean {
    // D-39-12, D-39-13: Per-workspace throttle, 4 calls/day
    // Uses dedicated keywordOptRunTimestamps array to avoid pollution from regular nocturnal runs (#321)
    const cooldown = checkKeywordOptCooldown(this.stateDir, {
      maxRunsPerWindow: 4,
      quotaWindowMs: 24 * 60 * 60 * 1000,
    });
    return !cooldown.quotaExhausted;
  }

  /**
   * Records that an optimization was performed.
   * Updates lastOptimizedAt for the store. Throttle state is managed
   * by checkCooldown() — no separate throttle file needed (CORR-08).
   */
  recordOptimizationPerformed(): void {
    this.store.lastOptimizedAt = new Date().toISOString();
    this.flush();
    // Record to dedicated keyword opt quota array (does NOT affect regular nocturnal quota)
    recordKeywordOptRun(this.stateDir).catch(err =>
      console.warn(`[CorrectionCueLearner] recordKeywordOptRun failed: ${String(err)}`)
    );
  }

  /**
   * Adds a new keyword to the store and immediately flushes (D-06, D-07).
   * Throws if the 200-term limit would be exceeded.
   */
  add(keyword: Omit<CorrectionKeyword, 'addedAt'>): void {
    if (this.store.keywords.length >= MAX_CORRECTION_KEYWORDS) {
      throw new Error('Correction keyword store limit reached (200 terms)');
    }

    const entry: CorrectionKeyword = {
      ...keyword,
      addedAt: new Date().toISOString(),
    };

    this.store.keywords.push(entry);
    this.flush();
  }

  /**
   * Updates the weight of an existing keyword.
   * Weight is clamped to 0.1-0.9 range.
   * Throws if keyword not found.
   */
  updateWeight(term: string, weight: number): void {
    const keyword = this.store.keywords.find(
      k => k.term.toLowerCase() === term.toLowerCase()
    );
    if (!keyword) {
      throw new Error(`Keyword not found: ${term}`);
    }

    keyword.weight = Math.max(MIN_KEYWORD_WEIGHT, Math.min(MAX_KEYWORD_WEIGHT, weight)); // Clamp to MIN-MAX_KEYWORD_WEIGHT
    const idx = this.store.keywords.findIndex(
      k => k.term.toLowerCase() === term.toLowerCase()
    );
    if (idx >= 0) {
      this.store.keywords[idx] = { ...keyword };
    }
    this.flush();
  }

  /**
   * Removes a keyword from the store by term.
   * Throws if keyword not found.
   */
  remove(term: string): void {
    const idx = this.store.keywords.findIndex(
      k => k.term.toLowerCase() === term.toLowerCase()
    );
    if (idx < 0) {
      throw new Error(`Keyword not found: ${term}`);
    }
    this.store.keywords.splice(idx, 1);
    this.flush();
  }

  /** Returns a reference to the in-memory store. */
  getStore(): CorrectionKeywordStore {
    return this.store;
  }

  /** Returns the lastOptimizedAt timestamp. */
  getLastOptimizedAt(): string {
    return this.store.lastOptimizedAt;
  }

  /** Persists the current in-memory store to disk atomically. */
  flush(): void {
    saveCorrectionKeywordStore(this.stateDir, this.store);
  }

  // ── Singleton factory ───────────────────────────────────────────────────

  /**
   * Returns the shared CorrectionCueLearner instance for a given stateDir.
   * Re-creates the instance if stateDir changes (e.g. workspace switch).
   */
  static get(stateDir: string): CorrectionCueLearner {
    if (!_instance || _lastStateDir !== stateDir) {
      _instance = new CorrectionCueLearner(stateDir);
      _lastStateDir = stateDir;
    }
    return _instance;
  }
}
