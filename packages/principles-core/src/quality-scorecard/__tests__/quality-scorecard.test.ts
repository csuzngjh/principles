/**
 * PRI-361 Quality Scorecard — Tests
 *
 * Tests pure logic from @principles/core only.
 * I/O layer tests belong in pd-cli.
 */
import { describe, it, expect } from 'vitest';
import {
  RUBRIC_DIMENSIONS,
  RUBRIC_LABELS,
  meetsMvpThreshold,
  sumScores,
  escapeHtml,
  escapeMarkdownTable,
  isValidRubricScore,
  parseRubricScore,
  validateDimensionScores,
  validateLlmScoreResponse,
  validateAdjudicationResponse,
  validatePainRow,
  validateGateRow,
  validateCliOptions,
  validateEvolutionRow,
  validatePrincipleEventRow,
  extractJsonFromLlmResponse,
  truncate,
  needsAdjudication,
  determineFinalLabel,
  sanitize,
  generateMarkdownReport,
  generateHtmlReport,
  generateJsonReport,
  type RubricDimension,
  type RubricScore,
  type QualityScorecardReport,
  type EpisodeEvaluation,
  type PainEpisode,
  type LocalEvaluation,
} from '../index.js';

// ── Rubric Tests ───────────────────────────────────────────────────

describe('Rubric definitions', () => {
  it('has exactly 7 dimensions (G1-G7)', () => {
    expect(RUBRIC_DIMENSIONS).toHaveLength(7);
    expect(RUBRIC_DIMENSIONS).toEqual(['G1', 'G2', 'G3', 'G4', 'G5', 'G6', 'G7']);
  });

  it('every dimension has a label', () => {
    for (const dim of RUBRIC_DIMENSIONS) {
      expect(RUBRIC_LABELS[dim]).toBeTruthy();
    }
  });
});

describe('meetsMvpThreshold', () => {
  const perfectScores: Record<RubricDimension, RubricScore> = {
    G1: 2, G2: 2, G3: 2, G4: 2, G5: 2, G6: 2, G7: 2,
  };

  it('passes with perfect scores', () => {
    expect(meetsMvpThreshold(perfectScores)).toBe(true);
  });

  it('fails when G1 < 2', () => {
    const scores: Record<RubricDimension, RubricScore> = { ...perfectScores, G1: 1 };
    expect(meetsMvpThreshold(scores)).toBe(false);
  });

  it('fails when G2 < 2', () => {
    const scores: Record<RubricDimension, RubricScore> = { ...perfectScores, G2: 1 };
    expect(meetsMvpThreshold(scores)).toBe(false);
  });

  it('fails when G5 < 2', () => {
    const scores: Record<RubricDimension, RubricScore> = { ...perfectScores, G5: 1 };
    expect(meetsMvpThreshold(scores)).toBe(false);
  });

  it('fails when G3 = 0 (must be >= 1)', () => {
    const scores: Record<RubricDimension, RubricScore> = { ...perfectScores, G3: 0 };
    expect(meetsMvpThreshold(scores)).toBe(false);
  });

  it('fails when total < 10', () => {
    const scores: Record<RubricDimension, RubricScore> = {
      G1: 2, G2: 2, G3: 1,
      G4: 0, G5: 2, G6: 0, G7: 0,
    };
    expect(meetsMvpThreshold(scores)).toBe(false);
  });

  it('fails with all zeros', () => {
    const zeros = Object.fromEntries(RUBRIC_DIMENSIONS.map(d => [d, 0])) as Record<RubricDimension, RubricScore>;
    expect(meetsMvpThreshold(zeros)).toBe(false);
  });
});

// ── Escaping Tests ─────────────────────────────────────────────────

describe('escapeHtml', () => {
  it('escapes < > & " \'', () => {
    expect(escapeHtml('<script>alert("xss")</script>')).toBe(
      '&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;'
    );
  });

  it('escapes ampersands', () => {
    expect(escapeHtml('a & b')).toBe('a &amp; b');
  });

  it('leaves safe text unchanged', () => {
    expect(escapeHtml('hello world')).toBe('hello world');
  });

  it('handles injection in pain summary', () => {
    const malicious = '<img src=x onerror=alert(1)>';
    const escaped = escapeHtml(malicious);
    expect(escaped).not.toContain('<');
    expect(escaped).not.toContain('>');
  });
});

describe('escapeMarkdownTable', () => {
  it('escapes pipe characters', () => {
    expect(escapeMarkdownTable('a | b | c')).toBe('a \\| b \\| c');
  });

  it('replaces newlines with spaces', () => {
    expect(escapeMarkdownTable('line1\nline2\rline3')).toBe('line1 line2line3');
  });

  it('leaves safe text unchanged', () => {
    expect(escapeMarkdownTable('hello world')).toBe('hello world');
  });
});

// ── Validation Tests ───────────────────────────────────────────────

