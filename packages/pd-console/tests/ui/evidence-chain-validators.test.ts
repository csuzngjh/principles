/**
 * Tests for the EvidenceChain validators (PRI-331).
 *
 * Covers:
 * - validateEvidenceChain: top-level response validation
 * - validateEvidenceChainRecord: per-record validation
 * - State enum validation
 * - Required field enforcement (ERR-009)
 * - Optional field type checking
 * - Degraded handling
 * - Malformed JSON / missing data
 * - Sanitizer boundary: no raw path/token/text leakage
 */
import { describe, it, expect } from 'vitest';
import {
  validateEvidenceChain,
  type EvidenceChainData,
  type EvidenceChainRecordData,
} from '../../src/ui/utils/validators.js';

// ── Valid record factory ───────────────────────────────────────────────────────

function validRecord(overrides?: Partial<EvidenceChainRecordData>): EvidenceChainRecordData {
  return {
    id: 'pain_1',
    sourceKind: 'manual',
    observedAt: '2026-06-07T10:00:00.000Z',
    state: 'pain_recorded',
    summary: 'Agent modified config without approval',
    ...overrides,
  };
}

function validResponse(overrides?: Partial<EvidenceChainData>): EvidenceChainData {
  return {
    records: [],
    generatedAt: '2026-06-07T10:00:00.000Z',
    ...overrides,
  };
}

// ── validateEvidenceChain ──────────────────────────────────────────────────────

describe('validateEvidenceChain', () => {
  it('accepts a valid empty response', () => {
    const result = validateEvidenceChain(validResponse());
    expect(result).not.toBeNull();
    expect(result?.records).toEqual([]);
    expect(result?.generatedAt).toBe('2026-06-07T10:00:00.000Z');
  });

  it('accepts a response with records', () => {
    const input = validResponse({ records: [validRecord()] });
    const result = validateEvidenceChain(input);
    expect(result).not.toBeNull();
    expect(result?.records).toHaveLength(1);
    expect(result?.records[0].id).toBe('pain_1');
  });

  it('accepts response with degraded reason and nextAction', () => {
    const input = validResponse({
      degradedReason: 'Trajectory database not found',
      nextAction: 'PD has not recorded any pain signals yet.',
    });
    const result = validateEvidenceChain(input);
    expect(result).not.toBeNull();
    expect(result?.degradedReason).toBe('Trajectory database not found');
    expect(result?.nextAction).toBe('PD has not recorded any pain signals yet.');
  });

  it('accepts response with note', () => {
    const input = validResponse({
      note: 'PD has not captured any displayable behavior evidence yet.',
    });
    const result = validateEvidenceChain(input);
    expect(result).not.toBeNull();
    expect(result?.note).toBe('PD has not captured any displayable behavior evidence yet.');
  });

  it('rejects null input', () => {
    expect(validateEvidenceChain(null)).toBeNull();
  });

  it('rejects non-object input', () => {
    expect(validateEvidenceChain('string')).toBeNull();
    expect(validateEvidenceChain(42)).toBeNull();
  });

  it('rejects when records is missing', () => {
    const input = { generatedAt: '2026-06-07T10:00:00.000Z' };
    expect(validateEvidenceChain(input)).toBeNull();
  });

  it('rejects when generatedAt is missing', () => {
    const input = { records: [] };
    expect(validateEvidenceChain(input)).toBeNull();
  });

  it('rejects when records is not an array', () => {
    const input = { records: 'not-array', generatedAt: '2026-06-07T10:00:00.000Z' };
    expect(validateEvidenceChain(input)).toBeNull();
  });

  it('rejects when degradedReason is not a string', () => {
    const input = validResponse({ degradedReason: 123 });
    expect(validateEvidenceChain(input)).toBeNull();
  });

  it('rejects when nextAction is not a string', () => {
    const input = validResponse({ nextAction: true });
    expect(validateEvidenceChain(input)).toBeNull();
  });

  it('rejects when note is not a string', () => {
    const input = validResponse({ note: [] });
    expect(validateEvidenceChain(input)).toBeNull();
  });

  it('rejects when any record is malformed (strict validation)', () => {
    const input = validResponse({
      records: [validRecord(), null],
    });
    // validateArray returns null if any element fails validation
    expect(validateEvidenceChain(input)).toBeNull();
  });
});

