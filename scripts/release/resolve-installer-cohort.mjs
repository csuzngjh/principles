#!/usr/bin/env node
/**
 * PRI-1103 — resolve the cohort commit the npm installer channel actually
 * shipped for a product version, so the signed release asset can be built
 * FROM THAT COMMIT instead of from whatever ref an operator happened to
 * dispatch.
 *
 * Why the commit and not the component versions: both publish legs build the
 * bundled payloads from source at their own checkout with source-version
 * preservation on (`.github/actions/publish-npm-package/action.yml` exports
 * `PD_BUNDLE_PRESERVE_SOURCE_VERSIONS=1`; `bundle-plugin.mjs` then skips the
 * movable registry `latest` sync). So the component set is a pure function of
 * the commit — but the converse does NOT hold: two commits can declare
 * identical component versions while their built bytes differ (main advances
 * with commits that touch no manifest version). Comparing version numbers
 * alone would grade exactly that case as equal, and it is the case the user
 * cannot observe. Binding the commit makes the invariant true by
 * construction.
 *
 * The npm side is a published, registry-readable fact:
 * `scripts/release/prepare-npm-candidate.mjs` refuses to pack unless the
 * tarball's `_release/product-identity.json` stamp matches the resolved
 * product version and cohort, and it overlays `gitHead = cohort` into the
 * published manifest. `dist-tags.latest` is therefore "what a fresh `npx`
 * install serves", which is the half of the pair this ticket exists to bind.
 *
 * Contract (single JSON object on stdout with --json; `::error::` on stderr):
 *
 *   MATCH                  exit 0  cohort resolved and pinned to the version
 *   VERSION_LAGS           exit 1  the npm channel serves a DIFFERENT product
 *                                  version; no older cohort may be republished
 *                                  onto the active channel to work around it
 *   EXPLICIT_UNPUBLISHED   exit 1  --expect-cohort is not any published
 *                                  installer version's recorded cohort
 *   EXPLICIT_NOT_LATEST    exit 1  --expect-cohort is published but npm
 *                                  `latest` now points at another commit;
 *                                  cohort_sha asserts the CURRENT latest,
 *                                  it is not a historical selector
 *   VERSION_MISMATCH       exit 1  npm latest's commit carries a different
 *                                  product version than the one being published
 *   ABSENT_COHORT          exit 1  the installer release records no gitHead —
 *                                  identity unverifiable, never assumed equal
 *   COMMIT_UNAVAILABLE     exit 1  the cohort commit is not in this checkout
 *   REGISTRY_ERROR         exit 1  undecidable; a failed read is not "no drift"
 *   INVALID_ARGS           exit 2
 *
 * No writes, and exactly one public packument read per run. That read is
 * FORCE-REVALIDATED (`?write=true`, the npm client's documented "give me the
 * current value" mechanism), because every caller of this resolver is a
 * publication decision: a cached packument cannot prove the channel still
 * serves what this run is about to publish.
 *
 * Distinct from `resolve-release-cohort.mjs`, which decides which SHA
 * SHOULD be the cohort from git history (it reproduces the Version Packages
 * PR). This script answers the other question — which SHA the registry SAYS
 * it shipped — and is the reason the asset channel can be bound to the npm
 * channel after the fact instead of only at publish time.
 */
import { execFileSync } from 'node:child_process';
import { fetchPackument, RegistryError } from './lib/registry-client.mjs';
import { STRICT_SEMVER } from '../lib/product-version-order.mjs';

const INSTALLER_PACKAGE = 'create-principles-disciple';
const GIT_SHA = /^[a-f0-9]{40}$/;

