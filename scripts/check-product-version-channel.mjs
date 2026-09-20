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

// PRI-874 review: an ADDITIONAL low-water mark supplied by the caller from a
// locally observed pointer (release-metadata.yml reads the published gh-pages
// snapshot). The remote pointer stays the authority, but this floor means a
// transient 404 from the public endpoint cannot erase a version we already know
// is live. Optional; when absent the guard behaves exactly as before.
const floorIndex = process.argv.indexOf('--channel-product-version');
const requestedFloor = floorIndex !== -1 && floorIndex + 1 < process.argv.length
  ? process.argv[floorIndex + 1]
  : null;
if (requestedFloor !== null && !STRICT_SEMVER.test(requestedFloor)) {
  fail(`--channel-product-version is not a strict x.y.z version: ${JSON.stringify(requestedFloor)}`);
}

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
// PRI-874 review: a channel the guard cannot READ is a refusal, and it has to
// SAY so. `fetch` rejects on DNS/connect/TLS/timeout failures and
// `response.json()` rejects on a truncated or non-JSON body; both previously
// escaped as an uncaught stack trace. The exit code was already 1, but the
// operator got a crash dump instead of the reason — so the documented rule
// "a broken channel read is never treated as first publish" was only half
// implemented. Both are structured failures now.
let response;
try {
  response = await fetch(channelUrl, { signal: AbortSignal.timeout(30_000) });
} catch (error) {
  fail(`Channel read failed for ${channelUrl} (${error instanceof Error ? error.message : String(error)}) — `
    + 'a broken channel read is never treated as "first publish".');
}
if (response.status === 404) {
  console.log(`No channel pointer at ${channelUrl} — treating as the first publication.`);
} else if (!response.ok) {
  fail(`Channel read failed (HTTP ${response.status}) for ${channelUrl} — a broken channel read is never treated as "first publish".`);
} else {
  let payload;
  try {
    payload = await response.json();
  } catch (error) {
    fail(`Channel pointer ${channelUrl} is not valid JSON (${error instanceof Error ? error.message : String(error)}) — `
      + 'a broken channel read is never treated as "first publish".');
  }
  if (typeof payload !== 'object' || payload === null || !Object.hasOwn(payload, 'productVersion')) {
    fail(`Channel pointer ${channelUrl} carries no productVersion field: ${JSON.stringify(payload).slice(0, 400)}`);
  }
  const value = payload.productVersion;
  if (typeof value !== 'string' || !STRICT_SEMVER.test(value)) {
    fail(`Channel pointer ${channelUrl} productVersion is not strict x.y.z: ${JSON.stringify(value)}`);
  }
  channelProductVersion = value;
}

// Every live version the guard can observe is a FLOOR. `channelProductVersion`
// is the remote pointer (the authority); `requestedFloor` is the caller's
// locally observed pointer, kept so a 404 from the public endpoint cannot erase
// a version we already know is live. Refusing on ANY floor is the same refusal
// as before — when only the remote pointer is in play the messages are
// unchanged.
const liveFloors = [];
if (channelProductVersion !== null) liveFloors.push({ label: 'live channel pointer', version: channelProductVersion });
if (requestedFloor !== null) liveFloors.push({ label: 'published pointer snapshot', version: requestedFloor });

if (liveFloors.length === 0) {
  console.log(`ok: resolved product version ${resolvedVersion}; no live channel to compare against.`);
  process.exit(0);
}

for (const floor of liveFloors) {
  if (compareProductVersions(resolvedVersion, floor.version) < 0) {
    fail(`Resolved product version (${resolvedVersion}) is LOWER than the ${floor.label} (${floor.version}). `
      + 'Publishing would downgrade every installed runtime. Advance the ROOT package.json version on main instead '
      + '(explicit version-advancement commit), then re-run.');
  }
}

const aheadOf = liveFloors.filter((floor) => compareProductVersions(resolvedVersion, floor.version) > 0);
if (aheadOf.length > 0) {
  const message = `Pending publication: main product version ${resolvedVersion} is AHEAD of the ${aheadOf.map((floor) => `${floor.label} (${floor.version})`).join(', ')}.`;
  if (reportMode) {
    console.log(message);
    console.log('ok: ahead-of-channel is the legitimate state between a version-advancement commit and its release.');
    process.exit(0);
  }
  console.log(`${message} Proceeding is correct for a release run.`);
  process.exit(0);
}
console.log(`ok: resolved product version ${resolvedVersion} equals the live channel pointer (same-version republish advances the counters).`);
