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
import {
  CorrectionKeyword,
  CorrectionKeywordStore,
  CorrectionMatchResult,
  CORRECTION_SEED_KEYWORDS,
  MAX_CORRECTION_KEYWORDS,
} from './correction-types.js';

const KEYWORD_STORE_FILE = 'correction_keywords.json';

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
  private store: CorrectionKeywordStore;
  private stateDir: string;

  constructor(stateDir: string) {
    this.stateDir = stateDir;
    this.store = loadCorrectionKeywordStore(stateDir);
  }

  // ── Public API ──────────────────────────────────────────────────────────

  /**
   * Checks whether text contains a correction cue (D-11).
   * Normalisation is equivalent to the original detectCorrectionCue():
   *   trim → lowercase → strip punctuation
   * Returns the first matched term only (first-match semantics).
   */
  match(text: string): CorrectionMatchResult {
    const normalized = text
      .trim()
      .toLowerCase()
      .replace(/[.,!?;:，。！？；：]/g, '');

    for (const keyword of this.store.keywords) {
      if (normalized.includes(keyword.term.toLowerCase())) {
        return { matched: true, matchedTerms: [keyword.term], score: keyword.weight, confidence: 0.9 };
      }
    }

    return { matched: false, matchedTerms: [], score: 0.0, confidence: 0.0 };
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

  /** Returns a reference to the in-memory store. */
  getStore(): CorrectionKeywordStore {
    return this.store;
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
