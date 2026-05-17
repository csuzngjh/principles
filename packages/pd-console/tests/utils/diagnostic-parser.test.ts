import { describe, it, expect } from 'vitest';
import {
  parseDiagnosticianOutput,
  parseDiagnosticInput,
  parseSeverityFromDiagnostic,
  parseReasonSummaryFromDiagnostic,
  parseRecommendationKind,
} from '../../src/server/utils/diagnostic-parser.js';

describe('parseDiagnosticianOutput', () => {
  it('parses valid full diagnostician output', () => {
    const input = JSON.stringify({
      rootCause: 'Missing input validation',
      confidence: 0.85,
      violatedPrinciples: [{ principleId: 'p1', title: 'Validate input', rationale: 'Should validate' }],
      evidence: [{ sourceRef: 'file.ts:10', note: 'Missing check' }],
      recommendations: [{ kind: 'rule', description: 'Add validation', triggerPattern: 'input', action: 'validate' }],
      ambiguityNotes: ['Low confidence on secondary cause'],
    });
    const result = parseDiagnosticianOutput(input);
    expect(result).toBeDefined();
    expect(result!.rootCause).toBe('Missing input validation');
    expect(result!.confidence).toBe(0.85);
    expect(result!.violatedPrinciples).toHaveLength(1);
    expect(result!.evidenceChain).toHaveLength(1);
    expect(result!.recommendations).toHaveLength(1);
    expect(result!.recommendations[0].kind).toBe('rule');
    expect(result!.ambiguityNotes).toHaveLength(1);
  });

  it('handles empty recommendations', () => {
    const input = JSON.stringify({ rootCause: 'Test', recommendations: [] });
    const result = parseDiagnosticianOutput(input);
    expect(result).toBeDefined();
    expect(result!.recommendations).toEqual([]);
  });

  it('handles missing optional fields', () => {
    const input = JSON.stringify({ rootCause: 'Test' });
    const result = parseDiagnosticianOutput(input);
    expect(result).toBeDefined();
    expect(result!.rootCause).toBe('Test');
    expect(result!.confidence).toBe(0);
    expect(result!.violatedPrinciples).toEqual([]);
    expect(result!.evidenceChain).toEqual([]);
    expect(result!.recommendations).toEqual([]);
    expect(result!.ambiguityNotes).toEqual([]);
  });

  it('returns undefined for malformed JSON', () => {
    const result = parseDiagnosticianOutput('not json');
    expect(result).toBeUndefined();
  });

  it('handles unknown kind falls back to principle', () => {
    const input = JSON.stringify({
      rootCause: 'Test',
      recommendations: [{ kind: 'unknown_type', description: 'desc' }],
    });
    const result = parseDiagnosticianOutput(input);
    expect(result!.recommendations[0].kind).toBe('principle');
  });

  it('validates kind against known set', () => {
    const input = JSON.stringify({
      rootCause: 'Test',
      recommendations: [
        { kind: 'principle', description: 'a' },
        { kind: 'rule', description: 'b' },
        { kind: 'implementation', description: 'c' },
        { kind: 'prompt', description: 'd' },
        { kind: 'defer', description: 'e' },
      ],
    });
    const result = parseDiagnosticianOutput(input);
    expect(result!.recommendations.map(r => r.kind)).toEqual([
      'principle',
      'rule',
      'implementation',
      'prompt',
      'defer',
    ]);
  });
});

describe('parseDiagnosticInput', () => {
  it('parses valid diagnostic input', () => {
    const input = JSON.stringify({
      reasonSummary: 'High severity pain',
      source: 'tool_failure',
      severity: 'high',
      painId: 'pain-1',
      sessionIdHint: 'session-abc',
    });
    const result = parseDiagnosticInput(input);
    expect(result).toBeDefined();
    expect(result!.reasonSummary).toBe('High severity pain');
    expect(result!.source).toBe('tool_failure');
    expect(result!.severity).toBe('high');
    expect(result!.painId).toBe('pain-1');
    expect(result!.sessionId).toBe('session-abc');
  });

  it('handles partial input with only severity and painId', () => {
    const input = JSON.stringify({ severity: 'low', painId: 'pain-2' });
    const result = parseDiagnosticInput(input);
    expect(result).toBeDefined();
    expect(result!.severity).toBe('low');
    expect(result!.painId).toBe('pain-2');
    expect(result!.reasonSummary).toBe('');
    expect(result!.source).toBe('');
  });

  it('handles empty object', () => {
    const result = parseDiagnosticInput('{}');
    expect(result).toBeDefined();
    expect(result!.reasonSummary).toBe('');
    expect(result!.source).toBe('');
    expect(result!.severity).toBe('unknown');
  });

  it('returns undefined for malformed JSON', () => {
    const result = parseDiagnosticInput('not json');
    expect(result).toBeUndefined();
  });
});

describe('parseSeverityFromDiagnostic', () => {
  it('extracts severity from JSON', () => {
    expect(parseSeverityFromDiagnostic('{"severity":"high"}')).toBe('high');
  });

  it('returns undefined for missing severity', () => {
    expect(parseSeverityFromDiagnostic('{}')).toBeUndefined();
  });

  it('returns undefined for null input', () => {
    expect(parseSeverityFromDiagnostic(null)).toBeUndefined();
  });

  it('returns undefined for undefined input', () => {
    expect(parseSeverityFromDiagnostic(undefined)).toBeUndefined();
  });

  it('returns undefined for malformed JSON', () => {
    expect(parseSeverityFromDiagnostic('not json')).toBeUndefined();
  });
});

describe('parseReasonSummaryFromDiagnostic', () => {
  it('extracts reason summary from JSON', () => {
    expect(parseReasonSummaryFromDiagnostic('{"reasonSummary":"test"}')).toBe('test');
  });

  it('returns empty string for missing reason summary', () => {
    expect(parseReasonSummaryFromDiagnostic('{}')).toBe('');
  });

  it('returns empty string for null input', () => {
    expect(parseReasonSummaryFromDiagnostic(null)).toBe('');
  });

  it('returns empty string for undefined input', () => {
    expect(parseReasonSummaryFromDiagnostic(undefined)).toBe('');
  });

  it('returns empty string for malformed JSON', () => {
    expect(parseReasonSummaryFromDiagnostic('not json')).toBe('');
  });
});

describe('parseRecommendationKind', () => {
  it('extracts kind from recommendation JSON', () => {
    expect(parseRecommendationKind('{"kind":"rule"}')).toBe('rule');
  });

  it('returns undefined for missing kind', () => {
    expect(parseRecommendationKind('{}')).toBeUndefined();
  });

  it('returns undefined for non-object JSON', () => {
    expect(parseRecommendationKind('"string"')).toBeUndefined();
  });

  it('returns undefined for array JSON', () => {
    expect(parseRecommendationKind('["a","b"]')).toBeUndefined();
  });

  it('returns undefined for null input', () => {
    expect(parseRecommendationKind(null)).toBeUndefined();
  });

  it('returns undefined for undefined input', () => {
    expect(parseRecommendationKind(undefined)).toBeUndefined();
  });

  it('returns undefined for malformed JSON', () => {
    expect(parseRecommendationKind('not json')).toBeUndefined();
  });
});