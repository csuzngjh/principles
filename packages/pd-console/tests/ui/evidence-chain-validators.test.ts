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
  validateIntentTension,
  type EvidenceChainData,
  type EvidenceChainRecordData,
  type IntentTensionData,
} from '../../src/ui/utils/validators.js';

// ── Valid record factory ───────────────────────────────────────────────────────

function validRecord(overrides?: Partial<EvidenceChainRecordData>): EvidenceChainRecordData {
  return {
    id: 'pain_1',
    sourceKind: 'manual',
    observedAt: '2026-06-07T10:00:00.000Z',
    state: 'recorded-only',
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
    expect(record.state).toBe('recorded-only');
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
      'recorded-only',
      'evidence-only',
      'diagnosis-queued',
      'diagnosis-running',
      'diagnosis-succeeded',
      'diagnosis-failed',
      'diagnosis-retry-wait',
      'candidate-generated',
      'internalization-missing',
      'internalization-pending',
      'internalization-running',
      'internalization-failed',
      'internalization-succeeded',
      'owner-reviewable',
      'malformed',
      'degraded',
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

  // Evidence-only must be a distinct state from recorded-only (PRI-385 P1-2).
  // The previous assertion claimed to "distinguish" the two but gave both the same
  // `recorded-only` state — a vacuous test. evidence_only observations now carry their
  // own `evidence-only` state so they cannot be grouped into the active pain chain.
  it('distinguishes evidence_only (evidence-only) from store_signal (recorded-only)', () => {
    const evidenceOnly = validRecord({ state: 'evidence-only', sourceKind: 'tool_call' });
    const painRecorded = validRecord({ state: 'recorded-only', sourceKind: 'manual' });

    const input = validResponse({ records: [evidenceOnly, painRecorded] });
    const result = validateEvidenceChain(input);
    expect(result).not.toBeNull();
    expect(result!.records[0].state).toBe('evidence-only');
    expect(result!.records[1].state).toBe('recorded-only');
    expect(result!.records[0].state).not.toBe(result!.records[1].state);
  });

  // Diagnosis failed shows failed/retry reason
  it('accepts diagnosis_failed with failureReason', () => {
    const record = validRecord({
      state: 'diagnosis-failed',
      failureReason: 'LLM returned invalid JSON',
      nextAction: 'Check error details and retry',
    });
    const input = validResponse({ records: [record] });
    const result = validateEvidenceChain(input);
    expect(result).not.toBeNull();
    expect(result!.records[0].state).toBe('diagnosis-failed');
    expect(result!.records[0].failureReason).toBe('LLM returned invalid JSON');
  });

  // Candidate generated shows linked candidate
  it('accepts candidate_generated with linkedCandidateId', () => {
    const record = validRecord({
      state: 'candidate-generated',
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

// ── PRI-469: intentTension validation ─────────────────────────────────────────

function validIntentTension(overrides?: Partial<IntentTensionData>): Record<string, unknown> {
  return {
    source: 'action_drift',
    evidenceStrength: 'strong',
    relatedIntentFields: ['current_strategic_focus', 'non_negotiables'],
    evidence: ['e1', 'e2', 'e3'],
    explanation: 'The work optimized presentation completeness before validating the learning loop.',
    suggestedOwnerAction: 'confirm_drift',
    intentDocHash: 'sha256:abc123',
    ...overrides,
  };
}

describe('validateIntentTension (PRI-469)', () => {
  it('accepts a valid intentTension', () => {
    const result = validateIntentTension(validIntentTension());
    expect(result).not.toBeNull();
    expect(result!.source).toBe('action_drift');
    expect(result!.evidenceStrength).toBe('strong');
    expect(result!.relatedIntentFields).toEqual(['current_strategic_focus', 'non_negotiables']);
    expect(result!.evidence).toHaveLength(3);
    expect(result!.suggestedOwnerAction).toBe('confirm_drift');
    expect(result!.intentDocHash).toBe('sha256:abc123');
  });

  it('rejects intentTension.confidence (SPEC §16.3)', () => {
    const malicious = validIntentTension();
    (malicious as Record<string, unknown>).confidence = 0.92;
    expect(validateIntentTension(malicious)).toBeNull();
  });

  it('rejects null and non-object input', () => {
    expect(validateIntentTension(null)).toBeNull();
    expect(validateIntentTension('string')).toBeNull();
    expect(validateIntentTension(42)).toBeNull();
    expect(validateIntentTension([])).toBeNull();
  });

  it('rejects missing required source', () => {
    const noSource = validIntentTension();
    delete (noSource as Record<string, unknown>).source;
    expect(validateIntentTension(noSource)).toBeNull();
  });

  it('rejects invalid source enum', () => {
    expect(validateIntentTension(validIntentTension({ source: 'definitely_drift' }))).toBeNull();
  });

  it('rejects invalid evidenceStrength enum', () => {
    expect(validateIntentTension(validIntentTension({ evidenceStrength: 'very_strong' }))).toBeNull();
  });

  it('rejects invalid suggestedOwnerAction enum', () => {
    expect(validateIntentTension(validIntentTension({ suggestedOwnerAction: 'auto_apply' }))).toBeNull();
  });

  it('rejects non-array relatedIntentFields', () => {
    const malformed = validIntentTension();
    (malformed as Record<string, unknown>).relatedIntentFields = 'not an array';
    expect(validateIntentTension(malformed)).toBeNull();
  });

  it('rejects relatedIntentFields with invalid enum element', () => {
    const malformed = validIntentTension();
    (malformed as Record<string, unknown>).relatedIntentFields = ['why', 'invalid_field'];
    expect(validateIntentTension(malformed)).toBeNull();
  });

  it('rejects non-array evidence', () => {
    const malformed = validIntentTension();
    (malformed as Record<string, unknown>).evidence = 'not an array';
    expect(validateIntentTension(malformed)).toBeNull();
  });

  it('rejects evidence with non-string element', () => {
    const malformed = validIntentTension();
    (malformed as Record<string, unknown>).evidence = ['e1', 42, 'e3'];
    expect(validateIntentTension(malformed)).toBeNull();
  });

  it('truncates evidence to max 3 items (SPEC §16.4)', () => {
    const oversized = validIntentTension();
    (oversized as Record<string, unknown>).evidence = ['e1', 'e2', 'e3', 'e4', 'e5'];
    const result = validateIntentTension(oversized);
    expect(result).not.toBeNull();
    expect(result!.evidence).toHaveLength(3);
    expect(result!.evidence).toEqual(['e1', 'e2', 'e3']);
  });

  it('rejects empty explanation', () => {
    expect(validateIntentTension(validIntentTension({ explanation: '' }))).toBeNull();
  });

  it('accepts intentTension without optional intentDocHash', () => {
    const noHash = validIntentTension();
    delete (noHash as Record<string, unknown>).intentDocHash;
    const result = validateIntentTension(noHash);
    expect(result).not.toBeNull();
    expect(result!.intentDocHash).toBeUndefined();
  });

  it('rejects non-string intentDocHash when present', () => {
    const malformed = validIntentTension();
    (malformed as Record<string, unknown>).intentDocHash = 123;
    expect(validateIntentTension(malformed)).toBeNull();
  });
});

describe('validateEvidenceChainRecord with intentTension (PRI-469)', () => {
  it('accepts a record with valid intentTension', () => {
    const record = validRecord({
      state: 'diagnosis-succeeded',
      intentTension: validIntentTension() as unknown as IntentTensionData,
    });
    const input = validResponse({ records: [record] });
    const result = validateEvidenceChain(input);
    expect(result).not.toBeNull();
    expect(result!.records[0].intentTension).toBeDefined();
    expect(result!.records[0].intentTension!.source).toBe('action_drift');
  });

  it('drops intentTension when malformed but keeps the rest of the record', () => {
    const malformedTension = validIntentTension();
    (malformedTension as Record<string, unknown>).confidence = 0.5; // SPEC §16.3 violation
    const record = validRecord({
      state: 'diagnosis-succeeded',
      intentTension: malformedTension as unknown as IntentTensionData,
    });
    const input = validResponse({ records: [record] });
    const result = validateEvidenceChain(input);
    // Record is still valid — just without intentTension
    expect(result).not.toBeNull();
    expect(result!.records[0].id).toBe('pain_1');
    expect(result!.records[0].intentTension).toBeUndefined();
  });

  it('accepts a record without intentTension (backward compat)', () => {
    const record = validRecord({ state: 'recorded-only' });
    const input = validResponse({ records: [record] });
    const result = validateEvidenceChain(input);
    expect(result).not.toBeNull();
    expect(result!.records[0].intentTension).toBeUndefined();
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
