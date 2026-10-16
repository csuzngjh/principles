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
 * PRI-2053: bounded convergence rate for a historically oversized store.
 *
 * A store can carry more than MAX_CORRECTION_KEYWORDS terms from an older
 * build. Freeing exactly one slot per ADD then replaced one learned term with
 * another forever — the count never moved (372 → 372). Clearing the whole
 * backlog in one shot would instead bulk-delete learned evidence on no
 * per-term grounds. So every successful ADD beyond the cap additionally evicts
 * up to this many least-valuable `llm` terms, each through the same tier-ranked
 * ordering and audit path as the normal single eviction. seed/user terms never
 * participate, and a store with no evictable term still refuses to grow.
 */
const MAX_EVICTIONS_PER_ADD = 5;

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
 * this module but read back as untrusted JSON, and its weight/TP/FP values gate
 * the earned-high precision path in host-runtime, so decision-bearing fields
 * are validated per row — the same contract as governance-signal-admission's
 * reader, not a weaker second schema beside it (EP-07).
 */
function parseStoredKeywordStore(input: unknown): CorrectionKeywordStore | null {
  if (typeof input !== 'object' || input === null) return null;
  const { keywords: rawKeywords, version, lastOptimizedAt } = input as {
    keywords?: unknown;
    version?: unknown;
    lastOptimizedAt?: unknown;
  };
  if (!Array.isArray(rawKeywords)) return null;

  const keywords: CorrectionKeyword[] = [];
  const dropped: string[] = [];
  for (const raw of rawKeywords) {
    const keyword = normalizeStoredKeyword(raw);
    if (keyword) {
      keywords.push(keyword);
    } else {
      dropped.push(previewRow(raw));
    }
  }
  if (dropped.length > 0) {
    // A row that fails the guard is already inert to detection — host-runtime
    // refuses the same fields on its read — so dropping it aligns the two
    // readers instead of discarding usable data. Names stay in the log because
    // this is the only trace of what the store no longer holds.
    console.warn(
      `[PD:CorrectionCue] ${KEYWORD_STORE_FILE}: ${dropped.length} unusable keyword row(s) ignored: ${dropped.slice(0, 3).join(' | ')}`,
    );
  }
  // version/lastOptimizedAt are bookkeeping, not decisions: rejecting a store
  // for a missing one would reset learned terms, so tolerate and re-stamp.
  return {
    keywords,
    version:
      typeof version === 'number' && Number.isSafeInteger(version) && version >= 0 ? version : 1,
    lastOptimizedAt:
      typeof lastOptimizedAt === 'string' ? lastOptimizedAt : new Date().toISOString(),
  };
}

/**
 * Validate the decision-bearing fields and rebuild the row (unknown extras are
 * dropped). Lenient where nothing reads the field: a missing addedAt becomes ''
 * (it only breaks an eviction tie-break) rather than costing a whole term.
 */
function normalizeStoredKeyword(raw: unknown): CorrectionKeyword | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const { term, weight, source, addedAt, truePositiveCount, falsePositiveCount, hitCount, lastHitAt } =
    raw as {
      term?: unknown;
      weight?: unknown;
      source?: unknown;
      addedAt?: unknown;
      truePositiveCount?: unknown;
      falsePositiveCount?: unknown;
      hitCount?: unknown;
      lastHitAt?: unknown;
    };
  if (typeof term !== 'string' || term.trim() === '') return null;
  // weight feeds precisionFor(): an out-of-range value would hand a term the
  // high-certainty path, so the bound is part of the contract, not presentation.
  if (typeof weight !== 'number' || !Number.isFinite(weight) || weight < 0 || weight > 1) return null;
  if (source !== 'seed' && source !== 'llm' && source !== 'user') return null;
  // Earned precision counts gate host-runtime's high-certainty path: a corrupt
  // 3.1 or a negative must not be trusted (same stance as its strict reader).
  const isCount = (value: unknown): boolean =>
    value === undefined ||
    (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0);
  if (!isCount(truePositiveCount) || !isCount(falsePositiveCount)) return null;

  const keyword: CorrectionKeyword = {
    term,
    weight,
    source,
    addedAt: typeof addedAt === 'string' ? addedAt : '',
  };
  if (typeof hitCount === 'number') keyword.hitCount = hitCount;
  if (typeof truePositiveCount === 'number') keyword.truePositiveCount = truePositiveCount;
  if (typeof falsePositiveCount === 'number') keyword.falsePositiveCount = falsePositiveCount;
  if (typeof lastHitAt === 'string') keyword.lastHitAt = lastHitAt;
  return keyword;
}

/** Bounded, safe one-line identity for a rejected row (rc-8). */
function previewRow(raw: unknown): string {
  if (typeof raw !== 'object' || raw === null) return `<${typeof raw}>`;
  const { term } = raw as { term?: unknown };
  const label = typeof term === 'string' ? term.slice(0, 40) : `<${typeof term}>`;
  return `"${label}"`;
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
   * At/over the cap the least valuable `llm` terms leave first (see
   * evictionTier), because throwing instead froze the learning channel
   * permanently once the store filled up. The store may already be OVERSIZED
   * from an older build; in that case each ADD also evicts up to
   * MAX_EVICTIONS_PER_ADD terms, so the count converges downwards instead of
   * being replaced one-for-one forever.
   *
   * @returns the evicted terms (empty when the store had room).
   * @throws only when the store is at/over the cap and holds no evictable term
   *         at all (every entry is Owner-authored seed/user), i.e. a cap the
   *         system is not allowed to resolve on its own.
   */
  add(keyword: Omit<CorrectionKeyword, 'addedAt'>): string[] {
    const evicted: string[] = [];
    const over = this.store.keywords.length - MAX_CORRECTION_KEYWORDS;
    if (over >= 0) {
      // over = 0 (exactly at cap) → free exactly one slot: the historical
      // behaviour. over > 0 → also take a bounded convergence step.
      const budget = Math.min(over + 1, MAX_EVICTIONS_PER_ADD);
      evicted.push(...this.evictLeastValuable(budget));
      if (evicted.length === 0) {
        throw new Error(
          `Correction keyword store limit reached (${MAX_CORRECTION_KEYWORDS} terms) and no learned term is evictable`,
        );
      }
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
   *
   * @param count maximum number of terms to evict (bounded by the caller).
   * @returns evicted terms in eviction order (fewer than `count` when the store
   *          holds fewer learned terms).
   */
  private evictLeastValuable(count: number): string[] {
    const evicted: string[] = [];
    for (let i = 0; i < count; i++) {
      const candidates: Array<{ keyword: CorrectionKeyword; index: number }> = [];
      this.store.keywords.forEach((keyword, index) => {
        if (keyword.source === 'llm') candidates.push({ keyword, index });
      });
      if (candidates.length === 0) break;
      candidates.sort((a, b) =>
        evictionTier(a.keyword) - evictionTier(b.keyword)
        || a.keyword.weight - b.keyword.weight
        || a.keyword.addedAt.localeCompare(b.keyword.addedAt),
      );

      const loser = candidates[0];
      if (!loser) break;
      this.store.keywords.splice(loser.index, 1);
      evicted.push(loser.keyword.term);
    }
    return evicted;
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

  /**
   * The store's only durable write: an atomic temp-file-then-rename of
   * correction_keywords.json (T-38-02). A successful flush — not a SYSTEM log
   * line — is what makes a mutation real; the audit trail emitted by
   * KeywordOptimizationService is best-effort and may be missing.
   */
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