function argValue(flag) {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

/** Root manifest version at a commit — the same authority
 *  `scripts/resolve-product-version.mjs` reads, applied to a specific commit. */
function productVersionAt(commit) {
  let raw;
  try {
    raw = execFileSync('git', ['show', `${commit}:package.json`], { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
  } catch {
    return { ok: false, status: 'COMMIT_UNAVAILABLE' };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, status: 'COMMIT_UNAVAILABLE' };
  }
  const version = typeof parsed?.version === 'string' ? parsed.version : null;
  if (version === null || !STRICT_SEMVER.test(version)) return { ok: false, status: 'COMMIT_UNAVAILABLE' };
  return { ok: true, version };
}

function gitHeads(packument) {
  const heads = new Map();
  for (const [version, manifest] of Object.entries(packument?.versions ?? {})) {
    if (typeof manifest?.gitHead === 'string' && GIT_SHA.test(manifest.gitHead)) heads.set(manifest.gitHead, version);
  }
  return heads;
}

async function main() {
  const asJson = process.argv.includes('--json');
  const productVersion = argValue('--product-version');
  const expectCohort = argValue('--expect-cohort');
  const pkg = INSTALLER_PACKAGE;

  const fail = (status, detail, extra = {}) => {
    const payload = { status, detail, productVersion: productVersion ?? null, package: pkg, ...extra };
    if (asJson) process.stdout.write(`${JSON.stringify(payload)}\n`);
    console.error(`::error::${detail}`);
    process.exit(1);
  };

  if (typeof productVersion !== 'string' || !STRICT_SEMVER.test(productVersion)) {
    console.error('usage: resolve-installer-cohort.mjs --product-version <x.y.z> [--expect-cohort <40-hex-sha>] [--json]');
    process.exit(2);
  }
  if (expectCohort !== undefined && !GIT_SHA.test(String(expectCohort))) {
    console.error(`::error::--expect-cohort must be a full 40-char git sha, got ${JSON.stringify(String(expectCohort)).slice(0, 60)}`);
    process.exit(2);
  }

  let packument;
  try {
    // PRI-1103 freshness: never accept a cached packument. A stale
    // `dist-tags.latest` would be read as "no drift" by every gate.
    packument = await fetchPackument(pkg, { fresh: true });
  } catch (err) {
    const detail = err instanceof RegistryError ? `registry read failed (${err.status ?? 'network'}): ${err.message}` : `registry read failed: ${String(err?.message ?? err)}`;
    // A failed registry read is never evidence of "no drift".
    fail('REGISTRY_ERROR', `cannot resolve the npm installer channel for ${pkg}: ${detail}. Refusing to publish an asset whose cross-channel identity is unprovable.`);
  }
  if (packument === null) {
    fail('REGISTRY_ERROR', `${pkg} is not published to the registry — the npm channel this release must be bound to does not exist.`);
  }

  const latestVersion = packument?.['dist-tags']?.latest;
  if (typeof latestVersion !== 'string') {
    fail('ABSENT_COHORT', `${pkg} has no \`latest\` dist-tag on the registry — there is no npm channel release to bind this asset to.`);
  }
  const latestManifest = packument.versions?.[latestVersion] ?? null;
  const cohort = typeof latestManifest?.gitHead === 'string' && GIT_SHA.test(latestManifest.gitHead)
    ? latestManifest.gitHead
    : null;

  if (expectCohort !== undefined) {
    // cohort_sha is an identity ASSERTION about the current npm latest, never
    // a historical selector. Once `latest` moved to another commit, naming an
    // older published cohort would make the console-update channel ship
    // different bytes than a fresh npm install receives.
    if (cohort === null) {
      fail('ABSENT_COHORT', `${pkg}@${latestVersion} carries no gitHead, so the commit the npm channel currently serves cannot be identified. An explicit cohort_sha cannot substitute for a live channel identity.`, { installerVersion: latestVersion, expectedCohort: expectCohort });
    }
    if (expectCohort !== cohort) {
      const heads = gitHeads(packument);
      if (!heads.has(expectCohort)) {
        fail('EXPLICIT_UNPUBLISHED', `cohort ${expectCohort} is not recorded as the gitHead of any published ${pkg} release, so it cannot be the bytes a fresh install receives. Publish the npm train for this cohort first.`, { expectedCohort: expectCohort });
      }
      const latestProduct = productVersionAt(cohort);
      fail(
        'EXPLICIT_NOT_LATEST',
        `EXPLICIT_NOT_LATEST: cohort_sha ${expectCohort} is a published ${pkg} release, but npm \`latest\` now points at ${cohort} (${pkg}@${latestVersion}, product version ${latestProduct.ok ? latestProduct.version : 'unreadable'}). Publishing the older cohort would make the console-update channel carry a different code identity than a fresh npm install. cohort_sha asserts the CURRENT npm latest commit; historical cohorts cannot be republished onto the active channel.`,
        {
          expectedCohort: expectCohort,
          expectedCommit: expectCohort,
          actualLatestCommit: cohort,
          installerVersion: latestVersion,
          actualProductVersion: latestProduct.ok ? latestProduct.version : null,
        },
      );
    }
    const atCohort = productVersionAt(expectCohort);
    if (!atCohort.ok) {
      fail('COMMIT_UNAVAILABLE', `cohort ${expectCohort} is the npm latest commit but its root manifest is not readable in this checkout (fetch the commit before dispatching).`, { expectedCohort: expectCohort, installerVersion: latestVersion });
    }
    if (atCohort.version !== productVersion) {
      fail('VERSION_MISMATCH', `npm latest (${pkg}@${latestVersion}) points at cohort ${expectCohort}, whose root manifest carries product version ${atCohort.version}, not ${productVersion}. Publish the product version that cohort carries.`, { expectedCohort: expectCohort, installerVersion: latestVersion, cohortProductVersion: atCohort.version });
    }
    const payload = { status: 'MATCH', via: 'explicit', productVersion, package: pkg, installerVersion: latestVersion, cohort: expectCohort };
    if (asJson) process.stdout.write(`${JSON.stringify(payload)}\n`);
    console.error(`npm channel: product ${productVersion} is ${pkg}@${latestVersion} from ${expectCohort.slice(0, 10)} (explicit cohort, asserted equal to npm latest).`);
    process.exit(0);
  }

  if (cohort === null) {
    // rc-9: an identity this check depends on being unreadable is reported,
    // never treated as agreement.
    fail('ABSENT_COHORT', `${pkg}@${latestVersion} carries no gitHead, so the cohort the npm channel shipped cannot be identified. Refusing to publish an asset that might differ from those bytes.`, { installerVersion: latestVersion });
  }
  const atCohort = productVersionAt(cohort);
  if (!atCohort.ok) {
    fail('COMMIT_UNAVAILABLE', `the npm channel's cohort ${cohort} is not readable in this checkout — fetch it before dispatching this release.`, { installerVersion: latestVersion, cohort });
  }
  if (atCohort.version === productVersion) {
    const payload = { status: 'MATCH', via: 'latest', productVersion, package: pkg, installerVersion: latestVersion, cohort };
    if (asJson) process.stdout.write(`${JSON.stringify(payload)}\n`);
    console.error(`npm channel: ${pkg}@${latestVersion} from ${cohort.slice(0, 10)} carries product ${productVersion}; the release asset must build from that cohort.`);
    process.exit(0);
  }

  // The live channel serves a different product version. There is deliberately
  // no "pass cohort_sha = <older cohort>" suggestion: an older cohort may not
  // be republished onto the active channel while `latest` points elsewhere.
  fail(
    'VERSION_LAGS',
    `the npm channel serves product version ${atCohort.version} (${pkg}@${latestVersion}, cohort ${cohort.slice(0, 10)}), not ${productVersion}. Build the release for the product version npm currently serves; an older cohort cannot overwrite the active channel.`,
    { installerVersion: latestVersion, cohort, channelProductVersion: atCohort.version },
  );
}

await main();
