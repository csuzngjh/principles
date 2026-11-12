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
import {
  previousReleaseVersion,
  resolvePreviousReleaseVersion,
  type PublishedVersionSource,
} from './helpers/n1-baseline.js';

const STRICT_SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

/** Registry stub: `versions === null` models an unreachable registry. */
function stubSource(versions: readonly string[] | null, exists: boolean | Error = true): PublishedVersionSource {
  return {
    async listVersions() {
      return versions;
    },
    async hasVersion() {
      if (exists instanceof Error) throw exists;
      return exists;
    },
  };
}

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

describe('resolvePreviousReleaseVersion (registry-first N-1 baseline)', () => {
  it('uses the highest published version strictly below a major candidate', async () => {
    // The real shape that blocked the 4.0.0 cohort: plugin 4.0.0 has no patch
    // below it, but npm really publishes 3.3.0.
    const resolved = await resolvePreviousReleaseVersion(
      'principles-disciple',
      '4.0.0',
      stubSource(['3.0.0', '3.1.5', '3.3.0', '4.0.0']),
    );
    expect(resolved).toEqual({ version: '3.3.0', source: 'registry' });
  });

  it('ignores prereleases, malformed entries and anything at or above the candidate', async () => {
    const resolved = await resolvePreviousReleaseVersion(
      'pkg',
      '2.1.0',
      stubSource(['1.9.9', '2.0.0', '2.0.5-rc.1', '2.1.0', '2.2.0', 'nope']),
    );
    expect(resolved.version).toBe('2.0.0');
  });

  it('falls back to the arithmetic step ONLY when the registry is unreachable, and only if it really exists', async () => {
    const resolved = await resolvePreviousReleaseVersion('principles-disciple', '4.0.0', stubSource(null, true));
    expect(resolved).toEqual({ version: '3.0.0', source: 'arithmetic-fallback' });
  });

  it('refuses an unverifiable fallback instead of guessing', async () => {
    await expect(resolvePreviousReleaseVersion('pkg', '4.0.0', stubSource(null, false))).rejects.toThrow(
      /fallback pkg@3\.0\.0 is not published — refusing to guess/,
    );
  });

  it('refuses when the registry cannot even answer the fallback check', async () => {
    await expect(
      resolvePreviousReleaseVersion('pkg', '4.0.0', stubSource(null, new Error('ETIMEDOUT'))),
    ).rejects.toThrow(/cannot be verified — refusing to guess a baseline/);
  });

  it('refuses when a reachable registry holds nothing below the candidate', async () => {
    await expect(resolvePreviousReleaseVersion('pkg', '1.0.0', stubSource(['1.0.0', '1.0.1']))).rejects.toThrow(
      /no published pkg version below 1\.0\.0/,
    );
  });

  it('still refuses 0.0.0 and non-strict input', async () => {
    await expect(resolvePreviousReleaseVersion('pkg', '0.0.0', stubSource([]))).rejects.toThrow(
      /no previous release below version 0\.0\.0/,
    );
    await expect(resolvePreviousReleaseVersion('pkg', '1.0', stubSource([]))).rejects.toThrow(/must be strict x\.y\.z/);
  });

  it('never returns the candidate or anything above it', async () => {
    for (const [candidate, expected] of [
      ['4.0.0', '3.3.0'],
      ['2.1.0', '2.0.0'],
      ['1.150.5', '1.150.4'],
    ] as const) {
      const resolved = await resolvePreviousReleaseVersion('pkg', candidate, stubSource(['0.1.0', '1.0.0', '3.3.0', '2.0.0', '1.150.4', '4.0.0', '2.1.0', '1.150.5']));
      expect(resolved.version).toBe(expected);
      expect(resolved.version).toMatch(STRICT_SEMVER);
    }
  });
});
