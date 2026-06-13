/**
 * PRI-361 Quality Scorecard — Pure Type Definitions & Rubric
 *
 * This module is PURE LOGIC — zero I/O dependencies.
 * No fs, path, fetch, database, process.env, or network access.
 */

// ── Rubric Dimensions ──────────────────────────────────────────────

export const RUBRIC_DIMENSIONS = [
  'G1', 'G2', 'G3', 'G4', 'G5', 'G6', 'G7',
] as const;
export type RubricDimension = (typeof RUBRIC_DIMENSIONS)[number];

/** 0 = fail, 1 = partial, 2 = pass */
export type RubricScore = 0 | 1 | 2;

export interface RubricEntry {
  dimension: RubricDimension;
  score: RubricScore;
  rationale: string;
}

export const RUBRIC_LABELS: Record<RubricDimension, string> = {
  G1: 'Evidence Grounding',
  G2: 'Behavior-Oriented',
  G3: 'Actionable Specificity',
  G4: 'Root Cause Depth',
  G5: 'Classification Correctness',
  G6: 'Confidence Calibration',
  G7: 'Scope Clarity',
};

export const RUBRIC_DESCRIPTIONS: Record<RubricDimension, string> = {
  G1: 'Diagnosis is grounded in concrete evidence (logs, error messages, code references) — not speculation or fabricated data.',
  G2: 'Principle/diagnosis describes observable agent behavior, not internal model states or vague abstractions.',
  G3: 'Root cause and recommended action are specific enough to act on without further clarification.',
  G4: 'Root cause goes beyond surface symptoms — uses 5-Whys depth or equivalent causal analysis.',
  G5: 'Pain classification (category, severity, confidence) matches the actual evidence.',
  G6: 'Confidence score reflects actual certainty — not overconfident on weak evidence or underconfident on strong evidence.',
  G7: 'Principle scope is clearly bounded — specifies when it applies and when it does not.',
};

export const RUBRIC_PROMPTS: Record<RubricDimension, string> = {
  G1: 'Does the diagnosis cite concrete evidence (error messages, file paths, code snippets, event IDs) rather than vague claims? Score 2 if specific evidence is quoted, 1 if partially grounded, 0 if purely speculative.',
  G2: 'Is the principle/diagnosis written in terms of observable agent behavior (tool calls, file edits, decision patterns)? Score 2 if fully behavior-oriented, 1 if partially, 0 if only describes internal states.',
  G3: 'Can someone act on the recommendation without asking clarifying questions? Score 2 if immediately actionable, 1 if needs minor clarification, 0 if vague or generic.',
  G4: 'Does the root cause analysis go beyond "the code has a bug"? Score 2 if identifies systemic pattern (5-Whys depth >=3), 1 if identifies proximate cause, 0 if only restates symptom.',
  G5: 'Does the pain classification match the evidence? Score 2 if category/severity/confidence align perfectly, 1 if mostly correct with minor mismatch, 0 if clearly miscategorized.',
  G6: 'Is the confidence level calibrated to evidence strength? Score 2 if confidence matches evidence quality, 1 if slightly off, 0 if grossly over/under confident.',
  G7: 'Is the principle scope explicitly bounded? Score 2 if clear applicability and exclusion criteria, 1 if scope is implicit, 0 if scope is unlimited or undefined.',
};

/** Sum rubric scores as plain numbers */
export function sumScores(scores: Record<RubricDimension, RubricScore>): number {
  return (Object.values(scores) as number[]).reduce((s, v) => s + v, 0);
}

/** MVP quality gate: G1=2 AND G2=2 AND G5=2 AND G3>=1 AND total >= 10/14 */
export function meetsMvpThreshold(scores: Record<RubricDimension, RubricScore>): boolean {
  const total = sumScores(scores);
  return (
    scores.G1 === 2 &&
    scores.G2 === 2 &&
    scores.G5 === 2 &&
    scores.G3 >= 1 &&
    total >= 10
  );
}

// ── Episode Data (desensitized) ────────────────────────────────────

export interface PainEpisode {
  episodeId: string;
  summary: string;
  source: string;
  score: number;
  severity: string;
  createdAt: string;
  evolutionTaskResolution: string | null;
  linkedPrinciples: string[];
  gateBlockCount: number;
}

// ── Evaluation Result ──────────────────────────────────────────────

export interface LocalEvaluation {
  model: string;
  dimensionScores: Record<RubricDimension, RubricScore>;
  dimensionRationales: Record<RubricDimension, string>;
  totalScore: number;
  maxScore: number;
  mvpMet: boolean;
  flags: string[];
}

export type AdjudicationStatus =
  | 'pass'
  | 'fail'
  | 'needs-review'
  | 'local-pass'
  | 'local-fail'
  | 'skipped';

export interface StrongModelAdjudication {
  model: string;
  adjudicationStatus: AdjudicationStatus;
  confirmedScores: Record<RubricDimension, RubricScore> | null;
  confirmedMvpMet: boolean | null;
  rationale: string;
  nextAction: string | null;
}

export interface EpisodeEvaluation {
  episode: PainEpisode;
  localEvaluation: LocalEvaluation;
  strongModelAdjudication: StrongModelAdjudication | null;
  finalLabel: AdjudicationStatus;
}

// ── Report ─────────────────────────────────────────────────────────

export interface QualityScorecardReport {
  generatedAt: string;
  dataSource: {
    painEventCount: number;
    evolutionTaskCount: number;
    principleEventCount: number;
    gateBlockCount: number;
    dateRange: { from: string; to: string };
  };
  localEvaluatorConfig: {
    model: string;
    baseUrl: string;
    apiKeyStatus: string;
  };
  strongModelConfig: {
    model: string | null;
    status: 'configured' | 'skipped';
  };
  evaluations: EpisodeEvaluation[];
  summary: {
    totalEpisodes: number;
    localPassCount: number;
    localFailCount: number;
    strongModelReviewedCount: number;
    finalPassCount: number;
    finalFailCount: number;
    needsReviewCount: number;
    skippedCount: number;
    averageLocalScore: number;
    mvpThresholdMetCount: number;
  };
  knownLimitations: string[];
}

// ── CLI Options (validated) ────────────────────────────────────────

export interface ScorecardOptions {
  dbPath: string;
  logsDir: string;
  localModelBaseUrl: string;
  localModelId: string;
  strongModelId: string | null;
  limit: number;
  format: 'json' | 'markdown' | 'html';
  output: string;
  minPainScore: number;
  skipStrongModel: boolean;
}
