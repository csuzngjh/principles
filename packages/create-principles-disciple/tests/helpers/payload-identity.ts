/**
 * Shared payload-identity fixture helper (PRI-874): stamps a payload
 * directory with the embedded product identity the installer now REQUIRES
 * (`_release/product-identity.json` — the same file the release train and
 * build-release-asset write before the archive bytes are hashed).
 *
 * Tests that build payload fixtures by hand must stamp them exactly like a
 * real train payload, or `beginInstallerJournal()` / `install()` refuse the
 * payload with `ProductIdentityError` before any mutation.
 *
 * Two entry points, one schema truth:
 *  - `stampPayloadIdentity` writes the file through `node:fs` (real-fs
 *    fixtures). NOTE: in suites where `fs`/`node:fs` is vi.mocked without a
 *    real-fs delegation loop, the helper's write is a mock no-op — use
 *    `productIdentityStampJson` with the suite's real-fs handle there.
 *  - `productIdentityStampJson` returns the exact stamp file content for
 *    mocked-fs answers and hand-rolled writes; it validates the values with
 *    the same strict rules the installer's parser applies (fail loud — a
 *    stamp must never be smuggled into a fixture half-formed).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

/** Fixed 40-hex source commit — mirrors what the asset build embeds. */
export const DEFAULT_STAMP_SOURCE_COMMIT = 'a'.repeat(40);

/**
 * Exact content of `_release/product-identity.json`:
 * `{schemaVersion:1, productVersion:"x.y.z", sourceCommit:"<40-hex>"}`.
 */
export function productIdentityStampJson(productVersion: string, sourceCommit: string = DEFAULT_STAMP_SOURCE_COMMIT): string {
  // Same strict pattern as parseProductVersion (src/update/product-identity.ts):
  // no prerelease suffix, no leading zeros.
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(productVersion)) {
    throw new Error(`productIdentityStampJson: productVersion must be strict x.y.z, got '${productVersion}'`);
  }
  if (!/^[0-9a-f]{40}$/.test(sourceCommit)) {
    throw new Error(`productIdentityStampJson: sourceCommit must be 40-hex, got '${sourceCommit}'`);
  }
  return `${JSON.stringify({ schemaVersion: 1, productVersion, sourceCommit }, null, 2)}\n`;
}

/** Write `_release/product-identity.json` into `payloadDir` (real-fs fixtures). */
export function stampPayloadIdentity(payloadDir: string, productVersion: string, sourceCommit: string = DEFAULT_STAMP_SOURCE_COMMIT): void {
  const releaseDir = path.join(payloadDir, '_release');
  fs.mkdirSync(releaseDir, { recursive: true });
  fs.writeFileSync(path.join(releaseDir, 'product-identity.json'), productIdentityStampJson(productVersion, sourceCommit));
}
