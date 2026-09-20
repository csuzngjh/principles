/**
 * Product-version ordering (PRI-874 review fix).
 *
 * The channel guard must order two `x.y.z` product versions EXACTLY — a
 * comparison that silently mis-orders can let a downgrade through, which is the
 * single thing `check-product-version-channel.mjs` exists to prevent.
 *
 * The previous implementation packed the three components into one number
 * (`major * 1_000_000 + minor * 1_000 + patch`). That is only correct while
 * minor and patch stay below 1000: `1.1000.1` weighed 2_000_001 — HIGHER than
 * `2.0.0` (2_000_000) — so the guard would have accepted a major downgrade.
 * Components are compared one at a time instead, as BigInt, so no component
 * width can carry into the next.
 *
 * This lives in its own module so the comparison can be unit-tested directly:
 * `check-product-version-channel.mjs` is a side-effecting top-level script, so
 * importing it would run the guard.
 */

/** Strict `x.y.z` — no prerelease, no build metadata, no leading zeros. */
export const STRICT_SEMVER = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;

/**
 * Compare two strict `x.y.z` versions by major, then minor, then patch.
 *
 * @returns -1 when `left` is older, 0 when equal, 1 when `left` is newer.
 * @throws when either input is not a strict `x.y.z` version — a fail-closed
 *   guard must fail loudly rather than order a value it cannot parse.
 */
export function compareProductVersions(left, right) {
  const leftMatch = STRICT_SEMVER.exec(String(left));
  const rightMatch = STRICT_SEMVER.exec(String(right));
  if (leftMatch === null) throw new Error(`not a strict x.y.z version: ${JSON.stringify(String(left))}`);
  if (rightMatch === null) throw new Error(`not a strict x.y.z version: ${JSON.stringify(String(right))}`);
  for (let index = 1; index <= 3; index += 1) {
    const leftComponent = BigInt(leftMatch[index]);
    const rightComponent = BigInt(rightMatch[index]);
    if (leftComponent !== rightComponent) return leftComponent < rightComponent ? -1 : 1;
  }
  return 0;
}

/**
 * The channel guard's policy, as a pure decision.
 *
 * `resolvedVersion` MUST be the version actually about to be published. That is
 * not always what the ref's root manifest says: `release-metadata.yml` accepts
 * an EXPLICIT `product_version` input and, with `allow_version_drift=true`, that
 * value deliberately disagrees with the manifest. Re-deriving the version from
 * the manifest inside the guard — which is what it used to do — compared the
 * wrong value and let this through:
 *
 *   root manifest 2.1.0 · live channel 2.1.0 · selected release version 2.0.0
 *   → guard compared 2.1.0 >= 2.1.0 and PASSED while a downgrade was published.
 *
 * Nothing downstream catches it either: the publisher's monotonicity checks
 * cover the publication sequence and the pointer version, never `productVersion`.
 *
 * Kept in this module (rather than inline in the guard) so the scenario above is
 * pinned by a test without a network round-trip.
 *
 * @param {object} input
 * @param {string} input.resolvedVersion  the product version about to be published
 * @param {Array<{ label: string, version: string }>} input.floors  every live
 *   version the guard could observe; empty means no live channel to compare with
 * @param {boolean} [input.reportMode]  drift-monitor mode, where ahead-of-channel
 *   is the legitimate pending-publish state rather than a refusal
 * @returns {{ ok: boolean, code: 'no_live_channel'|'below_live_version'|'ahead_of_channel'|'equal_to_channel', message: string }}
 *   `ok: false` is a refusal; `message` is the operator-facing reason either way.
 */
export function decideProductVersionPublish({ resolvedVersion, floors, reportMode = false }) {
  if (!STRICT_SEMVER.test(String(resolvedVersion))) {
    throw new Error(`not a strict x.y.z version: ${JSON.stringify(String(resolvedVersion))}`);
  }
  if (floors.length === 0) {
    return {
      ok: true,
      code: 'no_live_channel',
      message: `ok: selected product version ${resolvedVersion}; no live channel to compare against.`,
    };
  }
  for (const floor of floors) {
    if (compareProductVersions(resolvedVersion, floor.version) < 0) {
      return {
        ok: false,
        code: 'below_live_version',
        message: `Selected product version (${resolvedVersion}) is LOWER than the ${floor.label} (${floor.version}). `
          + 'Publishing would downgrade every installed runtime. Either publish a version at or above the live one, '
          + 'or advance the ROOT package.json version on main first (explicit version-advancement commit).',
      };
    }
  }
  const aheadOf = floors.filter((floor) => compareProductVersions(resolvedVersion, floor.version) > 0);
  if (aheadOf.length > 0) {
    const detail = aheadOf.map((floor) => `${floor.label} (${floor.version})`).join(', ');
    return {
      ok: true,
      code: 'ahead_of_channel',
      message: reportMode
        ? `Pending publication: selected product version ${resolvedVersion} is AHEAD of the ${detail}. `
          + 'ok: ahead-of-channel is the legitimate state between a version-advancement commit and its release.'
        : `Pending publication: selected product version ${resolvedVersion} is AHEAD of the ${detail}. `
          + 'Proceeding is correct for a release run.',
    };
  }
  return {
    ok: true,
    code: 'equal_to_channel',
    message: `ok: selected product version ${resolvedVersion} equals the live channel pointer (same-version republish advances the counters).`,
  };
}
