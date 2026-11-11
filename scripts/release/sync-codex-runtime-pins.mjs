#!/usr/bin/env node
// The Codex runtime pin is generated INSIDE the Version Packages PR
// (`--compose`, see materialize-version-plan.mjs) and verified against npm
// after the publish train (`--verify`). `--cohort` is the manual recovery path
// that reads a proven published cohort; no mode opens a PR of its own.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { fetchExactManifest } from './lib/registry-client.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
// mcpServer (Gate 4, PRI-1071) rides the same exact-pin release train.
const packages = { codexAdapter: '@principles/codex-adapter', hostRuntime: '@principles/host-runtime', core: '@principles/core', mcpServer: '@principles/pd-mcp-server' };
const plugin = 'plugins/principles-disciple/';
const pinsFile = plugin + 'runtime-version.json';
const metadataFile = plugin + '.codex-plugin/plugin.json';
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' });

export function nextPins(versions) {
  const pins = {};
  for (const [key, name] of Object.entries(packages)) {
    const version = versions?.[name];
    if (typeof version !== 'string' || !/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`invalid cohort version: ${name}`);
    pins[key] = version;
  }
  return pins;
}

export function checkMetadata(baseVersion, nextVersion, payloadChanged) {
  if (!payloadChanged) return;
  const parse = value => {
    if (typeof value !== 'string' || !/^\d+\.\d+\.\d+$/.test(value)) throw new Error('invalid Codex plugin version');
    return value.split('.').map(Number);
  };
  const before = parse(baseVersion), after = parse(nextVersion);
  const first = after.findIndex((value, i) => value !== before[i]);
  if (first < 0 || after[first] < before[first]) throw new Error('Codex plugin payload changed without increasing plugin.json version; Codex cache would not discover the update');
}

export function assertNoDowngrade(current, target) {
  for (const key of Object.keys(packages)) {
    // A key absent from the existing pins file is the FIRST introduction of
    // that component (e.g. mcpServer in Gate 4) — nothing to downgrade.
    if (current[key] === undefined) continue;
    if (typeof current[key] !== 'string' || !/^\d+\.\d+\.\d+$/.test(current[key])) throw new Error(`invalid existing pin: ${key}`);
    const before = current[key].split('.').map(Number), after = target[key].split('.').map(Number);
    const first = after.findIndex((value, i) => value !== before[i]);
    if (first >= 0 && after[first] < before[first]) throw new Error(`stale cohort would downgrade ${key}; rerun the current release cohort instead`);
  }
}

const PIN_KEYS = Object.keys(packages);

/** The pin file itself — the ONLY artifact normal PRs are forbidden to edit. */
export const CODEX_RUNTIME_PIN_PATH = pinsFile;

/** The two Version-PR artifacts this module owns (pin + Codex cache version). */
export const RUNTIME_PIN_TARGETS = [CODEX_RUNTIME_PIN_PATH, metadataFile];

/** Exact three-part versions for all four components — the pin contract. */
export function assertExactPins(pins, label = 'pin') {
  for (const key of PIN_KEYS) {
    const version = pins?.[key];
    if (typeof version !== 'string' || !/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`invalid ${label}: ${key}`);
  }
}

function workspaceVersion(cwd, npmName) {
  const packagesDir = path.join(cwd, 'packages');
  for (const dir of fs.readdirSync(packagesDir)) {
    const manifestPath = path.join(packagesDir, dir, 'package.json');
    if (!fs.existsSync(manifestPath)) continue;
    let manifest;
    try {
      manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    } catch (error) {
      throw new Error(`unreadable workspace manifest: ${manifestPath} (${error.message})`);
    }
    if (manifest?.name === npmName) return manifest.version;
  }
  return undefined;
}

/**
 * The pin this cohort's own manifests demand. This is a READ: it is the single
 * expected value used both by the Version-PR producer and by post-publication
 * verification, so the two can never disagree about what the pin should be.
 */
export function pinsFromWorkspace(cwd = root) {
  const versions = {};
  for (const name of Object.values(packages)) {
    const version = workspaceVersion(cwd, name);
    if (version === undefined) throw new Error(`pinned runtime package is not a workspace member: ${name}`);
    versions[name] = version;
  }
  return nextPins(versions);
}

/**
 * The single writer for both modes: no path may produce pins without the
 * downgrade check and the paired Codex cache-version bump.
 */
