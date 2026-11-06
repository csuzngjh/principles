#!/usr/bin/env node
/**
 * PRI-1103 race guard — re-prove the npm cohort identity BEFORE a release
 * publication commits to bytes.
 *
 * THE RACE. `release-metadata.yml` resolves the npm cohort ONCE, at the start
 * of the run, and then spends a long time building nine platform assets. The
 * npm channel is a GLOBAL, MUTABLE fact: if another npm train finishes during
 * that build, `dist-tags.latest` moves from commit A to commit B while this
 * run keeps building A. Every asset can carry a perfectly valid embedded
 * identity stamp and still be the WRONG bytes, because nothing in the asset
 * proves that A is still what a fresh `npx` install receives at delivery
 * time.
 *
 * THE GUARD. Re-read the npm channel with the SAME resolver
 * (`resolve-installer-cohort.mjs`) and the SAME registry client the initial
 * resolution used — no second npm query implementation — and compare the
 * FULL identity:
 *
 *   auto mode (no --explicit-cohort): the current `dist-tags.latest` must
 *     resolve to exactly EXPECTED_VERSION and the full 40-char EXPECTED_COMMIT;
 *   explicit-cohort mode: the named SHA must still be recorded as a published
 *     installer `gitHead`, must still declare EXPECTED_VERSION in its root
 *     manifest, and must equal EXPECTED_COMMIT (the run built that SHA).
 *
 * Both modes fail CLOSED. A 404, a 503, a timeout, malformed JSON, a missing
 * `gitHead`, a version change, a commit change, an unreadable commit, an
 * unreadable registry record, or an auto-mode resolution that changed at all
 * is a REFUSAL — never an implicit "no drift" (rc-9).
 *
 * Workflow wiring (two gates, same script so they cannot drift):
 *   gate 1 — after every platform asset is built/downloaded/identity-verified
 *            and BEFORE any external side effect (`--external-side-effects none`);
 *   gate 2 — immediately BEFORE the gh-pages metadata push
 *            (`--external-side-effects asset-bytes-uploaded`).
 *
 * A failed gate 1 leaves NOTHING published. A failed gate 2 may leave
 * content-addressed asset bytes already uploaded to the release host; these
 * are unreferenced (no signed metadata points at them), and the report says so
 * instead of claiming success.
 *
 * DRY-RUN. A rehearsal has no publication side effects, so the result is
 * ADVISORY: reported loudly, but never treated as publication evidence and
 * never blocks the rehearsal. `mode=publish` can never take the advisory path.
 *
 * Contract (--json prints exactly one JSON object on stdout):
 *
 *   status: MATCH | BLOCKED
 *   mode: auto-latest | explicit-cohort | dry-run-advisory
 *   expected: { version, commit }
 *   actual: { version, commit }   (null = unreadable / not published)
 *   resolverStatus, reason, detail, externalSideEffects
 *
 * Exit codes: 0 = verified (or dry-run advisory), 1 = BLOCKED, 2 = INVALID_ARGS.
 */
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_RESOLVER = path.join(HERE, 'resolve-installer-cohort.mjs');
const STRICT_SEMVER = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;
const GIT_SHA = /^[a-f0-9]{40}$/;
const SIDE_EFFECTS = new Set(['none', 'asset-bytes-uploaded']);

function argValue(flag) {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function invalid(message) {
  console.error(`usage: verify-publication-cohort.mjs --mode <publish|dry-run> --product-version <x.y.z> --expected-commit <40-hex> [--explicit-cohort <40-hex>] [--external-side-effects <none|asset-bytes-uploaded>] [--json]`);
  console.error(`::error::${message}`);
  process.exit(2);
}

/**
 * Run the EXISTING resolver as a subprocess. This is deliberate: the
 * resolver, not this guard, owns the npm channel query, the gitHead contract
 * and every refusal reason. Spawning it keeps one implementation (and one
 * test suite) authoritative instead of growing a parallel query path.
 */
function resolveChannel({ resolverPath, productVersion, explicitCohort }) {
  const args = [resolverPath, '--product-version', productVersion];
  if (explicitCohort !== undefined) args.push('--expect-cohort', explicitCohort);
  args.push('--json');
  let stdout = '';
  let code = 0;
  try {
    stdout = execFileSync(process.execPath, args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: 4 * 1024 * 1024,
    });
  } catch (err) {
    code = typeof err?.status === 'number' ? err.status : 1;
    stdout = String(err?.stdout ?? '');
  }
  let payload = null;
  try {
    payload = JSON.parse(stdout.trim());
  } catch {
    payload = null;
  }
  return { code, payload };
}

/** The ACTUAL side of the identity, read from the resolver's own payload —
 *  never invented by this script. `productVersion` is the REQUESTED version
 *  in a refusal payload, so it is used only for a genuine MATCH. */
function actualIdentity(status, payload) {
  switch (status) {
    case 'MATCH':
      return { version: payload?.productVersion ?? null, commit: payload?.cohort ?? null };
    case 'VERSION_LAGS':
      return { version: payload?.channelProductVersion ?? null, commit: payload?.cohort ?? null };
    case 'VERSION_MISMATCH':
      return { version: payload?.cohortProductVersion ?? null, commit: payload?.expectedCohort ?? null };
    case 'EXPLICIT_NOT_LATEST':
      // The named cohort is published, but the live channel serves another
      // commit; the actual side is the channel's current identity.
      return { version: payload?.actualProductVersion ?? null, commit: payload?.actualLatestCommit ?? null };
    case 'COMMIT_UNAVAILABLE':
      // The registry named a cohort, but this checkout cannot read it.
      return { version: null, commit: payload?.cohort ?? null };
    default:
      // ABSENT_COHORT / EXPLICIT_UNPUBLISHED / REGISTRY_ERROR / unparseable:
      // the channel identity is not established at all.
      return { version: null, commit: null };
  }
}

