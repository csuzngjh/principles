/**
 * Correction Cue Learner
 *
 * Persistent, learnable keyword store for correction cue detection.
 * Replaces the hardcoded cue list in detectCorrectionCue() with a
 * crash-safe JSON store that can grow over time.
 *
 * Persistence contract:
 *   - Atomic write: temp-file-then-rename (T-38-02)
 *   - Cache invalidated after every write (D-05), keyed by stateDir (EP-07)
 *   - MAX_CORRECTION_KEYWORDS is a budget, not a freeze: at the cap the least
 *     valuable llm-learned term is evicted so learning never stops (T-38-01).
 *     seed/user terms are never evicted — they are Owner-authored authority.
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

/**
 * EP-07 / ERR-092: the store is per-stateDir, so the cache is a Map keyed by
 * the resolved directory. A single-valued slot made one workspace's store
 * flush into another workspace's file.
 */
const _correctionCueCache = new Map<string, CorrectionKeywordStore>();

function cacheKey(stateDir: string): string {
  return path.resolve(stateDir);
}

export function _resetCorrectionCueCache(): void {
  _correctionCueCache.clear();
}

/**
 * The one term-identity rule for this store. Detection compares lowercased
 * substrings, so a learned term is the same term when it matches after
 * trim + lowercase — writers and readers must not disagree (the observer
 * echoes LLM text with surrounding whitespace).
 */
function normalizeTerm(term: string): string {
  return term.trim().toLowerCase();
}

function indexOfTerm(keywords: CorrectionKeyword[], term: string): number {
  const needle = normalizeTerm(term);
  return keywords.findIndex((k) => normalizeTerm(k.term) === needle);
}

/** Lower tier = evicted first. See CorrectionCueLearner.evictLeastValuable(). */
function evictionTier(keyword: CorrectionKeyword): number {
  const tp = keyword.truePositiveCount ?? 0;
  const fp = keyword.falsePositiveCount ?? 0;
  if (tp > 0) return 2;
  if (fp > 0) return 0;
  return 1;
}

/**
 * Read-side guard for the persisted store (rc-1/rc-2). The file is written by
 * this module but read back as untrusted JSON, and its TP/FP counts gate the
 * earned-high precision path in host-runtime, so decision-bearing fields are
 * validated per row — the same contract as governance-signal-admission's
 * reader, not a weaker second schema beside it (EP-07).
 */
function parseStoredKeywordStore(input: unknown): CorrectionKeywordStore | null {
  if (typeof input !== 'object' || input === null) return null;
  const record = input as Record<string, unknown>;
  const rawKeywords: unknown = record.keywords;
  if (!Array.isArray(rawKeywords)) return null;

  const keywords: CorrectionKeyword[] = [];
  let dropped = 0;
  for (const raw of rawKeywords) {
    if (!isStoredKeyword(raw)) {
      dropped += 1;
      continue;
    }
    keywords.push(raw);
  }
  if (dropped > 0) {
    console.warn(
      `[PD:CorrectionCue] ${KEYWORD_STORE_FILE}: ${dropped} malformed keyword row(s) ignored`,
    );
  }
  // version/lastOptimizedAt are bookkeeping, not decisions: rejecting a store
  // for a missing one would reset learned terms, so tolerate and re-stamp.
  const version =
    typeof record.version === 'number' && Number.isSafeInteger(record.version) && record.version >= 0
      ? record.version
      : 1;
  const lastOptimizedAt =
    typeof record.lastOptimizedAt === 'string' ? record.lastOptimizedAt : new Date().toISOString();
  return { keywords, version, lastOptimizedAt };
}

function isStoredKeyword(raw: unknown): raw is CorrectionKeyword {
  if (typeof raw !== 'object' || raw === null) return false;
  const k = raw as Record<string, unknown>;
  if (typeof k.term !== 'string' || k.term.trim() === '') return false;
  if (typeof k.weight !== 'number' || !Number.isFinite(k.weight)) return false;
  if (k.source !== 'seed' && k.source !== 'llm' && k.source !== 'user') return false;
  if (typeof k.addedAt !== 'string') return false;
  const isCount = (value: unknown): boolean =>
    value === undefined ||
    (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0);
  return isCount(k.truePositiveCount) && isCount(k.falsePositiveCount);
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
  const key = cacheKey(stateDir);
  const cached = _correctionCueCache.get(key);
  if (cached) return cached;

  const filePath = path.join(stateDir, KEYWORD_STORE_FILE);

  if (fs.existsSync(filePath)) {
    try {
      const raw = fs.readFileSync(filePath, 'utf-8');
      const loaded = parseStoredKeywordStore(JSON.parse(raw));
      if (loaded) {
        _correctionCueCache.set(key, loaded);
        return loaded;
      }
      console.warn(
        `[PD:CorrectionCue] ${KEYWORD_STORE_FILE} is not a valid store; replacing it with the seed store`,
      );
    } catch (err) {
      console.warn(
        `[PD:CorrectionCue] cannot parse ${KEYWORD_STORE_FILE} (${String(err)}); replacing it with the seed store`,
      );
    }
  }

  const defaultStore = createDefaultStore();
  saveCorrectionKeywordStore(stateDir, defaultStore);
  _correctionCueCache.set(key, defaultStore);
  return defaultStore;
}

