/**
 * Shared N-1 baseline helper for the release upgrade gates.
 *
 * The gates re-stamp a copy of the real release payload as a synthetic N-1
 * side, and every stamped version must stay a valid strict `x.y.z` that is
 * exactly ONE release back from the real component version — any lower value
 * would stop exercising the real N-1 → N upgrade step the gate exists for.
 *
 * The previous release is NOT always `patch - 1`: a cohort that minor-bumps a
 * component lands it on `x.y.0`, which has no previous patch. Deriving the
 * baseline from the stamped value therefore falls back to the previous minor
 * rather than throwing, so the release chain cannot be blocked by the gate's
 * own bookkeeping.
 */

/** Strict `x.y.z` with no leading zeros — same shape the identity parser accepts. */
const STRICT_SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

export function previousReleaseVersion(version: string): string {
  const match = STRICT_SEMVER.exec(version);
  if (!match) {
    throw new Error(`previousReleaseVersion: version must be strict x.y.z, got '${version}'`);
  }
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  if (patch > 0) return `${major}.${minor}.${patch - 1}`;
  if (minor > 0) return `${major}.${minor - 1}.0`;
  throw new Error(`previousReleaseVersion: no previous release below version ${version} — pick a different baseline`);
}