describe('validateLlmScoreResponse', () => {
  it('returns zeros for null input', () => {
    const result = validateLlmScoreResponse(null);
    expect(result.scores.G1).toBe(0);
    expect(result.flags).toContain('invalid_llm_response');
  });

  it('parses valid response', () => {
    const result = validateLlmScoreResponse({
      scores: { G1: 2, G2: 1, G3: 0, G4: 2, G5: 2, G6: 1, G7: 0 },
      rationales: { G1: 'Good evidence', G2: 'Partial' },
      flags: ['over_abstraction'],
    });
    expect(result.scores.G1).toBe(2);
    expect(result.scores.G2).toBe(1);
    expect(result.flags).toEqual(['over_abstraction']);
    expect(result.rationales.G2).toBe('Partial');
  });

  it('clamps invalid scores to 0', () => {
    const result = validateLlmScoreResponse({
      scores: { G1: 5, G2: -1, G3: 'bad' },
      rationales: {},
      flags: 'not-array',
    });
    expect(result.scores.G1).toBe(0);
    expect(result.scores.G2).toBe(0);
    expect(result.scores.G3).toBe(0);
    expect(result.flags).toEqual([]);
  });
});

describe('validateAdjudicationResponse', () => {
  it('returns needs-review for null input', () => {
    const result = validateAdjudicationResponse(null);
    expect(result.verdict).toBe('needs-review');
  });

  it('parses valid response', () => {
    const result = validateAdjudicationResponse({
      scores: { G1: 2, G2: 2, G3: 2, G4: 2, G5: 2, G6: 2, G7: 2 },
      rationale: 'All good',
      verdict: 'pass',
    });
    expect(result.verdict).toBe('pass');
    expect(result.rationale).toBe('All good');
  });
});

describe('validatePainRow', () => {
  it('returns null for null input', () => {
    expect(validatePainRow(null)).toBeNull();
  });

  it('returns null for missing required fields', () => {
    expect(validatePainRow({})).toBeNull();
  });

  it('parses valid row', () => {
    const row = validatePainRow({ id: 1, session_id: 's1', source: 'manual', score: 80, reason: 'test', severity: 'severe', created_at: '2026-01-01' });
    expect(row).not.toBeNull();
    if (row) {
      expect(row.id).toBe(1);
      expect(row.score).toBe(80);
    }
  });
});

describe('validateCliOptions', () => {
  it('rejects invalid format', () => {
    const { errors } = validateCliOptions({ format: 'xml', minPainScore: 50, limit: 0, localModelBaseUrl: 'http://x', output: 'out.md', localModelId: 'm' });
    expect(errors.some(e => e.field === 'format')).toBe(true);
  });

  it('rejects invalid minPainScore', () => {
    const { errors } = validateCliOptions({ format: 'json', minPainScore: -1, limit: 0, localModelBaseUrl: 'http://x', output: 'out.md', localModelId: 'm' });
    expect(errors.some(e => e.field === 'minPainScore')).toBe(true);
  });

  it('rejects invalid URL', () => {
    const { errors } = validateCliOptions({ format: 'json', minPainScore: 50, limit: 0, localModelBaseUrl: 'ftp://x', output: 'out.md', localModelId: 'm' });
    expect(errors.some(e => e.field === 'localModelBaseUrl')).toBe(true);
  });

  it('accepts valid options', () => {
    const { options, errors } = validateCliOptions({
      format: 'json', minPainScore: 50, limit: 10,
      localModelBaseUrl: 'http://localhost:12341/v1', output: 'report.json', localModelId: 'gemma',
    });
    expect(errors).toHaveLength(0);
    expect(options.format).toBe('json');
    expect(options.limit).toBe(10);
  });
});

// ── Gate Row Validation Tests ──────────────────────────────────────

describe('validateGateRow', () => {
  it('returns null for null input', () => {
    expect(validateGateRow(null)).toBeNull();
  });

  it('returns null for missing session_id', () => {
    expect(validateGateRow({ cnt: 5 })).toBeNull();
  });

  it('parses valid row', () => {
    const row = validateGateRow({ session_id: 'sess-1', cnt: 3 });
    expect(row).not.toBeNull();
    if (row) {
      expect(row.session_id).toBe('sess-1');
      expect(row.cnt).toBe(3);
    }
  });

  it('defaults cnt to 0 for non-number', () => {
    const row = validateGateRow({ session_id: 'sess-1', cnt: 'bad' });
    expect(row).not.toBeNull();
    if (row) {
      expect(row.cnt).toBe(0);
    }
  });
});

// ── Path Sanitization Tests ─────────────────────────────────────────

describe('sanitize — path redaction', () => {
  it('redacts Windows paths', () => {
    const result = sanitize('file at D:\\Code\\principles\\src\\index.ts');
    expect(result).not.toContain('D:\\');
    expect(result).toContain('<path>');
  });

  it('redacts POSIX /home/ paths', () => {
    const result = sanitize('error in /home/user/project/src/index.ts');
    expect(result).not.toContain('/home/');
    expect(result).toContain('<path>');
  });

  it('redacts WSL /mnt/ paths', () => {
    const result = sanitize('mounted at /mnt/c/Users/test/file.txt');
    expect(result).not.toContain('/mnt/');
    expect(result).toContain('<path>');
  });

  it('redacts /tmp/ paths', () => {
    const result = sanitize('temp file /tmp/build-12345/output.log');
    expect(result).not.toContain('/tmp/');
    expect(result).toContain('<path>');
  });

  it('redacts JWT-like tokens', () => {
    const result = sanitize('bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.abc');
    expect(result).not.toContain('eyJ');
    expect(result).toContain('<token-redacted>');
  });
});

