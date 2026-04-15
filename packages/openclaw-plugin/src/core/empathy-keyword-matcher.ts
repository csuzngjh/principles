/**
 * Empathy Keyword Matcher
 * 
 * Fast keyword-based empathy detection that replaces the previous
 * LLM subagent-per-turn approach.
 * 
 * Flow:
 *   User message → keyword matching → weighted score → GFI penalty
 * 
 * The keyword store is periodically optimized by a subagent that analyzes
 * recent conversations and updates keyword weights, discovers new terms,
 * and removes false positives.
 */

import * as fs from 'fs';
import * as path from 'path';
import { atomicWriteFileSync } from '../utils/io.js';
import type {
  EmpathyKeywordStore,
  EmpathyKeywordEntry,
  EmpathyKeywordStats,
  EmpathyMatchResult,
  EmpathyKeywordConfig} from './empathy-types.js';
import {
  EMPATHY_SEED_KEYWORDS,
  DEFAULT_EMPATHY_KEYWORD_CONFIG,
  scoreToSeverity,
} from './empathy-types.js';

const KEYWORD_STORE_FILE = 'empathy_keywords.json';

// =========================================================================
// Store Management
// =========================================================================

/**
 * Creates a default keyword store from seed keywords.
 * Supports both Chinese and English keywords.
 */
export function createDefaultKeywordStore(language: 'zh' | 'en' = 'zh'): EmpathyKeywordStore {
  const now = new Date().toISOString();
  const terms: Record<string, EmpathyKeywordEntry> = {};

  // Include all seed keywords (both zh and en)
  for (const seed of EMPATHY_SEED_KEYWORDS) {
    // For Chinese language, include all keywords
    // For English language, include only English keywords
    const isChinese = /[\u4e00-\u9fa5]/.test(seed.term);
    if (language === 'zh' || !isChinese) {
      terms[seed.term] = {
        weight: seed.weight,
        source: 'seed',
        hitCount: 0,
        falsePositiveRate: seed.initialFalsePositiveRate ?? 0.15, // Differentiated FPR (Finding #6)
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

/**
 * Loads the keyword store from disk, or creates a default one if not found.
 * Respects the configured language setting.
 */
export function loadKeywordStore(stateDir: string, language?: 'zh' | 'en'): EmpathyKeywordStore {
  const filePath = path.join(stateDir, KEYWORD_STORE_FILE);
  
  try {
    if (!fs.existsSync(filePath)) {
      const store = createDefaultKeywordStore(language);
       
       
      saveKeywordStore(stateDir, store);
      return store;
    }

    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    
    // Validate structure
    if (!parsed.terms || !parsed.stats || !parsed.version) {
      console.warn('[PD:Empathy] Invalid keyword store format, creating default');
      const store = createDefaultKeywordStore(language);
       
       
      saveKeywordStore(stateDir, store);
      return store;
    }

    return parsed as EmpathyKeywordStore;
  } catch (e) {
    console.warn(`[PD:Empathy] Failed to load keyword store: ${e}`);
    const store = createDefaultKeywordStore(language);
     
     
    saveKeywordStore(stateDir, store);
    return store;
  }
}

/**
 * Saves the keyword store to disk.
 */
 
export function saveKeywordStore(stateDir: string, store: EmpathyKeywordStore): void {
  const filePath = path.join(stateDir, KEYWORD_STORE_FILE);
  const dir = path.dirname(filePath);
  
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  store.lastUpdated = new Date().toISOString();
  atomicWriteFileSync(filePath, JSON.stringify(store, null, 2));
}

// =========================================================================
// Keyword Matching
// =========================================================================

/**
 * Matches text against the keyword store and returns a structured result.
 * 
 * This is the core function that replaces the previous LLM-based empathy detection.
 * It runs in < 1ms for typical keyword stores (50-200 terms).
 */
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
      // Weight adjusted by false positive rate
      const adjustedWeight = entry.weight * (1 - entry.falsePositiveRate);
      totalScore += adjustedWeight;
      matchedTerms.push(term);

      // Update hit stats
      entry.hitCount++;
      entry.lastHitAt = new Date().toISOString();
    }
  }

  // Cap score at 1.0
  const cappedScore = Math.min(1, totalScore);

  // Only consider matched if score exceeds threshold
  const isMatched = cappedScore >= config.matchThreshold && matchedTerms.length > 0;

  // Limit matched terms for performance
  const limitedTerms = matchedTerms.slice(0, config.maxTermsPerMessage);

  // Calculate confidence based on:
  // - Number of matched terms (more terms = higher confidence)
  // - Score relative to threshold (higher score = higher confidence)
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

  // Update store stats
  if (isMatched) {
    store.stats.totalHits += limitedTerms.length;
  }

  return result;
}

// =========================================================================
// Keyword Store Updates
// =========================================================================

/**
 * Applies keyword updates from subagent optimization.
 * 
 * This is called when the empathy optimizer subagent completes its analysis
 * and returns suggested updates to the keyword store.
 */
     
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
        if (!store.terms[term]) {
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
        if (store.terms[term]) {
          if (update.weight !== undefined) {
            store.terms[term].weight = update.weight;
          }
          if (update.falsePositiveRate !== undefined) {
            store.terms[term].falsePositiveRate = update.falsePositiveRate;
          }
          if (update.examples) {
            store.terms[term].examples = update.examples;
          }
          updated++;
        }
        break;

      case 'remove':
        if (store.terms[term]) {
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

// =========================================================================
// Optimization Trigger
// =========================================================================

/**
 * Checks if it's time to trigger subagent optimization.
 * 
 * Returns true if either:
 * - The number of turns since last optimization exceeds the interval
 * - The time since last optimization exceeds the interval
 */
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

// =========================================================================
// Store Inspection
// =========================================================================

/**
 * Returns a summary of the keyword store for debugging/monitoring.
 */
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
