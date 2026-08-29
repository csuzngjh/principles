// Safely remove a completed task worktree (AGENTS.md §23A, git-8-cleanup-after-merge).
//
// Never destroys unknown work (git-4): a dirty worktree, an unproven task
// branch, or the primary checkout all cause a refusal — this tool never
// resets, cleans, stashes, or force-deletes anything with unreviewed content.
//
// Completion proof (git-8): BOTH worktree removal and branch deletion require
// proving the task branch is an ancestor of origin/main. A clean-but-unmerged
// worktree is REFUSED — removing it would destroy another agent's active
// working directory even though no code would be lost. Squash-merged and
// closed-without-merge branches cannot be proven via ancestry and fail closed
// on purpose; remove those manually after confirming.
//
// Usage:
//   node scripts/dev/cleanup-task-worktree.mjs <branch-or-path> [--delete-branch] [--json]
//   npm run dev:worktree:cleanup -- ai/PRI-123-some-task
//
// <branch-or-path>  worktree path, or the name of the branch checked out in
//                   the target worktree (e.g. ai/PRI-123-some-task)
// --delete-branch   also delete the task branch (same completion proof).
//
// Removal uses `git worktree remove` (junction/reparse-point safe — ERR-098);
// a single retry with one --force is allowed ONLY after the porcelain-clean
// check passed, so the only thing it can override is ignored build output
// (node_modules). Double --force is never used.

import { listWorktrees, normalizeGitPath, runGit } from './lib/git.mjs';

function parseArgs(argv) {
  const args = { target: null, deleteBranch: false, json: false };
  const rest = argv.slice(2);
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === '--delete-branch') args.deleteBranch = true;
    else if (arg === '--json') args.json = true;
    else if (arg === '-h' || arg === '--help') {
      console.log('Usage: node scripts/dev/cleanup-task-worktree.mjs <branch-or-path> [--delete-branch] [--json]');
      process.exit(0);
    } else if (args.target === null) {
      args.target = arg;
    } else {
      console.error('Unexpected argument: ' + arg);
      process.exit(2);
    }
  }
  if (!args.target) {
    console.error('Usage: node scripts/dev/cleanup-task-worktree.mjs <branch-or-path> [--delete-branch] [--json]');
    process.exit(2);
  }
  return args;
}

function fail(args, message, nextAction) {
  if (args.json) {
    console.log(JSON.stringify({ ok: false, error: message, nextAction }, null, 2));
  } else {
    console.error('[cleanup-task-worktree] FAIL: ' + message);
    if (nextAction) console.error('  next: ' + nextAction);
  }
  process.exit(1);
}