// ── Adjudication Decision Tests ────────────────────────────────────

function makeLocalEval(overrides: Partial<{ totalScore: number; mvpMet: boolean; flags: string[] }> = {}) {
  return {
    model: 'test-model',
    dimensionScores: Object.fromEntries(RUBRIC_DIMENSIONS.map(d => [d, 2])) as Record<RubricDimension, RubricScore>,
    dimensionRationales: Object.fromEntries(RUBRIC_DIMENSIONS.map(d => [d, ''])) as Record<RubricDimension, string>,
    totalScore: overrides.totalScore ?? 14,
    maxScore: 14,
    mvpMet: overrides.mvpMet ?? true,
    flags: overrides.flags ?? [],
  };
}

function makeEpisode(overrides = {}) {
  return {
    episodeId: 'EP-1', summary: 'Test episode', source: 'manual', score: 80,
    severity: 'severe', createdAt: '2026-06-12T00:00:00Z',
    evolutionTaskResolution: null, linkedPrinciples: [], gateBlockCount: 0,
    ...overrides,
  };
}

describe('needsAdjudication', () => {
  it('returns critical when fabricated_evidence flag present', () => {
    const decision = needsAdjudication(makeEpisode(), makeLocalEval({ flags: ['fabricated_evidence'] }));
    expect(decision.shouldAdjudicate).toBe(true);
    expect(decision.priority).toBe('critical');
  });

  it('returns high when MVP not met', () => {
    const local = makeLocalEval({ mvpMet: false, totalScore: 5 });
    local.dimensionScores = { G1: 0, G2: 2, G3: 0, G4: 0, G5: 0, G6: 1, G7: 0 };
    const decision = needsAdjudication(makeEpisode(), local);
    expect(decision.shouldAdjudicate).toBe(true);
    expect(decision.priority).toBe('high');
  });

  it('returns low (no adjudication) when score >= 12 with MVP met', () => {
    const decision = needsAdjudication(makeEpisode(), makeLocalEval({ totalScore: 13 }));
    expect(decision.shouldAdjudicate).toBe(false);
    expect(decision.priority).toBe('low');
  });
});

describe('determineFinalLabel', () => {
  it('returns local-pass when high score and no adjudication', () => {
    const label = determineFinalLabel(makeLocalEval({ totalScore: 13 }), null);
    expect(label).toBe('local-pass');
  });

  it('returns local-fail when very low score and no adjudication', () => {
    const local = makeLocalEval({ totalScore: 3, mvpMet: false });
    local.dimensionScores = { G1: 0, G2: 0, G3: 0, G4: 1, G5: 0, G6: 1, G7: 1 };
    expect(determineFinalLabel(local, null)).toBe('local-fail');
  });
});

// ── Additional Boundary Condition Tests ───────────────────────────────────────

describe('validateLlmScoreResponse — boundary conditions', () => {
  it('handles array input (invalid)', () => {
    const result = validateLlmScoreResponse([1, 2, 3]);
    // Array input is treated as object with numeric keys, so scores default to 0
    expect(result.scores.G1).toBe(0);
    // flags are empty because the input is technically an object
    expect(result.flags).toEqual([]);
  });

  it('handles empty object input', () => {
    const result = validateLlmScoreResponse({});
    expect(result.scores.G1).toBe(0);
    expect(result.rationales.G1).toBe('No rationale provided');
  });

  it('handles scores with extra dimensions (ignores unknown)', () => {
    const result = validateLlmScoreResponse({
      scores: { G1: 2, G2: 1, G8: 5, G9: 3 }, // G8, G9 are unknown
      rationales: {},
      flags: [],
    });
    expect(result.scores.G1).toBe(2);
    expect(result.scores.G2).toBe(1);
    // Unknown dimensions should not appear
    expect('G8' in result.scores).toBe(false);
  });

  it('handles rationales with non-string values', () => {
    const result = validateLlmScoreResponse({
      scores: { G1: 2 },
      rationales: { G1: 123, G2: null, G3: undefined },
      flags: [],
    });
    expect(result.rationales.G1).toBe('No rationale provided');
    expect(result.rationales.G2).toBe('No rationale provided');
    expect(result.rationales.G3).toBe('No rationale provided');
  });

  it('handles flags with mixed types (filters non-strings)', () => {
    const result = validateLlmScoreResponse({
      scores: {},
      rationales: {},
      flags: ['valid_flag', 123, null, { obj: true }, 'another_valid'],
    });
    expect(result.flags).toEqual(['valid_flag', 'another_valid']);
  });
});

