import { describe, it, expect } from 'vitest';
import {
  parseTrajectorySummary,
  parsePainEvidence,
  parsePainEvidenceListResponse,
  isDegraded,
  getErrorMessage,
} from '../../src/ui/pages/pain/PainEvidenceValidators.js';

// ---------------------------------------------------------------------------
// Validators used by the PainPage React component.
// The vitest config in this package uses the `node` environment, so we test
// the pure validators directly without rendering React.
// ---------------------------------------------------------------------------

const VALID_TRAJECTORY = {
  taskId: 'task-001',
  toolName: 'write_file',
  timestamp: '2026-06-01T09:18:00.000Z',
};

const VALID_EVIDENCE = {
  id: 'pain-001',
  title: 'Modified config without showing impact',
  context: 'Agent was modifying configuration files during a coding task',
  agentBehavior: 'Called write_file on config.yml without presenting the change scope first',
  expectedBehavior: 'Should have shown the impact range before modifying',
  source: 'tool_call',
  recommendationState: 'pending',
  trajectorySummary: VALID_TRAJECTORY,
  createdAt: '2026-06-01T09:18:00.000Z',
};

// ── parseTrajectorySummary ────────────────────────────────────────────────────

describe('parseTrajectorySummary', () => {
  it('returns parsed object for a well-formed payload', () => {
    const result = parseTrajectorySummary(VALID_TRAJECTORY);
    expect(result).not.toBeNull();
    expect(result?.taskId).toBe('task-001');
    expect(result?.toolName).toBe('write_file');
    expect(result?.timestamp).toBe('2026-06-01T09:18:00.000Z');
  });

  it('returns null for null input', () => {
    expect(parseTrajectorySummary(null)).toBeNull();
  });

  it('returns null for non-object input', () => {
    expect(parseTrajectorySummary('string')).toBeNull();
    expect(parseTrajectorySummary(42)).toBeNull();
    expect(parseTrajectorySummary(true)).toBeNull();
  });

  it('returns null when required fields are missing', () => {
    expect(parseTrajectorySummary({ taskId: 'x' })).toBeNull();
    expect(parseTrajectorySummary({ taskId: 'x', toolName: 'y' })).toBeNull();
  });

  it('returns null when required fields are wrong type', () => {
    expect(parseTrajectorySummary({ taskId: 123, toolName: 'y', timestamp: 'z' })).toBeNull();
  });
});

// ── parsePainEvidence ─────────────────────────────────────────────────────────

describe('parsePainEvidence', () => {
  it('returns parsed PainEvidence for a well-formed payload', () => {
    const result = parsePainEvidence(VALID_EVIDENCE);
    expect(result).not.toBeNull();
    expect(result?.id).toBe('pain-001');
    expect(result?.title).toBe('Modified config without showing impact');
    expect(result?.source).toBe('tool_call');
    expect(result?.recommendationState).toBe('pending');
    expect(result?.trajectorySummary.taskId).toBe('task-001');
  });

  it('defaults expectedBehavior to empty string when missing', () => {
    const input = { ...VALID_EVIDENCE };
    // Remove expectedBehavior
    const { expectedBehavior: _, ...withoutExpected } = input;
    const result = parsePainEvidence(withoutExpected);
    expect(result).not.toBeNull();
    expect(result?.expectedBehavior).toBe('');
  });

  it('preserves expectedBehavior when provided', () => {
    const result = parsePainEvidence(VALID_EVIDENCE);
    expect(result?.expectedBehavior).toBe('Should have shown the impact range before modifying');
  });

  it('returns null for null input', () => {
    expect(parsePainEvidence(null)).toBeNull();
  });

  it('returns null for non-object input', () => {
    expect(parsePainEvidence('string')).toBeNull();
  });

  it('returns null when required string fields are missing', () => {
    const { id: _, ...noId } = VALID_EVIDENCE;
    expect(parsePainEvidence(noId)).toBeNull();
  });

  it('returns null when source is invalid', () => {
    expect(parsePainEvidence({ ...VALID_EVIDENCE, source: 'invalid' })).toBeNull();
  });

  it('returns null when recommendationState is invalid', () => {
    expect(parsePainEvidence({ ...VALID_EVIDENCE, recommendationState: 'unknown' })).toBeNull();
  });

  it('returns null when trajectorySummary is invalid', () => {
    expect(parsePainEvidence({ ...VALID_EVIDENCE, trajectorySummary: null })).toBeNull();
    expect(parsePainEvidence({ ...VALID_EVIDENCE, trajectorySummary: {} })).toBeNull();
  });

  it('accepts all valid source values', () => {
    expect(parsePainEvidence({ ...VALID_EVIDENCE, source: 'tool_call' })?.source).toBe('tool_call');
    expect(parsePainEvidence({ ...VALID_EVIDENCE, source: 'prompt' })?.source).toBe('prompt');
  });

  it('accepts all valid recommendationState values', () => {
    for (const state of ['pending', 'candidate', 'principle', 'dismissed'] as const) {
      expect(parsePainEvidence({ ...VALID_EVIDENCE, recommendationState: state })?.recommendationState).toBe(state);
    }
  });
});

