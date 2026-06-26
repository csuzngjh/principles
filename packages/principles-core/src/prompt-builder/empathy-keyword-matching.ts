import type {
  EmpathyKeywordStore,
  EmpathyKeywordEntry,
  EmpathyKeywordStats,
  EmpathyMatchResult,
  EmpathyKeywordConfig,
} from './empathy-types.js';
import {
  EMPATHY_SEED_KEYWORDS,
  DEFAULT_EMPATHY_KEYWORD_CONFIG,
  scoreToSeverity,
} from './empathy-types.js';

export function createDefaultKeywordStore(language: 'zh' | 'en' = 'zh'): EmpathyKeywordStore {
  const now = new Date().toISOString();
  const terms: Record<string, EmpathyKeywordEntry> = {};

  for (const seed of EMPATHY_SEED_KEYWORDS) {
    const isChinese = /[\u4e00-\u9fa5]/.test(seed.term);
    if (language === 'zh' || !isChinese) {
      terms[seed.term] = {
        weight: seed.weight,
        source: 'seed',
        hitCount: 0,
        falsePositiveRate: seed.initialFalsePositiveRate ?? 0.15,
      };
    }
  }

  const stats: EmpathyKeywordStats = {
    totalHits: 0,
    totalFalsePositives: 0,
    optimizationCount: 0,
  };

  return {
    version: 1,
    lastUpdated: now,
    lastOptimizedAt: now,
    terms,
    stats,
  };
}

export function matchEmpathyKeywords(
  text: string,
  store: EmpathyKeywordStore,
  config: EmpathyKeywordConfig = DEFAULT_EMPATHY_KEYWORD_CONFIG,
): EmpathyMatchResult {
  if (!text || typeof text !== 'string' || text.trim().length === 0) {
    return {
      matched: false,
      score: 0,
      matchedTerms: [],
      severity: 'mild',
      confidence: 0,
    };
  }

  const lowerText = text.toLowerCase();
  let totalScore = 0;
  const matchedTerms: string[] = [];

  for (const [term, entry] of Object.entries(store.terms)) {
    if (lowerText.includes(term.toLowerCase())) {
      const adjustedWeight = entry.weight * (1 - entry.falsePositiveRate);
      totalScore += adjustedWeight;
      matchedTerms.push(term);

      entry.hitCount++;
      entry.lastHitAt = new Date().toISOString();
    }
  }

  const cappedScore = Math.min(1, totalScore);

  const isMatched = cappedScore >= config.matchThreshold && matchedTerms.length > 0;

  const limitedTerms = matchedTerms.slice(0, config.maxTermsPerMessage);

  const termConfidence = Math.min(1, limitedTerms.length / 3);
  const scoreConfidence = Math.min(1, cappedScore / 0.8);
  const confidence = Math.max(termConfidence, scoreConfidence);

  const result: EmpathyMatchResult = {
    matched: isMatched,
    score: cappedScore,
    matchedTerms: limitedTerms,
    severity: scoreToSeverity(cappedScore),
    confidence,
  };

  if (isMatched) {
    store.stats.totalHits += limitedTerms.length;
  }

  return result;
}

export function applyKeywordUpdates(
  store: EmpathyKeywordStore,
  updates: Record<string, {
    action: 'add' | 'update' | 'remove';
    weight?: number;
    falsePositiveRate?: number;
    examples?: string[];
    reasoning?: string;
  }>,
): { added: number; updated: number; removed: number } {
  let added = 0;
  let updated = 0;
  let removed = 0;
  const now = new Date().toISOString();

  for (const [term, update] of Object.entries(updates)) {
    switch (update.action) {
      case 'add':
        if (!Object.hasOwn(store.terms, term)) {
          store.terms[term] = {
            weight: update.weight ?? 0.5,
            source: 'llm_discovered',
            hitCount: 0,
            falsePositiveRate: update.falsePositiveRate ?? 0.2,
            examples: update.examples,
            discoveredAt: now,
          };
          added++;
        }
        break;

      case 'update':
        if (Object.hasOwn(store.terms, term)) {
          const entry = store.terms[term];
          if (!entry) break; // unreachable at runtime, satisfies TS narrowing
          if (update.weight !== undefined) {
            entry.weight = update.weight;
          }
          if (update.falsePositiveRate !== undefined) {
            entry.falsePositiveRate = update.falsePositiveRate;
          }
          if (update.examples) {
            entry.examples = update.examples;
          }
          updated++;
        }
        break;

      case 'remove':
        if (Object.hasOwn(store.terms, term)) {
          delete store.terms[term];
          removed++;
        }
        break;
    }
  }

  store.lastOptimizedAt = now;
  store.stats.optimizationCount++;

  return { added, updated, removed };
}

export function shouldTriggerOptimization(
  store: EmpathyKeywordStore,
  turnsSinceLastOptimization: number,
  config: EmpathyKeywordConfig = DEFAULT_EMPATHY_KEYWORD_CONFIG,
): boolean {
  const turnsExceeded = turnsSinceLastOptimization >= config.optimizationIntervalTurns;

  const lastOpt = new Date(store.lastOptimizedAt).getTime();
  const now = Date.now();
  const timeExceeded = (now - lastOpt) >= config.optimizationIntervalMs;

  return turnsExceeded || timeExceeded;
}

export function getKeywordStoreSummary(store: EmpathyKeywordStore): {
  totalTerms: number;
  seedTerms: number;
  discoveredTerms: number;
  topHitTerms: { term: string; hitCount: number; weight: number }[];
  highFalsePositiveTerms: { term: string; falsePositiveRate: number }[];
} {
  const terms = Object.entries(store.terms);
  const seedTerms = terms.filter(([, e]) => e.source === 'seed');
  const discoveredTerms = terms.filter(([, e]) => e.source === 'llm_discovered');

  const topHitTerms = terms
    .map(([term, entry]) => ({ term, hitCount: entry.hitCount, weight: entry.weight }))
    .sort((a, b) => b.hitCount - a.hitCount)
    .slice(0, 10);

  const highFalsePositiveTerms = terms
    .filter(([, e]) => e.falsePositiveRate > 0.3)
    .map(([term, entry]) => ({ term, falsePositiveRate: entry.falsePositiveRate }))
    .sort((a, b) => b.falsePositiveRate - a.falsePositiveRate);

  return {
    totalTerms: terms.length,
    seedTerms: seedTerms.length,
    discoveredTerms: discoveredTerms.length,
    topHitTerms,
    highFalsePositiveTerms,
  };
}
