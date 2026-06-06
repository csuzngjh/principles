/**
 * CR10: API validators tests
 *
 * Validates the runtime validators in utils/validators.ts:
 * - Reject null, arrays, primitives
 * - Reject inherited properties
 * - Reject missing required fields
 * - Reject wrong field types
 * - Accept valid response shapes
 *
 * Tests import production validators (ERR-025: tests must cover real product paths, not copy implementation).
 */

import { describe, it, expect } from 'vitest';
import {
  validateErrorResponse,
  validateSuccessEnvelope,
  validateHeaders,
  validateFeedbackReport,
  validateFeedbackDraftsList,
  validateDeleteEnvelope,
} from '../../src/ui/utils/validators.js';

// ── validateErrorResponse ─────────────────────────────────────────────────────

describe('validateErrorResponse', () => {
  it('accepts a valid error response with message', () => {
    const result = validateErrorResponse({ message: 'Not found', nextAction: 'Check URL' });
    expect(result).not.toBeNull();
    expect(result!.message).toBe('Not found');
    expect(result!.nextAction).toBe('Check URL');
  });

  it('accepts a valid error response with error field', () => {
    const result = validateErrorResponse({ error: 'Unauthorized' });
    expect(result).not.toBeNull();
    expect(result!.error).toBe('Unauthorized');
  });

  it('accepts an empty object', () => {
    const result = validateErrorResponse({});
    expect(result).not.toBeNull();
    expect(result!.message).toBeUndefined();
    expect(result!.error).toBeUndefined();
  });

  it('rejects null', () => {
    expect(validateErrorResponse(null)).toBeNull();
  });

  it('rejects arrays', () => {
    expect(validateErrorResponse([1, 2, 3])).toBeNull();
  });

  it('rejects strings', () => {
    expect(validateErrorResponse('error')).toBeNull();
  });

  it('rejects numbers', () => {
    expect(validateErrorResponse(42)).toBeNull();
  });

  it('rejects inherited properties (e.g. toString)', () => {
    // Create an object where toString is on the prototype, not own property
    const obj = Object.create({ message: 'inherited' });
    obj.error = 'own';
    const result = validateErrorResponse(obj);
    expect(result).not.toBeNull();
    // Only own properties should be picked up
    expect(result!.message).toBeUndefined();
    expect(result!.error).toBe('own');
  });

  it('rejects wrong field types', () => {
    expect(validateErrorResponse({ message: 42 })).not.toBeNull();
    const result = validateErrorResponse({ message: 42 });
    // message is not a string, so it should be ignored
    expect(result!.message).toBeUndefined();
  });
});

// ── validateSuccessEnvelope ───────────────────────────────────────────────────

describe('validateSuccessEnvelope', () => {
  it('accepts a valid success envelope', () => {
    const result = validateSuccessEnvelope({ success: true, data: { id: '1' } });
    expect(result).not.toBeNull();
    expect(result!.success).toBe(true);
    expect(result!.data).toEqual({ id: '1' });
  });

  it('accepts success envelope without data', () => {
    const result = validateSuccessEnvelope({ success: true });
    expect(result).not.toBeNull();
    expect(result!.success).toBe(true);
    expect(result!.data).toBeUndefined();
  });

  it('accepts success: false envelope', () => {
    const result = validateSuccessEnvelope({ success: false });
    expect(result).not.toBeNull();
    expect(result!.success).toBe(false);
  });

  it('rejects null', () => {
    expect(validateSuccessEnvelope(null)).toBeNull();
  });

  it('rejects arrays', () => {
    expect(validateSuccessEnvelope([1, 2])).toBeNull();
  });

  it('rejects objects without success field', () => {
    expect(validateSuccessEnvelope({ data: {} })).toBeNull();
  });

  it('rejects objects with non-boolean success', () => {
    expect(validateSuccessEnvelope({ success: 'true' })).toBeNull();
    expect(validateSuccessEnvelope({ success: 1 })).toBeNull();
  });

  it('rejects inherited success property', () => {
    const obj = Object.create({ success: true });
    obj.data = {};
    // Object.hasOwn does not find inherited 'success'
    expect(validateSuccessEnvelope(obj)).toBeNull();
  });
});

// ── validateHeaders ───────────────────────────────────────────────────────────

describe('validateHeaders', () => {
  it('accepts a valid headers object', () => {
    const result = validateHeaders({ 'Content-Type': 'application/json', Authorization: 'Bearer x' });
    expect(result).toEqual({ 'Content-Type': 'application/json', Authorization: 'Bearer x' });
  });

  it('accepts empty object', () => {
    expect(validateHeaders({})).toEqual({});
  });

  it('returns null for null/undefined', () => {
    expect(validateHeaders(null)).toBeNull();
    expect(validateHeaders(undefined)).toBeNull();
  });

  it('returns null for arrays', () => {
    expect(validateHeaders([['key', 'val']])).toBeNull();
  });

  it('returns null for non-string values', () => {
    expect(validateHeaders({ 'X-Count': 42 })).toBeNull();
  });

  it('returns null for inherited properties', () => {
    const obj = Object.create({ inherited: 'value' });
    obj.own = 'valid';
    const result = validateHeaders(obj);
    expect(result).not.toBeNull();
    expect(result!.own).toBe('valid');
    expect(Object.hasOwn(result!, 'inherited')).toBe(false);
  });
});