function applyPins(cwd, target) {
  const pinsPath = path.join(cwd, pinsFile);
  const current = JSON.parse(fs.readFileSync(pinsPath, 'utf8'));
  assertNoDowngrade(current, target);
  if (PIN_KEYS.every((key) => current[key] === target[key])) {
    return { changed: false, pins: target };
  }
  const metadataPath = path.join(cwd, metadataFile);
  const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
  if (typeof metadata.version !== 'string' || !/^\d+\.\d+\.\d+$/.test(metadata.version)) {
    throw new Error('invalid plugin metadata version');
  }
  const before = metadata.version;
  const parts = before.split('.').map(Number);
  parts[2] += 1;
  metadata.version = parts.join('.');
  checkMetadata(before, metadata.version, true);
  fs.writeFileSync(pinsPath, JSON.stringify({ ...current, ...target }, null, 2) + '\n');
  fs.writeFileSync(metadataPath, JSON.stringify(metadata, null, 2) + '\n');
  return { changed: true, pins: target, pluginVersion: metadata.version };
}

/**
 * Version-PR materialization: pin the four runtime packages to THIS cohort's
 * committed versions and bump the Codex cache version with them. The bump is
 * not optional — Codex keys its plugin cache by `.codex-plugin/plugin.json`
 * version, so equal-content payloads with an unchanged version would never be
 * picked up.
 */
export function composePinsFromWorkspace(cwd = root) {
  return applyPins(cwd, pinsFromWorkspace(cwd));
}

/**
 * Compare the shipped pin with the registry. A pin may only pass when the
 * EXACT version exists and the registry reports that same identity — a
 * published-later version, a floating tag, or a missing component all fail.
 */
export async function verifyPinnedManifests({ pins, fetchManifest }) {
  assertExactPins(pins);
  const checked = [];
  const problems = [];
  for (const [key, name] of Object.entries(packages)) {
    const version = pins[key];
    checked.push(`${name}@${version}`);
    const manifest = await fetchManifest(name, version);
    if (!manifest) {
      problems.push(`${name}@${version}: not published`);
    } else if (manifest.name !== name || manifest.version !== version) {
      problems.push(`${name}@${version}: registry returned ${String(manifest.name)}@${String(manifest.version)}`);
    }
  }
  return { checked, problems };
}

/**
 * Post-publication gate with the SAME propagation budget as the cohort wait
 * (PUBLISH_WAIT_TIMEOUT_MS + one independent recheck round), because a pin is
 * only wrong if it is still wrong once npm has had time to catch up. The error
 * names every offending package and the measured elapsed time; it never
 * degrades into a warning.
 */
export async function waitForPinnedManifests({
  pins,
  fetchManifest,
  timeoutMs = PUBLISH_WAIT_TIMEOUT_MS,
  recheckMs = PUBLISH_RECHECK_TIMEOUT_MS,
  intervalMs = PUBLISH_WAIT_INTERVAL_MS,
  now = () => Date.now(),
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}) {
  const startedAt = now();
  const mainDeadline = startedAt + Math.max(0, timeoutMs);
  const recheckDeadline = mainDeadline + Math.max(0, recheckMs);
  for (;;) {
    const { checked, problems } = await verifyPinnedManifests({ pins, fetchManifest });
    if (problems.length === 0) return { checked, elapsedMs: now() - startedAt };
    const nowMs = now();
    if (nowMs >= recheckDeadline) {
      throw new Error(
        `shipped Codex runtime pin does not match the registry after ${nowMs - startedAt}ms (main budget ${timeoutMs}ms + ${recheckMs}ms recheck): ${problems.join('; ')}; nextAction: confirm the cohort published, then fix the pin through a new Version Packages PR — the pin is generated there, never by hand`,
      );
    }
    const phaseDeadline = nowMs < mainDeadline ? mainDeadline : recheckDeadline;
    await sleep(Math.min(intervalMs, phaseDeadline - nowMs));
  }
}

/**
 * PRI-1067: propagation budget for the maintenance leg (2s after publish is
 * real). PRI-1094 (Owner decision, 2026-11-04): a cohort package can stay
 * registry-invisible longer than 60s. Measured 2026-11-04: the
 * installer leg took ~4 minutes (publish finished 02:54:50Z, the registry only
 * reported 1.147.3 at 02:59:00Z), which also outlived the 180s budget.
 *
 * This budget is therefore the single authority, and it is sized for the
 * observed long tail with two distinct phases:
 *   * main wait: 300s — covers the 4-minute tail measured on the installer;
 *   * one independent recheck round: derived from the same budget (1/3 = 100s,
 *     inside the required 60-120s), because any fixed window can be exceeded
 *     again and hard-failing at the first deadline would be avoidable noise.
 *
 * Callers may still pass an explicit `timeoutMs`/`recheckMs`; no other magic
 * number is allowed to appear in the workflow.
 */
