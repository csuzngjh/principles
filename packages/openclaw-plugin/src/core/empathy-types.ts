/**
 * Empathy Keyword Matching Types
 * 
 * Types for the dynamic keyword-based empathy detection system.
 * Replaces the previous LLM subagent-per-turn approach with fast keyword
 * matching + periodic subagent optimization of the keyword store.
 */

// =========================================================================
// Keyword Store
// =========================================================================

export interface EmpathyKeywordStore {
  version: number;
  lastUpdated: string;
  lastOptimizedAt: string;
  terms: Record<string, EmpathyKeywordEntry>;
  stats: EmpathyKeywordStats;
}

export interface EmpathyKeywordEntry {
  /** 0-1, contribution to GFI when matched */
  weight: number;
  
  /** How this keyword was discovered */
  source: 'seed' | 'llm_discovered' | 'user_reported';
  
  /** Total times this keyword has matched */
  hitCount: number;
  
  /** Last time this keyword matched */
  lastHitAt?: string;
  
  /** 0-1, false positive rate calculated from subagent validation */
  falsePositiveRate: number;
  
  /** Example contexts where this keyword appeared */
  examples?: string[];
  
  /** When LLM first discovered this keyword */
  discoveredAt?: string;
}

export interface EmpathyKeywordStats {
  totalHits: number;
  totalFalsePositives: number;
  optimizationCount: number;
}

// =========================================================================
// Match Result
// =========================================================================

export interface EmpathyMatchResult {
  /** Whether any keywords matched */
  matched: boolean;
  
  /** Weighted total score (0-1) */
  score: number;
  
  /** List of matched keyword terms */
  matchedTerms: string[];
  
  /** Derived severity level */
  severity: 'mild' | 'moderate' | 'severe';
  
  /** Confidence in the result (0-1) */
  confidence: number;
}

// =========================================================================
// Keyword Update (from subagent optimization)
// =========================================================================

export interface EmpathyKeywordUpdate {
  action: 'add' | 'update' | 'remove';
  weight?: number;
  falsePositiveRate?: number;
  examples?: string[];
  reasoning?: string;
}

export interface EmpathyOptimizationResult {
  updates: Record<string, EmpathyKeywordUpdate>;
  reasoning: string;
  analyzedTurns: number;
  newPatternsDiscovered: number;
}

// =========================================================================
// Seed Keywords (preset list)
// =========================================================================

export interface SeedKeywordEntry {
  term: string;
  weight: number;
  category: 'negation' | 'anger' | 'disappointment' | 'escalation';
  /** Initial false positive rate — higher for generic words, lower for specific anger signals */
  initialFalsePositiveRate?: number;
}

/**
 * Preset seed keywords for empathy detection.
 * These are the initial keywords before the LLM starts discovering new ones.
 */
