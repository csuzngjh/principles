/**
 * @principles/core/quality-scorecard — Pure logic barrel export
 *
 * ZERO I/O. Re-exports types, validation, and report generation.
 */
export type {
  RubricDimension,
  RubricScore,
  RubricEntry,
  PainEpisode,
  LocalEvaluation,
  AdjudicationStatus,
  StrongModelAdjudication,
  EpisodeEvaluation,
  QualityScorecardReport,
  ScorecardOptions,
} from './types.js';

export {
  RUBRIC_DIMENSIONS,
  RUBRIC_LABELS,
  RUBRIC_DESCRIPTIONS,
  RUBRIC_PROMPTS,
  sumScores,
  meetsMvpThreshold,
} from './types.js';

export {
  escapeHtml,
  escapeMarkdownTable,
  isValidRubricScore,
  parseRubricScore,
  validateDimensionScores,
  validateLlmScoreResponse,
  validateAdjudicationResponse,
  validatePainRow,
  validateEvolutionRow,
  validatePrincipleEventRow,
  validateCliOptions,
  extractJsonFromLlmResponse,
  sanitize,
  truncate,
  needsAdjudication,
  determineFinalLabel,
} from './validation.js';

export type {
  ValidatedLlmScores,
  ValidatedPainRow,
  ValidatedEvolutionRow,
  ValidatedPrincipleEventRow,
  ValidationError,
  AdjudicationDecision,
} from './validation.js';

export {
  generateMarkdownReport,
  generateHtmlReport,
  generateJsonReport,
} from './report-generator.js';
