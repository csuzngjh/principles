/**
 * PRI-361 Quality Scorecard — Runtime Validation
 *
 * Pure validation functions for untrusted data from DB rows, LLM responses, CLI opts.
 * ZERO I/O — no fs, fetch, database, process.env.
 */

import {
  RUBRIC_DIMENSIONS,
  type RubricDimension,
  type RubricScore,
  type PainEpisode,
  type LocalEvaluation,
  type AdjudicationStatus,
  type ScorecardOptions,
} from './types.js';

// ── HTML / Markdown Escaping ───────────────────────────────────────

const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#x27;',
};

const HTML_RE = /[&<>"']/g;

export function escapeHtml(text: string): string {
  return text.replace(HTML_RE, (ch) => HTML_ESCAPES[ch] ?? ch);
}

const MARKDOWN_TABLE_RE = /[|\n\r]/g;

export function escapeMarkdownTable(text: string): string {
  return text.replace(MARKDOWN_TABLE_RE, (ch) => {
    if (ch === '|') return '\\|';
    if (ch === '\n') return ' ';
    if (ch === '\r') return '';
    return ch;
  });
}

// ── Score Validation ───────────────────────────────────────────────

export function isValidRubricScore(value: unknown): value is RubricScore {
  return value === 0 || value === 1 || value === 2;
}

export function parseRubricScore(value: unknown): RubricScore {
  if (isValidRubricScore(value)) return value;
  return 0;
}

export function validateDimensionScores(
  raw: Record<string, unknown>
): Record<RubricDimension, RubricScore> {
  const result = {} as Record<RubricDimension, RubricScore>;
  for (const dim of RUBRIC_DIMENSIONS) {
    result[dim] = parseRubricScore(raw[dim]);
  }
  return result;
}

// ── LLM Response Validation ────────────────────────────────────────

export interface ValidatedLlmScores {
  scores: Record<RubricDimension, RubricScore>;
  rationales: Record<RubricDimension, string>;
  flags: string[];
}

export function validateLlmScoreResponse(raw: unknown): ValidatedLlmScores {
  if (typeof raw !== 'object' || raw === null) {
    return {
      scores: validateDimensionScores({}),
      rationales: Object.fromEntries(RUBRIC_DIMENSIONS.map(d => [d, 'Invalid LLM response'])) as Record<RubricDimension, string>,
      flags: ['invalid_llm_response'],
    };
  }

  const obj = raw as Record<string, unknown>;
  const rawScores = (typeof obj.scores === 'object' && obj.scores !== null)
    ? obj.scores as Record<string, unknown>
    : {};
  const rawRationales = (typeof obj.rationales === 'object' && obj.rationales !== null)
    ? obj.rationales as Record<string, unknown>
    : {};

  const scores = validateDimensionScores(rawScores);
  const rationales = {} as Record<RubricDimension, string>;
  for (const dim of RUBRIC_DIMENSIONS) {
    rationales[dim] = typeof rawRationales[dim] === 'string'
      ? rawRationales[dim]
      : 'No rationale provided';
  }

  const flags = Array.isArray(obj.flags)
    ? obj.flags.filter((f: unknown) => typeof f === 'string').map(String)
    : [];

  return { scores, rationales, flags };
}

// ── Adjudication Response Validation ───────────────────────────────

const VALID_ADJUDICATION_STATUSES: AdjudicationStatus[] = ['pass', 'fail', 'needs-review'];

export function validateAdjudicationResponse(raw: unknown): {
  scores: Record<RubricDimension, RubricScore>;
  rationale: string;
  verdict: AdjudicationStatus;
} {
  if (typeof raw !== 'object' || raw === null) {
    return {
      scores: validateDimensionScores({}),
      rationale: 'Invalid adjudication response',
      verdict: 'needs-review',
    };
  }

  const obj = raw as Record<string, unknown>;
  const rawScores = (typeof obj.scores === 'object' && obj.scores !== null)
    ? obj.scores as Record<string, unknown>
    : {};

  const rawVerdict = String(obj.verdict ?? '').toLowerCase();
  const verdict: AdjudicationStatus = VALID_ADJUDICATION_STATUSES.includes(rawVerdict as AdjudicationStatus)
    ? (rawVerdict as AdjudicationStatus)
    : 'needs-review';

  return {
    scores: validateDimensionScores(rawScores),
    rationale: typeof obj.rationale === 'string' ? obj.rationale : 'No rationale provided',
    verdict,
  };
}

// ── DB Row Validation ──────────────────────────────────────────────

export interface ValidatedPainRow {
  id: number;
  session_id: string;
  source: string;
  score: number;
  reason: string;
  severity: string;
  created_at: string;
}

export function validatePainRow(raw: unknown): ValidatedPainRow | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const obj = raw as Record<string, unknown>;

  const id = typeof obj.id === 'number' ? obj.id : -1;
  const session_id = typeof obj.session_id === 'string' ? obj.session_id : '';
  const source = typeof obj.source === 'string' ? obj.source : 'unknown';
  const score = typeof obj.score === 'number' ? obj.score : 0;
  const reason = typeof obj.reason === 'string' ? obj.reason : '';
  const severity = typeof obj.severity === 'string' ? obj.severity : 'unknown';
  const created_at = typeof obj.created_at === 'string' ? obj.created_at : new Date().toISOString();

  if (id < 0 || reason === '') return null;
  return { id, session_id, source, score, reason, severity, created_at };
}