describe('validateAdjudicationResponse — boundary conditions', () => {
  it('handles array input (invalid)', () => {
    const result = validateAdjudicationResponse([1, 2, 3]);
    expect(result.verdict).toBe('needs-review');
    // rationale defaults to 'No rationale provided' for invalid input
    expect(result.rationale).toBe('No rationale provided');
  });

  it('handles empty object input', () => {
    const result = validateAdjudicationResponse({});
    expect(result.verdict).toBe('needs-review');
    expect(result.rationale).toBe('No rationale provided');
  });

  it('handles verdict with wrong case (normalizes to lowercase)', () => {
    const result = validateAdjudicationResponse({
      scores: {},
      rationale: 'test',
      verdict: 'PASS', // uppercase
    });
    expect(result.verdict).toBe('pass');
  });

  it('handles invalid verdict values', () => {
    const result = validateAdjudicationResponse({
      scores: {},
      rationale: 'test',
      verdict: 'invalid_status',
    });
    expect(result.verdict).toBe('needs-review');
  });

  it('handles numeric rationale', () => {
    const result = validateAdjudicationResponse({
      scores: {},
      rationale: 123,
      verdict: 'pass',
    });
    expect(result.rationale).toBe('No rationale provided');
  });
});

describe('validatePainRow — boundary conditions', () => {
  it('returns null for array input', () => {
    expect(validatePainRow([1, 2, 3])).toBeNull();
  });

  it('returns null for string input', () => {
    expect(validatePainRow('not an object')).toBeNull();
  });

  it('returns null for negative id', () => {
    expect(validatePainRow({ id: -1, reason: 'test' })).toBeNull();
  });

  it('returns null for empty reason', () => {
    expect(validatePainRow({ id: 1, reason: '' })).toBeNull();
  });

  it('defaults missing fields appropriately', () => {
    const row = validatePainRow({ id: 1, reason: 'test' });
    expect(row).not.toBeNull();
    if (row) {
      expect(row.session_id).toBe('');
      expect(row.source).toBe('unknown');
      expect(row.score).toBe(0);
      expect(row.severity).toBe('unknown');
    }
  });

  it('handles non-number id (defaults to -1 → null)', () => {
    expect(validatePainRow({ id: 'not-a-number', reason: 'test' })).toBeNull();
  });

  it('handles non-number score (defaults to 0)', () => {
    const row = validatePainRow({ id: 1, reason: 'test', score: 'high' });
    expect(row).not.toBeNull();
    if (row) {
      expect(row.score).toBe(0);
    }
  });
});

describe('validateEvolutionRow — boundary conditions', () => {
  it('returns null for null input', () => {
    expect(validateEvolutionRow(null)).toBeNull();
  });

  it('returns null for missing task_id', () => {
    expect(validateEvolutionRow({ score: 80 })).toBeNull();
  });

  it('returns null for empty task_id', () => {
    expect(validateEvolutionRow({ task_id: '' })).toBeNull();
  });

  it('defaults missing fields appropriately', () => {
    const row = validateEvolutionRow({ task_id: 'task-1' });
    expect(row).not.toBeNull();
    if (row) {
      expect(row.score).toBe(0);
      expect(row.status).toBe('unknown');
      expect(row.resolution).toBeNull();
    }
  });
});

describe('validateCliOptions — boundary conditions', () => {
  it('rejects minPainScore > 100', () => {
    const { errors } = validateCliOptions({ minPainScore: 150, localModelBaseUrl: 'http://x', output: 'out.md', localModelId: 'm' });
    expect(errors.some(e => e.field === 'minPainScore')).toBe(true);
  });

  it('rejects non-numeric minPainScore', () => {
    const { errors } = validateCliOptions({ minPainScore: 'high', localModelBaseUrl: 'http://x', output: 'out.md', localModelId: 'm' });
    expect(errors.some(e => e.field === 'minPainScore')).toBe(true);
  });

  it('rejects missing output path', () => {
    const { errors } = validateCliOptions({ localModelBaseUrl: 'http://x', localModelId: 'm' });
    expect(errors.some(e => e.field === 'output')).toBe(true);
  });

  it('rejects missing localModelId', () => {
    const { errors } = validateCliOptions({ localModelBaseUrl: 'http://x', output: 'out.md' });
    expect(errors.some(e => e.field === 'localModelId')).toBe(true);
  });

  it('rejects baseUrl without protocol', () => {
    const { errors } = validateCliOptions({ localModelBaseUrl: 'localhost:1234', output: 'out.md', localModelId: 'm' });
    expect(errors.some(e => e.field === 'localModelBaseUrl')).toBe(true);
  });

  it('rejects ftp:// protocol', () => {
    const { errors } = validateCliOptions({ localModelBaseUrl: 'ftp://server', output: 'out.md', localModelId: 'm' });
    expect(errors.some(e => e.field === 'localModelBaseUrl')).toBe(true);
  });

  it('accepts https:// protocol', () => {
    const { errors } = validateCliOptions({ localModelBaseUrl: 'https://api.example.com', output: 'out.md', localModelId: 'm' });
    expect(errors.some(e => e.field === 'localModelBaseUrl')).toBe(false);
  });

  it('defaults format to markdown when invalid', () => {
    const { options } = validateCliOptions({ format: 'invalid', localModelBaseUrl: 'http://x', output: 'out.md', localModelId: 'm' });
    expect(options.format).toBe('markdown');
  });

  it('handles multiple errors at once', () => {
    const { errors } = validateCliOptions({
      format: 'xml',
      minPainScore: -50,
      limit: -5,
      localModelBaseUrl: 'invalid',
      output: '',
      localModelId: '',
    });
    expect(errors.length).toBeGreaterThan(3);
  });
});