export function saveCorrectionKeywordStore(
  stateDir: string,
  store: CorrectionKeywordStore
): void {
  const filePath = path.join(stateDir, KEYWORD_STORE_FILE);

  fs.mkdirSync(stateDir, { recursive: true });
  atomicWriteFileSync(filePath, JSON.stringify(store, null, 2));

  _correctionCueCache.delete(cacheKey(stateDir));
}

// EP-07: keyed by stateDir like the store cache — one process hosts several
// workspaces (getSignalCollectorHost does the same for its hosts).
const _instances = new Map<string, CorrectionCueLearner>();

export function _resetCorrectionCueLearnerInstance(): void {
  _instances.clear();
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

  recordTruePositive(term: string): boolean {
    const idx = indexOfTerm(this.store.keywords, term);
    const keyword = idx < 0 ? undefined : this.store.keywords[idx];
    if (!keyword) return false;

    this.store.keywords[idx] = {
      ...keyword,
      truePositiveCount: (keyword.truePositiveCount ?? 0) + 1,
    };
    this.flush();
    return true;
  }

  recordFalsePositive(term: string): boolean {
    const idx = indexOfTerm(this.store.keywords, term);
    const keyword = idx < 0 ? undefined : this.store.keywords[idx];
    if (!keyword) return false;

    this.store.keywords[idx] = {
      ...keyword,
      falsePositiveCount: (keyword.falsePositiveCount ?? 0) + 1,
      weight: Math.max(MIN_KEYWORD_WEIGHT, keyword.weight * 0.8),
      lastHitAt: new Date().toISOString(),
    };
    this.flush();
    return true;
  }

  /**
   * Insert a term, keeping the store inside MAX_CORRECTION_KEYWORDS.
   *
   * At the cap the least valuable `llm` term leaves first (see
   * evictionTier), because throwing instead froze the learning channel
   * permanently once the store filled up.
   *
   * @returns the evicted term, or null when nothing had to be evicted.
   * @throws only when the store is full and holds no evictable term at all
   *         (every entry is Owner-authored seed/user), i.e. a cap the system
   *         is not allowed to resolve on its own.
   */
  add(keyword: Omit<CorrectionKeyword, 'addedAt'>): string | null {
    const evicted = this.store.keywords.length >= MAX_CORRECTION_KEYWORDS
      ? this.evictLeastValuable()
      : null;

    if (evicted === null && this.store.keywords.length >= MAX_CORRECTION_KEYWORDS) {
      throw new Error(
        `Correction keyword store limit reached (${MAX_CORRECTION_KEYWORDS} terms) and no learned term is evictable`,
      );
    }

    const entry: CorrectionKeyword = {
      ...keyword,
      addedAt: new Date().toISOString(),
    };

    this.store.keywords.push(entry);
    this.flush();
    return evicted;
  }

  /**
   * Rank learned terms by what the store itself proves about them, worst first:
   * proven noise (FP without any TP) leaves before never-confirmed terms, which
   * leave before confirmed-useful ones. Within a tier, low weight then old
   * addition loses. seed/user entries are Owner authority and never compete.
   */
  private evictLeastValuable(): string | null {
    const candidates: Array<{ keyword: CorrectionKeyword; index: number }> = [];
    this.store.keywords.forEach((keyword, index) => {
      if (keyword.source === 'llm') candidates.push({ keyword, index });
    });
    if (candidates.length === 0) return null;
    candidates.sort((a, b) =>
      evictionTier(a.keyword) - evictionTier(b.keyword)
      || a.keyword.weight - b.keyword.weight
      || a.keyword.addedAt.localeCompare(b.keyword.addedAt),
    );

    const loser = candidates[0];
    if (!loser) return null;
    this.store.keywords.splice(loser.index, 1);
    return loser.keyword.term;
  }

  /** @returns false when the term is not in the store (caller logs the skip). */
  updateWeight(term: string, weight: number): boolean {
    const idx = indexOfTerm(this.store.keywords, term);
    const keyword = idx < 0 ? undefined : this.store.keywords[idx];
    if (!keyword) return false;

    this.store.keywords[idx] = {
      ...keyword,
      weight: Math.max(MIN_KEYWORD_WEIGHT, Math.min(MAX_KEYWORD_WEIGHT, weight)),
    };
    this.flush();
    return true;
  }

  /** @returns false when the term is not in the store (caller logs the skip). */
  remove(term: string): boolean {
    const idx = indexOfTerm(this.store.keywords, term);
    if (idx < 0) return false;

    this.store.keywords.splice(idx, 1);
    this.flush();
    return true;
  }

  /** Look a term up with the store's own identity rule (trim + lowercase). */
  find(term: string): CorrectionKeyword | undefined {
    const idx = indexOfTerm(this.store.keywords, term);
    return idx < 0 ? undefined : this.store.keywords[idx];
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
    const key = cacheKey(stateDir);
    let instance = _instances.get(key);
    if (!instance) {
      instance = new CorrectionCueLearner(stateDir);
      _instances.set(key, instance);
    }
    return instance;
  }
}
