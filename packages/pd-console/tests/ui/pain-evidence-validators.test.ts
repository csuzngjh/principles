import { describe, it, expect } from 'vitest';
import {
  derivePainEvidenceFromPrinciple,
  derivePainEvidenceFromPrinciplesList,
  isDegraded,
  getErrorMessage,
} from '../../src/ui/pages/pain/PainEvidenceValidators.js';

// ---------------------------------------------------------------------------
// Validators used by the PainPage React component.
// The vitest config in this package uses the `node` environment, so we test
// the pure validators directly without rendering React.
// ---------------------------------------------------------------------------

const PRINCIPLE_WITH_PAIN = {
  id: 'principle-001',
  text: 'Always show change scope before modifying config files',
  triggerPattern: 'Agent modifies configuration without presenting impact',
  action: 'Present the change scope and get acknowledgment before modifying config',
  status: 'active',
  painPreventedCount: 3,
  derivedFromPainIds: ['pain-001', 'pain-002'],
  lastPainPreventedAt: '2026-06-01T09:18:00.000Z',
  createdAt: '2026-05-20T14:30:00.000Z',
};

const PRINCIPLE_NO_PAIN = {
  id: 'principle-002',
  text: 'Use conventional commits',
  triggerPattern: 'Agent creates non-standard commit messages',
  action: 'Follow conventional commit format',
  status: 'active',
  createdAt: '2026-05-21T10:00:00.000Z',
};

// ── derivePainEvidenceFromPrinciple ───────────────────────────────────────────

describe('derivePainEvidenceFromPrinciple', () => {
  it('derives evidence from a principle with pain data', () => {
    const result = derivePainEvidenceFromPrinciple(PRINCIPLE_WITH_PAIN);
    expect(result).not.toBeNull();
    expect(result?.id).toBe('principle-001');
    expect(result?.title).toBe('Always show change scope before modifying config files');
    expect(result?.context).toBe('Agent modifies configuration without presenting impact');
    expect(result?.expectedBehavior).toBe('Present the change scope and get acknowledgment before modifying config');
    expect(result?.source).toBe('principle_derivation');
    expect(result?.recommendationState).toBe('principle'); // active → principle
    expect(result?.trajectorySummary.painPreventedCount).toBe(3);
    expect(result?.trajectorySummary.derivedFromPainIds).toEqual(['pain-001', 'pain-002']);
    expect(result?.trajectorySummary.lastPainPreventedAt).toBe('2026-06-01T09:18:00.000Z');
  });

  it('returns null for a principle with no pain data', () => {
    expect(derivePainEvidenceFromPrinciple(PRINCIPLE_NO_PAIN)).toBeNull();
  });

  it('returns null for null input', () => {
    expect(derivePainEvidenceFromPrinciple(null)).toBeNull();
  });

  it('returns null for non-object input', () => {
    expect(derivePainEvidenceFromPrinciple('string')).toBeNull();
    expect(derivePainEvidenceFromPrinciple(42)).toBeNull();
  });

  it('returns null when id is missing', () => {
    const { id: _, ...noId } = PRINCIPLE_WITH_PAIN;
    expect(derivePainEvidenceFromPrinciple(noId)).toBeNull();
  });

  it('returns null when text is missing', () => {
    const { text: _, ...noText } = PRINCIPLE_WITH_PAIN;
    expect(derivePainEvidenceFromPrinciple(noText)).toBeNull();
  });

  it('derives evidence from principle with only painPreventedCount > 0', () => {
    const input = { ...PRINCIPLE_NO_PAIN, painPreventedCount: 1 };
    const result = derivePainEvidenceFromPrinciple(input);
    expect(result).not.toBeNull();
    expect(result?.trajectorySummary.painPreventedCount).toBe(1);
  });

  it('derives evidence from principle with only derivedFromPainIds', () => {
    const input = { ...PRINCIPLE_NO_PAIN, derivedFromPainIds: ['pain-003'] };
    const result = derivePainEvidenceFromPrinciple(input);
    expect(result).not.toBeNull();
    expect(result?.trajectorySummary.derivedFromPainIds).toEqual(['pain-003']);
  });

  it('derives evidence from principle with only lastPainPreventedAt', () => {
    const input = { ...PRINCIPLE_NO_PAIN, lastPainPreventedAt: '2026-06-01T09:18:00.000Z' };
    const result = derivePainEvidenceFromPrinciple(input);
    expect(result).not.toBeNull();
    expect(result?.trajectorySummary.lastPainPreventedAt).toBe('2026-06-01T09:18:00.000Z');
  });

  it('maps candidate status to pending recommendationState', () => {
    const input = { ...PRINCIPLE_WITH_PAIN, status: 'candidate' };
    const result = derivePainEvidenceFromPrinciple(input);
    expect(result?.recommendationState).toBe('pending');
  });

  it('maps probation status to candidate recommendationState', () => {
    const input = { ...PRINCIPLE_WITH_PAIN, status: 'probation' };
    const result = derivePainEvidenceFromPrinciple(input);
    expect(result?.recommendationState).toBe('candidate');
  });

  it('maps archived status to dismissed recommendationState', () => {
    const input = { ...PRINCIPLE_WITH_PAIN, status: 'archived' };
    const result = derivePainEvidenceFromPrinciple(input);
    expect(result?.recommendationState).toBe('dismissed');
  });

  it('maps deprecated status to dismissed recommendationState', () => {
    const input = { ...PRINCIPLE_WITH_PAIN, status: 'deprecated' };
    const result = derivePainEvidenceFromPrinciple(input);
    expect(result?.recommendationState).toBe('dismissed');
  });

  it('maps unknown status to pending recommendationState', () => {
    const input = { ...PRINCIPLE_WITH_PAIN, status: 'unknown_status' };
    const result = derivePainEvidenceFromPrinciple(input);
    expect(result?.recommendationState).toBe('pending');
  });

  it('filters non-string elements from derivedFromPainIds', () => {
    const input = { ...PRINCIPLE_WITH_PAIN, derivedFromPainIds: ['pain-001', 123, null, 'pain-002'] };
    const result = derivePainEvidenceFromPrinciple(input);
    expect(result?.trajectorySummary.derivedFromPainIds).toEqual(['pain-001', 'pain-002']);
  });

  it('uses detail data when provided', () => {
    const listItem = { id: 'p-1', text: 'Test', painPreventedCount: 0 };
    const detail = { painPreventedCount: 5, derivedFromPainIds: ['pain-005'], lastPainPreventedAt: '2026-06-02T10:00:00.000Z' };
    const result = derivePainEvidenceFromPrinciple(listItem, detail);
    expect(result).not.toBeNull();
    expect(result?.trajectorySummary.painPreventedCount).toBe(5);
    expect(result?.trajectorySummary.derivedFromPainIds).toEqual(['pain-005']);
  });

  it('defaults missing optional fields to empty strings', () => {
    const input = { id: 'p-1', text: 'Test', painPreventedCount: 1 };
    const result = derivePainEvidenceFromPrinciple(input);
    expect(result).not.toBeNull();
    expect(result?.context).toBe('');
    expect(result?.expectedBehavior).toBe('');
  });

  it('uses current timestamp when createdAt is missing', () => {
    const input = { id: 'p-1', text: 'Test', painPreventedCount: 1 };
    const result = derivePainEvidenceFromPrinciple(input);
    expect(result).not.toBeNull();
    expect(result?.createdAt).toBeTruthy();
  });
});