describe('sanitize — additional boundary conditions', () => {
  it('redacts /var/ paths', () => {
    const result = sanitize('log file /var/log/app.log');
    expect(result).not.toContain('/var/');
    expect(result).toContain('<path>');
  });

  it('redacts /etc/ paths', () => {
    const result = sanitize('config at /etc/nginx/nginx.conf');
    expect(result).not.toContain('/etc/');
    expect(result).toContain('<path>');
  });

  it('redacts /root/ paths', () => {
    const result = sanitize('file in /root/.bashrc');
    expect(result).not.toContain('/root/');
    expect(result).toContain('<path>');
  });

  it('redacts /opt/ paths', () => {
    const result = sanitize('installed at /opt/app/bin');
    expect(result).not.toContain('/opt/');
    expect(result).toContain('<path>');
  });

  it('redacts UUID-like session IDs', () => {
    const result = sanitize('session: 12345678-1234-1234-1234-123456789abc');
    expect(result).toContain('<session-id>');
    expect(result).not.toContain('12345678-1234');
  });

  it('preserves normal text without sensitive patterns', () => {
    const result = sanitize('This is a normal message without paths or tokens');
    expect(result).toBe('This is a normal message without paths or tokens');
  });

  it('handles multiple patterns in same string', () => {
    const result = sanitize('Error at /home/user/file.txt with token eyJhbGciOiJIUzI1NiJ9');
    expect(result).toContain('<path>');
    expect(result).toContain('<token-redacted>');
    expect(result).not.toContain('/home/');
    expect(result).not.toContain('eyJ');
  });
});

describe('needsAdjudication — additional boundary conditions', () => {
  it('returns medium when zero-score dimensions exist', () => {
    const local = makeLocalEval({ totalScore: 10, mvpMet: true });
    local.dimensionScores = { G1: 2, G2: 2, G3: 2, G4: 0, G5: 2, G6: 2, G7: 0 };
    const decision = needsAdjudication(makeEpisode(), local);
    expect(decision.shouldAdjudicate).toBe(true);
    expect(decision.priority).toBe('medium');
    expect(decision.reason).toContain('Zero-score');
  });

  it('returns high when total score <= 8', () => {
    const local = makeLocalEval({ totalScore: 7, mvpMet: false });
    const decision = needsAdjudication(makeEpisode(), local);
    expect(decision.shouldAdjudicate).toBe(true);
    expect(decision.priority).toBe('high');
  });

  it('returns medium for moderate scores (9-11)', () => {
    const local = makeLocalEval({ totalScore: 10, mvpMet: true });
    local.dimensionScores = { G1: 2, G2: 2, G3: 1, G4: 1, G5: 2, G6: 2, G7: 0 };
    const decision = needsAdjudication(makeEpisode(), local);
    expect(decision.shouldAdjudicate).toBe(true);
    expect(decision.priority).toBe('medium');
    // When there's a zero-score dimension, reason mentions that
    expect(decision.reason).toContain('Zero-score');
  });
});

describe('determineFinalLabel — additional boundary conditions', () => {
  it('returns needs-review for moderate score without adjudication', () => {
    const local = makeLocalEval({ totalScore: 8, mvpMet: true });
    const label = determineFinalLabel(local, null);
    expect(label).toBe('needs-review');
  });

  it('returns adjudication status when provided', () => {
    const local = makeLocalEval({ totalScore: 10 });
    const label = determineFinalLabel(local, { adjudicationStatus: 'fail' });
    expect(label).toBe('fail');
  });

  it('returns needs-review when adjudication is skipped', () => {
    const local = makeLocalEval({ totalScore: 10, mvpMet: false });
    const label = determineFinalLabel(local, { adjudicationStatus: 'skipped' });
    expect(label).toBe('needs-review');
  });
});

// ── Untested Validation Functions ──────────────────────────────────

describe('isValidRubricScore', () => {
  it('returns true for 0, 1, 2', () => {
    expect(isValidRubricScore(0)).toBe(true);
    expect(isValidRubricScore(1)).toBe(true);
    expect(isValidRubricScore(2)).toBe(true);
  });

  it('returns false for other numbers', () => {
    expect(isValidRubricScore(-1)).toBe(false);
    expect(isValidRubricScore(3)).toBe(false);
    expect(isValidRubricScore(1.5)).toBe(false);
    expect(isValidRubricScore(NaN)).toBe(false);
  });

  it('returns false for non-numbers', () => {
    expect(isValidRubricScore('0')).toBe(false);
    expect(isValidRubricScore(null)).toBe(false);
    expect(isValidRubricScore(undefined)).toBe(false);
    expect(isValidRubricScore({})).toBe(false);
  });
});