function main() {
  const asJson = process.argv.includes('--json');
  // cli-1-strict-json: with --json, stdout carries EXACTLY one JSON object;
  // all human-readable reporting goes to stderr instead.
  const log = asJson ? (...args) => console.error(...args) : (...args) => console.log(...args);
  const mode = argValue('--mode');
  const productVersion = argValue('--product-version');
  const expectedCommit = argValue('--expected-commit');
  const explicitCohort = argValue('--explicit-cohort');
  const sideEffects = argValue('--external-side-effects') ?? 'none';
  const resolverPath = argValue('--resolver') ?? DEFAULT_RESOLVER;

  if (mode !== 'publish' && mode !== 'dry-run') invalid(`--mode must be publish or dry-run, got ${JSON.stringify(mode)}`);
  if (typeof productVersion !== 'string' || !STRICT_SEMVER.test(productVersion)) {
    invalid(`--product-version must be a strict x.y.z version, got ${JSON.stringify(productVersion)}`);
  }
  if (typeof expectedCommit !== 'string' || !GIT_SHA.test(expectedCommit)) {
    invalid(`--expected-commit must be the full 40-char git sha this run resolved, got ${JSON.stringify(expectedCommit)}`);
  }
  if (explicitCohort !== undefined && !GIT_SHA.test(explicitCohort)) {
    invalid(`--explicit-cohort must be a full 40-char git sha, got ${JSON.stringify(explicitCohort)}`);
  }
  if (!SIDE_EFFECTS.has(sideEffects)) {
    invalid(`--external-side-effects must be none or asset-bytes-uploaded, got ${JSON.stringify(sideEffects)}`);
  }

  const { code, payload } = resolveChannel({ resolverPath, productVersion, explicitCohort });
  const resolverStatus = typeof payload?.status === 'string' ? payload.status : 'UNREADABLE_RESOLVER_OUTPUT';
  const actual = actualIdentity(resolverStatus, payload);
  const channelMode = explicitCohort === undefined ? 'auto-latest' : 'explicit-cohort';

  // The identity must match on EVERY axis. Comparing only the version is the
  // exact failure this race creates: npm can republish the same product
  // version from a different commit, and the bytes differ.
  const verified =
    code === 0 &&
    resolverStatus === 'MATCH' &&
    actual.version === productVersion &&
    actual.commit === expectedCommit;

  const reason = verified
    ? null
    : `npm channel identity does not match the identity this run built (resolver: ${resolverStatus})` +
      (payload?.detail ? `: ${payload.detail}` : '');
  const reportedMode = mode === 'dry-run' ? 'dry-run-advisory' : channelMode;
  const result = {
    status: verified ? 'MATCH' : mode === 'dry-run' ? 'ADVISORY_MISMATCH' : 'BLOCKED',
    mode: reportedMode,
    expected: { version: productVersion, commit: expectedCommit },
    actual,
    resolverStatus,
    reason,
    detail: payload?.detail ?? null,
    externalSideEffects: sideEffects,
  };

  const header = [
    `${mode === 'publish' ? 'Publication gate' : 'Publication gate (DRY RUN — advisory)'} (PRI-1103)`,
    `  mode: ${reportedMode}`,
    `  expected: productVersion=${productVersion} commit=${expectedCommit}`,
    `  actual:   productVersion=${actual.version ?? 'unreadable'} commit=${actual.commit ?? 'unreadable'}`,
    `  external side effects: ${sideEffects}`,
  ];

  if (verified) {
    for (const line of header) log(line);
    log(
      mode === 'dry-run'
        ? '  result: VERIFIED (advisory only — NOT publication evidence; this run publishes nothing).'
        : '  result: VERIFIED — the npm channel still serves the identity this run built.',
    );
    if (asJson) process.stdout.write(`${JSON.stringify(result)}\n`);
    process.exit(0);
  }

  if (mode === 'dry-run') {
    // A rehearsal publishes nothing; refusing it would only block the
    // preflight. It must never be read as publication evidence (rc-9).
    for (const line of header) log(line);
    log('::warning::PRI-1103: dry-run cohort re-check did NOT match. This run publishes nothing and this result is NOT publication evidence.');
    log(`::warning::${reason}`);
    if (asJson) process.stdout.write(`${JSON.stringify(result)}\n`);
    process.exit(0);
  }

  const nextAction =
    sideEffects === 'asset-bytes-uploaded'
      ? 'Asset bytes are ALREADY uploaded to the release host, but NO signed metadata pointer was pushed — they are content-addressed, unreferenced, and must not be presented as a publication. Re-dispatch a fresh publication from the current npm cohort; never re-point metadata at these bytes.'
      : 'Nothing was published: no asset bytes uploaded, no metadata emitted. Re-dispatch a fresh publication from the current npm cohort; do not reuse these assets.';
  for (const line of header) console.error(line);
  console.error(`::error::PRI-1103 publication gate REFUSED: ${reason}`);
  console.error(`::error::expected productVersion=${productVersion} commit=${expectedCommit}; actual productVersion=${actual.version ?? 'unreadable'} commit=${actual.commit ?? 'unreadable'}; mode=${reportedMode}; external side effects=${sideEffects}`);
  console.error(`::error::${nextAction}`);
  if (asJson) process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exit(1);
}

main();
