/**
 * PRI-531 review-fix regression tests: ledger writer contract details that
 * the BDD scenarios do not pin down — id pairing alignment and digest bounds
 * are call-site obligations; these tests document the writer-side contract.
 */
import { describe, it, expect } from 'vitest';
import { alignActivationIds } from '../../src/core/principle-application-ledger.js';

describe('alignActivationIds (review fix: injected-subset pairing)', () => {
  const principles = [
    { principleId: 'princ-A', activationId: 'act-A' },
    { principleId: 'princ-B', activationId: 'act-B' },
    { principleId: 'princ-C', activationId: 'act-C' },
  ];

  it('returns activation ids aligned with the injected subset (budget truncation drops the tail)', () => {
    const injected = new Set(['princ-A', 'princ-B']);
    expect(alignActivationIds(principles, injected)).toEqual(['act-A', 'act-B']);
  });

  it('drops middle principles too, keeping order', () => {
    const injected = new Set(['princ-A', 'princ-C']);
    expect(alignActivationIds(principles, injected)).toEqual(['act-A', 'act-C']);
  });

  it('empty injection yields empty alignment', () => {
    expect(alignActivationIds(principles, new Set())).toEqual([]);
  });
});