describe('parseRubricScore', () => {
  it('returns the score for valid values', () => {
    expect(parseRubricScore(0)).toBe(0);
    expect(parseRubricScore(1)).toBe(1);
    expect(parseRubricScore(2)).toBe(2);
  });

  it('returns 0 for invalid values', () => {
    expect(parseRubricScore(3)).toBe(0);
    expect(parseRubricScore(-1)).toBe(0);
    expect(parseRubricScore('bad')).toBe(0);
    expect(parseRubricScore(null)).toBe(0);
    expect(parseRubricScore(undefined)).toBe(0);
  });
});

describe('validateDimensionScores', () => {
  it('fills all dimensions with parsed scores', () => {
    const result = validateDimensionScores({ G1: 2, G2: 1, G3: 0 });
    expect(result.G1).toBe(2);
    expect(result.G2).toBe(1);
    expect(result.G3).toBe(0);
    expect(RUBRIC_DIMENSIONS.every(d => d in result)).toBe(true);
  });

  it('defaults missing dimensions to 0', () => {
    const result = validateDimensionScores({});
    for (const dim of RUBRIC_DIMENSIONS) {
      expect(result[dim]).toBe(0);
    }
  });

  it('clamps invalid scores to 0', () => {
    const result = validateDimensionScores({ G1: 5, G2: -1, G3: 'bad' });
    expect(result.G1).toBe(0);
    expect(result.G2).toBe(0);
    expect(result.G3).toBe(0);
  });

  it('ignores unknown dimensions', () => {
    const result = validateDimensionScores({ G8: 2, unknown: 1 } as Record<string, unknown>);
    expect('G8' in result).toBe(false);
    expect('unknown' in result).toBe(false);
  });
});

describe('sumScores', () => {
  it('sums all dimension scores', () => {
    const perfect = Object.fromEntries(RUBRIC_DIMENSIONS.map(d => [d, 2])) as Record<RubricDimension, RubricScore>;
    expect(sumScores(perfect)).toBe(14);
  });

  it('returns 0 for all zeros', () => {
    const zeros = Object.fromEntries(RUBRIC_DIMENSIONS.map(d => [d, 0])) as Record<RubricDimension, RubricScore>;
    expect(sumScores(zeros)).toBe(0);
  });

  it('handles mixed scores', () => {
    const mixed: Record<RubricDimension, RubricScore> = {
      G1: 2, G2: 1, G3: 0, G4: 2, G5: 1, G6: 0, G7: 2,
    };
    expect(sumScores(mixed)).toBe(8);
  });
});

describe('validatePrincipleEventRow', () => {
  it('returns null for null input', () => {
    expect(validatePrincipleEventRow(null)).toBeNull();
  });

  it('returns null for non-object input', () => {
    expect(validatePrincipleEventRow('string')).toBeNull();
    expect(validatePrincipleEventRow(123)).toBeNull();
    expect(validatePrincipleEventRow([])).toBeNull();
  });

  it('returns null for missing event_type', () => {
    expect(validatePrincipleEventRow({ principle_id: 'P-001' })).toBeNull();
  });

  it('returns null for empty event_type', () => {
    expect(validatePrincipleEventRow({ event_type: '' })).toBeNull();
  });

  it('parses valid row with all fields', () => {
    const row = validatePrincipleEventRow({
      principle_id: 'P-001',
      event_type: 'principle_created',
      created_at: '2026-06-01T00:00:00.000Z',
    });
    expect(row).not.toBeNull();
    if (row) {
      expect(row.principle_id).toBe('P-001');
      expect(row.event_type).toBe('principle_created');
      expect(row.created_at).toBe('2026-06-01T00:00:00.000Z');
    }
  });

  it('handles null principle_id', () => {
    const row = validatePrincipleEventRow({
      principle_id: null,
      event_type: 'system_start',
    });
    expect(row).not.toBeNull();
    expect(row?.principle_id).toBeNull();
  });

  it('defaults missing created_at to current ISO string', () => {
    const before = new Date().toISOString();
    const row = validatePrincipleEventRow({ event_type: 'test' });
    const after = new Date().toISOString();
    expect(row).not.toBeNull();
    if (row) {
      expect(row.created_at >= before && row.created_at <= after).toBe(true);
    }
  });

  it('handles non-string event_type (defaults to empty -> null)', () => {
    expect(validatePrincipleEventRow({ event_type: 123 })).toBeNull();
  });
});