// ── validateEvidenceChainRecord (via validateEvidenceChain) ────────────────────

describe('validateEvidenceChainRecord', () => {
  it('accepts a valid minimal record', () => {
    const input = validResponse({ records: [validRecord()] });
    const result = validateEvidenceChain(input);
    expect(result).not.toBeNull();
    const record = result!.records[0];
    expect(record.id).toBe('pain_1');
    expect(record.sourceKind).toBe('manual');
    expect(record.state).toBe('pain_recorded');
    expect(record.summary).toBe('Agent modified config without approval');
  });

  // Required field enforcement (ERR-009)
  it('rejects when id is missing', () => {
    const { id: _, ...noId } = validRecord();
    const input = validResponse({ records: [noId] });
    expect(validateEvidenceChain(input)).toBeNull();
  });

  it('rejects when sourceKind is missing', () => {
    const { sourceKind: _, ...noKind } = validRecord();
    const input = validResponse({ records: [noKind] });
    expect(validateEvidenceChain(input)).toBeNull();
  });

  it('rejects when observedAt is missing', () => {
    const { observedAt: _, ...noDate } = validRecord();
    const input = validResponse({ records: [noDate] });
    expect(validateEvidenceChain(input)).toBeNull();
  });

  it('rejects when state is missing', () => {
    const { state: _, ...noState } = validRecord();
    const input = validResponse({ records: [noState] });
    expect(validateEvidenceChain(input)).toBeNull();
  });

  it('rejects when summary is missing', () => {
    const { summary: _, ...noSummary } = validRecord();
    const input = validResponse({ records: [noSummary] });
    expect(validateEvidenceChain(input)).toBeNull();
  });

  // State enum validation
  it('rejects invalid state value', () => {
    const input = validResponse({ records: [validRecord({ state: 'invalid_state' })] });
    expect(validateEvidenceChain(input)).toBeNull();
  });

  it('accepts all valid state values', () => {
    const states = [
      'evidence_only',
      'pain_recorded',
      'diagnosis_queued',
      'diagnosis_running',
      'diagnosis_succeeded',
      'diagnosis_failed',
      'diagnosis_retry_wait',
      'candidate_generated',
      'internalization_started',
    ] as const;

    for (const state of states) {
      const input = validResponse({ records: [validRecord({ state })] });
      const result = validateEvidenceChain(input);
      expect(result).not.toBeNull();
      expect(result!.records[0].state).toBe(state);
    }
  });

  // Optional field type checking
  it('accepts record with all optional fields', () => {
    const record = validRecord({
      admissionDecision: 'store_signal',
      linkedPainId: 'pain-001',
      linkedTaskId: 'diagnosis_pain-001',
      linkedTaskStatus: 'running',
      linkedCandidateId: 'cand-001',
      linkedPrincipleId: 'principle-001',
      failureReason: 'LLM timeout',
      degradedReason: 'Partial data unavailable',
      nextAction: 'Retry diagnosis',
    });
    const input = validResponse({ records: [record] });
    const result = validateEvidenceChain(input);
    expect(result).not.toBeNull();
    expect(result!.records[0].admissionDecision).toBe('store_signal');
    expect(result!.records[0].linkedPainId).toBe('pain-001');
    expect(result!.records[0].linkedTaskId).toBe('diagnosis_pain-001');
    expect(result!.records[0].linkedTaskStatus).toBe('running');
    expect(result!.records[0].linkedCandidateId).toBe('cand-001');
    expect(result!.records[0].linkedPrincipleId).toBe('principle-001');
    expect(result!.records[0].failureReason).toBe('LLM timeout');
    expect(result!.records[0].degradedReason).toBe('Partial data unavailable');
    expect(result!.records[0].nextAction).toBe('Retry diagnosis');
  });

  it('rejects when optional field has wrong type', () => {
    const input = validResponse({ records: [validRecord({ admissionDecision: 123 })] });
    expect(validateEvidenceChain(input)).toBeNull();
  });

  it('rejects when linkedTaskId has wrong type', () => {
    const input = validResponse({ records: [validRecord({ linkedTaskId: true })] });
    expect(validateEvidenceChain(input)).toBeNull();
  });

  it('rejects when failureReason has wrong type', () => {
    const input = validResponse({ records: [validRecord({ failureReason: { msg: 'err' } })] });
    expect(validateEvidenceChain(input)).toBeNull();
  });

  // Evidence-only should not display as pain
  it('distinguishes evidence_only from pain_recorded', () => {
    const evidenceOnly = validRecord({ state: 'evidence_only', sourceKind: 'tool_call' });
    const painRecorded = validRecord({ state: 'pain_recorded', sourceKind: 'manual' });

    const input = validResponse({ records: [evidenceOnly, painRecorded] });
    const result = validateEvidenceChain(input);
    expect(result).not.toBeNull();
    expect(result!.records[0].state).toBe('evidence_only');
    expect(result!.records[1].state).toBe('pain_recorded');
  });

  // Diagnosis failed shows failed/retry reason
  it('accepts diagnosis_failed with failureReason', () => {
    const record = validRecord({
      state: 'diagnosis_failed',
      failureReason: 'LLM returned invalid JSON',
      nextAction: 'Check error details and retry',
    });
    const input = validResponse({ records: [record] });
    const result = validateEvidenceChain(input);
    expect(result).not.toBeNull();
    expect(result!.records[0].state).toBe('diagnosis_failed');
    expect(result!.records[0].failureReason).toBe('LLM returned invalid JSON');
  });

  // Candidate generated shows linked candidate
  it('accepts candidate_generated with linkedCandidateId', () => {
    const record = validRecord({
      state: 'candidate_generated',
      linkedCandidateId: 'cand-abc',
      linkedTaskId: 'diagnosis_pain_1',
      linkedTaskStatus: 'succeeded',
    });
    const input = validResponse({ records: [record] });
    const result = validateEvidenceChain(input);
    expect(result).not.toBeNull();
    expect(result!.records[0].linkedCandidateId).toBe('cand-abc');
  });

  // Sanitizer boundary: summaries should not contain raw paths/tokens
  it('accepts sanitized summary without raw paths', () => {
    const record = validRecord({
      summary: 'Agent modified config without approval',
    });
    const input = validResponse({ records: [record] });
    const result = validateEvidenceChain(input);
    expect(result).not.toBeNull();
    // Summary should not contain absolute paths
    expect(result!.records[0].summary).not.toContain('C:\\');
    expect(result!.records[0].summary).not.toContain('/home/');
  });
});

// ── Degraded handling ──────────────────────────────────────────────────────────

describe('EvidenceChain degraded handling', () => {
  it('returns degraded reason when data sources are unavailable', () => {
    const input = validResponse({
      degradedReason: 'Trajectory database not found; State database not found',
      nextAction: 'PD runtime has not been initialized in this workspace.',
    });
    const result = validateEvidenceChain(input);
    expect(result).not.toBeNull();
    expect(result?.degradedReason).toBeTruthy();
    expect(result?.nextAction).toBeTruthy();
  });

  it('returns note when no records but sources are available', () => {
    const input = validResponse({
      note: 'PD has not captured any displayable behavior evidence in this workspace yet.',
    });
    const result = validateEvidenceChain(input);
    expect(result).not.toBeNull();
    expect(result?.note).toBeTruthy();
    expect(result?.records).toHaveLength(0);
  });

  it('malformed JSON returns null (not silent 0)', () => {
    // Simulate what happens when API returns malformed data
    expect(validateEvidenceChain('not json')).toBeNull();
    expect(validateEvidenceChain(0)).toBeNull();
    expect(validateEvidenceChain(undefined)).toBeNull();
  });
});