export const EMPATHY_SEED_KEYWORDS: SeedKeywordEntry[] = [
  // 否定词 (Negation) — generic, higher FPR
  { term: '不对', weight: 0.5, category: 'negation', initialFalsePositiveRate: 0.3 },
  { term: '错了', weight: 0.5, category: 'negation', initialFalsePositiveRate: 0.3 },
  { term: '搞错了', weight: 0.5, category: 'negation', initialFalsePositiveRate: 0.25 },
  { term: '不行', weight: 0.4, category: 'negation', initialFalsePositiveRate: 0.35 },
  { term: '没用', weight: 0.4, category: 'negation', initialFalsePositiveRate: 0.3 },
  { term: '重做', weight: 0.6, category: 'negation', initialFalsePositiveRate: 0.15 },
  { term: '重写', weight: 0.6, category: 'negation', initialFalsePositiveRate: 0.15 },
  { term: 'not right', weight: 0.5, category: 'negation', initialFalsePositiveRate: 0.3 },
  { term: 'wrong', weight: 0.5, category: 'negation', initialFalsePositiveRate: 0.3 },
  { term: 'redo', weight: 0.6, category: 'negation', initialFalsePositiveRate: 0.15 },
  { term: 'start over', weight: 0.6, category: 'negation', initialFalsePositiveRate: 0.15 },

  // 愤怒表达 (Anger) — specific, lower FPR
  { term: '垃圾', weight: 0.9, category: 'anger', initialFalsePositiveRate: 0.05 },
  { term: '蠢', weight: 0.8, category: 'anger', initialFalsePositiveRate: 0.1 },
  { term: '废物', weight: 0.9, category: 'anger', initialFalsePositiveRate: 0.05 },
  { term: '白做', weight: 0.7, category: 'anger', initialFalsePositiveRate: 0.15 },
  { term: '浪费时间', weight: 0.8, category: 'anger', initialFalsePositiveRate: 0.1 },
  { term: 'garbage', weight: 0.9, category: 'anger', initialFalsePositiveRate: 0.05 },
  { term: 'stupid', weight: 0.8, category: 'anger', initialFalsePositiveRate: 0.1 },
  { term: 'useless', weight: 0.7, category: 'anger', initialFalsePositiveRate: 0.15 },
  { term: 'waste of time', weight: 0.8, category: 'anger', initialFalsePositiveRate: 0.1 },

  // 失望信号 (Disappointment) — moderate FPR
  { term: '不行啊', weight: 0.5, category: 'disappointment', initialFalsePositiveRate: 0.25 },
  { term: '还是不对', weight: 0.6, category: 'disappointment', initialFalsePositiveRate: 0.2 },
  { term: '没解决', weight: 0.5, category: 'disappointment', initialFalsePositiveRate: 0.25 },
  { term: '没用上', weight: 0.5, category: 'disappointment', initialFalsePositiveRate: 0.25 },
  { term: '不能用', weight: 0.5, category: 'disappointment', initialFalsePositiveRate: 0.25 },
  { term: 'still not working', weight: 0.6, category: 'disappointment', initialFalsePositiveRate: 0.2 },
  { term: "doesn't help", weight: 0.5, category: 'disappointment', initialFalsePositiveRate: 0.25 },
  { term: 'not useful', weight: 0.5, category: 'disappointment', initialFalsePositiveRate: 0.25 },

  // 升级信号 (Escalation) — specific context, lower FPR
  { term: '你自己看', weight: 0.8, category: 'escalation', initialFalsePositiveRate: 0.1 },
  { term: '你确定吗', weight: 0.7, category: 'escalation', initialFalsePositiveRate: 0.15 },
  { term: '你是不是没理解', weight: 0.8, category: 'escalation', initialFalsePositiveRate: 0.1 },
  { term: '你到底在干什么', weight: 0.9, category: 'escalation', initialFalsePositiveRate: 0.05 },
  { term: 'are you sure', weight: 0.7, category: 'escalation', initialFalsePositiveRate: 0.15 },
  { term: 'did you even read', weight: 0.8, category: 'escalation', initialFalsePositiveRate: 0.1 },
  { term: 'what are you doing', weight: 0.8, category: 'escalation', initialFalsePositiveRate: 0.1 },
];

// =========================================================================
// Configuration
// =========================================================================

export interface EmpathyKeywordConfig {
  /** Minimum score to consider a match (0-1) */
  matchThreshold: number;
  
  /** Maximum number of terms to match per message */
  maxTermsPerMessage: number;
  
  /** How often to trigger subagent optimization (number of turns) */
  optimizationIntervalTurns: number;
  
  /** How often to trigger subagent optimization (time-based, ms) */
  optimizationIntervalMs: number;
  
  /** GFI penalty for mild severity */
  penaltyMild: number;
  
  /** GFI penalty for moderate severity */
  penaltyModerate: number;
  
  /** GFI penalty for severe severity */
  penaltySevere: number;
}

export const DEFAULT_EMPATHY_KEYWORD_CONFIG: EmpathyKeywordConfig = {
  matchThreshold: 0.3,
  maxTermsPerMessage: 5,
  optimizationIntervalTurns: 50,
  optimizationIntervalMs: 6 * 60 * 60 * 1000, // 6 hours
  penaltyMild: 10,
  penaltyModerate: 25,
  penaltySevere: 40,
};

// =========================================================================
// Severity Mapping
// =========================================================================

/**
 * Maps a weighted score to a severity level.
 * 
 * Score ranges:
 * - 0.0 - 0.3: mild (single low-weight keyword)
 * - 0.3 - 0.6: moderate (multiple keywords or high-weight keyword)
 * - 0.6 - 1.0: severe (multiple high-weight keywords)
 */
export function scoreToSeverity(score: number): 'mild' | 'moderate' | 'severe' {
  if (score >= 0.6) return 'severe';
  if (score >= 0.3) return 'moderate';
  return 'mild';
}

/**
 * Maps severity to GFI penalty value.
 */
export function severityToPenalty(
  severity: 'mild' | 'moderate' | 'severe',
  config: EmpathyKeywordConfig = DEFAULT_EMPATHY_KEYWORD_CONFIG
): number {
  switch (severity) {
    case 'mild': return config.penaltyMild;
    case 'moderate': return config.penaltyModerate;
    case 'severe': return config.penaltySevere;
  }
}

/**
 * Normalizes various severity string inputs to the canonical empathy severity type.
 * Handles common aliases: 'high' → 'severe', 'medium' → 'moderate'.
 */
export function normalizeSeverity(input?: string): 'mild' | 'moderate' | 'severe' {
  const normalized = (input || '').toLowerCase().trim();
  if (normalized === 'severe' || normalized === 'high') return 'severe';
  if (normalized === 'moderate' || normalized === 'medium') return 'moderate';
  return 'mild';
}