describe('extractJsonFromLlmResponse', () => {
  it('extracts valid JSON object', () => {
    const result = extractJsonFromLlmResponse('Here is the result: {"score": 85, "status": "pass"}');
    expect(result).toEqual({ score: 85, status: 'pass' });
  });

  it('returns null for text without JSON', () => {
    const result = extractJsonFromLlmResponse('No JSON here, just plain text');
    expect(result).toBeNull();
  });

  it('returns null for malformed JSON', () => {
    const result = extractJsonFromLlmResponse('Here is {invalid json}');
    expect(result).toBeNull();
  });

  it('extracts JSON with nested objects', () => {
    const result = extractJsonFromLlmResponse('Result: {"outer": {"inner": "value"}, "arr": [1,2,3]}');
    expect(result).toEqual({ outer: { inner: 'value' }, arr: [1, 2, 3] });
  });

  it('handles empty string input', () => {
    expect(extractJsonFromLlmResponse('')).toBeNull();
  });

  it('extracts JSON even when surrounded by markdown code fences', () => {
    const result = extractJsonFromLlmResponse('```json\n{"key": "value"}\n```');
    expect(result).toEqual({ key: 'value' });
  });
});

describe('truncate', () => {
  it('returns original text when shorter than maxLen', () => {
    expect(truncate('hello', 100)).toBe('hello');
  });

  it('returns original text when exactly maxLen', () => {
    expect(truncate('hello', 5)).toBe('hello');
  });

  it('truncates long text and adds ellipsis', () => {
    const result = truncate('hello world', 5);
    expect(result).toHaveLength(8);
    expect(result.startsWith('hello')).toBe(true);
    expect(result.endsWith('...')).toBe(true);
  });

  it('uses default maxLen of 200', () => {
    const longText = 'a'.repeat(300);
    const result = truncate(longText);
    expect(result.length).toBeLessThan(300);
    expect(result.endsWith('...')).toBe(true);
  });

  it('handles empty string', () => {
    expect(truncate('')).toBe('');
  });

  it('handles maxLen of 0', () => {
    expect(truncate('hello', 0)).toBe('...');
  });
});

// ── Report Generator Tests ────────────────────────────────────────

function makeFullReport(): QualityScorecardReport {
  const episode: PainEpisode = {
    episodeId: 'EP-TEST-001',
    summary: 'Agent made incorrect assumption about API behavior',
    source: 'manual',
    score: 75,
    severity: 'high',
    createdAt: '2026-06-15T10:00:00.000Z',
    evolutionTaskResolution: null,
    linkedPrinciples: ['P-001'],
    gateBlockCount: 2,
  };

  const localEval: LocalEvaluation = {
    model: 'local-model',
    dimensionScores: Object.fromEntries(RUBRIC_DIMENSIONS.map(d => [d, 2])) as Record<RubricDimension, RubricScore>,
    dimensionRationales: Object.fromEntries(RUBRIC_DIMENSIONS.map(d => [d, `Good evidence for ${d}`])) as Record<RubricDimension, string>,
    totalScore: 14,
    maxScore: 14,
    mvpMet: true,
    flags: [],
  };

  const evaluation: EpisodeEvaluation = {
    episode,
    localEvaluation: localEval,
    strongModelAdjudication: {
      model: 'strong-model',
      adjudicationStatus: 'pass',
      confirmedScores: { ...localEval.dimensionScores },
      confirmedMvpMet: true,
      rationale: 'All dimensions well-supported by evidence.',
      nextAction: null,
    },
    finalLabel: 'pass',
  };

  return {
    generatedAt: '2026-06-16T00:00:00.000Z',
    dataSource: {
      painEventCount: 100,
      evolutionTaskCount: 25,
      principleEventCount: 50,
      gateBlockCount: 10,
      dateRange: { from: '2026-06-01', to: '2026-06-15' },
    },
    localEvaluatorConfig: {
      model: 'local-model-v1',
      baseUrl: 'http://localhost:1234/v1',
      apiKeyStatus: 'configured',
    },
    strongModelConfig: {
      model: 'strong-model-pro',
      status: 'configured',
    },
    evaluations: [evaluation],
    summary: {
      totalEpisodes: 1,
      localPassCount: 1,
      localFailCount: 0,
      strongModelReviewedCount: 1,
      finalPassCount: 1,
      finalFailCount: 0,
      needsReviewCount: 0,
      localOnlyCount: 0,
      averageLocalScore: 14,
      mvpThresholdMetCount: 1,
    },
    knownLimitations: [
      'Sample size limited to recent episodes',
      'Local model may have higher false-negative rate',
    ],
  };
}

describe('generateJsonReport', () => {
  it('produces valid JSON that round-trips correctly', () => {
    const report = makeFullReport();
    const jsonStr = generateJsonReport(report);
    const parsed = JSON.parse(jsonStr);
    expect(parsed.generatedAt).toBe(report.generatedAt);
    expect(parsed.summary.totalEpisodes).toBe(1);
    expect(parsed.evaluations).toHaveLength(1);
  });

  it('includes all top-level fields', () => {
    const report = makeFullReport();
    const jsonStr = generateJsonReport(report);
    const parsed = JSON.parse(jsonStr);
    expect(parsed).toHaveProperty('generatedAt');
    expect(parsed).toHaveProperty('dataSource');
    expect(parsed).toHaveProperty('localEvaluatorConfig');
    expect(parsed).toHaveProperty('strongModelConfig');
    expect(parsed).toHaveProperty('evaluations');
    expect(parsed).toHaveProperty('summary');
    expect(parsed).toHaveProperty('knownLimitations');
  });
});

