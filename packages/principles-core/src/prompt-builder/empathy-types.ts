export interface EmpathyKeywordStore {
  version: number;
  lastUpdated: string;
  lastOptimizedAt: string;
  terms: Record<string, EmpathyKeywordEntry>;
  stats: EmpathyKeywordStats;
}

export interface EmpathyKeywordEntry {
  weight: number;
  source: 'seed' | 'llm_discovered' | 'user_reported';
  hitCount: number;
  lastHitAt?: string;
  falsePositiveRate: number;
  examples?: string[];
  discoveredAt?: string;
}

export interface EmpathyKeywordStats {
  totalHits: number;
  totalFalsePositives: number;
  optimizationCount: number;
}

export interface EmpathyMatchResult {
  matched: boolean;
  score: number;
  matchedTerms: string[];
  severity: 'mild' | 'moderate' | 'severe';
  confidence: number;
}

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

export interface SeedKeywordEntry {
  term: string;
  weight: number;
  category: 'negation' | 'anger' | 'disappointment' | 'escalation';
  initialFalsePositiveRate?: number;
}

export const EMPATHY_SEED_KEYWORDS: SeedKeywordEntry[] = [
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

  { term: '垃圾', weight: 0.9, category: 'anger', initialFalsePositiveRate: 0.05 },
  { term: '蠢', weight: 0.8, category: 'anger', initialFalsePositiveRate: 0.1 },
  { term: '废物', weight: 0.9, category: 'anger', initialFalsePositiveRate: 0.05 },
  { term: '白做', weight: 0.7, category: 'anger', initialFalsePositiveRate: 0.15 },
  { term: '浪费时间', weight: 0.8, category: 'anger', initialFalsePositiveRate: 0.1 },
  { term: 'garbage', weight: 0.9, category: 'anger', initialFalsePositiveRate: 0.05 },
  { term: 'stupid', weight: 0.8, category: 'anger', initialFalsePositiveRate: 0.1 },
  { term: 'useless', weight: 0.7, category: 'anger', initialFalsePositiveRate: 0.15 },
  { term: 'waste of time', weight: 0.8, category: 'anger', initialFalsePositiveRate: 0.1 },

  { term: '不行啊', weight: 0.5, category: 'disappointment', initialFalsePositiveRate: 0.25 },
  { term: '还是不对', weight: 0.6, category: 'disappointment', initialFalsePositiveRate: 0.2 },
  { term: '没解决', weight: 0.5, category: 'disappointment', initialFalsePositiveRate: 0.25 },
  { term: '没用上', weight: 0.5, category: 'disappointment', initialFalsePositiveRate: 0.25 },
  { term: '不能用', weight: 0.5, category: 'disappointment', initialFalsePositiveRate: 0.25 },
  { term: 'still not working', weight: 0.6, category: 'disappointment', initialFalsePositiveRate: 0.2 },
  { term: "doesn't help", weight: 0.5, category: 'disappointment', initialFalsePositiveRate: 0.25 },
  { term: 'not useful', weight: 0.5, category: 'disappointment', initialFalsePositiveRate: 0.25 },

  { term: '你自己看', weight: 0.8, category: 'escalation', initialFalsePositiveRate: 0.1 },
  { term: '你确定吗', weight: 0.7, category: 'escalation', initialFalsePositiveRate: 0.15 },
  { term: '你是不是没理解', weight: 0.8, category: 'escalation', initialFalsePositiveRate: 0.1 },
  { term: '你到底在干什么', weight: 0.9, category: 'escalation', initialFalsePositiveRate: 0.05 },
  { term: 'are you sure', weight: 0.7, category: 'escalation', initialFalsePositiveRate: 0.15 },
  { term: 'did you even read', weight: 0.8, category: 'escalation', initialFalsePositiveRate: 0.1 },
  { term: 'what are you doing', weight: 0.8, category: 'escalation', initialFalsePositiveRate: 0.1 },

  // Soft frustration (PRI-274: previously missed by keyword matcher)
  { term: '怎么又', weight: 0.5, category: 'disappointment', initialFalsePositiveRate: 0.25 },
  { term: '算了', weight: 0.5, category: 'disappointment', initialFalsePositiveRate: 0.3 },
  { term: '说了N次', weight: 0.6, category: 'disappointment', initialFalsePositiveRate: 0.2 },
  { term: '说了好几次', weight: 0.6, category: 'disappointment', initialFalsePositiveRate: 0.2 },
  { term: '每次都这样', weight: 0.6, category: 'disappointment', initialFalsePositiveRate: 0.2 },
  { term: '每次这样', weight: 0.6, category: 'disappointment', initialFalsePositiveRate: 0.2 },
  { term: '我再试试', weight: 0.5, category: 'disappointment', initialFalsePositiveRate: 0.25 },
  { term: '我自己来', weight: 0.5, category: 'disappointment', initialFalsePositiveRate: 0.3 },
  { term: '不是这个意思', weight: 0.6, category: 'negation', initialFalsePositiveRate: 0.2 },
  { term: '不是让你', weight: 0.6, category: 'negation', initialFalsePositiveRate: 0.2 },
  { term: 'again?', weight: 0.5, category: 'disappointment', initialFalsePositiveRate: 0.25 },
  { term: 'never mind', weight: 0.5, category: 'disappointment', initialFalsePositiveRate: 0.3 },
  { term: 'told you', weight: 0.6, category: 'disappointment', initialFalsePositiveRate: 0.2 },
  { term: 'every time', weight: 0.5, category: 'disappointment', initialFalsePositiveRate: 0.25 },
  { term: "i'll do it myself", weight: 0.6, category: 'disappointment', initialFalsePositiveRate: 0.2 },
  { term: "that's not what i meant", weight: 0.6, category: 'negation', initialFalsePositiveRate: 0.2 },
  { term: "i didn't ask you to", weight: 0.6, category: 'negation', initialFalsePositiveRate: 0.2 },
];

export interface EmpathyKeywordConfig {
  matchThreshold: number;
  maxTermsPerMessage: number;
  optimizationIntervalTurns: number;
  optimizationIntervalMs: number;
  penaltyMild: number;
  penaltyModerate: number;
  penaltySevere: number;
}

export const DEFAULT_EMPATHY_KEYWORD_CONFIG: EmpathyKeywordConfig = {
  matchThreshold: 0.3,
  maxTermsPerMessage: 5,
  optimizationIntervalTurns: 50,
  optimizationIntervalMs: 6 * 60 * 60 * 1000,
  penaltyMild: 10,
  penaltyModerate: 25,
  penaltySevere: 40,
};

export function scoreToSeverity(score: number): 'mild' | 'moderate' | 'severe' {
  if (score >= 0.6) return 'severe';
  if (score >= 0.3) return 'moderate';
  return 'mild';
}

export function severityToPenalty(
  severity: 'mild' | 'moderate' | 'severe',
  config: EmpathyKeywordConfig = DEFAULT_EMPATHY_KEYWORD_CONFIG
): number {
  switch (severity) {
    case 'mild': return config.penaltyMild;
    case 'moderate': return config.penaltyModerate;
    case 'severe': return config.penaltySevere;
    default: return config.penaltyMild;
  }
}

export function normalizeSeverity(input?: string): 'mild' | 'moderate' | 'severe' {
  const normalized = (input || '').toLowerCase();
  if (normalized === 'severe' || normalized === 'high') return 'severe';
  if (normalized === 'moderate' || normalized === 'medium') return 'moderate';
  return 'mild';
}