// ── parsePainEvidenceListResponse ─────────────────────────────────────────────

describe('parsePainEvidenceListResponse', () => {
  it('returns valid data for a well-formed response', () => {
    const input = {
      evidence: [VALID_EVIDENCE],
      generatedAt: '2026-06-01T10:00:00.000Z',
    };
    const result = parsePainEvidenceListResponse(input);
    expect(isDegraded(result)).toBe(false);
    if (!isDegraded(result)) {
      expect(result.evidence).toHaveLength(1);
      expect(result.evidence[0].id).toBe('pain-001');
      expect(result.generatedAt).toBe('2026-06-01T10:00:00.000Z');
    }
  });

  it('returns degraded for null input', () => {
    const result = parsePainEvidenceListResponse(null);
    expect(isDegraded(result)).toBe(true);
    if (isDegraded(result)) {
      expect(result.reason).toBeTruthy();
      expect(result.nextAction).toBeTruthy();
    }
  });

  it('returns degraded for non-object input', () => {
    const result = parsePainEvidenceListResponse('not an object');
    expect(isDegraded(result)).toBe(true);
  });

  it('returns degraded when generatedAt is missing', () => {
    const result = parsePainEvidenceListResponse({ evidence: [] });
    expect(isDegraded(result)).toBe(true);
  });

  it('returns empty evidence array when evidence field is missing', () => {
    const result = parsePainEvidenceListResponse({ generatedAt: '2026-06-01T10:00:00.000Z' });
    expect(isDegraded(result)).toBe(false);
    if (!isDegraded(result)) {
      expect(result.evidence).toHaveLength(0);
    }
  });

  it('filters out malformed evidence items', () => {
    const input = {
      evidence: [VALID_EVIDENCE, { id: 123 }, null, 'string'],
      generatedAt: '2026-06-01T10:00:00.000Z',
    };
    const result = parsePainEvidenceListResponse(input);
    expect(isDegraded(result)).toBe(false);
    if (!isDegraded(result)) {
      expect(result.evidence).toHaveLength(1);
    }
  });

  it('preserves note field when present', () => {
    const input = {
      evidence: [],
      generatedAt: '2026-06-01T10:00:00.000Z',
      note: 'Pain evidence endpoint not yet available',
    };
    const result = parsePainEvidenceListResponse(input);
    expect(isDegraded(result)).toBe(false);
    if (!isDegraded(result)) {
      expect(result.note).toBe('Pain evidence endpoint not yet available');
    }
  });

  it('ignores non-string note field', () => {
    const input = {
      evidence: [],
      generatedAt: '2026-06-01T10:00:00.000Z',
      note: 42,
    };
    const result = parsePainEvidenceListResponse(input);
    expect(isDegraded(result)).toBe(false);
    if (!isDegraded(result)) {
      expect(result.note).toBeUndefined();
    }
  });

  it('returns empty evidence for empty array', () => {
    const input = {
      evidence: [],
      generatedAt: '2026-06-01T10:00:00.000Z',
    };
    const result = parsePainEvidenceListResponse(input);
    expect(isDegraded(result)).toBe(false);
    if (!isDegraded(result)) {
      expect(result.evidence).toHaveLength(0);
    }
  });
});

// ── isDegraded ────────────────────────────────────────────────────────────────

describe('isDegraded', () => {
  it('returns true for degraded results', () => {
    const degraded = { reason: 'error', nextAction: 'retry' };
    expect(isDegraded(degraded)).toBe(true);
  });

  it('returns false for valid data', () => {
    const valid = { evidence: [], generatedAt: '2026-06-01T10:00:00.000Z' };
    expect(isDegraded(valid)).toBe(false);
  });
});

// ── getErrorMessage ───────────────────────────────────────────────────────────

describe('getErrorMessage', () => {
  it('extracts message from Error instances', () => {
    expect(getErrorMessage(new Error('test error'))).toBe('test error');
  });

  it('returns string directly', () => {
    expect(getErrorMessage('string error')).toBe('string error');
  });

  it('returns default for unknown types', () => {
    expect(getErrorMessage(42)).toBe('Unknown error');
    expect(getErrorMessage(null)).toBe('Unknown error');
    expect(getErrorMessage(undefined)).toBe('Unknown error');
  });
});