describe('generateMarkdownReport', () => {
  it('produces non-empty markdown string', () => {
    const report = makeFullReport();
    const md = generateMarkdownReport(report);
    expect(typeof md).toBe('string');
    expect(md.length).toBeGreaterThan(0);
  });

  it('includes report title', () => {
    const report = makeFullReport();
    const md = generateMarkdownReport(report);
    expect(md).toContain('# PD Quality Scorecard Report');
  });

  it('includes data source section', () => {
    const report = makeFullReport();
    const md = generateMarkdownReport(report);
    expect(md).toContain('## Data Source');
    expect(md).toContain('Pain Events: 100');
    expect(md).toContain('Evolution Tasks: 25');
  });

  it('includes summary section with counts', () => {
    const report = makeFullReport();
    const md = generateMarkdownReport(report);
    expect(md).toContain('## Summary');
    expect(md).toContain('Total Episodes: 1');
    expect(md).toContain('Final Pass: 1');
    expect(md).toContain('MVP Threshold Met: 1/1');
  });

  it('includes episode evaluations section', () => {
    const report = makeFullReport();
    const md = generateMarkdownReport(report);
    expect(md).toContain('## Episode Evaluations');
    expect(md).toContain('EP-TEST-001');
    expect(md).toContain('PASS');
  });

  it('includes known limitations section', () => {
    const report = makeFullReport();
    const md = generateMarkdownReport(report);
    expect(md).toContain('## Known Limitations');
    expect(md).toContain('Sample size limited');
  });

  it('escapes markdown table special characters in content', () => {
    const report = makeFullReport();
    report.evaluations[0]!.episode.summary = 'Test | pipe | and \n newline';
    const md = generateMarkdownReport(report);
    const summaryLine = md.split('\n').find(line => line.startsWith('- Summary:'));
    expect(summaryLine).toBeDefined();
    expect(summaryLine!).toContain('Test \\| pipe \\|');
    expect(summaryLine!).toContain('newline');
  });

  it('handles report with zero episodes', () => {
    const report = makeFullReport();
    report.evaluations = [];
    report.summary.totalEpisodes = 0;
    const md = generateMarkdownReport(report);
    expect(md).toContain('Total Episodes: 0');
    expect(md).toContain('## Episode Evaluations');
  });

  it('handles episodes without strong model adjudication', () => {
    const report = makeFullReport();
    report.evaluations[0]!.strongModelAdjudication = null;
    report.evaluations[0]!.finalLabel = 'local-pass';
    const md = generateMarkdownReport(report);
    expect(md).toContain('LOCAL-PASS');
  });
});

describe('generateHtmlReport', () => {
  it('produces non-empty HTML string', () => {
    const report = makeFullReport();
    const html = generateHtmlReport(report);
    expect(typeof html).toBe('string');
    expect(html.length).toBeGreaterThan(0);
  });

  it('includes HTML doctype and structure', () => {
    const report = makeFullReport();
    const html = generateHtmlReport(report);
    expect(html).toContain('<!DOCTYPE html>');
    expect(html).toContain('<html');
    expect(html).toContain('</html>');
    expect(html).toContain('<head>');
    expect(html).toContain('</head>');
    expect(html).toContain('<body>');
    expect(html).toContain('</body>');
  });

  it('includes report title', () => {
    const report = makeFullReport();
    const html = generateHtmlReport(report);
    expect(html).toContain('PD Quality Scorecard');
  });

  it('includes summary statistics', () => {
    const report = makeFullReport();
    const html = generateHtmlReport(report);
    expect(html).toContain('Episodes');
    expect(html).toContain('Local Pass Rate');
    expect(html).toContain('Avg Score');
  });

  it('includes episode cards', () => {
    const report = makeFullReport();
    const html = generateHtmlReport(report);
    expect(html).toContain('EP-TEST-001');
    expect(html).toContain('card pass');
  });

  it('escapes HTML special characters in content', () => {
    const report = makeFullReport();
    report.evaluations[0]!.episode.summary = '<script>alert("xss")</script>';
    const html = generateHtmlReport(report);
    expect(html).not.toContain('<script>alert');
    expect(html).toContain('&lt;script&gt;');
  });

  it('handles episodes without strong model adjudication', () => {
    const report = makeFullReport();
    report.evaluations[0]!.strongModelAdjudication = null;
    report.evaluations[0]!.finalLabel = 'local-pass';
    const html = generateHtmlReport(report);
    expect(html).toContain('local-only assessment');
  });

  it('includes known limitations list', () => {
    const report = makeFullReport();
    const html = generateHtmlReport(report);
    expect(html).toContain('Known Limitations');
    expect(html).toContain('Sample size limited');
  });

  it('includes score bar visualizations', () => {
    const report = makeFullReport();
    const html = generateHtmlReport(report);
    expect(html).toContain('score-bars');
    expect(html).toContain('bar-fill');
  });
});
