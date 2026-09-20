#!/usr/bin/env node
/**
 * PRI-874 — product-version channel guard (single implementation, three
 * callers: release-metadata.yml, publish-npm.yml train + single-package
 * publish, and the version-drift monitor).
 *
 * Compares the RESOLVED product version (root manifest authority via
 * scripts/resolve-product-version.mjs) against the LIVE channel pointer's
 * productVersion:
 *
 *   gate mode (default)     — resolved <  channel → exit 1: publishing would
 *                             downgrade every installed runtime. resolved >=
 *                             channel → ok. Channel 404 → ok (first
 *                             publication). Any OTHER fetch/parse failure →
 *                             exit 1: a broken channel read is never treated
 *                             as "first publish".
 *   --report (drift monitor)— resolved < channel still fails (a published
 *                             version that never landed on main is an
 *                             error); resolved > channel is the legitimate
 *                             pending-publish state and only prints a
 *                             notice.
 *
 * The channel URL is https-only and must point at a public host.
 */
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { compareProductVersions, STRICT_SEMVER } from './lib/product-version-order.mjs';

const DEFAULT_CHANNEL_URL = 'https://csuzngjh.github.io/principles/targets/channels/stable.json';

function fail(message) {
  console.error(`::error::${message}`);
  process.exit(1);
}

// Version parsing and ordering live in ./lib/product-version-order.mjs: the
// comparison must be exact (a mis-order here accepts a downgrade), and keeping
// it out of this file makes it unit-testable without executing the guard.

const reportMode = process.argv.includes('--report');
const channelUrlIndex = process.argv.indexOf('--channel-url');
const channelUrl = channelUrlIndex !== -1 && channelUrlIndex + 1 < process.argv.length
  ? process.argv[channelUrlIndex + 1]
  : DEFAULT_CHANNEL_URL;

// URL safety: https + public host only (no loopback / private / reserved).
const parsedUrl = new URL(channelUrl);
if (parsedUrl.protocol !== 'https:') fail(`channel URL must be https: ${channelUrl}`);
const host = parsedUrl.hostname.toLowerCase();
const hostIsPrivate = host === 'localhost' || host.endsWith('.localhost') || host === '::1'
  || host.endsWith('.local') || host === 'metadata.google.internal'
  || /^127\./.test(host) || /^10\./.test(host) || /^0\./.test(host)
  || /^169\.254\./.test(host) || /^192\.168\./.test(host)
  || /^172\.(1[6-9]|2\d|3[01])\./.test(host);
if (hostIsPrivate) fail(`channel URL host must be public: ${channelUrl}`);

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const resolverEntry = path.join(repoRoot, 'scripts', 'resolve-product-version.mjs');
let resolvedVersion;
try {
  resolvedVersion = execFileSync(process.execPath, [resolverEntry], { encoding: 'utf8', timeout: 60_000 }).trim();
} catch (error) {
  fail(`The product resolver failed: ${error instanceof Error ? error.message : String(error)}`);
}
if (!STRICT_SEMVER.test(resolvedVersion)) fail(`Resolved product version is not strict x.y.z: ${JSON.stringify(resolvedVersion)}`);

let channelProductVersion = null;
const response = await fetch(channelUrl, { signal: AbortSignal.timeout(30_000) });
if (response.status === 404) {
  console.log(`No channel pointer at ${channelUrl} — treating as the first publication.`);
} else if (!response.ok) {
  fail(`Channel read failed (HTTP ${response.status}) for ${channelUrl} — a broken channel read is never treated as "first publish".`);
} else {
  const payload = await response.json();
  if (typeof payload !== 'object' || payload === null || !Object.hasOwn(payload, 'productVersion')) {
    fail(`Channel pointer ${channelUrl} carries no productVersion field: ${JSON.stringify(payload).slice(0, 400)}`);
  }
  const value = payload.productVersion;
  if (typeof value !== 'string' || !STRICT_SEMVER.test(value)) {
    fail(`Channel pointer ${channelUrl} productVersion is not strict x.y.z: ${JSON.stringify(value)}`);
  }
  channelProductVersion = value;
}

if (channelProductVersion === null) {
  console.log(`ok: resolved product version ${resolvedVersion}; no live channel to compare against.`);
  process.exit(0);
}

const order = compareProductVersions(resolvedVersion, channelProductVersion);

if (order < 0) {
  fail(`Resolved product version (${resolvedVersion}) is LOWER than the live channel pointer (${channelProductVersion}). `
    + 'Publishing would downgrade every installed runtime. Advance the ROOT package.json version on main instead '
    + '(explicit version-advancement commit), then re-run.');
}
if (order > 0) {
  const message = `Pending publication: main product version ${resolvedVersion} is AHEAD of the live channel (${channelProductVersion}).`;
  if (reportMode) {
    console.log(message);
    console.log('ok: ahead-of-channel is the legitimate state between a version-advancement commit and its release.');
    process.exit(0);
  }
  console.log(`${message} Proceeding is correct for a release run.`);
  process.exit(0);
}
console.log(`ok: resolved product version ${resolvedVersion} equals the live channel pointer (same-version republish advances the counters).`);
