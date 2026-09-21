#!/usr/bin/env node
/**
 * Release cohort resolver (SPEC v1.2 §17 / Step J).
 *
 * A release cohort is defined by EXACTLY one SHA: the Version Packages PR
 * merge commit. Identity is proven by reproduction (the merge commit's
 * first-parent diff must equal the materialization of the pending
 * changesets at its first parent) — never by commit message, branch name,
 * or actor.
 *
 * Modes:
 *   --is-cohort <sha>   exit 0 iff <sha> is a Version PR merge commit
 *   --explicit <sha>    resolve that SHA as the cohort (fails loud if not)
 *   (default)           scan main's recent merge commits newest-first for
 *                       the latest cohort; also report whether every
 *                       publishable package's exact version already exists
 *                       on the registry (published-complete -> no-op)
 *
 * Output: one JSON object on stdout. Exit 0 on resolution/no-op, 1 on
 * invalid explicit SHA, 2 on nothing found (callers that treat "no cohort"
 * as a clean no-op — the weekly window — use the JSON, not the code).
 */
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { reproduceVersionMaterialization } from './lib/version-plan.mjs';
import { fetchExactManifest } from './lib/registry-client.mjs';

const DEFAULT_REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function argValue(flag) {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const repoRoot = path.resolve(argValue('--repo-root') ?? DEFAULT_REPO_ROOT);

function git(args) {
  return execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

function gitSafe(args) {
  try {
    return git(args);
  } catch {
    return null;
  }
}

async function isCohort(sha) {
  // A Version PR merge commit has two parents; the reproduction base is the
  // first parent (main before the merge). A plain commit whose diff happens
  // to be a materialization is NOT a cohort — the release identity is the
  // MERGE SHA (SPEC §17), and single-parent commits on main are feature
  // pushes, not Version PR merges.
  const parents = gitSafe(['rev-list', '--parents', '-n', '1', sha]);
  if (!parents) return { ok: false, reason: `cannot read commit ${sha}` };
  const parts = parents.trim().split(/\s+/);
  if (parts.length < 3) return { ok: false, reason: `${sha} is not a merge commit` };
  const firstParent = parts[1];
  const repro = await reproduceVersionMaterialization({ repoRoot, baseSha: firstParent, headSha: sha });
  return { ok: repro.reproducible, reason: repro.reasons.join('; '), releases: repro.releases };
}

function committedVersions(sha) {
  // Dynamic tree scan (works for the real repo AND fixture trees): every
  // workspace package manifest directly under packages/*/.
  const out = {};
  const manifests = git(['ls-tree', '-r', '--name-only', sha, '--', 'packages/'])
    .split('\n')
    .filter((f) => /^packages\/[^/]+\/package\.json$/.test(f));
  for (const rel of manifests) {
    const manifest = JSON.parse(git(['show', `${sha}:${rel}`]));
    if (manifest.private) continue;
    out[manifest.name] = manifest.version;
  }
  return out;
}

const isCohortSha = argValue('--is-cohort');
const explicitSha = argValue('--explicit');

if (isCohortSha) {
  const verdict = await isCohort(isCohortSha);
  if (verdict.ok) {
    console.log(JSON.stringify({ cohort: true, sha: isCohortSha, releases: verdict.releases }));
    process.exit(0);
  }
  console.log(JSON.stringify({ cohort: false, sha: isCohortSha, reason: verdict.reason }));
  process.exit(1);
}

if (explicitSha) {
  const verdict = await isCohort(explicitSha);
  if (!verdict.ok) {
    console.error(`::error::${explicitSha} is not a Version Packages PR merge commit (${verdict.reason}). A release cohort must be bound to the Version PR merge SHA (SPEC §17).`);
    process.exit(1);
  }
  const versions = committedVersions(explicitSha);
  console.log(JSON.stringify({ cohort: true, sha: explicitSha, releases: verdict.releases, versions }));
  process.exit(0);
}

// Default: newest-first bounded scan of main's merge commits.
const SCAN_LIMIT = Number(argValue('--scan-limit') ?? 40);
const merges = gitSafe(['rev-list', '--merges', '-n', String(SCAN_LIMIT), 'main'])
  ?.split('\n')
  .filter(Boolean) ?? [];

let found = null;
for (const sha of merges) {
  const verdict = await isCohort(sha); // eslint-disable-line no-await-in-loop
  if (verdict.ok) {
    found = { sha, releases: verdict.releases };
    break;
  }
}

if (!found) {
  console.log(JSON.stringify({ cohort: false, scanned: merges.length, reason: 'no Version Packages merge commit in the scanned window' }));
  process.exit(2);
}

const versions = committedVersions(found.sha);
const packages = [];
let pendingCount = 0;
for (const [name, version] of Object.entries(versions)) {
  let manifest;
  try {
    manifest = await fetchExactManifest(name, version); // eslint-disable-line no-await-in-loop
  } catch (err) {
    console.error(`::error::Registry query failed for ${name}@${version}: ${err?.message ?? err}. A registry failure is never "absent" (SPEC §18.3).`);
    process.exit(1);
  }
  const present = manifest !== null;
  if (!present) pendingCount += 1;
  packages.push({ name, version, published: present, gitHead: manifest?.gitHead ?? null });
}

console.log(
  JSON.stringify({
    cohort: true,
    sha: found.sha,
    releases: found.releases,
    packages,
    publishPending: pendingCount,
    publishComplete: pendingCount === 0,
  }),
);
process.exit(0);
