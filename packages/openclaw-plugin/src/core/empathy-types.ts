export type {
  EmpathyKeywordStore,
  EmpathyKeywordEntry,
  EmpathyKeywordStats,
  EmpathyMatchResult,
  EmpathyKeywordUpdate,
  EmpathyOptimizationResult,
  SeedKeywordEntry,
  EmpathyKeywordConfig,
} from '@principles/core/prompt-builder';

export {
  EMPATHY_SEED_KEYWORDS,
  DEFAULT_EMPATHY_KEYWORD_CONFIG,
  scoreToSeverity,
  severityToPenalty,
  normalizeSeverity,
} from '@principles/core/prompt-builder';
