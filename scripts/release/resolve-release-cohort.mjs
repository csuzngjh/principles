#!/usr/bin/env node
/**
 * Release cohort resolver (SPEC v1.2 §17 / Step J).
 *
 * A release cohort is defined by EXACTLY one SHA: the commit that landed the
 * Version Packages PR on main. Identity is proven by reproduction (the
 * commit's first-parent diff must equal the materialization of the pending
 * changesets at its first parent) — never by commit message, branch name,
 * actor, or merge-vs-squash shape (SPEC §17; PRI-922).
 *
 * Modes:
 *   --is-cohort <sha>   exit 0 iff <sha> is a Version PR landing commit
 *   --explicit <sha>    resolve that SHA as the cohort (fails loud if not)
 *   (default)           scan main's recent commits newest-first for the
 *                       latest cohort; also report whether every
 *                       publishable package's exact version already exists
 *                       on the registry (published-complete -> no-op).
 *                       When NO cohort is found but main still carries
 *                       versions absent from the registry, that is a release
 *                       chain break and alarms red instead of no-opping.
 *
 * Output: one JSON object on stdout. Exit 0 on resolution, 1 on an invalid
 * explicit SHA, a registry failure (SPEC §18.3) or the chain-break alarm,
 * 2 on a clean no-op (callers that treat "no cohort, nothing pending" as a
 * no-op — the weekly window — use the JSON, not the code).
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
  // The reproduction base is the commit's FIRST PARENT — main before the
  // Version PR landed. Whether the PR was merged with a merge commit or
  // squashed/rebased is irrelevant: both forms produce exactly one commit
  // on main whose first-parent diff is the materialization, and both must
  // be valid cohorts (PRI-922: squash-only merge policy made every cohort
  // single-parent and silently dead-ended the train). Root commits (no
  // parent) cannot be cohorts; a feature push fails the reproduction
  // because its diff carries files outside the Version PR allowlist or
  // does not equal the deterministic materialization.
  const parents = gitSafe(['rev-list', '--parents', '-n', '1', sha]);
  if (!parents) return { ok: false, reason: `cannot read commit ${sha}` };
  const parts = parents.trim().split(/\s+/);
  if (parts.length < 2) return { ok: false, reason: `${sha} has no parent commit` };
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

// Default: newest-first bounded scan of main's spine for the latest cohort.
// --first-parent walks the integration line (merge commits and squash/rebase
// landings alike) and skips the interior commits of feature branches, which
// can never be cohorts; scanning HEAD rather than `main` because the train's
// tools checkout is a detached SHA where no `main` ref exists.
const SCAN_LIMIT = Number(argValue('--scan-limit') ?? 40);
const spine = gitSafe(['rev-list', '--first-parent', '-n', String(SCAN_LIMIT), 'HEAD'])
  ?.split('\n')
  .filter(Boolean) ?? [];

let found = null;
for (const sha of spine) {
  const verdict = await isCohort(sha); // eslint-disable-line no-await-in-loop
  if (verdict.ok) {
    found = { sha, releases: verdict.releases };
    break;
  }
}

if (!found) {
  // A cohort-free scan window is a clean no-op ONLY when the tree we scanned
  // carries nothing unpublished. A Version PR whose train never ran leaves
  // main holding package versions that no publish ever recorded, and it stays
  // silent forever unless somebody says so (PRI-922).
  const headSha = gitSafe(['rev-parse', 'HEAD'])?.trim();
  if (!headSha) {
    console.error(`::error::No cohort in the scanned window and HEAD is not readable in ${repoRoot} — cannot reconcile what main should have published.`);
    process.exit(1);
  }
  const unpublished = [];
  for (const [name, version] of Object.entries(committedVersions(headSha))) {
    let manifest;
    try {
      manifest = await fetchExactManifest(name, version); // eslint-disable-line no-await-in-loop
    } catch (err) {
      console.error(`::error::Registry query failed for ${name}@${version}: ${err?.message ?? err}. A registry failure is never "absent" (SPEC §18.3).`);
      process.exit(1);
    }
    if (manifest === null) unpublished.push(`${name}@${version}`);
  }
  if (unpublished.length > 0) {
    console.error(
      `::error::Release chain break: ${spine.length} commit(s) scanned on main with no release cohort, ` +
        `yet these committed versions are absent from the registry: ${unpublished.join(', ')}. ` +
        `A Version PR landed without its publish train — dispatch publish-npm.yml with an explicit cohort_sha.`,
    );
    console.log(JSON.stringify({ cohort: false, scanned: spine.length, chainBreak: true, unpublished }));
    process.exit(1);
  }
  console.log(JSON.stringify({ cohort: false, scanned: spine.length, reason: 'no release cohort in the scanned window and nothing unpublished' }));
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
