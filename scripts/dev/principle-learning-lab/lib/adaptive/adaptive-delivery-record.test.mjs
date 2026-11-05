import test from 'node:test';
import assert from 'node:assert/strict';
import { validateAdaptiveDeliveryRecord } from './adaptive-delivery-record.mjs';

const base = (overrides = {}) => ({
  hookInvocationId: 'hook-1',
  requestId: 'request-1',
  receiptState: 'closed',
  execution: 'completed',
  payload: 'returned',
  selection: 'selected',
  submission: 'unknown',
  ...overrides,
});

const accepted = (record) => assert.deepEqual(validateAdaptiveDeliveryRecord(record), { ok: true, errors: [] });
const rejected = (record) => assert.equal(validateAdaptiveDeliveryRecord(record).ok, false);

test('accepts an open receipt only with the specified pending initialization state', () => {
  accepted(base({
    receiptState: 'open',
    execution: 'unknown',
    payload: 'unknown',
    selection: 'unavailable',
    selectionPending: true,
  }));
  rejected(base({ receiptState: 'open', selection: 'unavailable', selectionPending: true }));
  rejected(base({ receiptState: 'open', execution: 'unknown', payload: 'unknown', selection: 'unavailable', submission: 'unknown' }));
  rejected(base({ selectionPending: true }));
});

test('validates independent confirmation and submission evidence without inferring success from receipt state', () => {
  accepted(base({
    payload: 'confirmed',
    evidence: { reference: 'evidence://request-1', independentlyVerified: true },
  }));
  rejected(base({ payload: 'confirmed' }));
  rejected(base({ payload: 'confirmed', evidence: { reference: 'evidence://request-1', independentlyVerified: false } }));
  accepted(base({ receiptState: 'closed', execution: 'unknown', payload: 'unknown' }));
  accepted(base({ receiptState: 'reconciled', execution: 'completed', payload: 'unknown' }));
  accepted(base({ submission: 'proceeded', evidence: { reference: 'host://submission', independentlyVerified: true } }));
  rejected(base({ submission: 'blocked' }));
  rejected(base({ submission: 'proceeded', evidence: { reference: 'host://submission' } }));
  rejected(base({ submission: 'proceeded', evidence: { reference: 'host://submission', independentlyVerified: false } }));
});

test('does not confuse a target payload of none with the Native fallback payload', () => {
  accepted(base({ execution: 'degraded', payload: 'none', selection: 'selected' }));
  rejected(base({ execution: 'degraded', payload: 'returned' }));
  rejected(base({ execution: 'failed', payload: 'confirmed' }));
  rejected(base({ execution: 'timeout', payload: 'prepared' }));
});

test('requires independent host kill evidence for timeout, while allowing other valid failure combinations', () => {
  accepted(base({
    execution: 'timeout',
    payload: 'none',
    evidence: { reference: 'host://kill', independentlyVerified: true, hostKillConfirmed: true },
  }));
  rejected(base({ execution: 'timeout', payload: 'none' }));
  accepted(base({ execution: 'failed', payload: 'unknown', selection: 'unavailable' }));
  accepted(base({ execution: 'degraded', payload: 'unknown', selection: 'skipped' }));
});

test('enforces completed empty selection and prevents unavailable selection from claiming a target payload', () => {
  accepted(base({ execution: 'completed', payload: 'none', selection: 'none_applicable' }));
  rejected(base({ execution: 'degraded', payload: 'none', selection: 'none_applicable' }));
  rejected(base({ execution: 'completed', payload: 'unknown', selection: 'none_applicable' }));
  accepted(base({ execution: 'failed', payload: 'unknown', selection: 'unavailable' }));
  rejected(base({ payload: 'prepared', selection: 'unavailable' }));
  accepted(base({ payload: 'unknown', selection: 'skipped' }));
});

test('rejects malformed and prototype-forged records without invoking accessors', () => {
  rejected(null);
  rejected([]);
  rejected(Object.create({ hookInvocationId: 'forged' }));
  rejected({ ...base(), evidence: Object.create({ reference: 'forged' }) });
  const record = base();
  Object.defineProperty(record, 'hookInvocationId', { enumerable: true, get() { throw new Error('must not run'); } });
  rejected(record);
  const forged = base();
  Object.defineProperty(forged, '__proto__', { enumerable: true, value: { hookInvocationId: 'forged' } });
  rejected(forged);
});

test('allows legacy extra fields without mutating input', () => {
  const source = base({ legacyField: { nested: ['keep'] }, payload: 'none', execution: 'degraded' });
  const before = structuredClone(source);
  accepted(source);
  assert.deepEqual(source, before);

  rejected(Object.assign(Object.create(null), base({ payload: 'unknown' })));
});

test('rejects invalid identifiers, enum values, and malformed optional evidence fields', () => {
  rejected(base({ hookInvocationId: '  ' }));
  const missingInvocationId = base();
  delete missingInvocationId.hookInvocationId;
  rejected(missingInvocationId);
  const missingEnum = base();
  delete missingEnum.receiptState;
  rejected(missingEnum);
  rejected(base({ requestId: '' }));
  rejected(base({ receiptState: 'success' }));
  rejected(base({ evidence: undefined }));
  rejected(base({ evidence: { reference: '' } }));
  rejected(base({ evidence: { independentlyVerified: 'yes' } }));
});
