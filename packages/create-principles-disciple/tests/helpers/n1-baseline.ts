/**
 * Shared N-1 baseline helper for the release upgrade gates.
 *
 * The gates re-stamp a copy of the real release payload as a synthetic N-1
 * side, and every stamped version must be a valid strict `x.y.z` that is the
 * previous release of the real component — any lower value would stop
 * exercising the real N-1 → N upgrade step the gate exists for.
 *
 * The previous release is NOT ``patch - 1``: a cohort that minor-bumps a
 * component lands it on `x.y.0`, and a major bump lands it on `x.0.0`, neither
 * of which has a previous patch. Deriving the baseline from the stamped value
 * therefore falls back to the previous minor / previous major rather than
 * throwing, so the release chain cannot be blocked by the gate's own
 * bookkeeping.
 *
 * `resolvePreviousReleaseVersion` is the release-gate entry point: it prefers
 * the REGISTRY truth ("highest published version strictly below the
 * candidate"), which is what the upgrade actually steps from, and only uses
 * the arithmetic fallback when the registry cannot be reached — and even then
 * the fallback must exist on the registry before it is accepted. A baseline is
 * never invented.
 */

/** Strict `x.y.z` with no leading zeros — same shape the identity parser accepts. */
const STRICT_SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

function parseStrict(version: string): [number, number, number] {
  const match = STRICT_SEMVER.exec(version);
  if (!match) {
    throw new Error(`previousReleaseVersion: version must be strict x.y.z, got '${version}'`);
  }
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function compareTriples(a: readonly [number, number, number], b: readonly [number, number, number]): number {
  for (let index = 0; index < 3; index += 1) {
    const left = a[index] ?? 0;
    const right = b[index] ?? 0;
    if (left !== right) return left < right ? -1 : 1;
  }
  return 0;
}

/**
 * Arithmetic step back from `version`.
 *
 * Used as the fallback when the registry cannot hand us the published history,
 * and as the pure derivation the unit tests pin. It is NOT the release-gate
 * answer on its own — `resolvePreviousReleaseVersion` verifies it exists.
 */
export function previousReleaseVersion(version: string): string {
  const [major, minor, patch] = parseStrict(version);
  if (patch > 0) return `${major}.${minor}.${patch - 1}`;
  if (minor > 0) return `${major}.${minor - 1}.0`;
  if (major > 0) return `${major - 1}.0.0`;
  throw new Error(`previousReleaseVersion: no previous release below version ${version} — pick a different baseline`);
}

/** Registry access seam: stubbed in unit tests, real npm registry in the gate. */
export interface PublishedVersionSource {
  /** Every published version of `pkg`, or `null` when the registry cannot answer. */
  listVersions(pkg: string): Promise<readonly string[] | null>;
  /** Whether exactly `version` is published. Throws when the registry cannot answer. */
  hasVersion(pkg: string, version: string): Promise<boolean>;
}

const REGISTRY_BASE = 'https://registry.npmjs.org';
const REGISTRY_TIMEOUT_MS = 15_000;

function registryUrl(pkg: string): string {
  return `${REGISTRY_BASE}/${encodeURIComponent(pkg)}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** Real npm registry source. Network failures surface as `null` / throws, never as "absent". */
export const npmPublishedVersionSource: PublishedVersionSource = {
  async listVersions(pkg: string): Promise<readonly string[] | null> {
    let response: Response;
    try {
      response = await fetch(registryUrl(pkg), {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(REGISTRY_TIMEOUT_MS),
      });
    } catch {
      return null;
    }
    if (!response.ok) return null;
    const body: unknown = await response.json().catch(() => null);
    if (!isRecord(body) || !isRecord(body['versions'])) return null;
    return Object.keys(body['versions'] as Record<string, unknown>);
  },

  async hasVersion(pkg: string, version: string): Promise<boolean> {
    let response: Response;
    try {
      response = await fetch(`${registryUrl(pkg)}/${encodeURIComponent(version)}`, {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(REGISTRY_TIMEOUT_MS),
      });
    } catch (error) {
      throw new Error(`registry unreachable while checking ${pkg}@${version}: ${String(error)}`);
    }
    if (response.status === 404) return false;
    if (!response.ok) {
      throw new Error(`registry answered ${response.status} while checking ${pkg}@${version}`);
    }
    return true;
  },
};

export interface ResolvedBaseline {
  version: string;
  source: 'registry' | 'arithmetic-fallback';
}

/** Highest strict-semver entry in `published` that is strictly below `candidate`. */
function highestPublishedBelow(published: readonly string[], candidate: string): string | null {
  const target = parseStrict(candidate);
  let best: string | null = null;
  let bestTriple: [number, number, number] | null = null;
  for (const raw of published) {
    if (!STRICT_SEMVER.test(raw)) continue;
    const triple = parseStrict(raw);
    if (compareTriples(triple, target) >= 0) continue;
    if (bestTriple === null || compareTriples(triple, bestTriple) > 0) {
      best = raw;
      bestTriple = triple;
    }
  }
  return best;
}

/**
 * Resolve the N-1 baseline for `pkg` from `candidate`.
 *
 * 1. Registry first: the highest published version strictly below the
 *    candidate — that is what an installed N-1 really upgrades from.
 * 2. Registry unreachable: step back arithmetically (patch → minor → major) and
 *    REFUSE unless that exact version is published. A baseline is never
 *    guessed, and the result is always strict `x.y.z` strictly below the
 *    candidate; `0.0.0` still has no baseline at all.
 */
export async function resolvePreviousReleaseVersion(
  pkg: string,
  candidate: string,
  source: PublishedVersionSource = npmPublishedVersionSource,
): Promise<ResolvedBaseline> {
  parseStrict(candidate);
  if (candidate === '0.0.0') {
    // Reuse the arithmetic guard so both entry points share one message.
    previousReleaseVersion(candidate);
  }

  const published = await source.listVersions(pkg).catch(() => null);
  if (published !== null) {
    const resolved = highestPublishedBelow(published, candidate);
    if (resolved === null) {
      throw new Error(
        `resolvePreviousReleaseVersion: the registry has no published ${pkg} version below ${candidate} — refusing to invent an N-1 baseline`,
      );
    }
    return { version: resolved, source: 'registry' };
  }

  const fallback = previousReleaseVersion(candidate);
  let exists: boolean;
  try {
    exists = await source.hasVersion(pkg, fallback);
  } catch (error) {
    throw new Error(
      `resolvePreviousReleaseVersion: registry unreachable and the ${fallback} fallback for ${pkg}@${candidate} cannot be verified — refusing to guess a baseline (${String(error)})`,
    );
  }
  if (!exists) {
    throw new Error(
      `resolvePreviousReleaseVersion: registry unreachable and the fallback ${pkg}@${fallback} is not published — refusing to guess an N-1 baseline for ${candidate}`,
    );
  }
  return { version: fallback, source: 'arithmetic-fallback' };
}
