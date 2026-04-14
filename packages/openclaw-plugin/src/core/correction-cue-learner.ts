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
import { checkCooldown } from '../service/nocturnal-runtime.js';

const KEYWORD_STORE_FILE = 'correction_keywords.json';

// CORR-08: Daily optimization throttle
const THROTTLE_FILE = 'correction_optimization_throttle.json';

interface OptimizationThrottle {
  count: number;
  date: string; // YYYY-MM-DD
}

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
  const tmpPath = filePath + '.tmp';

  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(tmpPath, JSON.stringify(store, null, 2), 'utf-8');
  fs.renameSync(tmpPath, filePath);

  // Invalidate cache so the next read re-loads from disk (D-05)
  _correctionCueCache = null;
}

// =========================================================================
// Throttle helpers (CORR-08)
// =========================================================================

function loadThrottle(stateDir: string): OptimizationThrottle {
  const filePath = path.join(stateDir, THROTTLE_FILE);
  const today = new Date().toISOString().split('T')[0];
  try {
    if (fs.existsSync(filePath)) {
      const raw = fs.readFileSync(filePath, 'utf-8');
      const throttle = JSON.parse(raw) as OptimizationThrottle;
      if (throttle.date === today) {
        return throttle;
      }
    }
  } catch { /* ignore */ }
  return { count: 0, date: today };
}

function recordOptimization(stateDir: string): void {
  const throttle = loadThrottle(stateDir);
  throttle.count++;
  const filePath = path.join(stateDir, THROTTLE_FILE);
  fs.writeFileSync(filePath, JSON.stringify(throttle), 'utf-8');
}

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
   * Normalisation is equivalent to the original detectCorrectionCue():
   *   trim → lowercase → strip punctuation
   * Returns weighted score based on keyword accuracy (D-39-03, D-39-04).
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
        // score = weight x ((TP + 1) / (TP + FP + 2))
        // +2 smoothing: new keywords (TP=0, FP=0) get accuracy=0.5
        const tp = keyword.truePositiveCount ?? 0;
        const fp = keyword.falsePositiveCount ?? 0;
        const accuracy = (tp + 1) / (tp + fp + 2);
        const score = keyword.weight * accuracy;

        totalScore += score;
        matchedTerms.push(keyword.term);

        // Increment hitCount
        keyword.hitCount = (keyword.hitCount ?? 0) + 1;
        keyword.lastHitAt = new Date().toISOString();
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
   * Records a confirmed true positive for the given keyword term.
   * Increments both hitCount and truePositiveCount.
   */
  recordTruePositive(term: string): void {
    const keyword = this.store.keywords.find(k => k.term.toLowerCase() === term.toLowerCase());
    if (!keyword) return;

    keyword.truePositiveCount = (keyword.truePositiveCount ?? 0) + 1;
    keyword.hitCount = (keyword.hitCount ?? 0) + 1;
    keyword.lastHitAt = new Date().toISOString();

    this.flush();
  }

  /**
   * Records a confirmed false positive for the given keyword term.
   * CORR-10: Decreases keyword weight by 20% (x0.8 multiplicative factor).
   */
  recordFalsePositive(term: string): void {
    const keyword = this.store.keywords.find(k => k.term.toLowerCase() === term.toLowerCase());
    if (!keyword) return;

    keyword.falsePositiveCount = (keyword.falsePositiveCount ?? 0) + 1;
    keyword.hitCount = (keyword.hitCount ?? 0) + 1;

    // D-39-15: Multiplicative weight decay x0.8 on confirmed FP
    keyword.weight = Math.max(0.1, keyword.weight * 0.8);
    keyword.lastHitAt = new Date().toISOString();

    this.flush();
  }

  /**
   * Returns true if optimization is allowed (within daily throttle limit).
   * CORR-08: Max 4 optimizations per day across all triggers.
   */
  canRunKeywordOptimization(): boolean {
    // D-39-12, D-39-13: Per-workspace throttle, 4 calls/day
    const cooldown = checkCooldown(this.stateDir, 'keyword_optimization', {
      maxRunsPerWindow: 4,
      quotaWindowMs: 24 * 60 * 60 * 1000,
    });
    return !cooldown.globalCooldownActive && !cooldown.quotaExhausted;
  }

  /**
   * Records that an optimization was performed.
   * Increments the daily throttle counter and updates lastOptimizedAt.
   */
  recordOptimizationPerformed(): void {
    recordOptimization(this.stateDir);
    this.store.lastOptimizedAt = new Date().toISOString();
    this.flush();
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

    keyword.weight = Math.max(0.1, Math.min(0.9, weight)); // Clamp to 0.1-0.9
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
