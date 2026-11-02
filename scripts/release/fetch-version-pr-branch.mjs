// PRI-1014: make an existing Version PR branch visible to changesets/action.
//
// The action runs `git checkout changeset-release/main` before materializing.
// A checkout that never fetched that ref makes the action create a branch from
// main, after which its ref update is rejected because the real Version PR
// branch already exists. Fetch ONLY this bot branch, and treat its absence as
// normal (the branch is deleted when the Version PR merges, so the next cohort
// starts without it). Any other git failure is still fail-loud.
//
// Usage: node scripts/release/fetch-version-pr-branch.mjs

import { execFileSync } from 'node:child_process';

const BRANCH = 'changeset-release/main';

function git(args) {
  return execFileSync('git', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

try {
  git(['ls-remote', '--exit-code', '--heads', 'origin', BRANCH]);
} catch (error) {
  const missing = typeof error === 'object' && error !== null && 'status' in error && error.status === 2;
  if (!missing) throw error;
  console.log(`No existing ${BRANCH} branch — the action will create one.`);
  process.exit(0);
}

git(['fetch', '--no-tags', 'origin', `+refs/heads/${BRANCH}:refs/heads/${BRANCH}`]);
console.log(`Fetched existing ${BRANCH}.`);
