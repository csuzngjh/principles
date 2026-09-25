#!/usr/bin/env node
/**
 * Finalize tag reconciliation CLI (PRI-923).
 *
 * Gathers the facts (remote tag position, introduced-by-cohort, exact
 * registry state, ancestor proof), judges them with the pure decision in
 * ./lib/finalize-tag-reconcile.mjs, and executes the verdict:
 *
 *   create-and-push  annotate the tag at the cohort and push it
 *   run-closing      tag already at the cohort — keep reconciling closings
 *   skip-closing     tag legitimately belongs to a prior cohort — the
 *                    caller must skip GitHub Release / ClawHub green
 *   fail             real conflict or registry doubt — loud, exit 1
 *
 * Writes `closing_steps=ran|skipped-prior-tag` to $GITHUB_OUTPUT when that
 * env var exists. Run from the PRODUCT checkout at the cohort SHA.
 *
 *   node finalize-tag-reconcile.mjs --cohort <sha> [--repo-root <path>]
 *
 * Exit 0 on any non-fail verdict, 1 on fail (or unusable inputs).
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { classifyPresence, fetchPackument } from './lib/registry-client.mjs';
import { decideFinalizeTag } from './lib/finalize-tag-reconcile.mjs';

const DEFAULT_REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PKG_REL = 'packages/openclaw-plugin/package.json';

function argValue(flag) {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const repoRoot = path.resolve(argValue('--repo-root') ?? DEFAULT_REPO_ROOT);
const cohort = argValue('--cohort');
if (!cohort || !/^[0-9a-f]{7,40}$/i.test(cohort)) {
  console.error('::error::usage: finalize-tag-reconcile.mjs --cohort <sha> — a cohort SHA is required.');
  process.exit(1);
}

function git(args, opts = {}) {
  return execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8', ...opts });
}
function gitSafe(args) {
  try {
    return git(args).trim();
  } catch {
    return null;
  }
}

function writeOutput(name, value) {
  if (!process.env.GITHUB_OUTPUT) return;
  fs.appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}\n`);
}

// --- facts -----------------------------------------------------------------
// The committed plugin version is read from the cohort tree itself (the
// checkout IS the cohort), matching what the publish leg uploaded.
const manifest = JSON.parse(git(['show', `${cohort}:${PKG_REL}`]));
const { name: pluginName, version: pluginVersion } = manifest;
const tag = `v${pluginVersion}`;

const remoteSha = gitSafe(['ls-remote', '--tags', 'origin', `refs/tags/${tag}`])
  ?.split(/\s+/)[0];
const tagExistsRemotely = Boolean(remoteSha);
let taggedCommit = null;
if (tagExistsRemotely) {
  gitSafe(['fetch', 'origin', `refs/tags/${tag}`]);
  taggedCommit = gitSafe(['rev-parse', `${tag}^{commit}`]);
}
const tagPointsAtCohort = taggedCommit !== null && taggedCommit === cohort;

// Introduced-by-cohort, exactly like the publish leg: the cohort's FIRST
// parent is main before the Version PR landed (merge or squash alike).
let prevVersion = null;
try {
  prevVersion = JSON.parse(git(['show', `${cohort}^:${PKG_REL}`])).version;
} catch {
  prevVersion = null;
}
const introducedByCohort = prevVersion !== pluginVersion;

let registryStatus = null;
let publishedCommit = null;
if (tagExistsRemotely && !tagPointsAtCohort) {
  let packument = null;
  try {
    packument = await fetchPackument(pluginName);
  } catch (err) {
    registryStatus = 'REGISTRY_ERROR';
    publishedCommit = null;
    console.log(`registry query failed for ${pluginName}: ${err?.message ?? err} (SPEC §18.3: never read as absent)`);
  }
  if (registryStatus === null) {
    const exact = packument?.versions?.[pluginVersion] ?? null;
    const base = classifyPresence(exact, { expectGitHead: cohort });
    publishedCommit = typeof exact?.gitHead === 'string' ? exact.gitHead : null;
    if (base === 'PRESENT_CONFLICT' && introducedByCohort === false && publishedCommit) {
      // Same promotion the publish leg applies: an UNCHANGED package may
      // reuse a prior publish only when that commit is provably inside
      // this cohort's history. A foreign commit never becomes an ancestor.
      const reachable = gitSafe(['cat-file', '-e', `${publishedCommit}^{commit}`]) !== null;
      const isAncestor = reachable && gitSafe(['merge-base', '--is-ancestor', publishedCommit, cohort]) !== null;
      if (isAncestor) registryStatus = 'PRESENT_PRIOR';
      else registryStatus = base;
    } else {
      registryStatus = base;
    }
  }
}

// --- verdict ---------------------------------------------------------------
const decision = decideFinalizeTag({
  tag,
  cohort,
  pluginName,
  pluginVersion,
  tagExistsRemotely,
  taggedCommit,
  tagPointsAtCohort,
  introducedByCohort,
  registryStatus,
  publishedCommit,
  publishedCommitIsAncestor: registryStatus === 'PRESENT_PRIOR',
});

writeOutput('closing_steps', decision.closingSteps);

if (decision.action === 'create-and-push') {
  git(['config', 'user.name', 'github-actions[bot]']);
  git(['config', 'user.email', 'github-actions[bot]@users.noreply.github.com']);
  git(['tag', '-a', tag, '-m', `Release ${tag} (plugin; bound to cohort ${cohort})`]);
  git(['push', 'origin', tag]);
  console.log(`Created and pushed tag: ${tag}`);
} else if (decision.action === 'run-closing') {
  console.log(`Tag ${tag} already exists at the cohort commit — skip (idempotent).`);
  console.log('Closing steps (GitHub Release / ClawHub) continue to reconcile.');
} else if (decision.action === 'skip-closing') {
  console.log(`::notice::${decision.reason} — closing steps skipped (PRI-923).`);
  if (process.env.GITHUB_STEP_SUMMARY) {
    fs.appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      `## Finalize skipped: tag ${tag} belongs to an earlier cohort\n\n` +
        `This release cohort did not change the plugin version (${pluginName}@${pluginVersion});\n` +
        `npm published it from \`${publishedCommit}\`, an ancestor of cohort \`${cohort}\`,\n` +
        `and tag \`${tag}\` is recorded at that earlier release.\n` +
        `Per SPEC §25 the tag marks the PLUGIN release, so this cohort has no new tag,\n` +
        `GitHub Release, or ClawHub upload. Other packages in this cohort were published\n` +
        `by their own legs (see the publish job summary).\n`,
    );
  }
} else {
  console.error(`::error::Refusing to move an existing tag. ${decision.reason}.`);
  process.exit(1);
}
process.exit(0);
