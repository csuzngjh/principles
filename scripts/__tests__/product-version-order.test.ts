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
import { compareProductVersions, decideProductVersionPublish, STRICT_SEMVER } from '../lib/product-version-order.mjs';

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

describe('decideProductVersionPublish', () => {
  const liveChannel = { label: 'live channel pointer', version: '2.1.0' };

  /**
   * The exact defect this policy exists to close.
   *
   * release-metadata.yml can be dispatched with an EXPLICIT product_version and
   * allow_version_drift=true, which deliberately disagrees with the ref's root
   * manifest. The guard used to re-derive the version from the manifest, so it
   * compared the manifest (2.1.0) instead of the version about to be published
   * (2.0.0) and PASSED — publishing a downgrade. The publisher does not catch it
   * either: its monotonicity checks cover publicationSequence and the pointer
   * version, never productVersion.
   *
   * Both halves are pinned below: the selected value refuses, the manifest value
   * (the value the buggy guard compared) passes. Passing the selected version to
   * the guard is therefore load-bearing, not cosmetic.
   */
  it('refuses a downgrade when the SELECTED release version is below the live channel', () => {
    const decision = decideProductVersionPublish({ resolvedVersion: '2.0.0', floors: [liveChannel] });

    expect(decision.ok).toBe(false);
    expect(decision.code).toBe('below_live_version');
    expect(decision.message).toMatch(/LOWER than the live channel pointer \(2\.1\.0\)/);
  });

  it('would have accepted that same publish had it judged the root manifest value instead', () => {
    // The contrast that makes the case above meaningful: 2.1.0 is what the root
    // manifest declares, and it is NOT the version being published.
    const decision = decideProductVersionPublish({ resolvedVersion: '2.1.0', floors: [liveChannel] });

    expect(decision.ok).toBe(true);
    expect(decision.code).toBe('equal_to_channel');
  });

  it('allows an equal version (same-version republish advances the counters)', () => {
    const decision = decideProductVersionPublish({ resolvedVersion: '2.1.0', floors: [liveChannel] });
    expect(decision.ok).toBe(true);
    expect(decision.message).toMatch(/equals the live channel pointer/);
  });

  it('allows a version ahead of the channel in release mode', () => {
    const decision = decideProductVersionPublish({ resolvedVersion: '2.2.0', floors: [liveChannel] });
    expect(decision.ok).toBe(true);
    expect(decision.code).toBe('ahead_of_channel');
    expect(decision.message).toMatch(/Proceeding is correct for a release run/);
  });

  it('reports ahead-of-channel as legitimate pending-publish state in report mode', () => {
    const decision = decideProductVersionPublish({ resolvedVersion: '2.2.0', floors: [liveChannel], reportMode: true });
    expect(decision.ok).toBe(true);
    expect(decision.code).toBe('ahead_of_channel');
    expect(decision.message).toMatch(/legitimate state between a version-advancement commit and its release/);
  });

  it('allows anything when there is no live channel to compare against', () => {
    const decision = decideProductVersionPublish({ resolvedVersion: '0.1.0', floors: [] });
    expect(decision.ok).toBe(true);
    expect(decision.code).toBe('no_live_channel');
  });

  it('refuses when ANY observed floor is above the selected version', () => {
    // The remote pointer can be older than a locally observed snapshot; every
    // live version is a floor, not just the remote one.
    const decision = decideProductVersionPublish({
      resolvedVersion: '2.1.0',
      floors: [liveChannel, { label: 'published pointer snapshot', version: '9.9.9' }],
    });
    expect(decision.ok).toBe(false);
    expect(decision.message).toMatch(/published pointer snapshot \(9\.9\.9\)/);
  });

  it('refuses to decide on a version it cannot parse', () => {
    expect(() => decideProductVersionPublish({ resolvedVersion: '2.1', floors: [liveChannel] })).toThrow(/strict x\.y\.z/);
  });
});