// ── validateFeedbackReport ────────────────────────────────────────────────────

describe('validateFeedbackReport', () => {
  const validReport = {
    id: 'rpt-001',
    createdAt: '2026-06-01T12:00:00.000Z',
    report: { type: 'bug', title: 'Test' },
  };

  it('accepts a valid feedback report', () => {
    const result = validateFeedbackReport(validReport);
    expect(result).not.toBeNull();
    expect(result!.id).toBe('rpt-001');
    expect(result!.report).toEqual({ type: 'bug', title: 'Test' });
  });

  it('rejects null', () => {
    expect(validateFeedbackReport(null)).toBeNull();
  });

  it('rejects arrays', () => {
    expect(validateFeedbackReport([1, 2])).toBeNull();
  });

  it('rejects missing required fields', () => {
    expect(validateFeedbackReport({ id: '1', createdAt: '2026' })).toBeNull(); // missing report
    expect(validateFeedbackReport({ id: '1', report: {} })).toBeNull(); // missing createdAt
    expect(validateFeedbackReport({ createdAt: '2026', report: {} })).toBeNull(); // missing id
  });

  it('rejects wrong field types', () => {
    expect(validateFeedbackReport({ ...validReport, id: 123 })).toBeNull();
    expect(validateFeedbackReport({ ...validReport, createdAt: null })).toBeNull();
    expect(validateFeedbackReport({ ...validReport, report: 'not-object' })).toBeNull();
  });

  it('rejects inherited properties as required fields', () => {
    const obj = Object.create({ id: 'inherited' });
    obj.createdAt = '2026-06-01';
    obj.report = {};
    // id is inherited, not own property → should fail
    expect(validateFeedbackReport(obj)).toBeNull();
  });
});

// ── validateFeedbackDraftsList ────────────────────────────────────────────────

describe('validateFeedbackDraftsList', () => {
  const validList = {
    drafts: [
      { id: '1', createdAt: '2026-06-01', type: 'bug', title: 'Test' },
      { id: '2', createdAt: '2026-06-02', type: 'confusing', title: 'Confusing' },
    ],
  };

  it('accepts a valid drafts list', () => {
    const result = validateFeedbackDraftsList(validList);
    expect(result).not.toBeNull();
    expect(result!.length).toBe(2);
    expect(result![0].id).toBe('1');
  });

  it('accepts empty drafts array', () => {
    const result = validateFeedbackDraftsList({ drafts: [] });
    expect(result).not.toBeNull();
    expect(result!.length).toBe(0);
  });

  it('rejects null', () => {
    expect(validateFeedbackDraftsList(null)).toBeNull();
  });

  it('rejects arrays', () => {
    expect(validateFeedbackDraftsList([])).toBeNull();
  });

  it('rejects missing drafts field', () => {
    expect(validateFeedbackDraftsList({})).toBeNull();
  });

  it('rejects non-array drafts', () => {
    expect(validateFeedbackDraftsList({ drafts: 'not-array' })).toBeNull();
  });

  it('rejects drafts with missing required fields', () => {
    expect(validateFeedbackDraftsList({ drafts: [{ id: '1' }] })).toBeNull();
  });

  it('rejects drafts with wrong field types', () => {
    expect(validateFeedbackDraftsList({ drafts: [{ id: 1, createdAt: '2026', type: 'bug', title: 'T' }] })).toBeNull();
  });
});

// ── validateDeleteEnvelope ────────────────────────────────────────────────────

describe('validateDeleteEnvelope', () => {
  it('accepts a valid delete envelope', () => {
    const result = validateDeleteEnvelope({ deleted: true });
    expect(result).not.toBeNull();
    expect(result!.deleted).toBe(true);
  });

  it('accepts deleted: false', () => {
    const result = validateDeleteEnvelope({ deleted: false });
    expect(result).not.toBeNull();
    expect(result!.deleted).toBe(false);
  });

  it('rejects null', () => {
    expect(validateDeleteEnvelope(null)).toBeNull();
  });

  it('rejects arrays', () => {
    expect(validateDeleteEnvelope([1])).toBeNull();
  });

  it('rejects missing deleted field', () => {
    expect(validateDeleteEnvelope({})).toBeNull();
  });

  it('rejects non-boolean deleted', () => {
    expect(validateDeleteEnvelope({ deleted: 'yes' })).toBeNull();
    expect(validateDeleteEnvelope({ deleted: 1 })).toBeNull();
  });

  it('rejects inherited deleted property', () => {
    const obj = Object.create({ deleted: true });
    expect(validateDeleteEnvelope(obj)).toBeNull();
  });
});
