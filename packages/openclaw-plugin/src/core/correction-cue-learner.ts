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
import { atomicWriteFileSync } from '../utils/io.js';

const KEYWORD_STORE_FILE = 'correction_keywords.json';

const MIN_KEYWORD_WEIGHT = 0.1;
const MAX_KEYWORD_WEIGHT = 0.9;

let _correctionCueCache: CorrectionKeywordStore | null = null;

export function _resetCorrectionCueCache(): void {
  _correctionCueCache = null;
}

function createDefaultStore(): CorrectionKeywordStore {
  const now = new Date().toISOString();
  const keywords: CorrectionKeyword[] = CORRECTION_SEED_KEYWORDS.map((k) => ({
    ...k,
    source: 'seed' as const,
    addedAt: now,
  }));
  return { keywords, version: 1, lastOptimizedAt: now };
}

export function loadCorrectionKeywordStore(stateDir: string): CorrectionKeywordStore {
  if (_correctionCueCache) return _correctionCueCache;

  const filePath = path.join(stateDir, KEYWORD_STORE_FILE);

  if (fs.existsSync(filePath)) {
    try {
      const raw = fs.readFileSync(filePath, 'utf-8');
      _correctionCueCache = JSON.parse(raw) as CorrectionKeywordStore;
      return _correctionCueCache;
    } catch {
      void 0;
    }
  }

  const defaultStore = createDefaultStore();
  saveCorrectionKeywordStore(stateDir, defaultStore);
  _correctionCueCache = defaultStore;
  return _correctionCueCache;
}

export function saveCorrectionKeywordStore(
  stateDir: string,
  store: CorrectionKeywordStore
): void {
  const filePath = path.join(stateDir, KEYWORD_STORE_FILE);

  fs.mkdirSync(stateDir, { recursive: true });
  atomicWriteFileSync(filePath, JSON.stringify(store, null, 2));

  _correctionCueCache = null;
}

let _instance: CorrectionCueLearner | null = null;
let _lastStateDir: string | null = null;

export function _resetCorrectionCueLearnerInstance(): void {
  _instance = null;
  _lastStateDir = null;
}

export class CorrectionCueLearner {
  private readonly store: CorrectionKeywordStore;
  private readonly stateDir: string;

  constructor(stateDir: string) {
    this.stateDir = stateDir;
    this.store = loadCorrectionKeywordStore(stateDir);
  }

  match(text: string): CorrectionMatchResult {
    const normalized = text
      .trim()
      .toLowerCase()
      .replace(/[.,!?;:，。！？；：]/g, '');

    const matchedTerms: string[] = [];
    let totalScore = 0;

    for (const keyword of this.store.keywords) {
      if (normalized.includes(keyword.term.toLowerCase())) {
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

  recordTruePositive(term: string): void {
    const keyword = this.store.keywords.find(k => k.term.toLowerCase() === term.toLowerCase());
    if (!keyword) return;

    keyword.truePositiveCount = (keyword.truePositiveCount ?? 0) + 1;

    const keywordIndex = this.store.keywords.findIndex(k => k.term.toLowerCase() === term.toLowerCase());
    if (keywordIndex >= 0) {
      this.store.keywords[keywordIndex] = { ...keyword };
    }

    this.flush();
  }

  recordFalsePositive(term: string): void {
    const keyword = this.store.keywords.find(k => k.term.toLowerCase() === term.toLowerCase());
    if (!keyword) return;

    keyword.falsePositiveCount = (keyword.falsePositiveCount ?? 0) + 1;

    keyword.weight = Math.max(MIN_KEYWORD_WEIGHT, keyword.weight * 0.8);
    keyword.lastHitAt = new Date().toISOString();

    const keywordIndex = this.store.keywords.findIndex(k => k.term.toLowerCase() === term.toLowerCase());
    if (keywordIndex >= 0) {
      this.store.keywords[keywordIndex] = { ...keyword };
    }

    this.flush();
  }

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

  updateWeight(term: string, weight: number): void {
    const keyword = this.store.keywords.find(
      k => k.term.toLowerCase() === term.toLowerCase()
    );
    if (!keyword) {
      throw new Error(`Keyword not found: ${term}`);
    }

    keyword.weight = Math.max(MIN_KEYWORD_WEIGHT, Math.min(MAX_KEYWORD_WEIGHT, weight));
    const idx = this.store.keywords.findIndex(
      k => k.term.toLowerCase() === term.toLowerCase()
    );
    if (idx >= 0) {
      this.store.keywords[idx] = { ...keyword };
    }
    this.flush();
  }

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

  getStore(): CorrectionKeywordStore {
    return this.store;
  }

  getLastOptimizedAt(): string {
    return this.store.lastOptimizedAt;
  }

  flush(): void {
    saveCorrectionKeywordStore(this.stateDir, this.store);
  }

  static get(stateDir: string): CorrectionCueLearner {
    if (!_instance || _lastStateDir !== stateDir) {
      _instance = new CorrectionCueLearner(stateDir);
      _lastStateDir = stateDir;
    }
    return _instance;
  }
}