export interface ValidatedEvolutionRow {
  task_id: string;
  score: number;
  status: string;
  resolution: string | null;
  created_at: string;
}

export function validateEvolutionRow(raw: unknown): ValidatedEvolutionRow | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const obj = raw as Record<string, unknown>;

  const task_id = typeof obj.task_id === 'string' ? obj.task_id : '';
  if (!task_id) return null;
  return {
    task_id,
    score: typeof obj.score === 'number' ? obj.score : 0,
    status: typeof obj.status === 'string' ? obj.status : 'unknown',
    resolution: typeof obj.resolution === 'string' ? obj.resolution : null,
    created_at: typeof obj.created_at === 'string' ? obj.created_at : new Date().toISOString(),
  };
}

export interface ValidatedPrincipleEventRow {
  principle_id: string | null;
  event_type: string;
  created_at: string;
}

export function validatePrincipleEventRow(raw: unknown): ValidatedPrincipleEventRow | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const obj = raw as Record<string, unknown>;

  const event_type = typeof obj.event_type === 'string' ? obj.event_type : '';
  if (!event_type) return null;
  return {
    principle_id: typeof obj.principle_id === 'string' ? obj.principle_id : null,
    event_type,
    created_at: typeof obj.created_at === 'string' ? obj.created_at : new Date().toISOString(),
  };
}

// ── Gate Block Row Validation ───────────────────────────────────────

export interface ValidatedGateRow {
  session_id: string;
  cnt: number;
}

export function validateGateRow(raw: unknown): ValidatedGateRow | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const obj = raw as Record<string, unknown>;
  const session_id = typeof obj.session_id === 'string' ? obj.session_id : '';
  if (!session_id) return null;
  const cnt = typeof obj.cnt === 'number' ? obj.cnt : 0;
  return { session_id, cnt };
}

// ── CLI Options Validation ─────────────────────────────────────────

export interface ValidationError {
  field: string;
  message: string;
}

export function validateCliOptions(raw: Record<string, unknown>): {
  options: ScorecardOptions;
  errors: ValidationError[];
} {
  const errors: ValidationError[] = [];

  const format = String(raw.format ?? 'markdown');
  if (format !== 'json' && format !== 'markdown' && format !== 'html') {
    errors.push({ field: 'format', message: `Invalid format "${format}"; must be json, markdown, or html` });
  }

  const minPainScore = Number(raw.minPainScore);
  if (!Number.isFinite(minPainScore) || minPainScore < 0 || minPainScore > 100) {
    errors.push({ field: 'minPainScore', message: `Invalid minPainScore "${raw.minPainScore}"; must be 0-100` });
  }

  const limit = Number(raw.limit);
  if (!Number.isFinite(limit) || limit < 0) {
    errors.push({ field: 'limit', message: `Invalid limit "${raw.limit}"; must be >= 0` });
  }

  const localUrl = String(raw.localModelBaseUrl ?? '');
  if (!localUrl.startsWith('http://') && !localUrl.startsWith('https://')) {
    errors.push({ field: 'localModelBaseUrl', message: `Invalid URL "${localUrl}"; must start with http:// or https://` });
  }

  const output = String(raw.output ?? '');
  if (!output) {
    errors.push({ field: 'output', message: 'Output path is required' });
  }

  const localModelId = String(raw.localModelId ?? '');
  if (!localModelId) {
    errors.push({ field: 'localModelId', message: 'Local model ID is required' });
  }

  const options: ScorecardOptions = {
    dbPath: String(raw.dbPath ?? ''),
    logsDir: String(raw.logsDir ?? ''),
    localModelBaseUrl: localUrl,
    localModelId,
    strongModelId: typeof raw.strongModelId === 'string' && raw.strongModelId ? raw.strongModelId : null,
    limit: Number.isFinite(limit) ? Math.floor(limit) : 0,
    format: (format === 'json' || format === 'markdown' || format === 'html') ? format : 'markdown',
    output,
    minPainScore: Number.isFinite(minPainScore) ? minPainScore : 0,
    skipStrongModel: Boolean(raw.skipStrongModel),
  };

  return { options, errors };
}

