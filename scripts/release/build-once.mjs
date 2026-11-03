#!/usr/bin/env node
/**
 * Build-once guard for the npm release train (G3.2 / ARCH-SIMPLIFICATION §6).
 *
 * All eight train legs execute sequentially in ONE job on ONE runner against
 * ONE cohort checkout. Several ABSENT legs build the SAME package with the
 * SAME npm script: the installer and pd-cli legs rebuild codex-adapter,
 * workbuddy-adapter and pd-cli that an earlier leg already built, and the
 * train preamble builds install-layout and host-runtime before their own legs
 * build them again. The later build consumes identical inputs and can only
 * reproduce the same output — no independent verification value (ARCH §8).
 *
 * This helper wraps one explicit `npm run <script> --workspace <ws>` with a
 * job-scoped ledger (RUNNER_TEMP is ephemeral per job, so entries can never
 * leak across cohorts or runs). Artifact identity recorded per entry:
 *   cohort (40-hex SHA) · package version · SHA-256 of the dist/ tree.
 * A repeat is skipped ONLY when all three still match what is on disk now.
 * Any mismatch (missing dist, mutated/corrupted dist, other cohort, other
 * version) is reported as a GitHub ::warning:: with the exact reason and the
 * package is rebuilt — never a silent fallback, never a silent skip. A failed
 * build fails the step exactly like the unwrapped command.
 *
 * Deliberately NOT wrapped (see action.yml): packages whose own leg lifecycle
 * rewrites dist into a different variant (principles-disciple: its prepack
 * replaces the tsc output with the production bundle), single-site builds,
 * reproducibility double builds (independent verification), and
 * release-metadata asset legs (each runner needs its own native build).
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { digestDist } from './lib/dist-digest.mjs';

function argValue(flag) {
  const index = process.argv.indexOf(flag);
  return index === -1 ? undefined : process.argv[index + 1];
}

const workspace = argValue('--workspace');
const script = argValue('--script');
const dir = argValue('--dir');
const cohort = argValue('--cohort');
const ledgerPath = argValue('--ledger') ?? join(process.env.RUNNER_TEMP ?? '.', 'pd-built-once.json');

const usage = 'usage: build-once.mjs --workspace <ws-name> --script <npm-script> --dir <package-dir> --cohort <40-hex> [--ledger <path>]';
if (!workspace || !script || !dir || !/^[a-f0-9]{40}$/.test(cohort ?? '') || process.argv.includes('--help')) {
  console.error(usage);
  process.exit(2);
}

const packageDir = resolve(dir);
const manifestPath = join(packageDir, 'package.json');
const distDir = join(packageDir, 'dist');
if (!existsSync(manifestPath)) {
  console.error(`build-once: package dir has no package.json: ${packageDir}`);
  process.exit(2);
}

function readVersion() {
  const version = JSON.parse(readFileSync(manifestPath, 'utf8')).version;
  if (typeof version !== 'string' || version.length === 0) {
    throw new Error(`build-once: ${manifestPath} has no version`);
  }
  return version;
}

function readLedger() {
  if (!existsSync(ledgerPath)) return {};
  try {
    const parsed = JSON.parse(readFileSync(ledgerPath, 'utf8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
  } catch {
    // fall through — a corrupt ledger can never enable a skip
  }
  console.log(`::warning::build-once: ledger ${ledgerPath} is unreadable — every package rebuilds`);
  return {};
}

const key = `${workspace}#${script}`;
const ledger = readLedger();
const entry = Object.hasOwn(ledger, key) ? ledger[key] : undefined;

if (entry !== undefined) {
  const reasons = [];
  if (entry.cohort !== cohort) reasons.push(`recorded cohort ${String(entry.cohort).slice(0, 12)} != current ${cohort.slice(0, 12)}`);
  let currentVersion;
  try {
    currentVersion = readVersion();
  } catch (error) {
    reasons.push(error.message);
  }
  if (currentVersion !== undefined && entry.version !== currentVersion) reasons.push(`recorded version ${entry.version} != current ${currentVersion}`);
  let currentDigest;
  try {
    currentDigest = digestDist(distDir);
  } catch (error) {
    // A dist with symlinks/special entries is not a reusable artifact. Rebuild
    // (the build replaces dist); if the rebuild still emits one, the post-build
    // digest below fails the step instead of recording an untrustworthy result.
    reasons.push(error.message);
  }
  if (currentDigest === null) reasons.push('dist/ is missing or empty');
  else if (currentDigest !== undefined && entry.distSha256 !== currentDigest) {
    reasons.push('dist/ content changed since it was recorded (SHA-256 mismatch)');
  }

  if (reasons.length === 0) {
    console.log(`build-once: ${key} reused for cohort ${cohort.slice(0, 12)} (version ${currentVersion}, dist sha256 ${currentDigest.slice(0, 16)}…)`);
    process.exit(0);
  }
  console.log(`::warning::build-once: ${key} ledger entry rejected (${reasons.join('; ')}) — rebuilding`);
}

// ERR-045: run npm through the running Node binary and npm-cli.js with pure
// argv arrays (bare `npm` is not spawnable on Windows dev machines).
const nodeDir = dirname(process.execPath);
const prefixDir = dirname(nodeDir);
const npmCliJs = [
  join(nodeDir, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  join(prefixDir, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  join(prefixDir, 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
].find((candidate) => existsSync(candidate));
if (!npmCliJs) {
  console.error('build-once: npm-cli.js not found next to the running Node binary');
  process.exit(1);
}

execFileSync(process.execPath, [npmCliJs, 'run', script, '--workspace', workspace], { stdio: 'inherit' });

let builtDigest;
try {
  builtDigest = digestDist(distDir);
} catch (error) {
  console.error(`build-once: ${key} built a dist/ tree that is not a regular-file artifact — refusing to record it: ${error.message}`);
  process.exit(1);
}
if (builtDigest === null) {
  console.error(`build-once: ${key} completed but ${distDir} is missing or empty — refusing to record`);
  process.exit(1);
}
ledger[key] = { cohort, version: readVersion(), distSha256: builtDigest };
mkdirSync(dirname(ledgerPath), { recursive: true });
writeFileSync(ledgerPath, JSON.stringify(ledger, null, 2) + '\n');
console.log(`build-once: ${key} built for cohort ${cohort.slice(0, 12)} (dist sha256 ${builtDigest.slice(0, 16)}…)`);
