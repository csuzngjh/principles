import { describe, expect, it } from 'vitest';
import { validateAdaptiveDeliveryRecord } from '../adaptive-delivery-record.js';

const base = (overrides: Record<string, unknown> = {}) => ({
  hookInvocationId: 'hook-1',
  requestId: 'request-1',
  receiptState: 'closed',
  execution: 'completed',
  payload: 'returned',
  selection: 'selected',
  submission: 'unknown',
  ...overrides,
});

const accepted = (record: unknown) => expect(validateAdaptiveDeliveryRecord(record)).toEqual({ ok: true, errors: [] });
const rejected = (record: unknown) => expect(validateAdaptiveDeliveryRecord(record).ok).toBe(false);

describe('validateAdaptiveDeliveryRecord', () => {
  it('accepts open receipts only in the pending initialization state', () => {
    accepted(base({
      receiptState: 'open', execution: 'unknown', payload: 'unknown', selection: 'unavailable', selectionPending: true,
    }));
    rejected(base({ receiptState: 'open', selection: 'unavailable', selectionPending: true }));
    rejected(base({ receiptState: 'open', execution: 'unknown', payload: 'unknown', selection: 'unavailable', submission: 'unknown' }));
    rejected(base({ selectionPending: true }));
  });

  it('requires independent confirmation and submission evidence, never receipt-state inference', () => {
    accepted(base({ payload: 'confirmed', evidence: { reference: 'evidence://request-1', independentlyVerified: true } }));
    rejected(base({ payload: 'confirmed' }));
    rejected(base({ payload: 'confirmed', evidence: { reference: 'evidence://request-1', independentlyVerified: false } }));
    accepted(base({ receiptState: 'closed', execution: 'unknown', payload: 'unknown' }));
    accepted(base({ receiptState: 'reconciled', execution: 'completed', payload: 'unknown' }));
    accepted(base({ submission: 'proceeded', evidence: { reference: 'host://submission', independentlyVerified: true } }));
    rejected(base({ submission: 'blocked' }));
    rejected(base({ submission: 'proceeded', evidence: { reference: 'host://submission' } }));
    rejected(base({ submission: 'proceeded', evidence: { reference: 'host://submission', independentlyVerified: false } }));
  });

  it('keeps target payload none distinct from the Native fallback payload', () => {
    accepted(base({ execution: 'degraded', payload: 'none', selection: 'selected' }));
    rejected(base({ execution: 'degraded', payload: 'returned' }));
    rejected(base({ execution: 'failed', payload: 'confirmed' }));
    rejected(base({ execution: 'timeout', payload: 'prepared' }));
  });

  it('requires independent host-kill evidence for timeout while allowing valid failures', () => {
    accepted(base({
      execution: 'timeout', payload: 'none',
      evidence: { reference: 'host://kill', independentlyVerified: true, hostKillConfirmed: true },
    }));
    rejected(base({ execution: 'timeout', payload: 'none' }));
    accepted(base({ execution: 'failed', payload: 'unknown', selection: 'unavailable' }));
    accepted(base({ execution: 'degraded', payload: 'unknown', selection: 'skipped' }));
  });

  it('enforces completed empty selection and prevents unavailable selection claiming a target payload', () => {
    accepted(base({ execution: 'completed', payload: 'none', selection: 'none_applicable' }));
    rejected(base({ execution: 'degraded', payload: 'none', selection: 'none_applicable' }));
    rejected(base({ execution: 'completed', payload: 'unknown', selection: 'none_applicable' }));
    accepted(base({ execution: 'failed', payload: 'unknown', selection: 'unavailable' }));
    rejected(base({ payload: 'prepared', selection: 'unavailable' }));
    accepted(base({ payload: 'unknown', selection: 'skipped' }));
  });

  it('rejects malformed and prototype-forged records without invoking accessors', () => {
    rejected(null);
    rejected([]);
    rejected(Object.create({ hookInvocationId: 'forged' }));
    rejected({ ...base(), evidence: Object.create({ reference: 'forged' }) });
    let invoked = false;
    const record = base();
    Object.defineProperty(record, 'hookInvocationId', { enumerable: true, get() { invoked = true; return 'hook-1'; } });
    rejected(record);
    expect(invoked).toBe(false);
    const forged = base();
    Object.defineProperty(forged, '__proto__', { enumerable: true, value: { hookInvocationId: 'forged' } });
    rejected(forged);
  });

  it('allows legacy data fields without mutation and rejects null-prototype records', () => {
    const source = base({ legacyField: { nested: ['keep'] }, payload: 'none', execution: 'degraded' });
    const before = structuredClone(source);
    accepted(source);
    expect(source).toEqual(before);
    rejected(Object.assign(Object.create(null), base({ payload: 'unknown' })));
  });

  it('rejects invalid identifiers, enum values, and malformed optional evidence', () => {
    rejected(base({ hookInvocationId: '  ' }));
    const missingInvocationId: Record<string, unknown> = base();
    delete missingInvocationId.hookInvocationId;
    rejected(missingInvocationId);
    const missingEnum: Record<string, unknown> = base();
    delete missingEnum.receiptState;
    rejected(missingEnum);
    rejected(base({ requestId: '' }));
    rejected(base({ receiptState: 'success' }));
    rejected(base({ evidence: undefined }));
    rejected(base({ evidence: { reference: '' } }));
    rejected(base({ evidence: { independentlyVerified: 'yes' } }));
  });

  it('does not treat open, closed, or reconciled as success outcomes', () => {
    rejected(base({ receiptState: 'open', execution: 'completed', payload: 'returned' }));
    accepted(base({ receiptState: 'closed', execution: 'unknown', payload: 'unknown' }));
    accepted(base({ receiptState: 'reconciled', execution: 'failed', payload: 'unknown' }));
    rejected(base({ receiptState: 'done' }));
  });
});