// ── derivePainEvidenceFromPrinciplesList ──────────────────────────────────────

describe('derivePainEvidenceFromPrinciplesList', () => {
  it('derives evidence from a valid principles list', () => {
    const input = {
      principles: [PRINCIPLE_WITH_PAIN, PRINCIPLE_NO_PAIN],
    };
    const result = derivePainEvidenceFromPrinciplesList(input);
    expect(isDegraded(result)).toBe(false);
    if (!isDegraded(result)) {
      expect(result.evidence).toHaveLength(1); // only principle with pain data
      expect(result.evidence[0].id).toBe('principle-001');
      expect(result.generatedAt).toBeTruthy();
    }
  });

  it('returns degraded for null input', () => {
    const result = derivePainEvidenceFromPrinciplesList(null);
    expect(isDegraded(result)).toBe(true);
    if (isDegraded(result)) {
      expect(result.reason).toBeTruthy();
      expect(result.nextAction).toBeTruthy();
    }
  });

  it('returns degraded for non-object input', () => {
    const result = derivePainEvidenceFromPrinciplesList('not an object');
    expect(isDegraded(result)).toBe(true);
  });

  it('returns degraded when principles array is missing', () => {
    const result = derivePainEvidenceFromPrinciplesList({ other: 'data' });
    expect(isDegraded(result)).toBe(true);
  });

  it('returns empty evidence for empty principles array', () => {
    const result = derivePainEvidenceFromPrinciplesList({ principles: [] });
    expect(isDegraded(result)).toBe(false);
    if (!isDegraded(result)) {
      expect(result.evidence).toHaveLength(0);
    }
  });

  it('returns empty evidence when no principles have pain data', () => {
    const result = derivePainEvidenceFromPrinciplesList({ principles: [PRINCIPLE_NO_PAIN] });
    expect(isDegraded(result)).toBe(false);
    if (!isDegraded(result)) {
      expect(result.evidence).toHaveLength(0);
    }
  });

  it('filters out malformed principle items', () => {
    const input = {
      principles: [PRINCIPLE_WITH_PAIN, null, 'string', { id: 123 }],
    };
    const result = derivePainEvidenceFromPrinciplesList(input);
    expect(isDegraded(result)).toBe(false);
    if (!isDegraded(result)) {
      expect(result.evidence).toHaveLength(1);
    }
  });

  it('derives multiple evidence items', () => {
    const principle2 = {
      ...PRINCIPLE_WITH_PAIN,
      id: 'principle-003',
      painPreventedCount: 1,
    };
    const input = {
      principles: [PRINCIPLE_WITH_PAIN, principle2],
    };
    const result = derivePainEvidenceFromPrinciplesList(input);
    expect(isDegraded(result)).toBe(false);
    if (!isDegraded(result)) {
      expect(result.evidence).toHaveLength(2);
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
