/**
 * PRI-874 review fix — product-version ordering for the channel guard.
 *
 * `check-product-version-channel.mjs` refuses a publish whose resolved product
 * version is BELOW the live channel pointer. That refusal is only as good as the
 * comparison behind it: a mis-order accepts a downgrade.
 *
 * The previous implementation packed `x.y.z` into
 * `major * 1_000_000 + minor * 1_000 + patch`, which mis-orders as soon as any
 * component reaches 1000 — `1.1000.1` outranked `2.0.0`. These tests pin the
 * exact ordering and the strict-parse refusal.
 */

import { describe, expect, it } from 'vitest';
import { compareProductVersions, STRICT_SEMVER } from '../lib/product-version-order.mjs';

describe('compareProductVersions', () => {
  it('orders by major, then minor, then patch', () => {
    expect(compareProductVersions('1.0.0', '2.0.0')).toBe(-1);
    expect(compareProductVersions('2.0.0', '1.9.9')).toBe(1);
    expect(compareProductVersions('1.2.0', '1.10.0')).toBe(-1);
    expect(compareProductVersions('1.10.0', '1.2.0')).toBe(1);
    expect(compareProductVersions('1.2.3', '1.2.4')).toBe(-1);
    expect(compareProductVersions('1.2.3', '1.2.3')).toBe(0);
  });

  it('does not carry a wide component into the next one', () => {
    // The exact case the packed-weight form got wrong: under
    // `minor * 1_000` the value 1.1000.1 weighed 2_000_001 — higher than
    // 2.0.0 (2_000_000) — so the guard would have allowed a major downgrade.
    expect(compareProductVersions('1.1000.1', '2.0.0')).toBe(-1);
    expect(compareProductVersions('2.0.0', '1.1000.1')).toBe(1);
    expect(compareProductVersions('1.0.1000', '1.1.0')).toBe(-1);
  });

  it('orders components wider than Number.MAX_SAFE_INTEGER exactly', () => {
    const beyondSafeInteger = '9007199254740993'; // 2^53 + 1
    expect(compareProductVersions(`1.0.${beyondSafeInteger}`, '1.0.9007199254740992')).toBe(1);
    expect(compareProductVersions(`1.0.${beyondSafeInteger}`, `1.0.${beyondSafeInteger}`)).toBe(0);
  });

  it('refuses anything that is not a strict x.y.z version', () => {
    for (const notAVersion of ['1.2', 'v1.2.3', '1.2.3-rc.1', '1.2.3+build', '01.2.3', '', 'latest']) {
      expect(() => compareProductVersions(notAVersion, '1.0.0')).toThrow(/strict x\.y\.z/);
      expect(() => compareProductVersions('1.0.0', notAVersion)).toThrow(/strict x\.y\.z/);
    }
  });

  it('keeps the exported regex in agreement with the comparator', () => {
    expect(STRICT_SEMVER.test('2.1.0')).toBe(true);
    expect(STRICT_SEMVER.test('1.2.3-rc.1')).toBe(false);
    expect(STRICT_SEMVER.test('01.2.3')).toBe(false);
  });
});
