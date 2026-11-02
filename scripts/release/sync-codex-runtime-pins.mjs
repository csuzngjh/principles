#!/usr/bin/env node
// Ordinary maintenance PR payload, never part of Version PR materialization.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { fetchExactManifest } from './lib/registry-client.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const packages = { codexAdapter: '@principles/codex-adapter', hostRuntime: '@principles/host-runtime', core: '@principles/core' };
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
    if (typeof current[key] !== 'string' || !/^\d+\.\d+\.\d+$/.test(current[key])) throw new Error(`invalid existing pin: ${key}`);
    const before = current[key].split('.').map(Number), after = target[key].split('.').map(Number);
    const first = after.findIndex((value, i) => value !== before[i]);
    if (first >= 0 && after[first] < before[first]) throw new Error(`stale cohort would downgrade ${key}; rerun the current release cohort instead`);
  }
}

/** PRI-1067: propagation budget for the maintenance leg (2s after publish is real). */
export const PUBLISH_WAIT_TIMEOUT_MS = 60_000;
export const PUBLISH_WAIT_INTERVAL_MS = 5_000;

function sleepSync(ms) {
  if (ms <= 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Resolve the current cohort, waiting through npm's propagation window.
 *
 * A registry QUERY failure must not be retried as "not published": the resolver
 * exits non-zero for that case and `resolve()` throws, so the error propagates
 * immediately. Only a successful resolve that reports `publishComplete:false`
 * is retried, within an explicit interval and total budget. On budget
 * exhaustion the error names every package still missing, never a generic
 * "not the current cohort".
 */
export function waitForPublishedCohort({
  sha,
  resolve,
  timeoutMs = PUBLISH_WAIT_TIMEOUT_MS,
  intervalMs = PUBLISH_WAIT_INTERVAL_MS,
  now = () => Date.now(),
  sleep = sleepSync,
}) {
  if (!/^[a-f0-9]{40}$/.test(sha)) throw new Error('cohort must be an exact 40-character SHA');
  const deadline = now() + timeoutMs;
  for (;;) {
    const latest = resolve();
    if (latest?.cohort !== true || latest.sha !== sha) {
      throw new Error(`target is not the current release cohort (expected ${sha}, got ${latest?.sha ?? 'none'})`);
    }
    if (latest.publishComplete === true) return latest;
    const missing = (Array.isArray(latest.packages) ? latest.packages : [])
      .filter(pkg => pkg?.published !== true)
      .map(pkg => `${String(pkg?.name)}@${String(pkg?.version)}`);
    const remaining = deadline - now();
    if (remaining <= 0) {
      throw new Error(
        `published cohort incomplete after ${timeoutMs}ms; missing: ${missing.length > 0 ? missing.join(', ') : 'registry did not report any package state'}; nextAction: retry the current release train once npm registry propagation completes`,
      );
    }
    sleep(Math.min(intervalMs, remaining));
  }
}

async function main() {
  const flag = process.argv[2], value = process.argv[3];
  if (!['--cohort', '--check-base'].includes(flag) || !value || process.argv.length !== 4) throw new Error('usage: sync-codex-runtime-pins.mjs --cohort <sha> | --check-base <sha>');
  if (flag === '--check-base') {
    const changed = git('diff', '--name-only', value, '--', plugin).trim().split('\n').filter(Boolean);
    // Documentation outside the shipped plugin never triggers this check.
    const metadata = JSON.parse(fs.readFileSync(path.join(root, metadataFile), 'utf8'));
    const before = JSON.parse(git('show', `${value}:${metadataFile}`));
    checkMetadata(before.version, metadata.version, changed.length > 0);
    console.log(JSON.stringify({ ok: true, payloadChanged: changed.length > 0 }));
    return;
  }
  if (!/^[a-f0-9]{40}$/.test(value)) throw new Error('cohort must be an exact 40-character SHA');
  // This existing resolver proves the SHA by deterministic Version PR reproduction.
  const cohort = JSON.parse(execFileSync(process.execPath, [path.join(root, 'scripts/release/resolve-release-cohort.mjs'), '--explicit', value], { cwd: root, encoding: 'utf8' }));
  if (cohort.cohort !== true || cohort.sha !== value) throw new Error('unproven release cohort');
  // A delayed run must not overwrite a maintenance branch for a newer cohort.
  // Reuse the same main-spine authority as the daily publish reconciliation.
  // PRI-1067: npm publication returning is not registry visibility; wait a
  // bounded amount instead of treating the first packument read as final.
  const latest = waitForPublishedCohort({
    sha: value,
    resolve: () => JSON.parse(execFileSync(process.execPath, [path.join(root, 'scripts/release/resolve-release-cohort.mjs')], { cwd: root, encoding: 'utf8' })),
  });
  const target = nextPins(cohort.versions);
  // All three exact packages must exist before any file mutation/PR creation.
  for (const [key, name] of Object.entries(packages)) {
    const manifest = await fetchExactManifest(name, target[key]);
    if (!manifest || manifest.name !== name || manifest.version !== target[key]) throw new Error(`published cohort incomplete: ${name}@${target[key]}`);
  }
  const pinsPath = path.join(root, pinsFile);
  const current = JSON.parse(fs.readFileSync(pinsPath, 'utf8'));
  assertNoDowngrade(current, target);
  if (Object.keys(packages).every(key => current[key] === target[key])) {
    console.log(JSON.stringify({ ok: true, changed: false, cohort: value }));
    return;
  }
  const metadataPath = path.join(root, metadataFile);
  const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
  if (!/^\d+\.\d+\.\d+$/.test(metadata.version)) throw new Error('invalid plugin metadata version');
  const parts = metadata.version.split('.').map(Number);
  parts[2] += 1;
  metadata.version = parts.join('.');
  fs.writeFileSync(pinsPath, JSON.stringify({ ...current, ...target }, null, 2) + '\n');
  fs.writeFileSync(metadataPath, JSON.stringify(metadata, null, 2) + '\n');
  console.log(JSON.stringify({ ok: true, changed: true, cohort: value, pins: target, pluginVersion: metadata.version }));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(`::error::Codex plugin delivery blocked: ${error.message}. Repair/retry the ordinary runtime-pins maintenance PR; npm publication is not plugin delivery.`); process.exitCode = 1; });
}
