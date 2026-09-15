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
} from './correction-types.js';
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

  // PRI-812: CorrectionCueLearner.match() 与 recordHits() 已删除。
  // match() 是 canonical detector（createSharedCorrectionKeywordStore →
  // collectSync）之外的幽灵第二检测算法，生产调用者为 0；recordHits() 同样
  // 无生产调用者，其维护的 hitCount 在观测面结构性恒 0。检测权威与 TP/FP
  // 反馈（recordTruePositive / recordFalsePositive）保持不变。

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