async function main() {
  const args = parseArgs(process.argv);
  const cwd = process.cwd();

  const worktrees = await listWorktrees(cwd);
  const primary = worktrees.find((w) => !w.bare);
  if (!primary) {
    fail(args, 'Could not identify the primary worktree.', 'Run from any worktree of the PD repository.');
  }

  // Resolve the target: exact path match, or the worktree whose checked-out
  // branch matches (accept both 'ai/foo' and 'refs/heads/ai/foo').
  const target = worktrees.find(
    (w) =>
      normalizeGitPath(w.path, cwd) === normalizeGitPath(args.target, cwd) ||
      w.branch === args.target ||
      w.branch === 'refs/heads/' + args.target
  );

  const branchName = target && target.branch ? target.branch.replace(/^refs\/heads\//, '') : args.target.replace(/^refs\/heads\//, '');
  const branchExists =
    (await runGit(['rev-parse', '--verify', 'refs/heads/' + branchName], { cwd, allowFailure: true })) !== null;

  if (!target && !branchExists) {
    fail(args, "No worktree or branch matches '" + args.target + "'.", 'List tasks with: git worktree list');
  }

  if (target && normalizeGitPath(target.path, cwd) === normalizeGitPath(primary.path, cwd)) {
    fail(args, 'Refusing to remove the PRIMARY worktree (' + primary.path + ').', 'The primary checkout is the repository control plane.');
  }

  // Completion proof BEFORE any mutation (fail loud, nothing destroyed).
  // Protects BOTH the worktree removal below and the branch deletion —
  // git-8 requires merged/closed + clean for the whole cleanup, not just
  // for the branch delete.
  const notes = [];
  const refreshed = await runGit(['fetch', 'origin', '--prune'], { cwd, allowFailure: true });
  if (refreshed === null) {
    notes.push('origin refresh failed — merge proof uses the cached origin/main (run git fetch origin and retry for a fresh verdict)');
  }
  const mainSha = (await runGit(['rev-parse', '--verify', 'origin/main^{commit}'], { cwd, allowFailure: true }))?.trim();
  if (!mainSha) {
    fail(
      args,
      'Merge completion proof requires a resolvable origin/main.',
      'git fetch origin and retry, or remove the worktree manually after confirming its PR is merged/closed.'
    );
  }
  if (!branchExists) {
    fail(
      args,
      "Branch '" + branchName + "' does not exist — cannot prove the task completed via merge ancestry.",
      'If this worktree is truly done, remove it manually: git worktree remove ' + (target ? target.path : '<worktree-path>')
    );
  }
  const ancestry = await runGit(['merge-base', '--is-ancestor', branchName, 'origin/main'], { cwd, allowFailure: true });
  if (ancestry === null) {
    fail(
      args,
      "Branch '" + branchName + "' is NOT an ancestor of origin/main — cannot prove the task completed. Worktree was not removed.",
      'Confirm the PR is closed/squash-merged, then remove manually: git worktree remove ' + (target ? target.path : '<worktree-path>')
    );
  }

  let removedWorktree = null;
  if (target) {
    const status = await runGit(['status', '--porcelain'], { cwd: target.path, allowFailure: true });
    if (status === null) {
      fail(args, 'Could not inspect worktree status: ' + target.path, 'Run git status there manually.');
    }
    if (status.trim().length > 0) {
      const preview = status
        .split(/\r?\n/)
        .slice(0, 5)
        .map((l) => '    ' + l)
        .join('\n');
      fail(
        args,
        'Worktree has uncommitted or untracked files — refusing to destroy unknown work:\n' + preview,
        'Review and commit (WIP commit is fine) or remove the files yourself; then retry cleanup.'
      );
    }

    let removeError = '';
    try {
      await runGit(['worktree', 'remove', target.path], { cwd });
    } catch (err) {
      removeError = err && err.message ? err.message : String(err);
    }
    if (removeError) {
      // Porcelain was clean, so only ignored build output (e.g. node_modules)
      // can be blocking the removal. One --force retry is safe in exactly
      // this situation; it cannot touch tracked/dirty content we did not
      // already refuse above.
      try {
        await runGit(['worktree', 'remove', '--force', target.path], { cwd });
        notes.push('removal needed one --force pass for ignored build output (porcelain was clean)');
      } catch (err2) {
        fail(
          args,
          'git worktree remove failed (porcelain was clean):\n' + (err2 && err2.message ? err2.message : String(err2)),
          'Inspect manually: git worktree remove ' + target.path
        );
      }
    }
    removedWorktree = target.path;
  }

  if (args.deleteBranch && branchExists) {
    // Ancestry already proven above; -d still refuses when the branch is not
    // merged into the CURRENT head, so fall back to -D with justification.
    let delError = '';
    try {
      await runGit(['branch', '-d', branchName], { cwd });
    } catch (err) {
      delError = err && err.message ? err.message : String(err);
    }
    if (delError) {
      try {
        await runGit(['branch', '-D', branchName], { cwd });
        notes.push('-d refused (not merged into current HEAD); -D used after proving ancestry to origin/main');
      } catch (err2) {
        fail(
          args,
          "git branch delete failed for '" + branchName + "' (merge into origin/main was already proven):\n" + (err2 && err2.message ? err2.message : String(err2)),
          'Delete manually: git branch -D ' + branchName
        );
      }
    }
  }

  await runGit(['worktree', 'prune'], { cwd, allowFailure: true });

  const summary = { ok: true, removedWorktree, deletedBranch: args.deleteBranch ? branchName : null, notes };
  if (args.json) {
    console.log(JSON.stringify(summary, null, 2));
  } else {
    console.log('[cleanup-task-worktree] ok');
    if (removedWorktree) console.log('  removed worktree: ' + removedWorktree);
    if (summary.deletedBranch) console.log('  deleted branch:   ' + summary.deletedBranch);
    for (const note of notes) console.log('  note: ' + note);
    console.log('  pruned stale worktree metadata');
  }
}

const isMain = process.argv[1] && process.argv[1].endsWith('cleanup-task-worktree.mjs');
if (isMain) {
  await main();
}