// ── JSON Extraction from LLM ───────────────────────────────────────

const JSON_RE = /\{[\s\S]*\}/;

export function extractJsonFromLlmResponse(text: string): unknown | null {
  const match = JSON_RE.exec(text);
  if (!match) return null;
  try {
    return JSON.parse(match[0]);
  } catch {
    return null;
  }
}

// ── Desensitization ────────────────────────────────────────────────

const WIN_PATH_RE = /[A-Z]:\\[^\s"']+/g;
const POSIX_PATH_RE = /(?:\/home|\/mnt|\/Users|\/tmp|\/var|\/opt|\/etc|\/root)\/[^\s"']+/g;
const TOKEN_RE = /(eyJ[A-Za-z0-9_-]{10,})/g;
const SESSION_ID_RE = /([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})/g;

export function sanitize(text: string): string {
  return text
    .replace(WIN_PATH_RE, '<path>')
    .replace(POSIX_PATH_RE, '<path>')
    .replace(TOKEN_RE, '<token-redacted>')
    .replace(SESSION_ID_RE, '<session-id>');
}

export function truncate(text: string, maxLen = 200): string {
  if (text.length <= maxLen) return text;
  return text.substring(0, maxLen) + '...';
}

// ── Adjudication Decision Logic (pure) ─────────────────────────────

export interface AdjudicationDecision {
  shouldAdjudicate: boolean;
  reason: string;
  priority: 'critical' | 'high' | 'medium' | 'low';
}

export function needsAdjudication(
  episode: PainEpisode,
  localEval: LocalEvaluation
): AdjudicationDecision {
  if (localEval.flags.includes('fabricated_evidence')) {
    return { shouldAdjudicate: true, reason: 'Fabrication detected in local evaluation', priority: 'critical' };
  }
  if (!localEval.mvpMet) {
    return { shouldAdjudicate: true, reason: `MVP threshold not met (score ${localEval.totalScore}/14)`, priority: 'high' };
  }
  if (localEval.totalScore <= 8) {
    return { shouldAdjudicate: true, reason: `Low total score (${localEval.totalScore}/14)`, priority: 'high' };
  }
  const zeroDims = RUBRIC_DIMENSIONS.filter(d => localEval.dimensionScores[d] === 0);
  if (zeroDims.length > 0) {
    return { shouldAdjudicate: true, reason: `Zero-score dimensions: ${zeroDims.join(', ')}`, priority: 'medium' };
  }
  if (localEval.totalScore >= 12 && localEval.mvpMet) {
    return { shouldAdjudicate: false, reason: 'High score with MVP met — local-pass sufficient', priority: 'low' };
  }
  return { shouldAdjudicate: true, reason: 'Moderate score — recommend strong-model review', priority: 'medium' };
}

export function determineFinalLabel(
  localEval: LocalEvaluation,
  adjudication: { adjudicationStatus: AdjudicationStatus } | null
): AdjudicationStatus {
  if (!adjudication || adjudication.adjudicationStatus === 'skipped') {
    if (localEval.mvpMet && localEval.totalScore >= 12) return 'local-pass';
    if (localEval.totalScore <= 6) return 'local-fail';
    return 'needs-review';
  }
  return adjudication.adjudicationStatus;
}
