#!/usr/bin/env node
/**
 * Exact-version registry contract CLI (SPEC v1.2 §18/§19 / Step K).
 *
 *   node scripts/release/registry-exact.mjs <package> <exact-version> \
 *        [--expect-git-head <sha>] [--json]
 *
 * One packument fetch answers every question:
 *   ABSENT                exact name@version not on the registry
 *   PRESENT_MATCH         present, provenance matches the expected cohort SHA
 *   PRESENT_CONFLICT      present, provenance points elsewhere
 *   PRESENT_UNVERIFIED    present, identity not verifiable (no gitHead)
 *   LOCAL_BEHIND_REGISTRY the registry latest is NEWER than this exact
 *                         version — main is behind the known registry
 *                         authority; publishing would fork the line
 *                         (SPEC §19; the T1 baseline gate)
 *   REGISTRY_ERROR        registry unreachable/misbehaving (NEVER "absent")
 *
 * Exit codes: 0 = ABSENT/PRESENT_MATCH (actionable), 3 = CONFLICT,
 * 4 = UNVERIFIED, 5 = REGISTRY_ERROR, 6 = LOCAL_BEHIND_REGISTRY.
 */
import { classifyPresence, fetchPackument } from './lib/registry-client.mjs';

function argValue(flag) {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const asJson = process.argv.includes('--json');
const positional = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const npmName = positional[0];
const exactVersion = positional[1];
const expectGitHead = argValue('--expect-git-head');

if (!npmName || !exactVersion || !/^\d+\.\d+\.\d+(-[\w.-]+)?$/.test(exactVersion)) {
  console.error('usage: registry-exact.mjs <package> <exact-version> [--expect-git-head <sha>] [--json]');
  process.exit(2);
}

function emit(status, detail) {
  const payload = { status, package: npmName, version: exactVersion, ...detail };
  if (asJson) console.log(JSON.stringify(payload));
  else console.log(`${status} ${npmName}@${exactVersion}${detail.reason ? ` — ${detail.reason}` : ''}`);
  const code = {
    ABSENT: 0,
    PRESENT_MATCH: 0,
    PRESENT_CONFLICT: 3,
    PRESENT_UNVERIFIED: 4,
    REGISTRY_ERROR: 5,
    LOCAL_BEHIND_REGISTRY: 6,
  }[status];
  process.exit(code ?? 5);
}

function semverCompare(a, b) {
  const pa = a.split('-')[0].split('.').map(Number);
  const pb = b.split('-')[0].split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1;
  }
  return 0;
}

let packument;
try {
  packument = await fetchPackument(npmName);
} catch (err) {
  emit('REGISTRY_ERROR', { reason: err?.message ?? String(err) });
}

if (packument === null) {
  emit('ABSENT', { packageExists: false, latest: null });
}

const latest = packument['dist-tags']?.latest ?? null;
const exactManifest = packument.versions?.[exactVersion] ?? null;

if (latest && semverCompare(exactVersion, latest) < 0) {
  emit('LOCAL_BEHIND_REGISTRY', {
    reason: `committed version is behind the registry latest (${latest}); publish would fork the package line`,
    latest,
  });
}

if (exactManifest === null) {
  emit('ABSENT', { packageExists: true, latest });
}

const status = classifyPresence(exactManifest, { expectGitHead });
emit(status, { latest, gitHead: exactManifest.gitHead ?? null });