export const PUBLISH_WAIT_TIMEOUT_MS = 300_000;
export const PUBLISH_RECHECK_TIMEOUT_MS = PUBLISH_WAIT_TIMEOUT_MS / 3;
export const PUBLISH_WAIT_INTERVAL_MS = 5_000;

function sleepSync(ms) {
  if (ms <= 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * No safe default exists for the ancestry question: answering "not an ancestor"
 * from missing wiring would silently turn every supersession back into a red
 * release run, and answering "ancestor" would turn every mismatch green. Refuse
 * loudly instead; the CLI always wires `gitIsAncestor`.
 */
function unwiredAncestry() {
  throw new Error('ancestry authority is not wired: refusing to decide whether the target cohort was superseded');
}

/**
 * Relationship between the cohort this run must pin and the cohort main
 * resolves to right now. The outcomes are deliberately distinct so a real
 * failure cannot be softened into a deferral: only `superseded` may defer.
 *
 *   current    — the resolver reproduced exactly this cohort; wait for its
 *                packages, then update the pins.
 *   superseded — a PROVEN newer cohort exists and this target is its ancestor;
 *                the newer cohort's run owns delivery.
 *   unproven   — the resolver did not reproduce a Version Packages landing
 *                commit, so nothing about it can be trusted.
 *   unrelated  — a different cohort, but this target is not an ancestor of it
 *                (target newer than main, unrelated history, shallow clone,
 *                wrong dispatch SHA). Supersession is NOT proven.
 */
export function classifyCohort({ sha, latest, isAncestor = unwiredAncestry }) {
  if (latest?.cohort !== true) {
    return { outcome: 'unproven', reason: 'resolved value is not a proven Version Packages landing commit' };
  }
  if (latest.sha === sha) return { outcome: 'current' };
  if (isAncestor(sha, latest.sha)) return { outcome: 'superseded', supersededBy: latest.sha };
  return {
    outcome: 'unrelated',
    reason: 'target cohort is not an ancestor of the resolved cohort, so supersession is not proven',
  };
}

/**
 * The one place the deferral is rendered. Pure so all three visibility
 * surfaces (stdout line, JSON payload, job summary) are testable without
 * running the CLI.
 */
export function deferredReport({ target, supersededBy }) {
  return {
    line: `[codex-runtime-pins] deferred: cohort ${target} was superseded by ${supersededBy}; no pin update from this run`,
    summary: [
      '### Codex plugin runtime pins: deferred (no update from this run)',
      '',
      `- **Target cohort:** \`${target}\``,
      `- **Superseded by:** \`${supersededBy}\` — a proven newer Version Packages landing commit on main.`,
      '- **Pins changed:** none. This run did not touch `runtime-version.json` or `.codex-plugin/plugin.json`.',
      "- **Why this is not a failure:** the newer cohort's own release run owns the pin update; the pin ships inside that cohort's Version Packages PR.",
      '- **If that run also fails:** the next Version Packages PR regenerates the pin from the workspace manifests; publication only verifies it.',
    ].join('\n'),
    payload: { ok: true, changed: false, deferred: true, cohort: target, supersededBy },
  };
}

/**
 * Resolve the current cohort, waiting through npm's propagation window.
 *
 * A registry QUERY failure must not be retried as "not published": the resolver
 * exits non-zero for that case and `resolve()` throws, so the error propagates
 * immediately. Only a successful resolve that reports `publishComplete:false`
 * is retried, within an explicit interval and total budget. Once the main
 * budget is exhausted, ONE independent recheck round runs before failing, so a
 * long-tail package that appears a few minutes late is still accepted.
 *
 * On exhaustion the error reports the MEASURED elapsed time (not just the
 * configured budget) and names every package still missing. When the recheck
 * round rescues the cohort, the measured delay is logged, so the next train can
 * be sized from evidence instead of guesses.
 *
 * A cohort that a PROVEN newer cohort has superseded is not a failure of this
 * run: it returns `{ outcome: 'deferred', supersededBy }` so the caller can
 * report the hand-off instead of failing the release train. Supersession must
 * be proven twice — `latest.cohort === true` (the resolver reproduced a Version
 * Packages landing commit) and `isAncestor(target, latest.sha)` (the target
 * really is an earlier point on the same spine). Every other mismatch (target
 * newer than main, unrelated history, an unproven resolver result, no resolvable
 * cohort) still throws. `isAncestor` has no safe default: a caller that forgets
 * to wire it is refused loudly the first time the question is asked, instead of
 * silently reading a supersession as an unrelated cohort (or the reverse).
 */
export function waitForPublishedCohort({
  sha,
  resolve,
  isAncestor = unwiredAncestry,
  timeoutMs = PUBLISH_WAIT_TIMEOUT_MS,
  recheckMs = PUBLISH_RECHECK_TIMEOUT_MS,
  intervalMs = PUBLISH_WAIT_INTERVAL_MS,
  now = () => Date.now(),
  sleep = sleepSync,
}) {
  if (!/^[a-f0-9]{40}$/.test(sha)) throw new Error('cohort must be an exact 40-character SHA');
  const startedAt = now();
  const mainDeadline = startedAt + Math.max(0, timeoutMs);
  const recheckDeadline = mainDeadline + Math.max(0, recheckMs);
  let latest = resolve();
  for (;;) {
    const verdict = classifyCohort({ sha, latest, isAncestor });
    if (verdict.outcome === 'superseded') {
      return { ...latest, outcome: 'deferred', target: sha, supersededBy: verdict.supersededBy };
    }
    if (verdict.outcome !== 'current') {
      throw new Error(
        `target is not the current release cohort (expected ${sha}, got ${latest?.sha ?? 'none'})` +
          (verdict.reason ? `: ${verdict.reason}` : ''),
      );
    }
    if (latest.publishComplete === true) {
      const elapsed = now() - startedAt;
      if (elapsed > Math.max(0, timeoutMs)) {
        console.log(`published cohort became visible after ${elapsed}ms (main budget ${timeoutMs}ms exhausted; recovered by ${recheckMs}ms recheck)`);
      }
      return { ...latest, outcome: 'published' };
    }
    const missing = (Array.isArray(latest.packages) ? latest.packages : [])
      .filter(pkg => pkg?.published !== true)
      .map(pkg => `${String(pkg?.name)}@${String(pkg?.version)}`);
    const nowMs = now();
    if (nowMs >= recheckDeadline) {
      throw new Error(
        `published cohort incomplete after ${nowMs - startedAt}ms (main budget ${timeoutMs}ms + ${recheckMs}ms recheck); missing: ${missing.length > 0 ? missing.join(', ') : 'registry did not report any package state'}; nextAction: retry the current release train once npm registry propagation completes`,
      );
    }
    const phaseDeadline = nowMs < mainDeadline ? mainDeadline : recheckDeadline;
    sleep(Math.min(intervalMs, phaseDeadline - nowMs));
    latest = resolve();
  }
}

/**
 * True only when `ancestor` is a real ancestor of `descendant` in this clone.
 * git exits 1 for "no"; any other failure is an unanswered question and must
 * stay a hard failure instead of being read as either answer.
 *
 * Exported so tests can exercise the real git call instead of only a fake.
 */
export function gitIsAncestor(ancestor, descendant) {
  try {
    execFileSync('git', ['merge-base', '--is-ancestor', ancestor, descendant], { cwd: root, stdio: 'ignore' });
    return true;
  } catch (error) {
    if (error?.status === 1) return false;
    throw new Error(`ancestry check failed (${ancestor} -> ${descendant}): ${error?.message ?? error}`);
  }
}

function appendStepSummary(markdown) {
  const file = process.env.GITHUB_STEP_SUMMARY;
  if (!file) return;
  fs.appendFileSync(file, markdown.endsWith('\n') ? markdown : `${markdown}\n`);
}

const USAGE =
  'usage: sync-codex-runtime-pins.mjs --compose [--root <dir>] | --verify [--root <dir>] | --cohort <sha> | --check-base <sha>';

function parseCli(argv) {
  const [flag, ...rest] = argv;
  let value;
  let cwd = root;
  for (let i = 0; i < rest.length; i += 1) {
    if (rest[i] === '--root') {
      const dir = rest[i + 1];
      if (!dir) throw new Error(`--root requires a directory. ${USAGE}`);
      cwd = path.resolve(dir);
      i += 1;
    } else if (value === undefined) {
      value = rest[i];
    } else {
      throw new Error(`unexpected argument "${rest[i]}". ${USAGE}`);
    }
  }
  return { flag, value, cwd };
}

async function main() {
  const { flag, value, cwd } = parseCli(process.argv.slice(2));
  if (flag === '--compose') {
    if (value) throw new Error(USAGE);
    const result = composePinsFromWorkspace(cwd);
    console.log(JSON.stringify({ ok: true, ...result }));
    return;
  }
  if (flag === '--verify') {
    if (value) throw new Error(USAGE);
    // The pin must equal THIS tree's committed package versions before the
    // registry is even asked: a pin that disagrees with its own cohort is
    // wrong regardless of what npm has.
    const expected = pinsFromWorkspace(cwd);
    const pins = JSON.parse(fs.readFileSync(path.join(cwd, pinsFile), 'utf8'));
    assertExactPins(pins);
    const mismatch = PIN_KEYS.filter((key) => pins[key] !== expected[key]);
    if (mismatch.length > 0) {
      throw new Error(
        `runtime pin does not match this cohort's committed package versions: ${mismatch.map((key) => `${key} pin=${pins[key]} workspace=${expected[key]}`).join('; ')}; nextAction: the pin is generated by the Version Packages PR — open one instead of editing the pin`,
      );
    }
    const result = await waitForPinnedManifests({ pins, fetchManifest: fetchExactManifest });
    console.log(JSON.stringify({ ok: true, changed: false, verified: true, pins: expected, checked: result.checked, elapsedMs: result.elapsedMs }));
    return;
  }
  if (flag === '--check-base') {
    const changed = git('diff', '--name-only', value, '--', plugin).trim().split('\n').filter(Boolean);
    // Documentation outside the shipped plugin never triggers this check.
    const metadata = JSON.parse(fs.readFileSync(path.join(root, metadataFile), 'utf8'));
    const before = JSON.parse(git('show', `${value}:${metadataFile}`));
    checkMetadata(before.version, metadata.version, changed.length > 0);
    console.log(JSON.stringify({ ok: true, payloadChanged: changed.length > 0 }));
    return;
  }
  if (flag !== '--cohort') throw new Error(USAGE);
  if (!/^[a-f0-9]{40}$/.test(value)) throw new Error('cohort must be an exact 40-character SHA');
  // This existing resolver proves the SHA by deterministic Version PR reproduction.
  const cohort = JSON.parse(execFileSync(process.execPath, [path.join(root, 'scripts/release/resolve-release-cohort.mjs'), '--explicit', value], { cwd: root, encoding: 'utf8' }));
  if (cohort.cohort !== true || cohort.sha !== value) throw new Error('unproven release cohort');
  // Manual recovery path only: a delayed run must not roll the pin back to an
  // older cohort. A proven supersession is a hand-off, not a failure: the wait
  // returns outcome:'deferred' and this run reports it instead of writing pins.
  // Reuse the same main-spine authority as the daily publish reconciliation.
  // PRI-1067: npm publication returning is not registry visibility; wait a
  // bounded amount instead of treating the first packument read as final.
  const outcome = waitForPublishedCohort({
    sha: value,
    resolve: () => JSON.parse(execFileSync(process.execPath, [path.join(root, 'scripts/release/resolve-release-cohort.mjs')], { cwd: root, encoding: 'utf8' })),
    isAncestor: gitIsAncestor,
  });
  if (outcome.outcome === 'deferred') {
    const report = deferredReport({ target: value, supersededBy: outcome.supersededBy });
    console.log(report.line);
    appendStepSummary(report.summary);
    console.log(JSON.stringify(report.payload));
    return;
  }
  const target = nextPins(cohort.versions);
  // All four exact packages must exist before any file mutation.
  for (const [key, name] of Object.entries(packages)) {
    const manifest = await fetchExactManifest(name, target[key]);
    if (!manifest || manifest.name !== name || manifest.version !== target[key]) throw new Error(`published cohort incomplete: ${name}@${target[key]}`);
  }
  console.log(JSON.stringify({ ok: true, cohort: value, ...applyPins(root, target) }));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(`::error::Codex plugin delivery blocked: ${error.message}. npm publication alone is not plugin delivery: the pin is materialized inside the Version Packages PR and verified against the registry after the train.`); process.exitCode = 1; });
}
