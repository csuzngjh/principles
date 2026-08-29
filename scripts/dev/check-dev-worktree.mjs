// Worktree safety guard — the single authority for "is this checkout a safe
// place for an implementation commit/push?" (AGENTS.md §23A).
//
// This tool JUDGES, it never repairs: no reset, no clean, no stash, no
// checkout, no branch mutation. On violation it fails closed with an
// actionable next step.
//
// Rules (each violation fails the guard):
//   not-a-repo       — cwd is not inside a git repository
//   unsafe-git-state — a rebase/merge/cherry-pick/revert is in progress
//   detached-head    — HEAD is detached or the branch cannot be identified
//   protected-branch— current branch is main/master (PR-only)
//   primary-worktree — cwd is the primary checkout (control plane; AI writers
//                      implement in task worktrees). Humans may override in
//                      emergencies with PD_DEV_WORKTREE_ALLOW_PRIMARY=1 —
//                      AI agents must NEVER set that variable.
//
// Usage:
//   node scripts/dev/check-dev-worktree.mjs [--json]
// Exit codes: 0 = safe, 1 = violation(s).

import fs from 'node:fs';
import path from 'node:path';
import { getGitContext } from './lib/git.mjs';

const PROTECTED_BRANCHES = new Set(['main', 'master']);

// Files/dirs whose presence inside the worktree git dir means an unsafe
// in-progress operation (same marker set as scripts/post-checkout-worktree.sh).
const UNSAFE_STATE_MARKERS = ['rebase-merge', 'rebase-apply', 'MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD'];

function parseArgs(argv) {
  const args = { json: false };
  for (const arg of argv.slice(2)) {
    if (arg === '--json') args.json = true;
    else if (arg === '-h' || arg === '--help') {
      console.log('Usage: node scripts/dev/check-dev-worktree.mjs [--json]');
      process.exit(0);
    } else {
      console.error('Unknown argument: ' + arg);
      process.exit(2);
    }
  }
  return args;
}

async function collectViolations() {
  const violations = [];
  let ctx = null;
  try {
    ctx = await getGitContext(process.cwd());
  } catch (err) {
    violations.push({
      rule: 'not-a-repo',
      message: 'Not inside a git repository (git rev-parse failed).',
      nextAction: 'Run this guard from a PD worktree. See AGENTS.md §23A.',
      detail: err && err.message ? err.message : '',
    });
    return { violations, ctx: null };
  }

  const markers = UNSAFE_STATE_MARKERS.filter((m) => fs.existsSync(path.join(ctx.gitDir, m)));
  if (markers.length > 0) {
    violations.push({
      rule: 'unsafe-git-state',
      message: 'A rebase/merge/cherry-pick/revert is in progress (' + markers.join(', ') + ').',
      nextAction: 'Finish or abort the in-progress operation manually before committing or pushing.',
    });
  }

  if (ctx.detached) {
    violations.push({
      rule: 'detached-head',
      message: 'HEAD is detached or the current branch cannot be identified.',
      nextAction: 'Create/checkout a task branch: git switch -c <branch> — never commit on a detached HEAD.',
    });
  }

  if (PROTECTED_BRANCHES.has(ctx.branch)) {
    violations.push({
      rule: 'protected-branch',
      message: "Branch '" + ctx.branch + "' is protected — changes land via pull request only.",
      nextAction: 'Create a task branch (npm run dev:worktree -- <task> <slug>) and commit there.',
    });
  }

  if (ctx.isPrimary && process.env.PD_DEV_WORKTREE_ALLOW_PRIMARY !== '1') {
    violations.push({
      rule: 'primary-worktree',
      message:
        'This is the PRIMARY checkout (' +
        ctx.cwd +
        ') — the repository control plane. Implementation commits/pushes belong in a task worktree.',
      nextAction:
        'npm run dev:worktree -- <task> <slug>  (creates an isolated worktree). ' +
        'Human emergency override: PD_DEV_WORKTREE_ALLOW_PRIMARY=1 (AI agents must never set this).',
    });
  }

  return { violations, ctx };
}

function reportHuman(violations, ctx) {
  if (violations.length === 0) {
    console.log('[worktree-guard] ok: branch ' + ctx.branch + ' in task worktree ' + ctx.cwd);
    return;
  }
  console.error('[worktree-guard] FAIL — this checkout is not a safe write target:');
  for (const v of violations) {
    console.error('  ' + v.rule + ': ' + v.message);
    console.error('    next: ' + v.nextAction);
  }
  process.exitCode = 1;
}

function reportJson(violations, ctx) {
  const payload = {
    ok: violations.length === 0,
    worktree: ctx ? ctx.cwd : process.cwd(),
    branch: ctx ? ctx.branch : null,
    isPrimary: ctx ? ctx.isPrimary : null,
    violations,
  };
  console.log(JSON.stringify(payload, null, 2));
  if (violations.length > 0) process.exitCode = 1;
}

async function main() {
  const args = parseArgs(process.argv);
  const { violations, ctx } = await collectViolations();
  if (args.json) reportJson(violations, ctx);
  else reportHuman(violations, ctx);
}

const isMain = process.argv[1] && process.argv[1].endsWith('check-dev-worktree.mjs');
if (isMain) {
  await main();
}
