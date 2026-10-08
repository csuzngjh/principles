/**
 * Fast unit coverage for the N-1 baseline derivation used by the release
 * upgrade gates (see `helpers/n1-baseline.ts`).
 *
 * Regression origin: cohort d2180e61 minor-bumped the plugin to 2.1.0, and the
 * gate's patch-only decrement threw `Cannot decrement patch of version 2.1.0`,
 * turning one matrix leg red and skipping the whole publish train. A minor
 * landing on `x.y.0` is normal release traffic, so the derivation itself is
 * what must be proven here — not the multi-minute gate.
 */
import { describe, expect, it } from 'vitest';
import { previousReleaseVersion } from './helpers/n1-baseline.js';

const STRICT_SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

describe('previousReleaseVersion (N-1 gate baseline)', () => {
  it('steps down one patch while a patch release exists', () => {
    expect(previousReleaseVersion('2.0.10')).toBe('2.0.9');
    expect(previousReleaseVersion('1.144.21')).toBe('1.144.20');
  });

  it('steps down one minor when the cohort landed on x.y.0', () => {
    expect(previousReleaseVersion('2.1.0')).toBe('2.0.0');
    expect(previousReleaseVersion('0.5.0')).toBe('0.4.0');
    expect(previousReleaseVersion('1.290.0')).toBe('1.289.0');
  });

  it('always returns a strict x.y.z below the input', () => {
    const isBelow = (previous: string, current: string): boolean => {
      const [pm = 0, pi = 0, pp = 0] = previous.split('.').map(Number);
      const [cm = 0, ci = 0, cp = 0] = current.split('.').map(Number);
      return pm < cm || (pm === cm && (pi < ci || (pi === ci && pp < cp)));
    };
    for (const version of ['2.0.10', '2.1.0', '0.5.0', '1.144.21', '10.2.3']) {
      const previous = previousReleaseVersion(version);
      expect(previous).toMatch(STRICT_SEMVER);
      expect(isBelow(previous, version), `${previous} must be below ${version}`).toBe(true);
    }
  });

  it('fails loud when there is no previous release to derive', () => {
    expect(() => previousReleaseVersion('0.0.0')).toThrow(/no previous release below version 0\.0\.0/);
  });

  it('refuses input that is not a strict x.y.z', () => {
    for (const bad of ['2.1', '2', '2.1.0-beta', '02.1.0', 'v2.1.0', '']) {
      expect(() => previousReleaseVersion(bad), `${bad} must be refused`).toThrow(/must be strict x\.y\.z/);
    }
  });
});
