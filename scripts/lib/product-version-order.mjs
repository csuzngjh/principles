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
